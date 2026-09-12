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
//       from - the one that last carried it at its original path. The gate
//       checks that the named commit's tree really carries the file at that path
//       (and that HEAD reaches it), and derives the move: the commit whose parent
//       is `retired_from_commit` and which removed the path from its original
//       location. That is the whole of what a machine can prove about a
//       retirement. It cannot prove that nobody wrote the file before the move:
//       an edit in an earlier commit and a "pure" move after it are
//       indistinguishable from a file that was edited long before it was
//       retired, and no history-only rule can tell them apart.
//
// What the gate does instead of judging that is expose it. For every entry it
// prints the complete diff of the file between `retired_from_commit` and the
// move commit, counts the differing lines, and names the entries whose diff is
// not empty and whose `review_signature` does not cover it. Those entries are
// listed as unsigned for the owner's push gate: an independent reviewer has to
// sign each one either `no-content-change` or `change-explained` (with a
// `review_note` holding the reason) before it may enter a push batch. The gate
// never accepts a retirement on the strength of a diff it cannot interpret.
//
// Every entry carries the seven registration fields: the retired path (`file`),
// the `original_path` it was retired from, the `sha256` of the preserved bytes
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
      // (e) re-checkable: the named commit has to carry the file at the original
      // path, and the move the retirement describes is derived from it. Whether
      // the move changed content is a receipt, not a verdict - it is printed in
      // full below and counted, and an unsigned change is named for the push
      // gate.
      row.retirementCarriesOriginalPath = null;
      row.moveCommit = null;
      row.historyError = null;
      row.contentChanged = null;
      row.contentChangedLines = 0;
      row.diffLines = [];
      row.priorWriteChanged = null;
      row.priorWriteDiffLines = [];
      row.reviewSignature = typeof entry.review_signature === 'string' ? entry.review_signature : null;
      row.signed = null;
      if (commitIsUsable && pathIsUsable) {
        try {
          row.retirementCarriesOriginalPath = blobAt(root, row.retiredFromCommit, entry.original_path) !== null;
          if (row.retirementCarriesOriginalPath) {
            // The named commit wrote the file itself: that write is also a way a
            // retirement can carry content that is not the file's older state,
            // and it is printed too.
            const earlierBlob = blobAt(root, `${row.retiredFromCommit}^`, entry.original_path);
            const atCommitBlob = blobAt(root, row.retiredFromCommit, entry.original_path);
            row.priorWriteChanged = earlierBlob !== null && earlierBlob !== atCommitBlob;
            if (row.priorWriteChanged) {
              row.priorWriteDiffLines = lineDiff(
                blobText(root, `${row.retiredFromCommit}^`, entry.original_path),
                blobText(root, row.retiredFromCommit, entry.original_path),
                `${row.retiredFromCommit.slice(0, 12)}^:${entry.original_path}`,
                `${row.retiredFromCommit.slice(0, 12)}:${entry.original_path}`,
              );
            }
            const move =
              removalCandidates(root, entry.original_path).find(
                (candidate) => parentOf(root, candidate) === row.retiredFromCommit,
              ) ?? null;
            row.moveCommit = move;
            if (move !== null) {
              const before = blobText(root, row.retiredFromCommit, entry.original_path);
              const after = blobText(root, move, entry.file);
              if (before !== null && after !== null) {
                row.contentChanged = before !== after;
                if (row.contentChanged) {
                  row.diffLines = lineDiff(
                    before,
                    after,
                    `${row.retiredFromCommit.slice(0, 12)}:${entry.original_path}`,
                    `${move.slice(0, 12)}:${entry.file}`,
                  );
                  row.contentChangedLines = row.diffLines.filter(
                    (line) => (line.startsWith('-') || line.startsWith('+')) && !line.startsWith('---') && !line.startsWith('+++'),
                  ).length;
                }
              }
            }
          }
          row.signed = signatureCovers(entry, row.contentChanged === true || row.priorWriteChanged === true);
        } catch (error) {
          row.historyError = error.message;
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
          `${entry.retired_from_commit} does not carry ${entry.original_path}, so it is not the commit ` +
          `the file was retired from`,
      });
    } else if (row.retirementCarriesOriginalPath === true && row.moveCommit === null) {
      findings.push({
        file: entry.file,
        check: 'retirement_move_commit_not_found',
        detail: `no commit on HEAD has ${entry.retired_from_commit} as its parent and removes ${entry.original_path}`,
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
        `retirement_move_commit=${row.moveCommit === null ? 'MISSING' : row.moveCommit.slice(0, 12)} ` +
        `content_changed=${row.contentChanged === null ? 'unknown' : row.contentChanged} ` +
        `content_changed_lines=${row.contentChangedLines} ` +
        `prior_write_to_the_file=${row.priorWriteChanged === null ? 'unknown' : row.priorWriteChanged} ` +
        `review_signature=${row.reviewSignature === null ? 'MISSING' : row.reviewSignature}`,
    );
    if (row.contentChanged === false) {
      console.log(
        `KDNA-RETIREMENT-UNCHANGED: ${entry.file} ${row.retiredFromCommit.slice(0, 12)}:${entry.original_path} ` +
          `and ${row.moveCommit.slice(0, 12)}:${entry.file} are identical (0 differing lines)`,
      );
    }
    if (row.contentChanged === true) {
      console.log(
        `KDNA-RETIREMENT-DIFF: ${entry.file} retired_from_commit=${row.retiredFromCommit.slice(0, 12)} ` +
          `move_commit=${row.moveCommit.slice(0, 12)} content_changed=true changed_lines=${row.contentChangedLines}`,
      );
      for (const line of row.diffLines) console.log(`  ${line}`);
    }
    if (row.priorWriteChanged === true) {
      console.log(
        `KDNA-RETIREMENT-PRIOR-WRITE: ${entry.file} retired_from_commit=${row.retiredFromCommit.slice(0, 12)} ` +
          `wrote the file at ${entry.original_path} itself; the file was still a current test then`,
      );
      for (const line of row.priorWriteDiffLines) console.log(`  ${line}`);
    }
    if ((row.contentChanged === true || row.priorWriteChanged === true) && row.signed !== true) {
      console.log(
        `KDNA-RETIREMENT-UNSIGNED: ${entry.file} content_changed=${row.contentChanged === true} ` +
          `prior_write=${row.priorWriteChanged === true} ` +
          `review_signature=${row.reviewSignature === null ? 'MISSING' : row.reviewSignature} ` +
          `-> an independent reviewer must sign this diff (no-content-change, or change-explained with a review_note) ` +
          `before the entry may enter a push batch`,
      );
    }
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
  const contentChanged = rows.filter((row) => row.contentChanged === true).length;
  const priorWrite = rows.filter((row) => row.priorWriteChanged === true).length;
  const touched = rows.filter((row) => row.contentChanged === true || row.priorWriteChanged === true);
  const unsigned = touched.filter((row) => row.signed !== true).length;
  const counters =
    `preserved=${preserved} restorable=${restorable} content_changed=${contentChanged} prior_write=${priorWrite} ` +
    `signed=${touched.length - unsigned} unsigned=${unsigned}`;
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
  lineDiff,
  overlayAtOriginalPath,
  parentOf,
  removalCandidates,
  runTestFile,
  sha256,
  sha256OfBlob,
  signatureCovers,
  verify,
  walk,
};
