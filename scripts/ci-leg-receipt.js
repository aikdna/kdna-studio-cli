#!/usr/bin/env node
'use strict';

// CI leg gate for legs whose object may be absent on the committed graph.
//
// Exactly three outcomes are allowed, and they are distinguishable:
//   * required configuration missing  -> KDNA-CI-CONFIG-MISSING on stderr, exit 2,
//     and no receipt is printed;
//   * the recomputed unavailability codes are exactly the codes the registration in
//     fixtures/runtime-candidates/leg-registry.json names -> exactly one
//     `KDNA-CI-NOT-RUN: <leg> ...` line plus one machine-readable
//     `KDNA-CI-RECEIPT: {...}` line, exit 0;
//   * otherwise -> the real leg command is executed and its exit status becomes this
//     process's exit status, with one `run` receipt.
//
// A not_run outcome requires BOTH an explicit registration AND the recomputed codes,
// compared in both directions. The gate cannot manufacture a condition of its own: a code
// it computes but the registration does not name, or a registered code that is no longer
// true, makes the real leg run instead - so a red committed graph can never be hidden
// behind a coordinate mismatch that describes a different problem.
//
// Every receipt carries the sha256 digests of the exact input files it read, so
// scripts/verify-ci-leg-receipts.js can tell a receipt produced from the committed bytes
// apart from a stubbed or replayed one.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BINDING_PATH,
  LEGS,
  LOCK_PATH,
  PACKAGE_PATH,
  REGISTRY_PATH,
  registrationFor,
  registeredNotRunFor,
  unavailabilityCodes,
} = require('./ci-leg-definitions');

const root = path.resolve(__dirname, '..');
const DIGEST_INPUTS = Object.freeze([BINDING_PATH, LOCK_PATH, PACKAGE_PATH, REGISTRY_PATH]);

function sha256(relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
}

function inputDigests() {
  return Object.fromEntries(DIGEST_INPUTS.map((relative) => [relative, sha256(relative)]));
}

function legRegistry() {
  return JSON.parse(fs.readFileSync(path.join(root, REGISTRY_PATH), 'utf8'));
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
  const computed = unavailabilityCodes(root, leg);
  const registration = registeredNotRunFor(root, leg, computed.codes);
  if (registration) {
    console.log(
      `KDNA-CI-NOT-RUN: ${leg} reason=${registration.reason} ` +
        `object=${registration.object} unavailable=${computed.codes.join(',')}`,
    );
    console.log(
      receipt({
        leg,
        class: 'not_run',
        reason: registration.reason,
        object: registration.object,
        unavailable_codes: [...computed.codes].sort(),
        code_detail: computed.detail,
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
      unavailable_codes: [...computed.codes].sort(),
      inputs: inputDigests(),
    }),
  );
  return result.status;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  LEGS,
  inputDigests,
  legRegistry,
  registrationFor,
  unavailabilityCodes,
};
