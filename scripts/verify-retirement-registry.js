#!/usr/bin/env node
'use strict';

// Independent gate over tests/retired.json.
//
// The registry is only a claim until something checks it. This gate checks it
// in both directions and against reality:
//
//   1. registration <-> directory: every entry names an existing file under
//      tests/legacy/, and every test file under tests/legacy/ is registered;
//   2. declared absence: every entry carries `object_absence` probes, each of
//      which is evaluated against the committed bytes. A token probe only
//      counts when the token also occurs in the retired file itself, so a probe
//      cannot be satisfied by an arbitrary string;
//   3. executability: **a file may only be retired while it is red where it
//      lived, or while its failure output names the retired object.**
//
// Rule 3 is the part that has to refuse evidence the judged object produced
// about itself. Its previous form was "the file is red under tests/legacy/",
// and a *passing* test satisfies that for free: `git mv tests/x.test.js
// tests/legacy/` breaks the file's relative `require`, so the file turns red
// with nothing retired at all, and the gate waved the retirement through. The
// red has to be attached to the retired object rather than to the move:
//
//   (a) the retired bytes are red when run from the path they were retired
//       from (`tests/<...>`), where their relative requires still resolve, so
//       the move cannot be the reason for the red - and the committed graph is
//       missing the object the entry's `object_absence` probes declare absent,
//       which is what explains the red; or
//   (b) the failure output explicitly names one of the identifiers those
//       probes declare.
//
// A red that is only red because of the move - green at the original path, and
// a failure that never names the declared object - is a finding
// (`retirement_red_only_because_of_the_move`), not a retirement.
//
// usage: node scripts/verify-retirement-registry.js [--root <tree>]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TEST_FILE_RE = /\.test\.(?:js|cjs|mjs)$/u;
const CONCURRENCY = 4;
const LEGACY_PREFIX = 'tests/legacy/';
const MODULE_RESOLUTION_RE = /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|MODULE_NOT_FOUND/u;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function walk(directory, matches) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, matches));
    else if (matches(entry.name)) found.push(full);
  }
  return found;
}

function occurrences(file, token) {
  return fs.readFileSync(file, 'utf8').split(token).length - 1;
}

function isPacked(files, relative) {
  return files.some((entry) => entry === relative || relative.startsWith(`${entry.replace(/\/$/u, '')}/`));
}

function probeFindings(root, entry, probe) {
  const findings = [];
  const retiredFile = path.join(root, entry.file);
  const anchor = (token) => {
    if (typeof token !== 'string' || occurrences(retiredFile, token) === 0) {
      findings.push({
        file: entry.file,
        check: 'probe_token_not_anchored',
        detail: `${probe.kind} token ${JSON.stringify(token)} does not occur in the retired file itself`,
      });
      return false;
    }
    return true;
  };
  switch (probe.kind) {
    case 'path_absent':
      if (fs.existsSync(path.join(root, probe.path))) {
        findings.push({ file: entry.file, check: 'declared_absent_path_exists', detail: probe.path });
      }
      break;
    case 'token_absent': {
      const target = path.join(root, probe.path);
      if (!anchor(probe.token)) break;
      if (!fs.existsSync(target)) {
        findings.push({ file: entry.file, check: 'probe_target_missing', detail: probe.path });
      } else if (occurrences(target, probe.token) > 0) {
        findings.push({ file: entry.file, check: 'declared_absent_token_present', detail: `${probe.path}:${probe.token}` });
      }
      break;
    }
    case 'not_packed': {
      const manifest = readJson(path.join(root, 'package.json'));
      if (!anchor(probe.path)) break;
      if (isPacked(manifest.files ?? [], probe.path)) {
        findings.push({ file: entry.file, check: 'declared_unpacked_path_is_packed', detail: probe.path });
      }
      break;
    }
    case 'not_exported': {
      const target = path.join(root, probe.module);
      if (!fs.existsSync(target)) {
        findings.push({ file: entry.file, check: 'probe_target_missing', detail: probe.module });
        break;
      }
      const exported = Object.keys(require(target));
      for (const token of probe.tokens ?? []) {
        if (!anchor(token)) continue;
        if (exported.includes(token)) {
          findings.push({ file: entry.file, check: 'declared_unexported_name_exported', detail: `${probe.module}:${token}` });
        }
      }
      break;
    }
    case 'help_excludes': {
      const [command, ...commandArgs] = probe.command;
      const result = spawnSync(
        command === 'node' ? process.execPath : command,
        command === 'node' ? commandArgs : [command, ...commandArgs],
        { cwd: root, encoding: 'utf8' },
      );
      if (result.status !== 0) {
        findings.push({ file: entry.file, check: 'probe_command_failed', detail: `${probe.command.join(' ')} rc=${result.status}` });
        break;
      }
      for (const token of probe.tokens ?? []) {
        if (!anchor(token)) continue;
        if (result.stdout.includes(token)) {
          findings.push({ file: entry.file, check: 'declared_absent_token_present', detail: `${probe.command.join(' ')}:${token}` });
        }
      }
      break;
    }
    default:
      findings.push({ file: entry.file, check: 'unknown_probe_kind', detail: String(probe.kind) });
  }
  return findings;
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
    child.on('close', (status) => {
      const count = (label) => {
        const match = output.match(new RegExp(`^# ${label} (\\d+)$`, 'm')) ?? output.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm'));
        return match ? Number(match[1]) : null;
      };
      resolve({ file, cwd, status, output, passed: count('pass'), failed: count('fail') });
    });
  });
}

