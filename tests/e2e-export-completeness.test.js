'use strict';
/**
 * Export completeness of the current bundle contract.
 *
 * This file drove the retired pre-component-semantics export pipeline
 * (`create` -> `card add` -> `card approve` -> `export` -> `validate` -> `load`)
 * through `bin/kdna-studio.js`. That pipeline is not in the committed graph any
 * more, so the run is red with `CLI_COMMAND_UNSUPPORTED`.
 *
 * It was recorded as retired from its failing test titles - `e2e: pattern ->
 * approve -> export -> patterns in payload` names retired commands but says
 * nothing about why the run is red. A title is static text, so it is not a
 * reason to retire a suite. Restored as a current test, this file keeps the
 * subject the file was about - completeness of an export - and pins the current
 * contract that has to hold instead: a bundle is read only when it carries the
 * current `complete.json` contract and every member, and a retired or partial
 * bundle is refused rather than read partially.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'kdna-studio.js');
const LEGACY_ASSET = path.join(ROOT, 'fixtures', 'legacy-shared-evidence', 'artifact.kdna');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function rejectedWith(result, code) {
  const seen = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2, `expected rc 2 for ${code}, got ${result.status}: ${seen}`);
  assert.equal(JSON.parse(result.stderr).code, code);
}

// Builds a bundle directory in the given shape. `complete` is the raw
// `complete.json` body (`undefined` writes none), `members` the files that are
// present beside it.
function bundle({ complete, members = [] }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-e2e-export-'));
  if (complete !== undefined) fs.writeFileSync(path.join(directory, 'complete.json'), complete);
  for (const member of members) fs.copyFileSync(LEGACY_ASSET, path.join(directory, member));
  return directory;
}

function withBundle(shape, body) {
  const directory = bundle(shape);
  try {
    return body(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('a directory with no bundle contract is not read as a bundle', () => {
  withBundle({}, (directory) => {
    rejectedWith(run(['verify', '--bundle', directory]), 'ENOENT');
    rejectedWith(run(['read', '--bundle', directory, '--allow-read']), 'ENOENT');
  });
});

test('the retired bundle contract version is refused as incomplete', () => {
  withBundle(
    { complete: '{"kind":"private-studio-export-bundle","version":1}\n', members: ['asset.kdna'] },
    (directory) => {
      rejectedWith(run(['verify', '--bundle', directory]), 'CLI_BUNDLE_INCOMPLETE');
      rejectedWith(run(['read', '--bundle', directory, '--allow-read']), 'CLI_BUNDLE_INCOMPLETE');
    },
  );
});

test('a bundle with the wrong kind is refused as incomplete', () => {
  withBundle(
    { complete: '{"kind":"private-studio-export-partial","version":2}\n', members: ['asset.kdna'] },
    (directory) => {
      rejectedWith(run(['verify', '--bundle', directory]), 'CLI_BUNDLE_INCOMPLETE');
    },
  );
});

test('the current contract is accepted only with every member present', () => {
  withBundle(
    { complete: '{"kind":"private-studio-export-bundle","version":2}\n', members: ['asset.kdna'] },
    (directory) => {
      // The current version passes the contract check, so the refusal moves on to
      // the missing member rather than to `CLI_BUNDLE_INCOMPLETE`.
      rejectedWith(run(['verify', '--bundle', directory]), 'ENOENT');
    },
  );
});

test('a current-contract bundle carrying retired evidence is refused, not downgraded', () => {
  withBundle(
    {
      complete: '{"kind":"private-studio-export-bundle","version":2}\n',
      members: ['asset.kdna'],
    },
    (directory) => {
      fs.writeFileSync(path.join(directory, 'creation-evidence.json'), '{"format":"kdna.studio-creation-evidence/unsupported"}\n');
      fs.writeFileSync(path.join(directory, 'binding.json'), '{}\n');
      for (const command of ['verify', 'read']) {
        const args = [command, '--bundle', directory, ...(command === 'read' ? ['--allow-read'] : [])];
        const result = run(args);
        assert.equal(result.status, 3, result.stderr);
        assert.equal(JSON.parse(result.stdout).reason, 'STUDIO_EVIDENCE_FORMAT_NOT_CURRENT');
      }
    },
  );
});
