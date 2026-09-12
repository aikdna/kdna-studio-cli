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
//   3. executability: **a file may only be retired while it is red on the
//      committed graph.** The gate runs every registered file and requires a
//      non-zero exit status. A test that still passes was retired while it
//      still had coverage, which silently shrinks the verification surface.
//
// usage: node scripts/verify-retirement-registry.js [--root <tree>]

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TEST_FILE_RE = /\.test\.(?:js|cjs|mjs)$/u;
const CONCURRENCY = 4;

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
// this uses an asynchronous child process.
function runRetiredFile(root, file) {
  return new Promise((resolve, reject) => {
    // NODE_TEST_CONTEXT would make the grandchild behave as part of the calling
    // test runner instead of printing its own summary, so it is dropped.
    const environment = { ...process.env, NODE_TEST_CONTEXT: undefined };
    const child = spawn(process.execPath, ['--test', path.relative(root, file)], { cwd: root, env: environment });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (status) => {
      const count = (label) => {
        const match = stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm')) ?? stdout.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm'));
        return match ? Number(match[1]) : null;
      };
      resolve({ file, status, passed: count('pass'), failed: count('fail') });
    });
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
    (entry) => runRetiredFile(root, path.join(root, entry.file)),
    CONCURRENCY,
  );
  for (const run of runs) {
    console.log(
      `KDNA-RETIRED-FILE: ${run.file} rc=${run.status} pass=${run.passed ?? 'UNKNOWN'} fail=${run.failed ?? 'UNKNOWN'}`,
    );
    if (run.status === 0) {
      findings.push({
        file: run.file,
        check: 'retired_file_still_passes',
        detail: 'a file may only be retired while it is red on the committed graph',
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
  console.log(
    `KDNA-RETIREMENT-REGISTRY: ok root=${root} entries=${entries} legacy=${legacy} ` +
      `red=${runs.filter((run) => run.status !== 0).length}`,
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { probeFindings, verify, walk };
