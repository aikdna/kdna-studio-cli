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
// A retirement is a preservation claim. The gate checks five things, and this is
// the whole of what it claims:
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
//   (e) re-checkable: the copy under tests/legacy/ hashes to the registered
//       sha256, and `retired_from_commit` is the commit the file was retired
//       from. The gate computes that commit itself - `C_last`, the newest commit
//       reachable from HEAD whose tree still carries the file at its original path
//       (`git rev-list --topo-order HEAD`, first tree containing it) - and
//       refuses any entry that names a different commit, so a retirement cannot
//       be anchored at an older retirement that a later one superseded. It also
//       derives the move: the commit whose parent is `retired_from_commit` and
//       which removed the path from its original location. That is the whole of
//       what a machine can prove about a retirement. It cannot prove that nobody
//       wrote the file before the move: an edit in an earlier commit and a
//       "pure" move after it are indistinguishable from a file that was edited
//       long before it was retired, and no history-only rule can tell them apart.
//
// What the gate does instead of judging that is expose it. For every entry it
// prints the complete diff of the file between `retired_from_commit` and the
// move commit, the diff of the named commit's own write when that commit wrote
// the file, and every commit in the retirement window (from the first commit
// that took the file out of its original location to HEAD) that touched the
// retired copy's content, as `content_changed_in_window`. Anything it printed -
// a non-empty move diff, a write by the named commit, or a non-zero window -
// needs the reviewer's per-entry signature (`no-content-change`, or
// `change-explained` with a `review_note` holding the reason) before the entry
// may enter a push batch, and the entries that still lack one are printed as
// unsigned. The gate never accepts a retirement on the strength of a diff it
// cannot interpret, and it does not refuse a shape it cannot judge: shape five -
// "rewrite one byte, then move the file" - is rc=0 with the change exposed and a
// signature required, not a red gate.
//
// Every entry carries the seven registration fields: the retired path (`file`),
// the `original_path_sha256` that resolves its exact historical path, the `sha256` of the preserved bytes
// (the retirement's `retired_sha256`), the `retired_from_commit` those bytes are
// claimed to come from, a free-text `reason`, the registration date `retired_on`,
// and a `review_reference` that says who accepted the retirement. An entry whose
// move changed content also needs the reviewer's per-entry signature:
// `review_signature` is `no-content-change` or `change-explained`, and the
// latter needs a non-empty `review_note`. The gate prints which entries are
// unsigned; it does not refuse them, because an unsigned entry is a decision for
// the push gate, not for a file-and-hash check.
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
  'original_path_sha256',
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
  const result = spawnSync('git', ['--literal-pathspecs', '-C', root, ...args], { maxBuffer: 1 << 28 });
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

// The commit where the file was last seen in its original location: the newest
// commit on HEAD whose tree still carries it. The registry has to name this
// commit verbatim, so an entry cannot anchor at a retirement that a later
// retirement superseded.
function lastAppearanceCommit(root, originalPath) {
  // A path-limited log omits later unrelated commits and simplifies merges.
  // Enumerate the full ordered ancestry before looking at each actual tree.
  const output = gitBytes(root, ['rev-list', '--topo-order', 'HEAD']).toString('utf8').trim();
  if (output === '') return null;
  for (const commit of output.split('\n')) {
    if (blobAt(root, commit, originalPath) !== null) return commit;
  }
  return null;
}

// The retirement window: from the first commit that took the file out of its
// original location to HEAD. Every commit in that window that touched the
// retired copy's content is a change the owner has to see and sign.
function retirementWindow(root, originalPath, retiredFile) {
  const removals = removalCandidates(root, originalPath);
  if (removals.length === 0) return null;
  const first = removals[removals.length - 1];
  const output = gitBytes(root, [
    'log',
    '--format=%H%x09%s',
    '--diff-filter=MD',
    `${first}..HEAD`,
    '--',
    retiredFile,
  ])
    .toString('utf8')
    .trim();
  return {
    first,
    commits:
      output === ''
        ? []
        : output.split('\n').map((line) => {
            const [commit, ...rest] = line.split('\t');
            return { commit, subject: rest.join('\t') };
          }),
  };
}

