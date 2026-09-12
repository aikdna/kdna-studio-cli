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
// The criterion has one sufficient leg (b): the failure output has to name an
// object the entry declares absent. The fixtures below are the shapes it has to
// tell apart, and all three of the hostile shapes are refused:
//
//   1. `RELOCATION_LOSS_TEST` still passes, and is only moved (`git mv`, no
//      require touched). It turns red under tests/legacy/ because the move broke
//      `../src/live.js`.
//   2. `MIXED_DEPTH_TEST` still passes, and the move rewrites exactly one of its
//      relative requires to the new depth - the shape an independent review
//      reproduced against the previous rule. Both the registered run and the
//      re-run from the original path then die on `Cannot find module` with no
//      assertion executed at all, and the probe is pointed at the broken
//      specifier itself.
//   3. `RED_AT_ORIGINAL_TEST` is red from the path it was retired from with its
//      requires untouched. That is the demoted auxiliary leg (a): the gate
//      reports it as admissible but it never accepts an entry on its own.
//
// `NAMED_OBJECT_TEST` fails with a message that spells out a declared absent
// object, which is the accepting leg (b).

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
const MIXED_DEPTH_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const live = require('../src/live.js');",
  "const moved = require('../../src/live.js');",
  "test('still current behaviour', () => { assert.equal(live.live, true); assert.equal(moved.live, true); });",
  '// c2MixedDepthProbe',
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
      assert.match(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
      assert.match(result.output, /named_object=1 aux_leg_a=0/);
      assert.match(result.output, /criterion=b:failure-names-the-object/);
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

// The three cases below are the retirement criterion itself: two hostile shapes
// that must stay red, and the one shape that is allowed to accept an entry.

test('a still-passing test that is only moved (no require rewritten) is refused', () => {
  const entry = baseEntry();
  // `src/live.js` is named by the probe and it is also the specifier the move
  // broke, so a gate that matched the failure text naively would accept this.
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: 'c2RelocationProbe' }];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': RELOCATION_LOSS_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retirement_red_not_attributed_to_the_declared_object/);
      assert.match(result.output, /named_object=no/);
      assert.match(result.output, /criterion=none/);
      assert.match(result.output, /original_path=tests\/probe.test.js original_rc=0/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a still-passing test whose move rewrote one require is refused', () => {
  const entry = baseEntry();
  // The declared identity is the specifier the un-rewritten require asks for, so
  // the failure text does contain the token - inside a module-resolution
  // specifier, which is exactly what must not count.
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: '../src/live.js' }];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': MIXED_DEPTH_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retirement_red_not_attributed_to_the_declared_object/);
      assert.match(result.output, /named_object=no/);
      assert.match(result.output, /original_path=tests\/probe.test.js original_rc=1/);
      assert.match(result.output, /aux_leg_a=inadmissible/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a file that is red from the path it was retired from is not accepted on its own', () => {
  const entry = baseEntry();
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: 'c2RedAtOriginalProbe' }];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': RED_AT_ORIGINAL_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      // The demoted leg (a) is reported as admissible, and still does not accept:
      // the failure never names an object this entry declares absent.
      assert.match(result.output, /original_path=tests\/probe.test.js original_rc=1/);
      assert.match(result.output, /aux_leg_a=admissible/);
      assert.match(result.output, /criterion=none/);
      assert.match(result.output, /retirement_red_not_attributed_to_the_declared_object/);
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

// Round-4 tightening. Two kinds of naming used to be accepted as the reason for
// a retirement and are not reasons:
//
//   * a *failing test's title* - static text that can name any object at all, so
//     it cannot show that the named object is why the run is red;
//   * a *diagnostic line* - output the judged artifact printed rather than a
//     statement about the failure - which counts only together with the
//     differential contrast that shows it appears because the object is absent.
//
// The last three cases are the diagnostic contract in both directions: the same
// entry with and without the contrast, and a contrast that does not hold.

const TITLE_ONLY_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "test('c2TitleOnlyProbe is gone', () => { assert.equal(1, 2); });",
  '',
].join('\n');
const DIAGNOSTIC_TEST = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live.js'), 'utf8');",
  "if (!source.includes('c2DiagnosticProbe')) {",
  "  process.stdout.write(JSON.stringify({ c2DiagnosticProbe: 'the retired object is absent from the live source' }) + '\\n');",
  "}",
  "test('retired behaviour', () => { assert.equal(source.includes('c2DiagnosticProbe'), true); });",
  '',
].join('\n');
const UNCONDITIONAL_DIAGNOSTIC_TEST = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "process.stdout.write(JSON.stringify({ c2DiagnosticProbe: 'the retired object is absent from the live source' }) + '\\n');",
  "test('retired behaviour', () => { assert.equal(1, 2); });",
  '',
].join('\n');

function diagnosticEntry() {
  const entry = baseEntry();
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: 'c2DiagnosticProbe' }];
  return entry;
}

const DIAGNOSTIC_CONTRAST = {
  identifier: 'c2DiagnosticProbe',
  diagnostic: 'the retired object is absent from the live source',
  present: { kind: 'append_token', path: 'src/live.js', token: 'c2DiagnosticProbe' },
};

test('a reason that only comes from a failing test title is refused', () => {
  const entry = baseEntry();
  entry.object_absence = [{ kind: 'token_absent', path: 'src/live.js', token: 'c2TitleOnlyProbe' }];
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': TITLE_ONLY_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /named_object=no/);
      assert.match(result.output, /criterion=none/);
      assert.match(result.output, /retirement_red_not_attributed_to_the_declared_object/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a diagnostic reason without a differential contrast is refused', () => {
  const entry = diagnosticEntry();
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': DIAGNOSTIC_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /criterion=c:diagnostic-names-the-object/);
      assert.match(result.output, /diagnostic_reason_without_contrast/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a diagnostic reason with a differential contrast that holds is accepted', () => {
  const entry = diagnosticEntry();
  entry.diagnostic_evidence = DIAGNOSTIC_CONTRAST;
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': DIAGNOSTIC_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /criterion=c:diagnostic-names-the-object/);
      assert.match(result.output, /absent_rc=1 absent_diagnostic=true/);
      assert.match(result.output, /present_rc=0 present_diagnostic=false/);
      assert.match(result.output, /verdict=holds/);
      assert.match(result.output, /diagnostic_contrast=1/);
    },
  );
});

test('a diagnostic reason whose contrast does not hold is refused', () => {
  const entry = diagnosticEntry();
  entry.diagnostic_evidence = DIAGNOSTIC_CONTRAST;
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': UNCONDITIONAL_DIAGNOSTIC_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /diagnostic_contrast_failed/);
      assert.match(result.output, /verdict=fails/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});
