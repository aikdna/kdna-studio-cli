'use strict';
/**
 * Current Studio CLI surface - `bin/kdna-studio.js`.
 *
 * This file drove the retired pre-component-semantics command surface
 * (`project`, `card`, `identity`, `migrate`, `export`, `llm config`). That
 * surface is not in the committed graph any more: `bin/kdna-studio.js` is a shim
 * over `src/terminal-workspace.js` and the only commands it declares are
 * `session`, `verify` and `read`.
 *
 * It was recorded as retired from its failing test titles. A failing test's
 * title is static text - `card approve --all locks every unlocked card` names a
 * retired command but says nothing about why the run is red - so it is not a
 * reason to retire anything. Restored as a current test, this file checks the
 * current surface, and it enumerates the retired commands as commands the CLI
 * must keep refusing: the boundary is an assertion in the suite.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'kdna-studio.js');
const CURRENT_COMMANDS = Object.freeze(['session', 'verify', 'read']);
const RETIRED_COMMANDS = Object.freeze([
  'project',
  'card',
  'identity',
  'migrate',
  'export',
  'llm',
  'create-agent',
  'finalize-agent',
  'answer',
  'review',
  'resume',
  'try',
  'repair',
]);

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    input: options.input,
  });
}

function rejectedWith(result, code) {
  const seen = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2, `expected rc 2 for ${code}, got ${result.status}: ${seen}`);
  assert.deepEqual(JSON.parse(result.stderr), { status: 'rejected', code });
}

function withScratch(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-cli-'));
  try {
    return body(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('the CLI entry point reports the committed package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), require('../package.json').version);
});

test('help advertises the current command surface and no retired command', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const command of CURRENT_COMMANDS) {
    assert.match(result.stdout, new RegExp(`^kdna-studio ${command}\\b`, 'mu'), command);
  }
  for (const command of RETIRED_COMMANDS) {
    assert.doesNotMatch(result.stdout, new RegExp(`^kdna-studio ${command}\\b`, 'mu'), command);
  }
});

test('every retired command is refused as unsupported', () => {
  for (const command of RETIRED_COMMANDS) {
    rejectedWith(run([command, 'probe']), 'CLI_COMMAND_UNSUPPORTED');
  }
});

test('an unknown command is refused the same way', () => {
  rejectedWith(run(['feynman', 'probe']), 'CLI_COMMAND_UNSUPPORTED');
});

test('session requires an output directory', () => {
  rejectedWith(run(['session']), 'CLI_OUTPUT_REQUIRED');
});

test('session requires an adoption channel', () => {
  withScratch((directory) => {
    rejectedWith(run(['session', '--out', path.join(directory, 'bundle')]), 'CLI_HUMAN_CHANNEL_REQUIRED');
  });
});

test('verify and read require a bundle', () => {
  rejectedWith(run(['verify']), 'CLI_BUNDLE_REQUIRED');
  rejectedWith(run(['read']), 'CLI_BUNDLE_REQUIRED');
});

test('the agent channel needs its delegation record and cannot share the human flag', () => {
  withScratch((directory) => {
    const bundle = path.join(directory, 'bundle');
    rejectedWith(run(['session', '--out', bundle, '--agent-adoption-fd', '3']), 'CLI_ADOPTION_OPTIONS_INVALID');
    const delegation = path.join(directory, 'delegation.json');
    fs.writeFileSync(delegation, '{}\n');
    rejectedWith(
      run(['session', '--out', bundle, '--human-fd', '3', '--agent-adoption-fd', '3', '--delegation-record', delegation]),
      'CLI_ADOPTION_OPTIONS_INVALID',
    );
  });
});

test('verify and read refuse a directory that is not a bundle', () => {
  withScratch((directory) => {
    rejectedWith(run(['verify', '--bundle', directory]), 'ENOENT');
    rejectedWith(run(['read', '--bundle', directory, '--allow-read']), 'ENOENT');
  });
});
