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
// rewrote. Each shape is decided from files, hashes and the object store alone:
//
//   1. a registry that agrees with the committed files -> green;
//   2. delete a registered file                        -> refused (preserved);
//   3. change one byte of a registered file after the move
//                                                      -> refused (sha256);
//   4. drop an unregistered file into tests/legacy/    -> refused (complete);
//   5. register a file that is still running           -> refused (not a fake
//      retirement: the original path still carries the registered bytes);
//   6. put a registered file's bytes back at the original path and they pass
//                                                      -> named as
//      KDNA-RETIREMENT-RESTORABLE, without failing the gate.
//   7. rewrite one byte while moving the file and register the rewritten bytes
//                                                      -> refused (zero rewrite:
//      the registered bytes are not the bytes the original path carried);
//   8. rewrite one byte in a commit of its own and move the file in the next
//      commit                                      -> refused (the retirement
//      would preserve bytes written while the file was still a current test);
//   9. name a commit that is not the parent of the retirement
//                                                      -> refused;
//  10. name a pre-retirement commit that HEAD cannot reach -> refused.
//
// Every shape is built on a real commit history, because (e) derives the
// retirement commit from it: it is the newest commit that removed the path from
// its original location while its parent carried exactly the registered bytes,
// and the entry has to name that commit's parent. The last two cases also carry
// the entry guard: a clean copy of the gate runs and prints its success line,
// and so does an invocation through an absolute symlink - neither may be a
// silent no-op that exits 0.

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

function writeFile(dir, relative, contents) {
  fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
  fs.writeFileSync(path.join(dir, relative), contents);
}

// A real repository, because (e) has to read the retired bytes out of git. The
// identity is passed through the environment rather than taken from whatever
// global config the machine happens to carry.
function git(dir, args) {
  const result = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'probe',
      GIT_AUTHOR_EMAIL: 'probe@example.invalid',
      GIT_COMMITTER_NAME: 'probe',
      GIT_COMMITTER_EMAIL: 'probe@example.invalid',
    },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr ?? result.error}`);
  return result.stdout.trim();
}

function sandbox({
  registry,
  files,
  earlier = null,
  history = null,
  rewrite = null,
  withGate = false,
  fillCommit = true,
  fillCommitFrom = 'pre',
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retirement-registry-'));
  fs.mkdirSync(path.join(dir, 'tests', 'legacy'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'live.js'), "'use strict';\nmodule.exports = { live: true };\n");
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'probe', files: ['src/live.js'] }, null, 2)}\n`);
  if (withGate) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(verifier, path.join(dir, 'scripts', 'verify-retirement-registry.js'));
  }
  // The pre-retirement commit: the bytes each file carried at the path it was
  // retired from. A move that leaves them alone is the shape the gate accepts.
  const before = history ?? {};
  if (history === null) {
    for (const entry of registry) {
      if (typeof entry.file === 'string' && typeof entry.original_path === 'string' && files[entry.file] !== undefined) {
        before[entry.original_path] = files[entry.file];
      }
    }
  }
  if (earlier !== null) {
    for (const [relative, contents] of Object.entries(earlier)) writeFile(dir, relative, contents);
    git(dir, ['init', '--quiet']);
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--message', 'probe: an earlier state of the file']);
  }
  for (const [relative, contents] of Object.entries(before)) writeFile(dir, relative, contents);
  if (earlier === null) git(dir, ['init', '--quiet']);
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--message', 'probe: the file at the path it was retired from']);
  const preRetire = git(dir, ['rev-parse', 'HEAD']);
  if (rewrite !== null) {
    for (const [relative, contents] of Object.entries(rewrite)) writeFile(dir, relative, contents);
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--message', 'probe: rewrite one byte, then move']);
  }
  const rewritten = git(dir, ['rev-parse', 'HEAD']);
  const entries = registry.map((entry) =>
    fillCommit && entry.retired_from_commit === undefined
      ? { ...entry, retired_from_commit: fillCommitFrom === 'rewrite' ? rewritten : preRetire }
      : entry,
  );
  // The move itself: a path the retirement did not leave at its original place
  // is gone from the working tree, exactly as `git mv` would leave it.
  for (const relative of Object.keys(before)) {
    if (files[relative] === undefined) fs.rmSync(path.join(dir, relative), { force: true });
  }
  for (const [relative, contents] of Object.entries(files)) writeFile(dir, relative, contents);
  fs.writeFileSync(
    path.join(dir, 'tests', 'retired.json'),
    `${JSON.stringify({ schema: 'kdna.retired-test-registry', schema_version: '3.0.0', entries }, null, 2)}\n`,
  );
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--message', 'probe: the retirement']);
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
      assert.match(result.output, /entries=1 legacy=1 preserved=1 restorable=0 zero_rewrite=1/);
      assert.match(result.output, /preserved=true original_carries_same_bytes=false/);
      assert.match(result.output, /reeval=fails rc=1/);
      assert.match(result.output, /zero_rewrite=true/);
    },
  );
});

