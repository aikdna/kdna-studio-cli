'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BINDING_PATH = 'fixtures/runtime-candidates/binding.json';
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(bytes, algorithm, encoding) {
  return crypto.createHash(algorithm).update(bytes).digest(encoding);
}

function canonicalRegistryUrl(name, version) {
  const leaf = name.slice(name.indexOf('/') + 1);
  return `https://registry.npmjs.org/${name}/-/${leaf}-${version}.tgz`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function tarPackageManifest(artifact) {
  return JSON.parse(
    execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }),
  );
}

function verifyCandidateBinding(root) {
  const binding = readJson(path.join(root, BINDING_PATH));
  const packageJson = readJson(path.join(root, 'package.json'));
  const packageLock = readJson(path.join(root, 'package-lock.json'));

  assert(binding.schema === 'kdna.runtime-candidate-binding', 'candidate binding schema mismatch');
  assert(binding.schema_version === '0.1.0', 'candidate binding schema version mismatch');
  assert(Array.isArray(binding.packages) && binding.packages.length > 0, 'candidate binding is empty');

  for (const entry of binding.packages) {
    assert(typeof entry.name === 'string' && entry.name.startsWith('@aikdna/'), 'candidate package name invalid');
    assert(SEMVER_RE.test(entry.version || ''), `candidate version invalid: ${entry.name}`);
    assert(COMMIT_RE.test(entry.commit || ''), `candidate commit invalid: ${entry.name}`);
    assert(
      typeof entry.artifact === 'string' &&
        entry.artifact.startsWith('fixtures/runtime-candidates/') &&
        !path.isAbsolute(entry.artifact) &&
        !entry.artifact.split('/').includes('..'),
      `candidate artifact path invalid: ${entry.name}`,
    );

    const artifact = path.join(root, entry.artifact);
    const bytes = fs.readFileSync(artifact);
    assert(
      entry.integrity === `sha512-${digest(bytes, 'sha512', 'base64')}`,
      `candidate integrity mismatch: ${entry.name}`,
    );
    assert(entry.sha256 === digest(bytes, 'sha256', 'hex'), `candidate sha256 mismatch: ${entry.name}`);

    const packedPackage = tarPackageManifest(artifact);
    assert(packedPackage.name === entry.name, `candidate tar package name mismatch: ${entry.name}`);
    assert(packedPackage.version === entry.version, `candidate tar version mismatch: ${entry.name}`);
    assert(packageJson.dependencies?.[entry.name] === entry.version, `package dependency mismatch: ${entry.name}`);
    assert(
      packageLock.packages?.['']?.dependencies?.[entry.name] === entry.version,
      `lock root dependency mismatch: ${entry.name}`,
    );

    const locked = packageLock.packages?.[`node_modules/${entry.name}`];
    assert(locked?.version === entry.version, `lock package version mismatch: ${entry.name}`);
    assert(locked.integrity === entry.integrity, `lock package integrity mismatch: ${entry.name}`);
    const allowedResolutions = new Set([
      `file:${entry.artifact}`,
      canonicalRegistryUrl(entry.name, entry.version),
    ]);
    assert(allowedResolutions.has(locked.resolved), `lock package resolution invalid: ${entry.name}`);
  }

  return binding;
}

function assertRegistryReleaseReady(root, registryLookup = null) {
  const binding = verifyCandidateBinding(root);
  const packageLock = readJson(path.join(root, 'package-lock.json'));
  for (const entry of binding.packages) {
    const locked = packageLock.packages[`node_modules/${entry.name}`];
    const registryUrl = canonicalRegistryUrl(entry.name, entry.version);
    assert(
      locked.resolved === registryUrl,
      `registry dependency gate blocked: ${entry.name}@${entry.version} is still candidate-bound`,
    );
    const lookup = registryLookup || ((name, version) => {
      const output = execFileSync(
        'npm',
        ['view', `${name}@${version}`, 'name', 'version', 'dist.integrity', '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return JSON.parse(output);
    });
    const metadata = lookup(entry.name, entry.version);
    assert(metadata.name === entry.name, `registry package name mismatch: ${entry.name}`);
    assert(metadata.version === entry.version, `registry package version mismatch: ${entry.name}`);
    assert(metadata['dist.integrity'] === entry.integrity, `registry integrity mismatch: ${entry.name}`);
  }
  return binding;
}

module.exports = {
  assertRegistryReleaseReady,
  canonicalRegistryUrl,
  verifyCandidateBinding,
};
