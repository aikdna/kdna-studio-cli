'use strict';
/**
 * Retired Agent creation CLI surface, restored as a current test.
 *
 * This file drove the pre-component-semantics Agent creation CLI
 * (`create-agent`, `finalize-agent`, `answer`, `review`, `resume`, `try`,
 * `repair`, `export-agent`, ...) through `bin/kdna-studio.js`, and the creation
 * CLI implementation behind it. `bin/kdna-studio.js` is now a shim over
 * `src/terminal-workspace.js`, so those commands are gone from the shipped CLI
 * and the run is red with `CLI_COMMAND_UNSUPPORTED`.
 *
 * It was recorded as retired from its failing test titles - `create-agent saves
 * an eleven-artifact workspace and status resumes it` names a retired command
 * but says nothing about why the run is red. A title is static text, so it is
 * not a reason to retire a suite. Restored as a current test, this file pins the
 * current boundary the retirement actually depends on: the retired commands stay
 * unsupported, the current agent channel keeps its explicit delegation contract,
 * and the retired creation-CLI implementation stays outside the shipped tarball
 * surface.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'kdna-studio.js');
const RETIRED_AGENT_COMMANDS = Object.freeze([
  'create-agent',
  'finalize-agent',
  'inventory-agent',
  'deliver-material',
  'guide-agent',
  'answer',
  'review',
  'try',
  'repair',
  'resume',
  'status',
  'export-agent',
  'verify-application-agent',
]);
const RETIRED_CREATION_CLI_MEMBERS = Object.freeze([
  'src/creation-cli.js',
  'src/application-host.js',
  'src/ai/distill.js',
  'src/ai/interview.js',
  'src/llm/config.js',
  'src/llm/transport.js',
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

test('the shipped entry point is the current terminal workspace, not the retired creation CLI', () => {
  const source = fs.readFileSync(CLI, 'utf8');
  assert.match(source, /require\('\.\.\/src\/terminal-workspace\.js'\)\.main\(process\.argv\.slice\(2\)\)/u);
  assert.doesNotMatch(source, /src\/creation-cli|creation-cli\.js/u);
});

test('every retired Agent creation command is refused as unsupported', () => {
  for (const command of RETIRED_AGENT_COMMANDS) {
    rejectedWith(run([command, 'probe']), 'CLI_COMMAND_UNSUPPORTED');
  }
});

test('the current agent channel keeps its explicit delegation contract', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-creation-agent-cli-'));
  try {
    const bundle = path.join(directory, 'bundle');
    rejectedWith(run(['session', '--out', bundle, '--agent-adoption-fd', '3']), 'CLI_ADOPTION_OPTIONS_INVALID');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the retired creation-CLI implementation is outside the shipped tarball surface', () => {
  const manifest = require('../package.json');
  const packed = manifest.files ?? [];
  const isPacked = (relative) =>
    packed.some((entry) => entry === relative || relative.startsWith(`${entry.replace(/\/$/u, '')}/`));
  for (const member of RETIRED_CREATION_CLI_MEMBERS) {
    assert.equal(isPacked(member), false, `${member} must not ship`);
  }
  for (const member of ['bin/kdna-studio.js', 'src/terminal-workspace.js', 'src/component-operations.js']) {
    assert.equal(isPacked(member), true, `${member} must ship`);
  }
});
