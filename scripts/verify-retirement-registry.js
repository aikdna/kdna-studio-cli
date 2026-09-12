#!/usr/bin/env node
'use strict';

// Independent gate over tests/retired.json.
//
// A retirement is a *preservation* claim, not a story about a red run. Every
// earlier revision of this gate tried to read a test's output and decide whether
// the run failed *because* the retired object is gone. That is not decidable
// from the judged artifact's own output: a failing test's title, a console.log
// the test itself prints, a stack frame naming its own file, a specifier the
// move rewrote - each one can be made to name any object at all, and each one
// was in turn accepted as "proof". The gate therefore reads no test output. It
// checks files, hashes and the object store, plus one run that is a receipt
// rather than a verdict.
//
// retirement = preservation + registration + zero rewrite. The gate checks five
// things:
//
//   (a) preserved: the registered file exists at its registered location and its
//       sha256 is the registered sha256, so a retirement can never quietly
//       delete or rewrite the bytes it claims to keep;
//   (b) complete: every file under tests/legacy/ is registered, so nothing can
//       be dropped into the retired directory without a receipt;
//   (c) not a fake retirement: the original path does not still carry the
//       registered bytes, so the file really is out of the current surface
//       instead of being registered while it keeps running;
//   (d) re-evaluable: the registered bytes are put back at the original path and
//       run. If that run passes, the file was not stale at all and the gate names
//       the entry so it can be restored or its reason rewritten. (d) is a
//       receipt, never an acceptance condition: the exit code is about (a)-(c)
//       and (e).
//   (e) zero rewrite: the registered sha256 is the sha256 of the bytes the file
//       carried at its original path in the commit before the retirement, read
//       from the object store rather than from the working tree, so a later edit
//       to the copy under tests/legacy/ cannot make the claim true. A move that
//       rewrote even one of the file's own requires - to the new depth, say -
//       registers bytes that are not the test that was there, and the record
//       would then describe a test that never ran. Such an entry is refused, and
//       the disposition is to put the pre-retirement bytes back under
//       tests/legacy/: a file that would only retire after being adapted is not
//       retired at all.
//
//       "The commit before the retirement" is pinned by the gate, not by the
//       entry. The retirement commit is derived: it is the newest commit on
//       HEAD's history that removes the path from its original location
//       (`--no-renames --diff-filter=D`) *while its parent carries exactly the
//       registered bytes*. The entry has to name that commit's parent verbatim,
//       so a commit cannot be picked by hand - older, newer, or from another
//       branch - to make rewritten bytes look original. And the named commit
//       must not itself be the commit that wrote those bytes: a rewrite in the
//       commit immediately before the move ("rewrite one byte, then move it")
//       is refused, because the bytes the retirement keeps were written while
//       the file was still a current test.
//
// Every entry carries the seven registration fields: the retired path (`file`),
// the `original_path` it was retired from, the `sha256` of the preserved bytes
// (the retirement's `retired_sha256`), the `retired_from_commit` those bytes are
// claimed to come from, a free-text `reason`, the registration date `retired_on`,
// and a `review_reference` that says who accepted the retirement.
//
// usage: node scripts/verify-retirement-registry.js [--root <tree>]

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CONCURRENCY = 4;
const LEGACY_PREFIX = 'tests/legacy/';
const SHA256_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const REQUIRED_FIELDS = [
  'file',
  'original_path',
  'sha256',
  'retired_from_commit',
  'reason',
  'retired_on',
  'review_reference',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// (e) reads the retired bytes from the object store. `spawnSync` is used with an
// argument vector and no shell, and the commit is matched against COMMIT_RE
// before it reaches git, so a registry field cannot turn into an option or a
// command.
function gitBytes(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { maxBuffer: 1 << 28 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr.toString('utf8').trim()}`);
  }
  return result.stdout;
}

// The blob the entry claims to preserve: <commit>:<original_path> resolved to an
// object name, then the bytes of that object, hashed here rather than compared
// through a git-provided digest.
function historicalSha256(root, commit, originalPath) {
  const blob = gitBytes(root, ['rev-parse', '--verify', '--quiet', `${commit}:${originalPath}`])
    .toString('utf8')
    .trim();
  return crypto.createHash('sha256').update(gitBytes(root, ['cat-file', 'blob', blob])).digest('hex');
}

// The object name a path carries in a tree, or null when the tree does not have
// it. `rev-parse --verify --quiet` exits non-zero for a missing path, which is
// the answer rather than an error here.
function blobAt(root, commit, relative) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${commit}:${relative}`], {
    maxBuffer: 1 << 20,
  });
  if (result.status !== 0) return null;
  return result.stdout.toString('utf8').trim();
}

