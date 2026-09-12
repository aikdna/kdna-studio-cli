#!/usr/bin/env node
'use strict';

// CI leg gate for legs whose object may be absent on the committed graph.
//
// Exactly three outcomes are allowed, and they are distinguishable:
//   * required configuration missing  -> KDNA-CI-CONFIG-MISSING on stderr, exit 2,
//     and no not_run receipt is printed;
//   * object unavailable              -> exactly one `KDNA-CI-NOT-RUN: <leg> ...`
//     receipt on stdout, exit 0;
//   * object available                -> the real leg command is executed and its
//     exit status becomes this process's exit status.
//
// The object of the runtime-candidate legs is a candidate authority that
// describes the dependency graph this repository actually ships. It is checked
// rather than assumed: admitting the current graph into the retired
// 3.0.0/0.21.0 authority would weaken a supply-chain gate.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const BINDING_PATH = path.join('fixtures', 'runtime-candidates', 'binding.json');
const LOCK_PATH = 'package-lock.json';

const LEGS = {
  'candidate-sources': {
    object: 'runtime candidate authority that matches the shipped dependency graph',
    requires: ['KDNA_CORE_CANDIDATE_SOURCE', 'KDNA_STUDIO_CORE_CANDIDATE_SOURCE'],
    command: ['scripts/run-trusted-npm.js', 'run', 'verify:candidate-sources'],
  },
  'candidate-chain': {
    object: 'runtime candidate authority that matches the shipped dependency graph',
    requires: ['KDNA_CORE_CANDIDATE_SOURCE', 'KDNA_STUDIO_CORE_CANDIDATE_SOURCE'],
    command: ['scripts/run-trusted-npm.js', 'run', 'test:candidate-chain'],
  },
};

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

function main(argv) {
  const [leg] = argv;
  if (argv.length !== 1 || !Object.hasOwn(LEGS, leg)) {
    console.error(
      `usage: node scripts/ci-leg-receipt.js <${Object.keys(LEGS).join('|')}>`,
    );
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
  if (authority !== shipped) {
    console.log(
      `KDNA-CI-NOT-RUN: ${leg} reason=retired_runtime_candidate_authority ` +
        `object=${definition.object} authority=${authority} shipped=${shipped}`,
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
  return result.status;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { LEGS, authorityCoordinates, shippedCoordinates };