function blobText(root, commit, relative) {
  const blob = blobAt(root, commit, relative);
  if (blob === null) return null;
  return gitBytes(root, ['cat-file', 'blob', blob]).toString('utf8');
}

// A complete line diff between the two versions of the file, in one hunk: the
// common prefix and suffix are trimmed first, so the quadratic table only ever
// covers the part that actually differs. If the remaining middle is enormous
// (a wholesale rewrite), the diff degrades to "every old line, then every new
// line" rather than allocating a table that big - it is still complete.
const DIFF_TABLE_LIMIT = 4_000_000;

function lineDiff(before, after, beforeLabel, afterLabel) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start += 1;
  let end = 0;
  while (
    end < beforeLines.length - start &&
    end < afterLines.length - start &&
    beforeLines[beforeLines.length - 1 - end] === afterLines[afterLines.length - 1 - end]
  ) {
    end += 1;
  }
  const oldMiddle = beforeLines.slice(start, beforeLines.length - end);
  const newMiddle = afterLines.slice(start, afterLines.length - end);
  const lines = [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -${start + 1},${oldMiddle.length} +${start + 1},${newMiddle.length} @@`,
  ];
  if (oldMiddle.length * newMiddle.length > DIFF_TABLE_LIMIT) {
    for (const line of oldMiddle) lines.push(`-${line}`);
    for (const line of newMiddle) lines.push(`+${line}`);
    return lines;
  }
  const table = Array.from({ length: oldMiddle.length + 1 }, () => new Array(newMiddle.length + 1).fill(0));
  for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
    for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        oldMiddle[i] === newMiddle[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < oldMiddle.length && j < newMiddle.length) {
    if (oldMiddle[i] === newMiddle[j]) {
      lines.push(` ${oldMiddle[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push(`-${oldMiddle[i]}`);
      i += 1;
    } else {
      lines.push(`+${newMiddle[j]}`);
      j += 1;
    }
  }
  while (i < oldMiddle.length) {
    lines.push(`-${oldMiddle[i]}`);
    i += 1;
  }
  while (j < newMiddle.length) {
    lines.push(`+${newMiddle[j]}`);
    j += 1;
  }
  return lines;
}

// Does the recorded signature cover the diff the gate printed? An empty diff
// needs no signature; a non-empty one needs `change-explained` plus a reason -
// `no-content-change` is a claim the diff contradicts.
function signatureCovers(entry, contentChanged) {
  if (contentChanged !== true) return true;
  if (entry.review_signature !== 'change-explained') return false;
  return typeof entry.review_note === 'string' && entry.review_note.trim() !== '';
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
  if (
    entry.reeval_in_place !== undefined &&
    !['possible', 'not-possible'].includes(entry.reeval_in_place)
  ) {
    findings.push({ file, check: 'malformed_reeval_in_place', detail: String(entry.reeval_in_place) });
  }
  if (
    entry.review_signature !== undefined &&
    !['no-content-change', 'change-explained'].includes(entry.review_signature)
  ) {
    findings.push({ file, check: 'malformed_review_signature', detail: String(entry.review_signature) });
  }
  if (Object.hasOwn(entry, 'original_path')) {
    findings.push({ file, check: 'literal_original_path_not_supported' });
  }
  if (typeof entry.original_path_sha256 === 'string' && !SHA256_RE.test(entry.original_path_sha256)) {
    findings.push({ file, check: 'malformed_original_path_sha256' });
  }
  return findings;
}

