#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const productTests = [
  'tests/cli.test.js',
  'tests/e2e-export-completeness.test.js',
  'tests/protocol-producer.test.js',
  'tests/runtime-candidate-binding-completeness.test.js',
];
const result = spawnSync(process.execPath, ['--test', ...productTests], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
assert.equal(result.error, undefined, 'product and Runtime tests failed to start');
assert.equal(result.signal, null, 'product and Runtime tests were interrupted');
assert.equal(result.status, 0, 'product and Runtime tests failed');