test('deleting a registered file is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: {}, history: { 'tests/probe.test.js': RED_TEST } }, (dir) => {
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /registered_file_missing/);
    assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
  });
});

test('changing one byte of a registered file is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  const changed = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 3)');
  withSandbox(
    {
      registry: [entry],
      files: { 'tests/legacy/probe.test.js': changed },
      history: { 'tests/probe.test.js': RED_TEST },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /preserved_bytes_changed/);
      assert.match(result.output, /preserved=false/);
      // This shape edits the copy after the move, so the registered bytes still
      // are the bytes the original path carried: (a) refuses it, not (e).
      assert.match(result.output, /zero_rewrite=true/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
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

test('a registration missing any of the seven fields is refused', () => {
  const fields = [
    'file',
    'original_path',
    'sha256',
    'retired_from_commit',
    'reason',
    'retired_on',
    'review_reference',
  ];
  for (const field of fields) {
    const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
    delete entry[field];
    withSandbox(
      {
        registry: [entry],
        files: { 'tests/legacy/probe.test.js': RED_TEST },
        fillCommit: field !== 'retired_from_commit',
      },
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

test('a retirement that rewrote one byte on the way into tests/legacy/ is refused', () => {
  // One commit does the move and the edit, which is how a retirement that
  // re-points a relative require is actually written. The registered bytes are
  // then not the bytes the original path carried, and the entry describes a
  // test that never ran.
  const rewritten = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 3)');
  const entry = entryFor('tests/legacy/probe.test.js', rewritten);
  withSandbox(
    {
      registry: [entry],
      files: { 'tests/legacy/probe.test.js': rewritten },
      history: { 'tests/probe.test.js': RED_TEST },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retired_bytes_were_rewritten/);
      assert.match(result.output, /zero_rewrite=false/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a byte rewritten in the commit before the move is refused', () => {
  // The rewrite is its own commit, and the registry names it truthfully: the
  // move that follows changes nothing. The gate still refuses, because the
  // bytes it would preserve were written while the file was a current test.
  const rewritten = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 3)');
  const entry = entryFor('tests/legacy/probe.test.js', rewritten);
  withSandbox(
    {
      registry: [entry],
      history: { 'tests/probe.test.js': RED_TEST },
      rewrite: { 'tests/probe.test.js': rewritten },
      files: { 'tests/legacy/probe.test.js': rewritten },
      fillCommitFrom: 'rewrite',
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retired_bytes_written_immediately_before_the_move/);
      assert.match(result.output, /written_immediately_before_the_move=true/);
      assert.match(result.output, /zero_rewrite=false/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a retired_from_commit that is not the parent of the retirement is refused', () => {
  // An older commit that exists and carries the original path: readable, but not
  // the commit the registered bytes were taken out of the original path by.
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox(
    {
      registry: [entry],
      earlier: { 'tests/probe.test.js': RED_TEST.replace('retired behaviour', 'an earlier state') },
      history: { 'tests/probe.test.js': RED_TEST },
      files: { 'tests/legacy/probe.test.js': RED_TEST },
      fillCommit: false,
    },
    (dir) => {
      const earlierCommit = git(dir, ['rev-list', '--max-parents=0', 'HEAD']);
      assert.notEqual(earlierCommit, git(dir, ['rev-parse', 'HEAD^']));
      // Re-write the registry to name the oldest commit instead of the parent of
      // the retirement, then run the gate over that tree.
      const registryPath = path.join(dir, 'tests', 'retired.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      registry.entries[0].retired_from_commit = earlierCommit;
      fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      git(dir, ['add', '--all']);
      git(dir, ['commit', '--quiet', '--message', 'probe: name the wrong commit']);
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retired_from_commit_is_not_the_retirement_parent/);
      assert.match(result.output, /zero_rewrite=false/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a pre-retirement commit that the head history cannot reach is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } }, (dir) => {
    // The registered bytes still exist in the object store, but no commit under
    // HEAD ever carried them at that path.
    git(dir, ['checkout', '--quiet', '--orphan', 'elsewhere']);
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--message', 'probe: a history that is not the one being retired']);
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /retired_from_commit_not_an_ancestor_of_head/);
    // The bytes are unchanged and readable, but no removal on the history of
    // HEAD ever took them out of the original path, so (e) cannot hold.
    assert.match(result.output, /zero_rewrite=false/);
    assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
  });
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
      assert.match(result.output, /entries=1 legacy=1 preserved=1 restorable=0 zero_rewrite=1/);
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
      assert.match(result.output, /entries=1 legacy=1 preserved=1 restorable=0 zero_rewrite=1/);
    } finally {
      fs.rmSync(linkDirectory, { recursive: true, force: true });
    }
  });
});