// Resolve the exact historical pathname, never an alias for it. Hash the raw
// path bytes from a NUL-delimited Git tree: identical blobs or basenames at
// other locations cannot satisfy this binding. No fallback is permitted.
function resolveOriginalPath(root, commit, expectedDigest) {
  const matches = [];
  const tree = gitBytes(root, ['ls-tree', '-r', '-z', commit]);
  let offset = 0;
  while (offset < tree.length) {
    const end = tree.indexOf(0, offset);
    if (end < 0) throw new Error('unterminated Git tree entry');
    const record = tree.subarray(offset, end);
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('malformed Git tree entry');
    const rawPath = record.subarray(tab + 1);
    if (crypto.createHash('sha256').update(rawPath).digest('hex') === expectedDigest) {
      const [mode, type] = record.subarray(0, tab).toString('ascii').split(' ');
      const relative = rawPath.toString('utf8');
      if (!Buffer.from(relative, 'utf8').equals(rawPath) ||
          !['100644', '100755'].includes(mode) || type !== 'blob' ||
          !relative.startsWith('tests/') || relative.includes('\\') ||
          /[\x00-\x1f\x7f]/u.test(relative) ||
          relative.split('/').some((part) => ['', '.', '..'].includes(part))) {
        throw new Error('unsafe historical test path');
      }
      matches.push(relative);
    }
    offset = end + 1;
  }
  if (matches.length !== 1) throw new Error(`expected one historical path, found ${matches.length}`);
  return matches[0];
}

