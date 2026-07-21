#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  readTarFileEntries,
  resolveTrustedNpmInvocation,
} = require('./runtime-candidate-binding');

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.txt',
  '.yaml',
  '.yml',
]);
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);
const ALLOWLIST_FILE = 'scripts/third-party-name-allowlist.json';
const GENERATION_PATTERN = new RegExp(`\\b${'v'}[0-9]+(?:\\.[0-9]+){0,2}\\b`, 'gi');
const TEMPLATE_PATTERN = new RegExp(`\\b${'v'}\\$\\{`, 'gi');
const IDENTIFIER_PATTERN = new RegExp(
  `\\b[a-z][A-Za-z0-9]*${'V'}[0-9]+[A-Za-z0-9]*\\b`,
  'g',
);

function listFiles(root, relative = '') {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function isTextFile(relative) {
  if (['LICENSE', 'NOTICE', 'mimetype'].includes(path.basename(relative))) return true;
  return TEXT_EXTENSIONS.has(path.extname(relative));
}

function readAllowlist(root) {
  const file = path.join(root, ALLOWLIST_FILE);
  if (!fs.existsSync(file)) return [];
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('third-party naming allowlist must be an array');
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.file !== 'string' ||
      typeof entry.text !== 'string' ||
      typeof entry.reason !== 'string' ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1 ||
      !entry.file ||
      !entry.text ||
      !entry.reason
    ) {
      throw new Error(
        'third-party naming allowlist entries require file, text, count, and reason',
      );
    }
  }
  return entries;
}

function removeAllowedText(relative, text, allowlist) {
  let residual = text;
  for (const entry of allowlist.filter((candidate) => candidate.file === relative)) {
    const actualCount = residual.split(entry.text).length - 1;
    if (actualCount !== entry.count) {
      throw new Error(
        `third-party naming allowlist count mismatch: ${entry.file} ${entry.text} expected ${entry.count}, found ${actualCount}`,
      );
    }
    residual = residual.split(entry.text).join('');
  }
  return residual;
}

function findingsForText(relative, text, allowlist) {
  if (relative === ALLOWLIST_FILE) return [];
  const basename = path.basename(relative);
  const inspectableText =
    basename === 'package-lock.json'
      ? text.replace(/("integrity"\s*:\s*")[^"]+(")/g, '$1<opaque digest>$2')
      : relative.startsWith('fixtures/runtime-candidates/')
        ? text.replace(
            /("(?:integrity|sha1|sha256|sha512)"\s*:\s*")[^"]+(")/g,
            '$1<opaque digest>$2',
          )
        : text;
  const residual = removeAllowedText(relative, inspectableText, allowlist);
  const findings = [];
  const lines = residual.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const [rule, pattern] of [
      ['generation-style label', GENERATION_PATTERN],
      ['generation-style tag template', TEMPLATE_PATTERN],
      ['generation-style implementation identifier', IDENTIFIER_PATTERN],
    ]) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) findings.push({ file: relative, line: index + 1, rule });
    }
  }
  return findings;
}

function scanTree(root) {
  const allowlist = readAllowlist(root);
  const files = listFiles(root).sort();
  const findings = [];
  for (const relative of files) {
    findings.push(...findingsForText(relative, relative, []));
    if (!isTextFile(relative)) continue;
    findings.push(
      ...findingsForText(relative, fs.readFileSync(path.join(root, relative), 'utf8'), allowlist),
    );
  }
  return findings;
}

function scanPackedArtifact(root) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-cli-names-'));
  const invocation = resolveTrustedNpmInvocation(root);
  const allowlist = readAllowlist(root);
  try {
    const result = spawnSync(
      invocation.command,
      [
        ...invocation.prefixArgs,
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporary,
        '--registry=https://registry.npmjs.org/',
        '--@aikdna:registry=https://registry.npmjs.org/',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: invocation.environment,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
      },
    );
    if (result.error || result.status !== 0 || result.signal) {
      throw new Error('trusted npm public-surface pack failed');
    }
    const reports = JSON.parse(result.stdout);
    if (!Array.isArray(reports) || reports.length !== 1 || !reports[0].filename) {
      throw new Error('trusted npm public-surface pack returned invalid JSON');
    }
    const tarball = path.join(temporary, reports[0].filename);
    const findings = [];
    for (const entry of readTarFileEntries(tarball)) {
      if (!entry.path.startsWith('package/')) {
        throw new Error(`public package entry escaped its root: ${entry.path}`);
      }
      const relative = entry.path.slice('package/'.length);
      findings.push(...findingsForText(relative, relative, []));
      if (!isTextFile(relative)) continue;
      findings.push(...findingsForText(relative, entry.bytes.toString('utf8'), allowlist));
    }
    return findings.map((finding) => ({ ...finding, file: `npm-pack/${finding.file}` }));
  } finally {
    invocation.cleanup();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const findings = [...scanTree(root), ...scanPackedArtifact(root)];
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
    }
    throw new Error(`current protocol naming gate found ${findings.length} issue(s)`);
  }
  console.log('Current protocol naming gate passed');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { findingsForText, scanPackedArtifact, scanTree };
