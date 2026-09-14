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
//   7. SHAPE FIVE: rewrite one byte while moving the file, and register the
//      rewritten bytes                                  -> rc=0, and the gate
//      must expose content_changed_in_window>0 and name the entry unsigned. This
//      shape is "expose and sign", never "must be red": no file-and-hash check
//      can judge it;
//   8. rewrite one byte in a commit of its own and move the file in the next
//      commit                                        -> rc=0 and exposed too
//      (the named commit's own write is printed);
//   9. sign that change with review_signature=change-explained and a
//      review_note                                     -> no longer unsigned;
//  10. name a commit whose tree does not carry the file at the original path, or
//      one that is not the parent of the retirement, or one HEAD cannot reach
//                                                      -> refused.
//
// Every shape is built on a real commit history, because (e) reads it: the named
// commit has to carry the file at the original path, and the move is the commit
// whose parent that is. The last two cases also carry the entry guard: a clean
// copy of the gate runs and prints its success line, and so does an invocation
// through an absolute symlink - neither may be a silent no-op that exits 0.

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
  const originalPath = overrides.original_path ?? `tests/${file.slice('tests/legacy/'.length)}`;
  return {
    file,
    original_path: originalPath, // Only the fixture builder sees this literal.
    original_path_sha256: digest(originalPath),
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
  afterMove = null,
  withGate = false,
  fillCommit = true,
  fillCommitFrom = 'pre',
  beforeMove = null,
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
  if (beforeMove !== null) {
    const branch = git(dir, ['branch', '--show-current']);
    if (beforeMove === 'merge') git(dir, ['checkout', '--quiet', '-b', 'probe-side']);
    writeFile(dir, 'unrelated.txt', 'unrelated change\n');
    git(dir, ['add', 'unrelated.txt']);
    git(dir, ['commit', '--quiet', '--message', 'probe: unrelated change']);
    if (beforeMove === 'merge') {
      git(dir, ['checkout', '--quiet', branch]);
      writeFile(dir, 'another.txt', 'another change\n');
      git(dir, ['add', 'another.txt']);
      git(dir, ['commit', '--quiet', '--message', 'probe: another unrelated change']);
      git(dir, ['merge', '--quiet', '--no-ff', 'probe-side', '--message', 'probe: merge before retirement']);
    }
  }
  const latest = git(dir, ['rev-parse', 'HEAD']);
  const entries = registry.map(({ original_path, ...entry }) =>
    fillCommit && entry.retired_from_commit === undefined
      ? { ...entry, retired_from_commit: fillCommitFrom === 'latest' ? latest : fillCommitFrom === 'rewrite' ? rewritten : preRetire }
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
    `${JSON.stringify({ schema: 'kdna.retired-test-registry', schema_version: '4.0.0', entries }, null, 2)}\n`,
  );
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--message', 'probe: the retirement']);
  // Edits that land after the retirement commit: uncommitted working-tree
  // changes, which is how a copy gets edited in place rather than by the move.
  if (afterMove !== null) {
    for (const [relative, contents] of Object.entries(afterMove)) writeFile(dir, relative, contents);
  }
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

function mutateRegistry(dir, mutate) {
  const file = path.join(dir, 'tests', 'retired.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(registry);
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
}

test('a path binding rejects malformed digests and absent paths without falling back to the basename or blob', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  for (const bad of ['not-a-digest', digest('tests/missing/probe.test.js'), digest(RED_TEST)]) {
    withSandbox({ registry: [entry], files: { [entry.file]: RED_TEST } }, (dir) => {
      mutateRegistry(dir, (registry) => { registry.entries[0].original_path_sha256 = bad; });
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /malformed_original_path_sha256|original_path_resolution_failed/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
      assert.doesNotMatch(result.output, /reeval=passes|reeval=fails/);
    });
  }
});

test('a literal path cannot override or supplement a path digest', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: { [entry.file]: RED_TEST } }, (dir) => {
    mutateRegistry(dir, (registry) => { registry.entries[0].original_path = 'tests/other.test.js'; });
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /literal_original_path_not_supported/);
  });
});

