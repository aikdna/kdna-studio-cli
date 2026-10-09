#!/usr/bin/env node
'use strict';

// The current vendored candidate has its own source authority. Historical
// registry fixtures remain test material and never select the shipped graph.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { generate } = require('./generate-current-bindings');
const { checkRepository } = require('./dependency-coordinate-policy');
const { authoritativeGit, assertNoReplacementRefs, materializeCommitTree } = require('./authoritative-git');
const { assertPackageTarInstallEquivalent, resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');
const root = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function verifyCurrentBinding() {
  assert.deepEqual(checkRepository(root), []);
  const { target, result } = generate();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, target))), result);
  const binding = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/runtime-candidates/current-sources.json')));
  assert.equal(binding.schema, 'kdna.current-candidate-sources');
  const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const names = Object.keys(locked.packages).filter(key => key.startsWith('node_modules/@aikdna/')).map(key => key.slice(13)).sort();
  assert.deepEqual(binding.packages.map(entry => entry.name).sort(), names);
  for (const entry of binding.packages) {
    assert(/^[a-f0-9]{40}$/u.test(entry.commit), 'source commit must be exact');
    assert(/^[a-f0-9]{40}$/u.test(entry.tree), 'source package tree must be exact');
    assert(/^aikdna\/[a-z0-9-]+$/u.test(entry.repository), 'source repository must have an explicit public owner');
    assert.equal(locked.packages['node_modules/' + entry.name].resolved, 'file:' + entry.artifact, 'source archive must be the exact installed coordinate');
    assert(/^[A-Z][A-Z0-9_]+$/u.test(entry.sourceEnvironment), 'source environment must be explicit');
    assert(/^vendor\/[a-z0-9.-]+\.tgz$/u.test(entry.artifact), 'candidate archive path is invalid');
    assert.equal(digest(fs.readFileSync(path.join(root, entry.artifact))), entry.sha256);
    assert.equal(locked.packages['node_modules/' + entry.name].version, entry.version);
  }
  return binding;
}

function verifySourceCoordinate(entry) {
  const repository = process.env[entry.sourceEnvironment];
  assert(repository, `${entry.sourceEnvironment} is required`);
  assertNoReplacementRefs(repository);
  assert.equal(authoritativeGit(repository, ['rev-parse', `${entry.commit}^{commit}`]), entry.commit);
  assert.equal(authoritativeGit(repository, ['rev-parse', `${entry.commit}:${entry.packageDirectory || ''}`.replace(/:$/u, '^{tree}')]), entry.tree);
  return repository;
}

function main() {
  assert.deepEqual(process.argv.slice(2), []);
  const binding = verifyCurrentBinding();
  const invocation = resolveTrustedNpmInvocation(root);
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-current-source-'));
  try {
    for (const [index, entry] of binding.packages.entries()) {
      const repository = verifySourceCoordinate(entry);
      const archives = [];
      for (const label of ['first', 'second']) {
        const source = path.join(temporary, `source-${index}-${label}`), packed = path.join(temporary, `pack-${index}-${label}`);
        fs.mkdirSync(source); fs.mkdirSync(packed);
        materializeCommitTree(repository, entry.commit, entry.packageDirectory, source, { requiredPath: 'package.json' });
        const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
        assert.equal(manifest.name, entry.name); assert.equal(manifest.version, entry.version);
        const run = spawnSync(invocation.command, [...invocation.prefixArgs, 'pack', '--ignore-scripts', '--json', '--pack-destination', packed],
          { cwd: source, env: invocation.environment, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: false });
        assert.equal(run.error, undefined); assert.equal(run.signal, null); assert.equal(run.status, 0, run.stderr);
        const reports = JSON.parse(run.stdout); assert.equal(reports.length, 1);
        assert.equal(path.basename(reports[0].filename), reports[0].filename);
        archives.push(fs.readFileSync(path.join(packed, reports[0].filename)));
      }
      assert(archives[0].equals(archives[1]), 'two exact source packs must be byte-identical');
      const compared = assertPackageTarInstallEquivalent(fs.readFileSync(path.join(root, entry.artifact)), archives[0]);
      console.log(`${entry.name}@${entry.version}: ${compared.status}; members=${compared.entry_count}; source=${entry.commit}`);
    }
  } finally { invocation.cleanup(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (require.main === module) main();
module.exports = { verifyCurrentBinding, verifySourceCoordinate, main };