// The identifiers an entry declares absent: the tokens a probe names, plus the
// token/path/module the probe itself names. These are what the failure output
// has to spell out for leg (b) of the retirement criterion to hold.
function declaredIdentifiers(entry) {
  const identifiers = new Set();
  for (const probe of entry.object_absence ?? []) {
    for (const token of probe.tokens ?? []) if (typeof token === 'string' && token) identifiers.add(token);
    for (const key of ['token', 'path', 'module']) {
      if (typeof probe[key] === 'string' && probe[key]) identifiers.add(probe[key]);
    }
  }
  return [...identifiers];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function identifierMatch(line, identifier) {
  if (/^\w+$/u.test(identifier)) return new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'u').test(line);
  return line.includes(identifier);
}

// Leg (b): does the failure explicitly name the retired object? A match inside
// the specifier of a module-resolution failure does not count. That specifier is
// what the move broke, and treating it as the object's identity would let the
// relocation artifact certify itself again.
function namesRetiredObject(output, identifiers) {
  for (const line of output.split('\n')) {
    for (const identifier of identifiers) {
      if (!identifierMatch(line, identifier)) continue;
      if (MODULE_RESOLUTION_RE.test(line)) {
        const specifiers = [
          ...[...line.matchAll(/'([^']*)'/gu)].map((match) => match[1]),
          ...[...line.matchAll(/"([^"]*)"/gu)].map((match) => match[1]),
        ];
        if (specifiers.some((specifier) => identifierMatch(specifier, identifier))) continue;
      }
      return identifier;
    }
  }
  return null;
}

// Leg (a): run the retired bytes from the path they were retired from. The
// original path is reconstructed in an overlay whose top level and whose
// tests/ siblings are symlinked back to the committed tree, so every relative
// require resolves exactly as it did before the move while the committed bytes
// stay untouched.
function originalPathOf(entry) {
  if (typeof entry.file !== 'string' || !entry.file.startsWith(LEGACY_PREFIX)) return null;
  return `tests/${entry.file.slice(LEGACY_PREFIX.length)}`;
}

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