test('a path digest resolves Unicode, whitespace and pathspec characters among identical basenames and blobs', () => {
  const original = 'tests/保留 空格/[probe].test.js';
  const other = 'tests/other/[probe].test.js';
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST, { original_path: original });
  withSandbox({
    registry: [entry],
    history: { [original]: RED_TEST, [other]: RED_TEST },
    files: { [entry.file]: RED_TEST, [other]: RED_TEST },
  }, (dir) => {
    const { resolveOriginalPath } = require('../scripts/verify-retirement-registry');
    const commit = JSON.parse(fs.readFileSync(path.join(dir, 'tests/retired.json'))).entries[0].retired_from_commit;
    assert.equal(resolveOriginalPath(dir, commit, digest(original)), original);
    const result = runVerifier(dir);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes(`original_path=${original}`), result.output);
    mutateRegistry(dir, (registry) => { registry.entries[0].original_path_sha256 = digest(other); });
    const duplicate = runVerifier(dir);
    assert.equal(duplicate.status, 1, duplicate.output);
    assert.match(duplicate.output, /retirement_is_a_duplicate_of_a_running_test/);
  });
});

test('a digest cannot turn a non-test path or historical symlink into a replay target', () => {
  const { resolveOriginalPath } = require('../scripts/verify-retirement-registry');
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: { [entry.file]: RED_TEST } }, (dir) => {
    fs.symlinkSync('../src/live.js', path.join(dir, 'tests', 'linked.test.js'));
    git(dir, ['add', 'tests/linked.test.js']);
    git(dir, ['commit', '--quiet', '--message', 'probe: a symlink is not a historical test file']);
    const commit = git(dir, ['rev-parse', 'HEAD']);
    for (const relative of ['src/live.js', 'tests/linked.test.js']) {
      assert.throws(() => resolveOriginalPath(dir, commit, digest(relative)), /unsafe historical test path/);
    }
  });
});

test('a later restoration and second retirement still rejects the superseded commit through the digest binding', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: { [entry.file]: RED_TEST } }, (dir) => {
    writeFile(dir, 'tests/probe.test.js', RED_TEST);
    git(dir, ['add', 'tests/probe.test.js']);
    git(dir, ['commit', '--quiet', '--message', 'probe: restore the original test']);
    fs.rmSync(path.join(dir, 'tests/probe.test.js'));
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--message', 'probe: retire it again']);
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /retired_from_commit_is_not_the_last_appearance/);
  });
});

test('the digest representation requires the matching registry schema', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: { [entry.file]: RED_TEST } }, (dir) => {
    mutateRegistry(dir, (registry) => { registry.schema_version = '3.0.0'; });
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /unsupported_registry_schema/);
  });
});

