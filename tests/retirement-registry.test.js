'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The retirement registry is a claim; these cases keep the gate that checks it
// honest. Every hostile case below used to be silently accepted: a passing test
// could be moved under tests/legacy/ and registered, an unregistered legacy
// file was ignored, and a retired_object declaration was never checked.
//
// The first three fixtures below are the shapes the criterion has to tell
// apart. `RED_TEST` is red everywhere. `RELOCATION_LOSS_TEST` passes on the
// committed graph and only turns red because the move into tests/legacy/ broke
// its relative require - retiring it deletes coverage, so the gate must refuse
// it. `NAMED_OBJECT_TEST` fails with a message that spells out a declared
// absent object, which is the fallback leg (b) of the criterion.

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
const RELOCATION_LOSS_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const live = require('../src/live.js');",
  "test('still current behaviour', () => { assert.equal(live.live, true); });",
  '// c2RelocationProbe',
  '',
].join('\n');
const RED_AT_ORIGINAL_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const live = require('../src/live.js');",
  "test('retired behaviour', () => { assert.equal(live.retiredObject, true); });",
  '// c2RedAtOriginalProbe',
  '',
].join('\n');
const NAMED_OBJECT_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const live = require('../src/live.js');",
  "if (live.live !== true) throw new Error('c2NamedProbe is gone');",
  "test('still current behaviour', () => {});",
  '',
].join('\n');

function baseEntry() {
  return {
    file: 'tests/legacy/probe.test.js',
    retired_object: 'probe retired object',
    reason: 'synthetic',
    observed_on_committed_graph: '0 passing / 1 failing assertion',
    coverage_inherited_by: 'tests/retirement-registry.test.js',
    object_absence: [{ kind: 'token_absent', path: 'src/live.js', token: 'retired' }],
  };
}

function sandbox({ registry, files }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retirement-registry-'));
  fs.mkdirSync(path.join(dir, 'tests', 'legacy'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'live.js'), "'use strict';\nmodule.exports = { live: true };\n");
  fs.writeFileSync(path.join(dir, 'bin', 'probe-cli.js'), "console.log('kdna-studio session --out DIR card');\n");
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'probe', files: ['src/live.js'] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'tests', 'retired.json'), `${JSON.stringify({ schema: 'kdna.retired-test-registry', schema_version: '1.0.0', entries: registry }, null, 2)}\n`);
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), contents);
  }
  return dir;
}

function runVerifier(dir) {
  const result = spawnSync(process.execPath, [verifier, '--root', dir], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

function withSandbox(options, body) {
  const dir = sandbox(options);
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a registry that agrees with the committed graph is green', () => {
  withSandbox(
    { registry: [baseEntry()], files: { 'tests/legacy/probe.test.js': RED_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
      assert.match(result.output, /red_where_retired=1/);
      assert.match(result.output, /criterion=a:red-where-it-lived/);
    },
  );
});

test('retiring a file that still passes is caught', () => {
  withSandbox(
    { registry: [baseEntry()], files: { 'tests/legacy/probe.test.js': GREEN_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retired_file_still_passes/);
    },
  );
});

test('a legacy file that is not registered is caught', () => {
  withSandbox(
    {
      registry: [baseEntry()],
      files: { 'tests/legacy/probe.test.js': RED_TEST, 'tests/legacy/unregistered.test.js': RED_TEST },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /legacy_file_not_registered/);
    },
  );
});

test('a registered file that does not exist is caught', () => {
  withSandbox(
    { registry: [baseEntry()], files: {} },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /registered_file_missing/);
    },
  );
});

test('a registered file outside tests/legacy/ is caught', () => {
  const entry = { ...baseEntry(), file: 'tests/probe.test.js' };
  withSandbox(
    { registry: [entry], files: { 'tests/probe.test.js': RED_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retired_file_outside_legacy/);
    },
  );
});

test('an entry without an object_absence probe is caught', () => {
  const entry = baseEntry();
  delete entry.object_absence;
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /missing_object_absence_probe/);
    },
  );
});

test('a probe whose token does not name the retired file is caught', () => {
  const entry = baseEntry();
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: 'neverMentionedAnywhere' }];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /probe_token_not_anchored/);
    },
  );
});

test('a declared absence that is still present in the live source is caught', () => {
  const entry = baseEntry();
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: 'retiredToken' }];
  withSandbox(
    {
      registry: [entry],
      files: {
        'tests/legacy/probe.test.js': `${RED_TEST}// drives retiredToken\n`,
        'src/live.js': "'use strict';\nmodule.exports = { retiredToken: true };\n",
      },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /declared_absent_token_present/);
    },
  );
});

test('a claimed absence from the packed surface is checked against files[]', () => {
  const entry = baseEntry();
  entry.object_absence = [{ kind: 'not_packed', path: 'src/live.js' }];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': `${RED_TEST}// src/live.js\n` } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /declared_unpacked_path_is_packed/);
    },
  );
});

test('a claimed absence from the shipped command help is checked by running it', () => {
  const entry = baseEntry();
  entry.object_absence = [
    { kind: 'help_excludes', command: ['node', 'bin/probe-cli.js', '--help'], tokens: ['card'] },
  ];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': `${RED_TEST}// card\n` } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /declared_absent_token_present/);
    },
  );
});

// The three cases below are the retirement criterion itself. The first is the
// bypass an independent review reproduced against the previous rule ("red under
// tests/legacy/"), and the other two are the two legs that are allowed to
// accept an entry.

test('a file that only turns red because the move broke its relative require is refused', () => {
  const entry = baseEntry();
  // `src/live.js` is named by the probe and it is also the specifier the move
  // broke, so a gate that matched the failure text naively would accept this.
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: 'c2RelocationProbe' }];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': RELOCATION_LOSS_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retirement_red_only_because_of_the_move/);
      assert.match(result.output, /original_path=tests\/probe.test.js original_rc=0/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a file that is red from the path it was retired from is accepted', () => {
  const entry = baseEntry();
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: 'c2RedAtOriginalProbe' }];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': RED_AT_ORIGINAL_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /original_path=tests\/probe.test.js original_rc=1/);
      assert.match(result.output, /criterion=a:red-where-it-lived/);
    },
  );
});

test('a failure that names the retired object is accepted even where the original path is green', () => {
  const entry = baseEntry();
  entry.object_absence = [{ kind: 'token_absent', path: 'package.json', token: 'c2NamedProbe' }];
  withSandbox(
    {
      registry: [entry],
      files: {
        'tests/legacy/probe.test.js': NAMED_OBJECT_TEST,
        'tests/src/live.js': "'use strict';\nmodule.exports = { live: false };\n",
      },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /original_rc=0/);
      assert.match(result.output, /criterion=b:failure-names-the-object/);
    },
  );
});