async function verify(root) {
  const findings = [];
  const registry = readJson(path.join(root, 'tests', 'retired.json'));
  const entries = registry.entries ?? [];
  const legacyDir = path.join(root, 'tests', 'legacy');
  const legacyFiles = walk(legacyDir, (name) => TEST_FILE_RE.test(name)).map((file) => path.relative(root, file));
  const registered = entries.map((entry) => entry.file);

  for (const entry of entries) {
    if (!entry.file?.startsWith('tests/legacy/')) {
      findings.push({ file: String(entry.file), check: 'retired_file_outside_legacy' });
    }
    if (!entry.file || !fs.existsSync(path.join(root, entry.file))) {
      findings.push({ file: String(entry.file), check: 'registered_file_missing' });
    }
    if (!entry.retired_object) findings.push({ file: String(entry.file), check: 'missing_retired_object' });
    if (!Array.isArray(entry.object_absence) || entry.object_absence.length === 0) {
      findings.push({ file: String(entry.file), check: 'missing_object_absence_probe' });
    }
  }
  for (const file of new Set(registered)) {
    if (registered.filter((candidate) => candidate === file).length > 1) {
      findings.push({ file, check: 'duplicate_registration' });
    }
  }
  for (const file of legacyFiles) {
    if (!registered.includes(file)) findings.push({ file, check: 'legacy_file_not_registered' });
  }
  for (const file of registered) {
    if (!legacyFiles.includes(file)) findings.push({ file, check: 'registered_file_not_a_test_file' });
  }
  for (const entry of entries) {
    if (!fs.existsSync(path.join(root, entry.file ?? ''))) continue;
    for (const probe of entry.object_absence ?? []) {
      findings.push(...probeFindings(root, entry, probe));
    }
  }

  const runs = await runWithConcurrency(
    entries.filter((entry) => fs.existsSync(path.join(root, entry.file))),
    async (entry) => {
      const registered = await runTestFile(root, entry.file);
      const original = originalPathOf(entry);
      let atOriginal = null;
      if (original) {
        const overlay = overlayAtOriginalPath(root, original, path.join(root, entry.file));
        try {
          atOriginal = await runTestFile(overlay, original);
        } finally {
          fs.rmSync(overlay, { recursive: true, force: true });
        }
      }
      const identifiers = declaredIdentifiers(entry);
      return {
        entry,
        identifiers,
        registered,
        atOriginal,
        namedObject: namesRetiredObject(registered.output, identifiers),
      };
    },
    CONCURRENCY,
  );
  for (const run of runs) {
    const { entry, registered, atOriginal } = run;
    // (a) red where it lived: the move cannot be the reason for the red, and the
    // object_absence probes (checked above) are what explains it.
    const redWhereItLived = atOriginal !== null && atOriginal.status !== 0;
    // (b) the failure output explicitly names the declared object.
    const namedObject = run.namedObject;
    console.log(
      `KDNA-RETIRED-FILE: ${entry.file} registered_rc=${registered.status} ` +
        `pass=${registered.passed ?? 'UNKNOWN'} fail=${registered.failed ?? 'UNKNOWN'} ` +
        `original_path=${atOriginal ? atOriginal.file : 'UNKNOWN'} original_rc=${atOriginal ? atOriginal.status : 'UNKNOWN'} ` +
        `named_object=${namedObject === null ? 'no' : JSON.stringify(namedObject)} ` +
        `criterion=${redWhereItLived ? 'a:red-where-it-lived' : namedObject === null ? 'none' : 'b:failure-names-the-object'}`,
    );
    if (registered.status === 0) {
      findings.push({
        file: entry.file,
        check: 'retired_file_still_passes',
        detail: 'the retired file still passes where it is registered, so nothing was retired',
      });
      continue;
    }
    if (!redWhereItLived && namedObject === null) {
      findings.push({
        file: entry.file,
        check: 'retirement_red_only_because_of_the_move',
        detail: atOriginal
          ? `the file passes when it is run from ${atOriginal.file}, so the red comes from the move rather than from the retired object`
          : 'the original path could not be reconstructed and the failure never names the declared object',
      });
    }
  }
  return { findings, runs, entries: entries.length, legacy: legacyFiles.length };
}

async function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? path.resolve(__dirname, '..') : path.resolve(argv[rootIndex + 1]);
  const { findings, runs, entries, legacy } = await verify(root);
  if (findings.length > 0) {
    console.log(
      `KDNA-RETIREMENT-REGISTRY: findings=${findings.length} root=${root} entries=${entries} ` +
        `legacy=${legacy} ${JSON.stringify(findings)}`,
    );
    return 1;
  }
  const redWhereItLived = runs.filter((run) => run.atOriginal !== null && run.atOriginal.status !== 0).length;
  const namedObject = runs.filter((run) => run.namedObject !== null).length;
  console.log(
    `KDNA-RETIREMENT-REGISTRY: ok root=${root} entries=${entries} legacy=${legacy} ` +
      `red_where_retired=${redWhereItLived} named_object=${namedObject}`,
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { declaredIdentifiers, namesRetiredObject, originalPathOf, probeFindings, verify, walk };