test('a registry that agrees with the committed files is green', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox(
    { registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
      assert.match(
        result.output,
        /entries=1 legacy=1 preserved=1 restorable=0 retirement_rewrote=0 prior_write=0 content_changed_in_window=0 signed=0 unsigned=0/,
      );
      assert.match(result.output, /preserved=true original_carries_same_bytes=false/);
      assert.match(result.output, /reeval=fails rc=1/);
      assert.match(result.output, /retirement_rewrote_content=false retirement_rewrite_lines=0/);
      assert.match(result.output, /content_changed_in_window=0/);
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
      files: { 'tests/legacy/probe.test.js': RED_TEST },
      history: { 'tests/probe.test.js': RED_TEST },
      afterMove: { 'tests/legacy/probe.test.js': changed },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /preserved_bytes_changed/);
      assert.match(result.output, /preserved=false/);
      // This shape edits the copy after the move, so the registered bytes still
      // are the bytes the move carried: (a) refuses it, and the diff the gate
      // prints for the move itself is empty.
      assert.match(result.output, /content_changed_in_window=0/);
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
    'original_path_sha256',
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

test('shape 05: a retirement that rewrote one byte while moving is exposed and unsigned, not refused', () => {
  // One commit does the move and the edit, which is how a retirement that
  // re-points a relative require is actually written. The gate cannot judge
  // that; it has to put the diff on the record.
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
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /retirement_rewrote_content=true retirement_rewrite_lines=2/);
      assert.match(result.output, /KDNA-RETIREMENT-DIFF: tests\/legacy\/probe\.test\.js/);
      assert.match(result.output, /^\s+-test\('retired behaviour', \(\) => \{ assert\.equal\(1, 2\); \}\);/mu);
      assert.match(result.output, /^\s+\+test\('retired behaviour', \(\) => \{ assert\.equal\(1, 3\); \}\);/mu);
      assert.match(result.output, /KDNA-RETIREMENT-UNSIGNED: tests\/legacy\/probe\.test\.js/);
      assert.match(result.output, /content_changed_in_window=1 signed=0 unsigned=1/);
    },
  );
});

test('shape 06: a rewrite in the commit before the move is exposed, not judged', () => {
  // The rewrite is its own commit, the move that follows changes nothing, and
  // the registry names the rewrite commit truthfully. No history-only rule can
  // refuse this shape, so the gate must not pretend to: it prints the diff and
  // names the entry unsigned for the push gate.
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
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /prior_write_to_the_file=true/);
      assert.match(result.output, /KDNA-RETIREMENT-PRIOR-WRITE: tests\/legacy\/probe\.test\.js/);
      assert.match(result.output, /^\s+-test\('retired behaviour', \(\) => \{ assert\.equal\(1, 2\); \}\);/mu);
      assert.match(result.output, /^\s+\+test\('retired behaviour', \(\) => \{ assert\.equal\(1, 3\); \}\);/mu);
      assert.match(result.output, /KDNA-RETIREMENT-UNSIGNED: tests\/legacy\/probe\.test\.js/);
      assert.match(result.output, /content_changed_in_window=0 signed=0 unsigned=1/);
    },
  );
});

test('a signed content change is no longer named unsigned', () => {
  const rewritten = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 3)');
  const entry = entryFor('tests/legacy/probe.test.js', rewritten, {
    review_signature: 'change-explained',
    review_note: 'the move re-pointed a relative require; the copy was restored to the original bytes',
  });
  withSandbox(
    {
      registry: [entry],
      files: { 'tests/legacy/probe.test.js': rewritten },
      history: { 'tests/probe.test.js': RED_TEST },
    },
    (dir) => {
      const result = runVerifier(dir);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /retirement_rewrote_content=true retirement_rewrite_lines=2/);
      assert.match(result.output, /review_signature=change-explained/);
      assert.match(result.output, /content_changed_in_window=1 signed=1 unsigned=0/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-UNSIGNED:/);
    },
  );
});

