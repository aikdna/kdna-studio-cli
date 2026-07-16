#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files.sort();
}

for (const directory of ['bin', 'src', 'tests', 'scripts']) {
  for (const file of javascriptFiles(path.join(root, directory))) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(result.error, undefined, `syntax check failed to start: ${file}`);
    assert.equal(result.signal, null, `syntax check was interrupted: ${file}`);
    assert.equal(result.status, 0, result.stderr || `syntax check failed: ${file}`);
  }
}
