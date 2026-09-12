'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

test('exact dependency declarations reject content drift and unbound providers before material access', () => {
  const source = process.env.KDNA_CLI_TEST_BIN ? path.resolve(path.dirname(process.env.KDNA_CLI_TEST_BIN), '..') : path.resolve(__dirname, '../..');
  const scoped = createRequire(source + '/package.json');
  const pkg = JSON.parse(fs.readFileSync(source + '/package.json'));
  const binding = JSON.parse(fs.readFileSync(source + '/src/public-bindings.json'));
  const root = fs.mkdtempSync(path.join(process.env.KDNA_CLI_TEST_ROOT || os.tmpdir(), 'dependency-declarations-'));
  const installed = path.join(root, 'node_modules', pkg.name);
  function copy(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  for (const name of [...pkg.files, 'package.json']) copy(path.join(source, name), path.join(installed, name));
  for (const archive of binding.archives) {
    const resolved = scoped.resolve(archive.name);
    const suffix = path.sep + archive.publicEntry.split('/').join(path.sep);
    assert.ok(resolved.endsWith(suffix)); const original = resolved.slice(0, -suffix.length);
    for (const entry of archive.files) {
      const from = path.join(original, entry.path); const bytes = fs.readFileSync(from);
      assert.equal(bytes.length, entry.bytes); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
      copy(from, path.join(root, 'node_modules', archive.name, entry.path));
    }
  }
  const records = [];
  const bin = installed + '/bin/kdna-studio.js';
  function invoke(label, expected, args = ['verify', '--bundle', root + '/never-opened-material']) {
    const argv = [bin, ...args]; const start = new Date().toISOString();
    const result = spawnSync(process.execPath, argv, { cwd: root, env: process.env, encoding: 'utf8', timeout: 15000 });
    records.push({ label, argv: [process.execPath, ...argv], pid: result.pid, start, end: new Date().toISOString(), exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.signal, null); assert.equal(result.status, expected ? 2 : 0, result.stderr);
    if (expected) assert.equal(JSON.parse(result.stderr).code, expected);
    return result;
  }
  function mutate(label, file, changed, expected) {
    const bytes = fs.readFileSync(file);
    try { fs.writeFileSync(file, changed(bytes)); invoke(label, expected); }
    finally { fs.writeFileSync(file, bytes); }
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  const studio = root + '/node_modules/@aikdna/kdna-studio-core';
  try {
    mutate('same-version different bytes', studio + '/src/index.js', bytes => { const b = Buffer.from(bytes); b[0] ^= 1; return b; }, 'CLI_DEPENDENCY_CONTENT_MISMATCH');
    mutate('different version', studio + '/package.json', bytes => { const p = JSON.parse(bytes); p.version = '0.0.0-test'; return JSON.stringify(p); }, 'CLI_DEPENDENCY_MISMATCH');
    const extra = studio + '/unexpected-member';
    try { fs.writeFileSync(extra, 'synthetic'); invoke('extra member', 'CLI_DEPENDENCY_PATHSET_MISMATCH'); }
    finally { fs.unlinkSync(extra); }
    const nested = root + '/node_modules/@aikdna/kdna-read/node_modules';
    try {
      fs.mkdirSync(nested + '/@aikdna/kdna-core', { recursive: true });
      fs.writeFileSync(nested + '/@aikdna/kdna-core/package.json', JSON.stringify({ name: '@aikdna/kdna-core', version: '0.23.0' }));
      invoke('nested same-version Core', 'CLI_DEPENDENCY_PATHSET_MISMATCH');
    } finally { fs.rmSync(nested, { recursive: true }); }
    const optional = root + '/node_modules/cbor-extract';
    try {
      fs.mkdirSync(optional); fs.writeFileSync(optional + '/package.json', JSON.stringify({ name: 'cbor-extract', version: '0.0.0-test', main: 'index.js' }));
      fs.writeFileSync(optional + '/index.js', 'throw new Error("unbound provider executed");');
      invoke('unbound optional provider', 'CLI_OPTIONAL_DEPENDENCY_UNBOUND');
    } finally { fs.rmSync(optional, { recursive: true }); }
    assert.match(invoke('help', null, ['--help']).stdout, /kdna-studio session/);
    assert.equal(invoke('version', null, ['--version']).stdout.trim(), pkg.version);
  } finally {
    fs.writeFileSync(path.join(root, 'commands.json'), JSON.stringify({ records, synthetic: true, source }, null, 2) + '\n');
    console.log(JSON.stringify({ dependency_binding_evidence: root }));
  }
});