test('a retired_from_commit whose tree lacks the original path is refused', () => {
  // The oldest commit predates the file at tests/probe.test.js, so it cannot be
  // the commit the file was retired from.
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox(
    {
      registry: [entry],
      earlier: { 'tests/other.test.js': RED_TEST },
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
      assert.match(result.output, /original_path_resolution_failed/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('a retired_from_commit that is not the parent of the retirement is refused', () => {
  // An older commit that exists and does carry the file: readable, but no move
  // on HEAD has it as its parent, so it is not the retirement.
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
      const registryPath = path.join(dir, 'tests', 'retired.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      registry.entries[0].retired_from_commit = earlierCommit;
      fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      git(dir, ['add', '--all']);
      git(dir, ['commit', '--quiet', '--message', 'probe: name the wrong commit']);
      const result = runVerifier(dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /retired_from_commit_is_not_the_last_appearance/);
      assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
    },
  );
});

test('an entry that cannot be re-run in place says so, and records why', () => {
  // The suite requires a helper that is itself retired material, so its bytes
  // cannot be put back at the original path. That is a recorded fact, not a
  // silent skip, and the entry carries the reason.
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST, {
    reeval_in_place: 'not-possible',
    reeval_note: 'probe: the helper this suite requires is retired material too',
  });
  withSandbox({ registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } }, (dir) => {
    const result = runVerifier(dir);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /reeval=not_possible/);
    assert.match(result.output, /KDNA-RETIREMENT-REEVAL-NOTE: tests\/legacy\/probe\.test\.js/);
    assert.doesNotMatch(result.output, /reeval=fails/);
  });
});

test('an entry that cannot be re-run in place without a reason is refused', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST, { reeval_in_place: 'not-possible' });
  withSandbox({ registry: [entry], files: { 'tests/legacy/probe.test.js': RED_TEST } }, (dir) => {
    const result = runVerifier(dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /missing_reeval_note/);
    assert.doesNotMatch(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
  });
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
    // The bytes are unchanged and readable, but the commit is not on the
    // history of HEAD, so it cannot be the commit the file was retired from.
    assert.match(result.output, /content_changed_in_window=0/);
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
      assert.match(
        result.output,
        /entries=1 legacy=1 preserved=1 restorable=0 retirement_rewrote=0 prior_write=0 content_changed_in_window=0 signed=0 unsigned=0/,
      );
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
      assert.match(
        result.output,
        /entries=1 legacy=1 preserved=1 restorable=0 retirement_rewrote=0 prior_write=0 content_changed_in_window=0 signed=0 unsigned=0/,
      );
    } finally {
      fs.rmSync(linkDirectory, { recursive: true, force: true });
    }
  });
});


test('last appearance includes unrelated commits and merge trees', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  for (const beforeMove of ['unrelated', 'merge']) {
    for (const fillCommitFrom of ['latest', 'pre']) {
      withSandbox({registry: [entry], files: {[entry.file]: RED_TEST}, beforeMove, fillCommitFrom}, (dir) => {
        const result = runVerifier(dir);
        assert.equal(result.status, fillCommitFrom === 'latest' ? 0 : 1, `${beforeMove}/${fillCommitFrom}: ${result.output}`);
        if (fillCommitFrom === 'latest') assert.match(result.output, /KDNA-RETIREMENT-REGISTRY: ok/);
        else assert.match(result.output, /retired_from_commit_is_not_the_last_appearance/);
      });
    }
  }
});

function retirementResult(dir) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retirement-result-'));
  const file = path.join(output, 'result.json');
  try {
    const result = spawnSync(process.execPath, ['-e',
      "require(process.argv[1]).verify(process.argv[2]).then(result => require('node:fs').writeFileSync(process.argv[3], JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });",
      verifier, dir, file,
    ], { encoding: 'utf8', maxBuffer: 1 << 24 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

function commitRetiredBytes(dir, file, text, message) {
  writeFile(dir, file, text);
  mutateRegistry(dir, (registry) => { registry.entries[0].sha256 = digest(text); });
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--message', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('a same-tree merge preserves every retirement field, including files introduced only on the merged branch', () => {
  const moved = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 3)');
  const later = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 4)');
  const entry = entryFor('tests/legacy/probe.test.js', moved);
  for (const presentAtBase of [false, true]) {
    withSandbox({
      registry: [entry], files: { [entry.file]: moved },
      history: { [entry.original_path]: RED_TEST },
      earlier: { 'base.txt': 'base\n' },
    }, (dir) => {
      const first = git(dir, ['rev-parse', 'HEAD']);
      const pre = git(dir, ['rev-parse', 'HEAD^']);
      const base = git(dir, ['rev-parse', presentAtBase ? pre : `${pre}^`]);
      const laterCommit = commitRetiredBytes(dir, entry.file, later, 'probe: later content edit');
      const before = retirementResult(dir);
      assert.deepEqual(before.findings, []);
      assert.equal(before.rows[0].firstRetirement, first);
      assert.equal(before.rows[0].retirementRewroteContent, true);
      assert.equal(before.rows[0].retirementRewriteLines, 2);
      assert.equal(before.rows[0].changedInWindow, 2);
      assert.deepEqual(before.rows[0].windowCommits, [{ commit: laterCommit, subject: 'probe: later content edit' }]);
      assert.equal(before.rows[0].signed, false);
      const tree = git(dir, ['rev-parse', 'HEAD^{tree}']);
      git(dir, ['branch', 'probe-retirement']);
      git(dir, ['checkout', '--quiet', '-b', 'probe-main', base]);
      git(dir, ['merge', '--quiet', '--no-ff', 'probe-retirement', '--message', 'probe: publish retirement']);
      assert.equal(git(dir, ['rev-parse', 'HEAD^{tree}']), tree);
      assert.equal(git(dir, ['show', '-s', '--format=%P', 'HEAD']).split(' ').length, 2);
      const after = retirementResult(dir);
      assert.deepEqual(after.findings, []);
      assert.deepEqual(after.rows, before.rows);
      assert.equal(runVerifier(dir).status, 0);
    });
  }
});

