'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('npm tarball excludes unvalidated CLI workshops', () => {
  const npmExecPath = process.env.npm_execpath;
  const packed = npmExecPath
    ? spawnSync(
        process.execPath,
        [npmExecPath, 'pack', '--dry-run', '--json', '--ignore-scripts'],
        { cwd: ROOT, encoding: 'utf8', shell: false },
      )
    : spawnSync(
        'npm',
        ['pack', '--dry-run', '--json', '--ignore-scripts'],
        { cwd: ROOT, encoding: 'utf8', shell: false },
      );
  assert.equal(packed.status, 0, packed.stderr);
  const reports = JSON.parse(packed.stdout);
  assert.equal(reports.length, 1);
  const files = reports[0].files.map((entry) => entry.path);

  for (const forbidden of ['src/ai/feynman.js', 'src/ai/testlab.js']) {
    assert.equal(files.includes(forbidden), false, `workshop leaked into npm tarball: ${forbidden}`);
  }
  for (const required of [
    'bin/kdna-studio.js',
    'src/ai/distill.js',
    'src/ai/interview.js',
    'src/creation-cli.js',
    'src/llm/index.js',
    'src/llm/transport.js',
    'docs/CREATION_COMMAND_CONTRACT.md',
    'docs/TERMINAL_AGENT_CREATION.md',
  ]) {
    assert.ok(files.includes(required), `supported CLI dependency missing from npm tarball: ${required}`);
  }
});
