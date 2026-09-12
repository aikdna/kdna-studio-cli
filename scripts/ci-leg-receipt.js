#!/usr/bin/env node
'use strict';

// CI leg gate for legs whose object may be absent on the committed graph.
//
// Exactly three outcomes are allowed, and they are distinguishable:
//   * required configuration missing  -> KDNA-CI-CONFIG-MISSING on stderr, exit 2,
//     and no receipt is printed;
//   * object registered as retired and unavailable -> exactly one
//     `KDNA-CI-NOT-RUN: <leg> ...` line plus one machine-readable
//     `KDNA-CI-RECEIPT: {...}` line, exit 0;
//   * object available                -> the real leg command is executed and its
//     exit status becomes this process's exit status, with one `run` receipt.
//
// A not_run outcome requires BOTH an explicit registration in
// fixtures/runtime-candidates/leg-registry.json AND the recomputed coordinate
// mismatch that registration describes. A gate cannot manufacture a permanent
// not_run out of its own condition: with no registration, or with the
// registered mismatch actually gone, the real leg command runs.
//
// Every receipt carries the sha256 digests of the exact input files it read, so
// scripts/verify-ci-leg-receipts.js can tell a receipt produced from the
// committed bytes apart from a stubbed or replayed one.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { BINDING_PATH, LEGS, LOCK_PATH, REGISTRY_PATH } = require('./ci-leg-definitions');

const root = path.resolve(__dirname, '..');

function coordinates(entries) {
  return entries
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, version]) => `${name}@${version}`)
    .join(',');
}

function authorityCoordinates() {
  const binding = JSON.parse(fs.readFileSync(path.join(root, BINDING_PATH), 'utf8'));
  return coordinates(binding.packages.map(({ name, version }) => [name, version]));
}

function shippedCoordinates() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_PATH), 'utf8'));
  const entries = Object.entries(lock.packages)
    .filter(([key]) => key.startsWith('node_modules/@aikdna/'))
    .map(([key, entry]) => [key.slice('node_modules/'.length), entry.version]);
  return coordinates(entries);
}

function sha256(relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
}

function inputDigests() {
  return { [BINDING_PATH]: sha256(BINDING_PATH), [LOCK_PATH]: sha256(LOCK_PATH) };
}

function legRegistry() {
  return JSON.parse(fs.readFileSync(path.join(root, REGISTRY_PATH), 'utf8'));
}

function registrationFor(leg) {
  return (legRegistry().entries ?? []).find((entry) => entry.leg === leg);
}

function receipt(payload) {
  return `KDNA-CI-RECEIPT: ${JSON.stringify(payload)}`;
}

function main(argv) {
  const [leg] = argv;
  if (argv.length !== 1 || !Object.hasOwn(LEGS, leg)) {
    console.error(`usage: node scripts/ci-leg-receipt.js <${Object.keys(LEGS).join('|')}>`);
    return 2;
  }
  const definition = LEGS[leg];
  const missing = definition.requires.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`KDNA-CI-CONFIG-MISSING: ${leg} missing=${missing.join(',')}`);
    return 2;
  }
  const authority = authorityCoordinates();
  const shipped = shippedCoordinates();
  const registration = registrationFor(leg);
  if (registration?.class === 'not_run' && authority !== shipped) {
    console.log(
      `KDNA-CI-NOT-RUN: ${leg} reason=${registration.reason} ` +
        `object=${registration.object} authority=${authority} shipped=${shipped}`,
    );
    console.log(
      receipt({
        leg,
        class: 'not_run',
        reason: registration.reason,
        object: registration.object,
        authority,
        shipped,
        inputs: inputDigests(),
      }),
    );
    return 0;
  }
  const result = spawnSync(process.execPath, definition.command, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${leg} was interrupted by ${result.signal}`);
  console.log(
    receipt({
      leg,
      class: 'run',
      command: [...definition.command],
      status: result.status,
      inputs: inputDigests(),
    }),
  );
  return result.status;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  LEGS,
  authorityCoordinates,
  inputDigests,
  legRegistry,
  registrationFor,
  shippedCoordinates,
};