test('the window retains edits on both merge branches and counts only a new resolution once', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  for (const newResolution of [false, true]) {
    withSandbox({ registry: [entry], files: { [entry.file]: RED_TEST } }, (dir) => {
      const first = git(dir, ['rev-parse', 'HEAD']);
      const originalBranch = git(dir, ['branch', '--show-current']);
      git(dir, ['checkout', '--quiet', '-b', 'probe-side']);
      const side = commitRetiredBytes(dir, entry.file, `${RED_TEST}// side\n`, 'probe: side content edit');
      git(dir, ['checkout', '--quiet', originalBranch]);
      const main = commitRetiredBytes(dir, entry.file, `${RED_TEST}// main\n`, 'probe: main content edit');
      git(dir, ['merge', '--quiet', '--no-ff', '--no-commit', '-s', 'ours', 'probe-side']);
      if (newResolution) {
        writeFile(dir, entry.file, `${RED_TEST}// resolution\n`);
        mutateRegistry(dir, (registry) => { registry.entries[0].sha256 = digest(`${RED_TEST}// resolution\n`); });
        git(dir, ['add', '--all']);
      }
      git(dir, ['commit', '--quiet', '--message', 'probe: merge content']);
      const merged = git(dir, ['rev-parse', 'HEAD']);
      const result = retirementResult(dir);
      assert.deepEqual(result.findings, []);
      const row = result.rows[0];
      assert.equal(row.firstRetirement, first);
      assert.equal(row.retirementRewroteContent, false);
      assert.equal(row.changedInWindow, newResolution ? 3 : 2);
      assert.deepEqual(new Set(row.windowCommits.map(({ commit }) => commit)), new Set(newResolution ? [main, side, merged] : [main, side]));
      assert.equal(row.windowCommits.filter(({ commit }) => commit === merged).length, newResolution ? 1 : 0);
      assert.equal(row.signed, false);
    });
  }
});