async function verify(root) {
  const findings = [];
  const registry = readJson(path.join(root, 'tests', 'retired.json'));
  const entries = registry.entries ?? [];
  if (registry.schema !== 'kdna.retired-test-registry' || registry.schema_version !== '4.0.0') {
    findings.push({ file: 'tests/retired.json', check: 'unsupported_registry_schema' });
  }
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
      row.retiredFromCommit = typeof entry.retired_from_commit === 'string' ? entry.retired_from_commit : null;
      const commitIsUsable = row.retiredFromCommit !== null && COMMIT_RE.test(row.retiredFromCommit);
      row.originalPath = null;
      row.pathResolutionError = null;
      if (commitIsUsable && SHA256_RE.test(entry.original_path_sha256 ?? '')) {
        try {
          row.originalPath = resolveOriginalPath(root, row.retiredFromCommit, entry.original_path_sha256);
        } catch (error) {
          row.pathResolutionError = error.message;
        }
      }
      if (row.originalPath !== null && row.originalPath.startsWith('tests/legacy')) {
        findings.push({ file: entry.file, check: 'original_path_inside_legacy' });
      }
      if (row.originalPath === entry.file) {
        findings.push({ file: entry.file, check: 'original_path_is_the_retired_path' });
      }
      const pathIsUsable = row.originalPath !== null && !row.originalPath.startsWith('tests/legacy');
      // (c) and (d) use the real historical path, never the digest as a path.
      const original = pathIsUsable ? path.join(root, row.originalPath) : null;
      row.originalExists = original !== null && fs.existsSync(original);
      row.originalSameBytes = row.originalExists && sha256(original) === entry.sha256;
      row.historicalSha256 = null;
      row.historicalError = null;
      row.ancestorOfHead = commitIsUsable ? ancestorOfHead(root, row.retiredFromCommit) : null;
      if (commitIsUsable && pathIsUsable) {
        try {
          row.historicalSha256 = historicalSha256(root, row.retiredFromCommit, row.originalPath);
        } catch (error) {
          row.historicalError = error.message;
        }
        row.ancestorOfHead = ancestorOfHead(root, row.retiredFromCommit);
      }
      // (e) re-checkable, and the exposure that goes with it. The named commit
      // has to be C_last, the commit where the file was last seen at its original
      // path. Three things can carry a change and each is printed in full: the
      // first retirement rewrote the bytes while moving the file, the named commit
      // wrote the file itself, and commits after the first retirement modified or
      // removed the retired copy (the retirement window). None of them is a
      // verdict; all of them require the reviewer's signature.
      row.retirementCarriesOriginalPath = null;
      row.lastAppearance = null;
      row.historyError = null;
      row.firstRetirement = null;
      row.changedInWindow = 0;
      row.retirementRewroteContent = null;
      row.retirementRewriteLines = 0;
      row.retirementRewriteDiff = [];
      row.priorWriteChanged = null;
      row.priorWriteDiffLines = [];
      row.windowCommits = [];
      row.reviewSignature = typeof entry.review_signature === 'string' ? entry.review_signature : null;
      row.signed = null;
      if (commitIsUsable && pathIsUsable) {
        try {
          row.lastAppearance = lastAppearanceCommit(root, row.originalPath);
          row.retirementCarriesOriginalPath = blobAt(root, row.retiredFromCommit, row.originalPath) !== null;
          if (row.retirementCarriesOriginalPath) {
            // The named commit wrote the file itself: that write is also a way a
            // retirement can carry content that is not the file's older state,
            // and it is printed too.
            const earlierBlob = blobAt(root, `${row.retiredFromCommit}^`, row.originalPath);
            const atCommitBlob = blobAt(root, row.retiredFromCommit, row.originalPath);
            row.priorWriteChanged = earlierBlob !== null && earlierBlob !== atCommitBlob;
            if (row.priorWriteChanged) {
              row.priorWriteDiffLines = lineDiff(
                blobText(root, `${row.retiredFromCommit}^`, row.originalPath),
                blobText(root, row.retiredFromCommit, row.originalPath),
                `${row.retiredFromCommit.slice(0, 12)}^:${row.originalPath}`,
                `${row.retiredFromCommit.slice(0, 12)}:${row.originalPath}`,
              );
            }
          }
          const window = retirementWindow(root, row.originalPath, entry.file);
          if (window !== null) {
            row.firstRetirement = window.first;
            row.windowCommits = window.commits;
            // Did the first retirement itself change the bytes while moving them?
            const beforeMove = blobText(root, `${window.first}^`, row.originalPath);
            const afterMove = blobText(root, window.first, entry.file);
            if (beforeMove !== null && afterMove !== null) {
              row.retirementRewroteContent = beforeMove !== afterMove;
              if (row.retirementRewroteContent) {
                row.retirementRewriteDiff = lineDiff(
                  beforeMove,
                  afterMove,
                  `${window.first.slice(0, 12)}^:${row.originalPath}`,
                  `${window.first.slice(0, 12)}:${entry.file}`,
                );
                row.retirementRewriteLines = row.retirementRewriteDiff.filter(
                  (line) => (line.startsWith('-') || line.startsWith('+')) && !line.startsWith('---') && !line.startsWith('+++'),
                ).length;
              }
            }
          }
          row.signed = signatureCovers(
            entry,
            row.retirementRewroteContent === true ||
              row.priorWriteChanged === true ||
              row.windowCommits.length > 0,
          );
          row.changedInWindow =
            row.windowCommits.length + (row.retirementRewroteContent === true ? 1 : 0);
        } catch (error) {
          row.historyError = error.message;
        }
      }
      // (d) re-evaluable receipt.
      row.reeval = 'skipped';
      row.reevalNote = typeof entry.reeval_note === 'string' ? entry.reeval_note : null;
      if (entry.reeval_in_place === 'not-possible') {
        // The entry itself says its bytes cannot be run where they used to live
        // (the helper they require is retired material too, say). That is a
        // recorded fact, not a silent skip, and it needs the reason.
        row.reeval = 'not_possible';
      } else if (original !== null) {
        const overlay = overlayAtOriginalPath(root, row.originalPath, target);
        try {
          const run = await runTestFile(overlay, row.originalPath);
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
    if (row.pathResolutionError !== null) {
      findings.push({ file: entry.file, check: 'original_path_resolution_failed', detail: row.pathResolutionError });
    }
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
        detail: `${row.originalPath} still carries the registered bytes, so the file still runs as a current test`,
      });
    }
    if (row.historicalError !== null) {
      findings.push({
        file: entry.file,
        check: 'retired_from_commit_unreadable',
        detail: `${entry.retired_from_commit}:${row.originalPath ?? 'MISSING'}: ${row.historicalError}`,
      });
    }
    if (row.ancestorOfHead === false) {
      findings.push({
        file: entry.file,
        check: 'retired_from_commit_not_an_ancestor_of_head',
        detail: entry.retired_from_commit,
      });
    }
    if (row.historyError !== null) {
      findings.push({
        file: entry.file,
        check: 'retirement_history_unreadable',
        detail: row.historyError,
      });
    } else if (row.retirementCarriesOriginalPath === false) {
      findings.push({
        file: entry.file,
        check: 'retired_from_commit_does_not_carry_the_original_path',
        detail:
          `${entry.retired_from_commit} does not carry ${row.originalPath}, so it is not the commit ` +
          `the file was retired from`,
      });
    } else if (row.retirementCarriesOriginalPath === true && row.moveCommit === null) {
      findings.push({
        file: entry.file,
        check: 'retirement_move_commit_not_found',
        detail: `no commit on HEAD has ${entry.retired_from_commit} as its parent and removes ${row.originalPath}`,
      });
    }
    if (row.lastAppearance !== null && row.retiredFromCommit !== row.lastAppearance) {
      findings.push({
        file: entry.file,
        check: 'retired_from_commit_is_not_the_last_appearance',
        detail:
          `the file was last at ${row.originalPath} in ${row.lastAppearance}, but the entry names ` +
          `${row.retiredFromCommit}, so it anchors at a retirement that was superseded`,
      });
    }
    if (
      entry.reeval_in_place === 'not-possible' &&
      (typeof entry.reeval_note !== 'string' || entry.reeval_note.trim() === '')
    ) {
      findings.push({
        file: entry.file,
        check: 'missing_reeval_note',
        detail: 'reeval_in_place is not-possible, so the entry has to record why it cannot be re-run in place',
      });
    }
    console.log(
      `KDNA-RETIREMENT-ENTRY: ${entry.file} original_path=${row.originalPath ?? 'MISSING'} ` +
        `sha256=${typeof entry.sha256 === 'string' ? entry.sha256.slice(0, 12) : 'MISSING'} ` +
        `preserved=${row.preserved} original_carries_same_bytes=${row.originalSameBytes} ` +
        `retired_on=${entry.retired_on ?? 'MISSING'} review_reference=${JSON.stringify(entry.review_reference ?? '')} ` +
        `reeval=${row.reeval}${row.reevalRc === undefined ? '' : ` rc=${row.reevalRc}`} ` +
        `retired_from_commit=${row.retiredFromCommit === null ? 'MISSING' : row.retiredFromCommit.slice(0, 12)} ` +
        `last_appearance=${row.lastAppearance === null ? 'MISSING' : row.lastAppearance.slice(0, 12)} ` +
        `historical_sha256=${row.historicalSha256 === null ? 'MISSING' : row.historicalSha256.slice(0, 12)} ` +
        `first_retirement=${row.firstRetirement === null ? 'MISSING' : row.firstRetirement.slice(0, 12)} ` +
        `retirement_rewrote_content=${row.retirementRewroteContent === null ? 'unknown' : row.retirementRewroteContent} ` +
        `retirement_rewrite_lines=${row.retirementRewriteLines} ` +
        `prior_write_to_the_file=${row.priorWriteChanged === null ? 'unknown' : row.priorWriteChanged} ` +
        `content_changed_in_window=${row.changedInWindow} ` +
        `review_signature=${row.reviewSignature === null ? 'MISSING' : row.reviewSignature}`,
    );
    if (row.retirementRewroteContent === true) {
      console.log(
        `KDNA-RETIREMENT-DIFF: ${entry.file} the first retirement ${row.firstRetirement.slice(0, 12)} changed the ` +
          `content while moving the file (${row.retirementRewriteLines} differing lines)`,
      );
      for (const line of row.retirementRewriteDiff) console.log(`  ${line}`);
    }
    if (row.firstRetirement !== null) {
      console.log(
        `KDNA-RETIREMENT-WINDOW: ${entry.file} first_retirement=${row.firstRetirement.slice(0, 12)} ` +
          `content_changed_in_window=${row.changedInWindow} (the retirement's own rewrite counted: ` +
          `${row.retirementRewroteContent === true}; later modifying/removing commits: ${row.windowCommits.length})`,
      );
      for (const commit of row.windowCommits) console.log(`  ${commit.commit.slice(0, 12)} ${commit.subject}`);
    }
    if (row.reeval === 'not_possible') {
      console.log(
        `KDNA-RETIREMENT-REEVAL-NOTE: ${entry.file} cannot be re-run at ${row.originalPath}: ${row.reevalNote}`,
      );
    }
    if (row.priorWriteChanged === true) {
      console.log(
        `KDNA-RETIREMENT-PRIOR-WRITE: ${entry.file} retired_from_commit=${row.retiredFromCommit.slice(0, 12)} ` +
          `wrote the file at ${row.originalPath} itself; the file was still a current test then`,
      );
      for (const line of row.priorWriteDiffLines) console.log(`  ${line}`);
    }
    if ((row.changedInWindow > 0 || row.priorWriteChanged === true) && row.signed !== true) {
      console.log(
        `KDNA-RETIREMENT-UNSIGNED: ${entry.file} content_changed_in_window=${row.changedInWindow} ` +
          `prior_write=${row.priorWriteChanged === true} ` +
          `review_signature=${row.reviewSignature === null ? 'MISSING' : row.reviewSignature} ` +
          `-> an independent reviewer must sign this change (no-content-change, or change-explained with a review_note) ` +
          `before the entry may enter a push batch`,
      );
    }
    if (row.reeval === 'passes') {
      console.log(
        `KDNA-RETIREMENT-RESTORABLE: ${entry.file} original_path=${row.originalPath} rc=0 ` +
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
  const retirementRewrote = rows.filter((row) => row.retirementRewroteContent === true).length;
  const priorWrite = rows.filter((row) => row.priorWriteChanged === true).length;
  const windowChanged = rows.reduce((total, row) => total + row.changedInWindow, 0);
  const touched = rows.filter(
    (row) => row.changedInWindow > 0 || row.priorWriteChanged === true,
  );
  const unsigned = touched.filter((row) => row.signed !== true).length;
  const counters =
    `preserved=${preserved} restorable=${restorable} retirement_rewrote=${retirementRewrote} prior_write=${priorWrite} ` +
    `content_changed_in_window=${windowChanged} signed=${touched.length - unsigned} unsigned=${unsigned}`;
  if (findings.length > 0) {
    console.log(
      `KDNA-RETIREMENT-REGISTRY: findings=${findings.length} root=${root} entries=${entries} ` +
        `legacy=${legacy} ${counters} ${JSON.stringify(findings)}`,
    );
    return 1;
  }
  console.log(
    `KDNA-RETIREMENT-REGISTRY: ok root=${root} entries=${entries} legacy=${legacy} ${counters}`,
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  ancestorOfHead,
  blobAt,
  blobText,
  fieldFindings,
  historicalSha256,
  lastAppearanceCommit,
  lineDiff,
  overlayAtOriginalPath,
  parentOf,
  removalCandidates,
  resolveOriginalPath,
  retirementWindow,
  runTestFile,
  sha256,
  sha256OfBlob,
  signatureCovers,
  verify,
  walk,
};