function sha256OfBlob(root, blob) {
  return crypto.createHash('sha256').update(gitBytes(root, ['cat-file', 'blob', blob])).digest('hex');
}

function parentOf(root, commit) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${commit}^`], { maxBuffer: 1 << 20 });
  if (result.status !== 0) return null;
  return result.stdout.toString('utf8').trim();
}

// Every commit on HEAD's history that removed the path from its original
// location, newest first. `--no-renames` makes a `git mv` count as a removal of
// the old path rather than as a rename.
function removalCandidates(root, originalPath) {
  const output = gitBytes(root, ['log', '--no-renames', '--diff-filter=D', '--format=%H', '--', originalPath])
    .toString('utf8')
    .trim();
  return output === '' ? [] : output.split('\n');
}

// A commit that is not on the history of HEAD cannot describe the tree being
// retired, so the entry is refused as well.
function ancestorOfHead(root, commit) {
  const result = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

// (d): run the registered bytes from the path they were retired from. The
// overlay's top level and its tests/ siblings are the committed tree, so every
// relative require resolves the way it did before the move while the committed
// bytes stay untouched.
function linkTestsTree(sourceDir, targetDir, root, relative, source) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const item of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, item.name);
    const to = path.join(targetDir, item.name);
    const itemRelative = path.relative(root, from);
    if (itemRelative === relative) {
      fs.copyFileSync(source, to);
      continue;
    }
    if (item.isDirectory() && relative.startsWith(`${itemRelative}${path.sep}`)) {
      linkTestsTree(from, to, root, relative, source);
      continue;
    }
    fs.symlinkSync(from, to);
  }
}

function overlayAtOriginalPath(root, relative, source) {
  const overlay = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kdna-retirement-original-'));
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.name === 'tests') continue;
    fs.symlinkSync(path.join(root, item.name), path.join(overlay, item.name));
  }
  linkTestsTree(path.join(root, 'tests'), path.join(overlay, 'tests'), root, relative, source);
  const target = path.join(overlay, relative);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return overlay;
}

// `spawnSync` would block the event loop and serialise the pool, which is why
// this uses an asynchronous child process. NODE_TEST_CONTEXT would make the
// grandchild behave as part of the calling test runner instead of printing its
// own summary, so it is dropped.
function runTestFile(cwd, file) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, NODE_TEST_CONTEXT: undefined };
    const child = spawn(process.execPath, ['--test', file], { cwd, env: environment });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ file, cwd, status, output }));
  });
}

function runWithConcurrency(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  return new Promise((resolve) => {
    let active = 0;
    const pump = () => {
      while (active < limit && next < items.length) {
        const index = next++;
        active += 1;
        Promise.resolve(worker(items[index]))
          .then((value) => { results[index] = value; })
          .finally(() => { active -= 1; if (next >= items.length && active === 0) resolve(results); else pump(); });
      }
      if (items.length === 0) resolve(results);
    };
    pump();
  });
}

function fieldFindings(entry) {
  const findings = [];
  const file = typeof entry.file === 'string' ? entry.file : String(entry.file);
  for (const field of REQUIRED_FIELDS) {
    const value = entry[field];
    if (typeof value !== 'string' || value.length === 0) {
      findings.push({ file, check: `missing_${field}`, detail: `entry does not register a ${field}` });
    }
  }
  if (typeof entry.sha256 === 'string' && !SHA256_RE.test(entry.sha256)) {
    findings.push({ file, check: 'malformed_sha256', detail: entry.sha256 });
  }
  if (typeof entry.retired_from_commit === 'string' && !COMMIT_RE.test(entry.retired_from_commit)) {
    findings.push({ file, check: 'malformed_retired_from_commit', detail: entry.retired_from_commit });
  }
  if (typeof entry.retired_on === 'string' && !DATE_RE.test(entry.retired_on)) {
    findings.push({ file, check: 'malformed_retired_on', detail: entry.retired_on });
  }
  if (typeof entry.original_path === 'string') {
    if (entry.original_path.startsWith('tests/legacy')) {
      findings.push({ file, check: 'original_path_inside_legacy', detail: entry.original_path });
    }
    if (entry.original_path === entry.file) {
      findings.push({ file, check: 'original_path_is_the_retired_path', detail: entry.original_path });
    }
  }
  return findings;
}

async function verify(root) {
  const findings = [];
  const registry = readJson(path.join(root, 'tests', 'retired.json'));
  const entries = registry.entries ?? [];
  const legacyRoot = path.join(root, 'tests', 'legacy');
  const legacyFiles = walk(legacyRoot).map((file) => path.relative(root, file).split(path.sep).join('/'));
  const registered = entries.filter((entry) => typeof entry.file === 'string').map((entry) => entry.file);

  for (const entry of entries) findings.push(...fieldFindings(entry));
  for (const file of new Set(registered)) {
    if (registered.filter((candidate) => candidate === file).length > 1) {
      findings.push({ file, check: 'duplicate_registration' });
    }
  }
  // (b) completeness, in both directions.
  for (const file of legacyFiles) {
    if (!registered.includes(file)) findings.push({ file, check: 'legacy_file_not_registered' });
  }
  for (const file of registered) {
    if (!legacyFiles.includes(file)) findings.push({ file, check: 'registered_file_missing' });
  }

  const rows = await runWithConcurrency(
    entries.filter((entry) => typeof entry.file === 'string' && legacyFiles.includes(entry.file)),
    async (entry) => {
      const row = { entry, file: entry.file };
      const target = path.join(root, entry.file);
      // (a) preservation.
      row.actualSha256 = SHA256_RE.test(entry.sha256 ?? '') ? sha256(target) : null;
      row.preserved = row.actualSha256 !== null && row.actualSha256 === entry.sha256;
      // (c) not a fake retirement.
      const original = typeof entry.original_path === 'string' ? path.join(root, entry.original_path) : null;
      row.originalExists = original !== null && fs.existsSync(original);
      row.originalSameBytes = row.originalExists && sha256(original) === entry.sha256;
      // (e) zero rewrite, from the object store rather than the working tree.
      row.retiredFromCommit = typeof entry.retired_from_commit === 'string' ? entry.retired_from_commit : null;
      row.historicalSha256 = null;
      row.historicalError = null;
      row.zeroRewrite = null;
      row.ancestorOfHead = null;
      const commitIsUsable = row.retiredFromCommit !== null && COMMIT_RE.test(row.retiredFromCommit);
      const pathIsUsable =
        typeof entry.original_path === 'string' &&
        entry.original_path.length > 0 &&
        !entry.original_path.startsWith('-');
      if (commitIsUsable && pathIsUsable) {
        try {
          row.historicalSha256 = historicalSha256(root, row.retiredFromCommit, entry.original_path);
        } catch (error) {
          row.historicalError = error.message;
        }
        row.ancestorOfHead = ancestorOfHead(root, row.retiredFromCommit);
      }
      // (e) pinned: the entry has to name the parent of a retirement that took
      // exactly these bytes out of the original path. The retirement commits are
      // derived from history, so a commit cannot be picked by hand; and the named
      // commit must not itself be the commit that wrote the bytes.
      row.retirementCommit = null;
      row.retirementParent = null;
      row.derivedHistoricalSha256 = null;
      row.derivedHistoricalError = null;
      row.derivedHistoricalErrorKind = null;
      row.writtenImmediatelyBefore = null;
      if (pathIsUsable && SHA256_RE.test(entry.sha256 ?? '')) {
        try {
          const removals = removalCandidates(root, entry.original_path);
          if (removals.length === 0) {
            row.derivedHistoricalError = `no commit on the history of HEAD removes ${entry.original_path}`;
            row.derivedHistoricalErrorKind = 'no-removal';
          }
          let namedCommitIsARetirementParent = false;
          for (const removal of removals) {
            if (parentOf(root, removal) !== row.retiredFromCommit) continue;
            namedCommitIsARetirementParent = true;
            const parentBlob = blobAt(root, `${removal}^`, entry.original_path);
            if (parentBlob === null) continue;
            const parentSha256 = sha256OfBlob(root, parentBlob);
            if (parentSha256 !== entry.sha256) {
              row.namedCommitSha256 = parentSha256;
              continue;
            }
            row.retirementCommit = removal;
            row.retirementParent = row.retiredFromCommit;
            row.derivedHistoricalSha256 = parentSha256;
            const earlierBlob = blobAt(root, `${removal}^^`, entry.original_path);
            row.writtenImmediatelyBefore = earlierBlob !== null && earlierBlob !== parentBlob;
            break;
          }
          if (row.retirementCommit === null && row.derivedHistoricalError === null) {
            if (namedCommitIsARetirementParent) {
              row.derivedHistoricalError =
                `the retirement changed the file: ${entry.retired_from_commit}:${entry.original_path} carries ` +
                `${row.namedCommitSha256 ?? '(absent)'}, not the registered bytes`;
              row.derivedHistoricalErrorKind = 'rewritten';
            } else {
              row.derivedHistoricalError =
                `${entry.retired_from_commit} is not the parent of a commit on HEAD that removed ` +
                `${entry.original_path} (removals: ${removals.map((commit) => commit.slice(0, 12)).join(', ')})`;
              row.derivedHistoricalErrorKind = 'not-a-retirement-parent';
            }
          }
          row.zeroRewrite = row.derivedHistoricalSha256 !== null && row.writtenImmediatelyBefore !== true;
        } catch (error) {
          row.derivedHistoricalError = error.message;
          row.derivedHistoricalErrorKind = 'unreadable';
        }
      }
      // (d) re-evaluable receipt.
      row.reeval = 'skipped';
      if (original !== null && typeof entry.original_path === 'string' && entry.original_path.startsWith('tests/')) {
        const overlay = overlayAtOriginalPath(root, entry.original_path, target);
        try {
          const run = await runTestFile(overlay, entry.original_path);
          row.reeval = run.status === 0 ? 'passes' : 'fails';
          row.reevalRc = run.status;
        } finally {
          fs.rmSync(overlay, { recursive: true, force: true });
        }
      }
      return row;
    },
    CONCURRENCY,
  );

  for (const row of rows) {
    const { entry } = row;
    if (row.actualSha256 !== null && !row.preserved) {
      findings.push({
        file: entry.file,
        check: 'preserved_bytes_changed',
        detail: `registered sha256 ${entry.sha256} but the file at ${entry.file} is ${row.actualSha256}`,
      });
    }
    if (row.originalSameBytes) {
      findings.push({
        file: entry.file,
        check: 'retirement_is_a_duplicate_of_a_running_test',
        detail: `${entry.original_path} still carries the registered bytes, so the file still runs as a current test`,
      });
    }
    if (row.historicalError !== null) {
      findings.push({
        file: entry.file,
        check: 'retired_from_commit_unreadable',
        detail: `${entry.retired_from_commit}:${entry.original_path ?? 'MISSING'}: ${row.historicalError}`,
      });
    }
    if (row.ancestorOfHead === false) {
      findings.push({
        file: entry.file,
        check: 'retired_from_commit_not_an_ancestor_of_head',
        detail: entry.retired_from_commit,
      });
    }
    if (row.derivedHistoricalError !== null) {
      const check =
        row.derivedHistoricalErrorKind === 'rewritten'
          ? 'retired_bytes_were_rewritten'
          : row.derivedHistoricalErrorKind === 'unreadable'
            ? 'retirement_history_unreadable'
            : 'retired_from_commit_is_not_the_retirement_parent';
      findings.push({
        file: entry.file,
        check,
        detail: `registered sha256 ${entry.sha256}: ${row.derivedHistoricalError}`,
      });
    }
    if (row.writtenImmediatelyBefore === true) {
      findings.push({
        file: entry.file,
        check: 'retired_bytes_written_immediately_before_the_move',
        detail:
          `the bytes come from ${row.retirementParent}, a commit that wrote them: the parent of that commit ` +
          `carried different bytes at ${entry.original_path}, so the file was still a current test when they ` +
          `were written, and the move followed a write`,
      });
    }
    console.log(
      `KDNA-RETIREMENT-ENTRY: ${entry.file} original_path=${entry.original_path ?? 'MISSING'} ` +
        `sha256=${typeof entry.sha256 === 'string' ? entry.sha256.slice(0, 12) : 'MISSING'} ` +
        `preserved=${row.preserved} original_carries_same_bytes=${row.originalSameBytes} ` +
        `retired_on=${entry.retired_on ?? 'MISSING'} review_reference=${JSON.stringify(entry.review_reference ?? '')} ` +
        `reeval=${row.reeval}${row.reevalRc === undefined ? '' : ` rc=${row.reevalRc}`} ` +
        `retired_from_commit=${row.retiredFromCommit === null ? 'MISSING' : row.retiredFromCommit.slice(0, 12)} ` +
        `historical_sha256=${row.historicalSha256 === null ? 'MISSING' : row.historicalSha256.slice(0, 12)} ` +
        `zero_rewrite=${row.zeroRewrite === null ? 'unchecked' : row.zeroRewrite} ` +
        `retirement_commit=${row.retirementCommit === null ? 'MISSING' : row.retirementCommit.slice(0, 12)} ` +
        `retirement_parent=${row.retirementParent === null ? 'MISSING' : row.retirementParent.slice(0, 12)} ` +
        `written_immediately_before_the_move=${row.writtenImmediatelyBefore === null ? 'unknown' : row.writtenImmediatelyBefore}`,
    );
    if (row.reeval === 'passes') {
      console.log(
        `KDNA-RETIREMENT-RESTORABLE: ${entry.file} original_path=${entry.original_path} rc=0 ` +
          `the registered bytes pass where the file used to run, so this entry is not stale: ` +
          `restore it or record why it stays retired`,
      );
    }
  }

  return { findings, rows, entries: entries.length, legacy: legacyFiles.length };
}

async function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? path.resolve(__dirname, '..') : path.resolve(argv[rootIndex + 1]);
  const { findings, rows, entries, legacy } = await verify(root);
  const preserved = rows.filter((row) => row.preserved).length;
  const restorable = rows.filter((row) => row.reeval === 'passes').length;
  const zeroRewrite = rows.filter((row) => row.zeroRewrite === true).length;
  if (findings.length > 0) {
    console.log(
      `KDNA-RETIREMENT-REGISTRY: findings=${findings.length} root=${root} entries=${entries} ` +
        `legacy=${legacy} preserved=${preserved} restorable=${restorable} zero_rewrite=${zeroRewrite} ` +
        `${JSON.stringify(findings)}`,
    );
    return 1;
  }
  console.log(
    `KDNA-RETIREMENT-REGISTRY: ok root=${root} entries=${entries} legacy=${legacy} ` +
      `preserved=${preserved} restorable=${restorable} zero_rewrite=${zeroRewrite}`,
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  ancestorOfHead,
  blobAt,
  fieldFindings,
  historicalSha256,
  overlayAtOriginalPath,
  parentOf,
  removalCandidates,
  runTestFile,
  sha256,
  sha256OfBlob,
  verify,
  walk,
};