test('a first retirement in a merge exposes a rewrite against a later parent', () => {
  const moved = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 3)');
  const entry = entryFor('tests/legacy/probe.test.js', moved);
  withSandbox({
    registry: [entry], files: { [entry.file]: moved },
    history: { [entry.original_path]: RED_TEST }, earlier: { 'base.txt': 'base\n' },
  }, (dir) => {
    const registry = fs.readFileSync(path.join(dir, 'tests/retired.json'));
    const pre = git(dir, ['rev-parse', 'HEAD^']);
    git(dir, ['checkout', '--quiet', '-b', 'probe-main', `${pre}^`]);
    git(dir, ['merge', '--quiet', '--no-ff', '--no-commit', '-s', 'ours', pre]);
    writeFile(dir, entry.file, moved);
    writeFile(dir, 'tests/retired.json', registry);
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--message', 'probe: retire in merge']);
    const merge = git(dir, ['rev-parse', 'HEAD']);
    const result = retirementResult(dir);
    assert.deepEqual(result.findings, []);
    const row = result.rows[0];
    assert.equal(row.firstRetirement, merge);
    assert.equal(row.lastAppearance, pre);
    assert.equal(row.retirementRewroteContent, true);
    assert.equal(row.changedInWindow, 1);
    assert.equal(row.retirementRewriteLines, 2);
    assert.equal(row.retirementRewriteDiff[0], `--- ${merge.slice(0, 12)}^2:${entry.original_path}`);
    assert.equal(row.signed, false);
  });
});

test('a merge retirement compares every original-bearing parent even when its first parent already matches', () => {
  const moved = RED_TEST.replace('assert.equal(1, 2)', 'assert.equal(1, 3)');
  const entry = entryFor('tests/legacy/probe.test.js', moved);
  withSandbox({
    registry: [entry], files: { [entry.file]: moved },
    history: { [entry.original_path]: RED_TEST }, earlier: { 'base.txt': 'base\n' },
  }, (dir) => {
    const registry = fs.readFileSync(path.join(dir, 'tests/retired.json'));
    const side = git(dir, ['rev-parse', 'HEAD^']);
    git(dir, ['checkout', '--quiet', '-b', 'probe-main', `${side}^`]);
    writeFile(dir, entry.original_path, moved);
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--message', 'probe: first-parent original']);
    git(dir, ['merge', '--quiet', '--no-ff', '--no-commit', '-s', 'ours', side]);
    fs.rmSync(path.join(dir, entry.original_path));
    writeFile(dir, entry.file, moved);
    writeFile(dir, 'tests/retired.json', registry);
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--message', 'probe: retire both originals in merge']);
    const merge = git(dir, ['rev-parse', 'HEAD']);
    const last = git(dir, ['rev-list', '--topo-order', 'HEAD']).split('\n').find((commit) =>
      spawnSync('git', ['-C', dir, 'cat-file', '-e', `${commit}:${entry.original_path}`]).status === 0,
    );
    mutateRegistry(dir, (current) => { current.entries[0].retired_from_commit = last; });
    const result = retirementResult(dir);
    assert.deepEqual(result.findings, []);
    assert.equal(result.rows[0].firstRetirement, merge);
    assert.equal(result.rows[0].retirementRewroteContent, true);
    assert.equal(result.rows[0].retirementRewriteLines, 2);
    assert.equal(result.rows[0].retirementRewriteDiff[0], `--- ${merge.slice(0, 12)}^2:${entry.original_path}`);
  });
});

test('the retirement window preserves mode-only modifications even when the bytes return unchanged', () => {
  const entry = entryFor('tests/legacy/probe.test.js', RED_TEST);
  withSandbox({ registry: [entry], files: { [entry.file]: RED_TEST } }, (dir) => {
    git(dir, ['config', 'core.filemode', 'true']);
    const first = git(dir, ['rev-parse', 'HEAD']);
    const changes = [];
    for (const mode of [0o755, 0o644]) {
      fs.chmodSync(path.join(dir, entry.file), mode);
      git(dir, ['add', '--all']);
      git(dir, ['commit', '--quiet', '--message', 'probe: change preserved mode']);
      changes.push(git(dir, ['rev-parse', 'HEAD']));
    }
    const result = retirementResult(dir);
    assert.deepEqual(result.findings, []);
    assert.equal(result.rows[0].firstRetirement, first);
    assert.equal(result.rows[0].retirementRewroteContent, false);
    assert.equal(result.rows[0].changedInWindow, 2);
    assert.deepEqual(result.rows[0].windowCommits.map(({ commit }) => commit), changes.reverse());
    assert.equal(result.rows[0].signed, false);
  });
});
