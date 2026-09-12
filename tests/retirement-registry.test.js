'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A retirement is a preservation claim, and these cases keep the gate that
// checks it honest. The gate reads no test output, so nothing here can be
// defeated by a title, a console.log, a stack frame or a specifier the move
// rewrote. Each shape is decided from files and hashes alone:
//
//   1. a registry that agrees with the committed files -> green;
//   2. delete a registered file                        -> refused (preserved);
//   3. change one byte of a registered file            -> refused (sha256);
//   4. drop an unregistered file into tests/legacy/    -> refused (complete);
//   5. register a file that is still running           -> refused (not a fake
//      retirement: the original path still carries the registered bytes);
//   6. put a registered file's bytes back at the original path and they pass
//                                                      -> named as
//      KDNA-RETIREMENT-RESTORABLE, without failing the gate.
//
// The last two cases also carry the entry guard: a clean copy of the gate runs
// and prints its success line, and so does an invocation through an absolute
// symlink - neither may be a silent no-op that exits 0.

const root = path.resolve(__dirname, '..');
const verifier = path.join(root, 'scripts', 'verify-retirement-registry.js');

const RED_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "test('retired behaviour', () => { assert.equal(1, 2); });",
  '',
].join('\n');
const GREEN_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "test('still current behaviour', () => { assert.equal(1, 1); });",
  '',
].join('\n');
// Passes from tests/ (the original path), fails from tests/legacy/ (the retired
// path): exactly the shape a plain `git mv` produces, and the one the gate has
// to name rather than retire.
const BROKEN_AT_LEGACY_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const live = require('../src/live.js');",
  "test('still current behaviour', () => { assert.equal(live.live, true); });",
  '',
].join('\n');

function digest(text) {
  return crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
}

function entryFor(file, text, overrides = {}) {
  return {
    file,
    original_path: `tests/${file.slice('tests/legacy/'.length)}`,
    sha256: digest(text),
    retired_object: 'probe retired object',
    reason: 'synthetic',
    retired_on: '2026-09-12',
    review_reference: 'review:synthetic',
    ...overrides,
  };
}

function sandbox({ registry, files, withGate = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retirement-registry-'));
  fs.mkdirSync(path.join(dir, 'tests', 'legacy'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'live.js'), "'use strict';\nmodule.exports = { live: true };\n");
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'probe', files: ['src/live.js'] }, null, 2)}\n`);
  if (withGate) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(verifier, path.join(dir, 'scripts', 'verify-retirement-registry.js'));
  }
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), contents);
  }
  fs.writeFileSync(
    path.join(dir, 'tests', 'retired.json'),
    `${JSON.stringify({ schema: 'kdna.retired-test-registry', schema_version: '2.0.0', entries: registry }, null, 2)}\n`,
  );
  return dir;
}

function runVerifier(dir, { script = verifier, cwd } = {}) {
  const result = spawnSync(process.execPath, [script, '--root', dir], { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function withSandbox(options, body) {
  const dir = sandbox(options);
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a registry that agrees with the committed files is green', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
      assert.match(result.output, /entries=1 legacy=1 preserved=1 restorable=0/);
      assert.match(result.output, /preserved=true original_carries_same_bytes=false/);
      assert.match(result.output, /reeval=fails rc=1/);
    },
  );
});

test('deleting a registered file is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: {} }, (dir) => {
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /registered_file_missing/);
    assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
  });
});

test('changing one byte of a registered file is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  const changed = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 3)');
  withSandbox({ registry: [entry], files: { 'tests/legacy/probe.test.js': changed } }, (dir) => {
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /preserved_bytes_changed/);
    assert.match(result.output, /preserved=false/);
    assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
  });
});

test('an unregistered file under tests/legacy/ is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox(
    {
      registry: [entry],
      files: { 'tests/legacy/probe.test.js': RED_TEST, 'tests/legacy/unregistered.test.js': RED_TEST },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /legacy_file_not_registered/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a retirement that is a duplicate of a running test is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox(
    {
      registry: [entry],
      files: { 'tests/legacy/probe.test.js': RED_TEST, 'tests/probe.test.js': RED_TEST },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retirement_is_a_duplicate_of_a_running_test/);
      assert.match(result.output, /original_carries_same_bytes=true/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('registered bytes that pass at the original path are named, not accepted silently', () => {
  const entry = entryFor('tests/legacy/probe.test.js', BROKEN_AT_LEGACY_TEST);
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': BROKEN_AT_LEGACY_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      // (d) is a receipt, not a verdict: the entry is named and the gate stays green.
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /KDNA-RETIREMENT-RESTORABLE: tests\/legacy\/probe\.test\.js/);
      assert.match(result.output, /reeval=passes rc=0/);
      assert.match(result.output, /restorable=1/);
    },
  );
});

test('a registration missing any of the six fields is refused', () => {
  for (const field of ['file', 'original_path', 'sha256', 'reason', 'retired_on', 'review_reference']) {
    const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
    delete entry[field];
    withSandbox(
      { registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } },
      (dir) => {
        const result = runVerifier(dir);
        assert.equal(result.status, 1, `${field}: ${result.output}`);
        assert.match(result.output, new RegExp(`missing_${field}`, 'u'));
      },
    );
  }
});

test('a registration whose original path is the retired path is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST, { original_path: 'tests/legacy/probe.test.js' });
  withSandbox({ registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } }, (dir) => {
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /original_path_inside_legacy/);
    assert.match(result.output, /original_path_is_the_retired_path/);
  });
});

test('a duplicate registration is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox(
    { registry: [entry, { ...entry }], files: { 'tests/legacy/probe.test.js': RED_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /duplicate_registration/);
    },
  );
});

test('a clean copy of the gate really runs and prints its success line', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox(
    {
      registry: [entry],
      files: { 'tests/legacy/probe.test.js': RED_TEST },
      withGate: true,
    },
    (dir) => {
      const script = path.join(dir, 'scripts', 'verify-retirement-registry.js');
      const result = runVerifier(dir, { script, cwd: dir });
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
      assert.match(result.output, /entries=1 legacy=1 preserved=1/);
    },
  );
});

test('the gate still runs through an absolute symlinked invocation path', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } }, (dir) => {
    const linkDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retirement-gate-link-'));
    try {
      const link = path.join(linkDirectory, 'gate.js');
      fs.symlinkSync(verifier, link);
      const result = runVerifier(dir, { script: link, cwd: linkDirectory });
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
      assert.match(result.output, /entries=1 legacy=1 preserved=1/);
    } finally {
      fs.rmSync(linkDirectory, { recursive: true, force: true });
    }
  });
});
