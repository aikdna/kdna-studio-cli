'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const TRUSTED_NPM_VERSION = '11.17.0';
const TRUSTED_NPM_URL = 'https://registry.npmjs.org/npm/-/npm-11.17.0.tgz';
const TRUSTED_NPM_INTEGRITY =
  'sha512-PurxiZexEHDTE4SSaLI3ZrnbAGiZfeyUcQcxcP5D+hfytNAze/D1IzDuInTn9XVLIbAQUnQuSPXJx02LHjLvQw==';
const TRUSTED_NPM_ENVIRONMENT = 'KDNA_TRUSTED_NPM_TARBALL';
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

function defaultTrustedNpmTarball() {
  return path.join(os.tmpdir(), 'aikdna-trusted-tools', `npm-${TRUSTED_NPM_VERSION}.tgz`);
}

function canonicalizeParent(file) {
  const absolute = path.resolve(file);
  const pending = [path.basename(absolute)];
  let ancestor = path.dirname(absolute);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    assert.notEqual(parent, ancestor, 'trusted npm release path has no existing ancestor');
    pending.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const stat = fs.statSync(ancestor);
  assert.ok(stat.isDirectory(), 'trusted npm release parent must resolve through a directory');
  return path.join(fs.realpathSync(ancestor), ...pending);
}

function assertRegularCanonicalFile(file, label) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  assert.equal(stat.nlink, 1, `${label} must have exactly one hard link`);
  assert.equal(fs.realpathSync(file), file, `${label} path must be canonical`);
  return stat;
}

function trustedTarballPath(explicitPath = process.env[TRUSTED_NPM_ENVIRONMENT]) {
  return canonicalizeParent(explicitPath || defaultTrustedNpmTarball());
}

function verifyTrustedNpmTarball(file) {
  const canonical = trustedTarballPath(file);
  const stat = assertRegularCanonicalFile(canonical, 'trusted npm release tarball');
  assert.ok(
    stat.size > 0 && stat.size <= MAX_COMPRESSED_BYTES,
    'trusted npm release tarball size is invalid',
  );
  const bytes = fs.readFileSync(canonical);
  const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(
    integrity,
    TRUSTED_NPM_INTEGRITY,
    `trusted npm release tarball integrity must equal the audited npm ${TRUSTED_NPM_VERSION} release`,
  );
  return bytes;
}

function tarString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function tarOctal(block, offset, length, label) {
  const raw = tarString(block, offset, length).trim();
  assert.match(raw, /^[0-7]+$/, `trusted npm tar ${label} is invalid`);
  const value = Number.parseInt(raw, 8);
  assert.ok(Number.isSafeInteger(value) && value >= 0, `trusted npm tar ${label} is invalid`);
  return value;
}

function readTrustedNpmEntries(bytes) {
  let archive;
  try {
    archive = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new Error('trusted npm release gzip stream is invalid');
  }
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(
        archive.subarray(offset).every((byte) => byte === 0),
        'trusted npm tar has bytes after its end marker',
      );
      terminated = true;
      break;
    }
    const storedChecksum = tarOctal(header, 148, 8, 'header checksum');
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    assert.equal(storedChecksum, actualChecksum, 'trusted npm tar header checksum mismatch');
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    assert.ok(
      entryPath.startsWith('package/') &&
        /^[\x21-\x7e]+$/.test(entryPath) &&
        !entryPath.includes('\\') &&
        !path.posix.isAbsolute(entryPath) &&
        path.posix.normalize(entryPath) === entryPath &&
        !entryPath.split('/').some((segment) => ['', '.', '..'].includes(segment)) &&
        !seen.has(entryPath),
      `trusted npm tar entry path is invalid: ${entryPath}`,
    );
    const type = header[156];
    assert.ok(type === 0 || type === 48, `trusted npm tar entry type is unsupported: ${entryPath}`);
    const size = tarOctal(header, 124, 12, 'entry size');
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    assert.ok(bodyEnd <= archive.length, `trusted npm tar entry is truncated: ${entryPath}`);
    seen.add(entryPath);
    entries.push({ path: entryPath, bytes: Buffer.from(archive.subarray(bodyStart, bodyEnd)) });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  assert.ok(terminated, 'trusted npm tar end marker is missing');
  assert.equal(entries.length, 1938, 'trusted npm tar entry count is not the audited release');
  return entries;
}

function extractTrustedNpmRelease(file) {
  const bytes = verifyTrustedNpmTarball(file);
  const entries = readTrustedNpmEntries(bytes);
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aikdna-trusted-npm-'));
  let complete = false;
  try {
    for (const entry of entries) {
      const destination = path.join(temporary, ...entry.path.split('/'));
      const relative = path.relative(temporary, destination);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, entry.bytes, { flag: 'wx', mode: 0o600 });
    }
    const npmRoot = path.join(temporary, 'package');
    const manifestPath = path.join(npmRoot, 'package.json');
    const cliPath = path.join(npmRoot, 'bin', 'npm-cli.js');
    assertRegularCanonicalFile(manifestPath, 'extracted npm manifest');
    assertRegularCanonicalFile(cliPath, 'extracted npm CLI');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'npm', 'audited npm manifest package name is invalid');
    assert.equal(manifest.version, TRUSTED_NPM_VERSION, 'audited npm manifest version is invalid');
    complete = true;
    return Object.freeze({
      cliPath,
      root: temporary,
      cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }),
    });
  } finally {
    if (!complete) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = {
  TRUSTED_NPM_ENVIRONMENT,
  TRUSTED_NPM_INTEGRITY,
  TRUSTED_NPM_URL,
  TRUSTED_NPM_VERSION,
  canonicalizeParent,
  defaultTrustedNpmTarball,
  extractTrustedNpmRelease,
  trustedTarballPath,
  verifyTrustedNpmTarball,
};
