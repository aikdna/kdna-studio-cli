#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function node(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
  assert.equal(result.error, undefined, `${label} failed to start`);
  assert.equal(result.signal, null, `${label} was interrupted`);
  assert.equal(result.status, 0, `${label} failed`);
}

node(['scripts/acquire-trusted-npm-release.js'], 'trusted npm release acquisition');
node(['scripts/run-lint.js'], 'syntax checks');
node(['scripts/check-current-protocol-names.js'], 'protocol naming gate');
const tests = fs.readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('tests', name));
node(['--test', ...tests], 'test suite');
