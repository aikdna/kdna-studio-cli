#!/usr/bin/env node
'use strict';

// Exercise the shipped session API after an offline install from a new empty
// cache. Historical create/export/project tests do not select this graph.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyCurrentBinding, verifySourceCoordinate } = require('./verify-current-candidate-sources');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');
const { packIsolatedSource, assertReproduciblePackBytes } = require('./generate-release-evidence');
const root = path.resolve(__dirname, '..');

function main() {
  assert.deepEqual(process.argv.slice(2), []);
  const binding = verifyCurrentBinding();
  for (const entry of binding.packages) verifySourceCoordinate(entry);
  const invocation = resolveTrustedNpmInvocation(root);
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-current-chain-'));
  const consumer = path.join(temporary, 'consumer'), cache = path.join(temporary, 'empty-cache');
  function npm(args) {
    const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...args],
      { cwd: consumer, env: invocation.environment, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, `trusted npm ${args[0]} failed: ${result.stderr}`);
    return result;
  }
  try {
    fs.mkdirSync(consumer); fs.mkdirSync(cache);
    const packs = ['first', 'second'].map(label => {
      const destination = path.join(temporary, label); fs.mkdirSync(destination);
      return packIsolatedSource(invocation, root, destination);
    });
    assertReproduciblePackBytes(packs[0].bytes, packs[1].bytes);
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
    const dependencies = {}, overrides = {};
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/') || entry.optional) continue;
      const name = key.slice('node_modules/'.length);
      assert(!name.includes('node_modules/'), 'the bound graph cannot contain nested dependency copies');
      const archive = entry.resolved.startsWith('file:') ? path.resolve(root, entry.resolved.slice(5))
        : path.join(root, 'vendor', `${name.replace(/^@/u, '').replace('/', '-')}-${entry.version}.tgz`);
      assert.equal(path.dirname(archive), path.join(root, 'vendor'));
      assert(fs.existsSync(archive)); dependencies[name] = 'file:' + archive; overrides[name] = '$' + name;
    }
    dependencies['@aikdna/kdna-studio-cli'] = 'file:' + packs[0].artifact;
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
      name: 'studio-current-chain-consumer', version: '1.0.0', private: true, dependencies, overrides,
    }, null, 2) + '\n');
    assert.deepEqual(fs.readdirSync(cache), []);
    npm(['install', '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--cache', cache]);
    npm(['ls', '--all', '--offline', '--cache', cache]);
    const installed = JSON.parse(fs.readFileSync(path.join(consumer, 'package-lock.json')));
    const expected = Object.fromEntries(Object.entries(lock.packages).filter(([key, entry]) => key.startsWith('node_modules/') && !entry.optional)
      .map(([key, entry]) => [key, entry.version]));
    expected['node_modules/@aikdna/kdna-studio-cli'] = require('../package.json').version;
    const actual = Object.fromEntries(Object.entries(installed.packages).filter(([key, entry]) => key.startsWith('node_modules/') && !entry.optional)
      .map(([key, entry]) => [key, entry.version]));
    assert.deepEqual(actual, expected, 'packed install must have one exact bound dependency graph');
    const packageRoot = path.join(consumer, 'node_modules/@aikdna/kdna-studio-cli');
    const tests = ['terminal-session.test.cjs', 'protected-export-session.test.cjs'].map(name => path.join(root, 'tests/current-components', name));
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
      cwd: consumer, env: { ...invocation.environment, STUDIO_TEST_PACKAGE_ROOT: packageRoot,
        STUDIO_TEST_ARTIFACT_ROOT: path.join(temporary, 'session-artifacts') }, encoding: 'utf8', shell: false,
      maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, 'installed current session/protection tests failed');
    assert.match(result.stdout, /# fail 0\b/u); assert.match(result.stdout, /# skipped 0\b/u);
    console.log('Current packed candidate chain: two identical CLI packs; empty-cache offline exact graph; current session/save/read/verify and dual-slot protection passed; editorial_input=synthetic_fixture');
  } finally {
    invocation.cleanup();
    // Successful Studio delivery deliberately seals bundle directories. Only
    // the test's own temporary tree is made removable; never change a source
    // checkout or a caller's delivery directory, and never follow symlinks.
    function restoreTemporaryDirectory(directory) {
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      fs.chmodSync(directory, 0o700);
      for (const name of fs.readdirSync(directory)) restoreTemporaryDirectory(path.join(directory, name));
    }
    restoreTemporaryDirectory(temporary);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) main();
module.exports = { main };
