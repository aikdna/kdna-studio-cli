'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BINDING_PATH = 'fixtures/runtime-candidates/binding.json';
const AIKDNA_SCOPE = '@aikdna';
const AIKDNA_PACKAGE_RE = /^@aikdna\/[a-z0-9][a-z0-9._-]*$/;
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

function referencesAikdnaScope(value) {
  if (typeof value !== 'string') return false;
  const candidates = [];
  let candidate = value;
  for (let depth = 0; depth <= value.length; depth += 1) {
    candidates.push(candidate);
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      // A malformed escape remains invalid if an already decoded value references this scope.
      break;
    }
  }
  return candidates.some((candidate) =>
    candidate
      .replaceAll('\\', '/')
      .split('/')
      .some((segment) => segment.toLowerCase() === AIKDNA_SCOPE),
  );
}

function aikdnaDependencyNames(dependencies, label) {
  const names = [];
  for (const name of Object.keys(dependencies || {})) {
    if (!referencesAikdnaScope(name)) continue;
    assert(AIKDNA_PACKAGE_RE.test(name), `${label} AIKDNA package name invalid: ${name}`);
    names.push(name);
  }
  return names.sort();
}

function assertExactPackageNames(label, actualNames, expectedNames) {
  const counts = new Map();
  for (const name of actualNames) counts.set(name, (counts.get(name) || 0) + 1);
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  assert(duplicates.length === 0, `${label} contains duplicate packages: ${duplicates.join(', ')}`);

  const actual = new Set(actualNames);
  const expected = new Set(expectedNames);
  const missing = expectedNames.filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name)).sort();
  assert(
    missing.length === 0 && extra.length === 0,
    `${label} package set mismatch: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
  );
}

function parseLockPackagePath(lockPath) {
  assert(
    typeof lockPath === 'string' && lockPath.length > 0 && !lockPath.includes('\\'),
    `AIKDNA lock package path invalid: ${lockPath}`,
  );
  const segments = lockPath.split('/');
  assert(
    !segments.some((segment) => segment === '' || segment === '.' || segment === '..'),
    `AIKDNA lock package path invalid: ${lockPath}`,
  );

  const packages = [];
  let index = 0;
  while (index < segments.length) {
    assert(segments[index] === 'node_modules', `AIKDNA lock package path invalid: ${lockPath}`);
    index += 1;
    const first = segments[index];
    assert(first && first !== 'node_modules', `AIKDNA lock package path invalid: ${lockPath}`);
    if (first.startsWith('@')) {
      const leaf = segments[index + 1];
      assert(
        leaf && leaf !== 'node_modules' && !leaf.startsWith('@'),
        `AIKDNA lock package path invalid: ${lockPath}`,
      );
      index += 2;
      packages.push({ name: `${first}/${leaf}`, lockPath: segments.slice(0, index).join('/') });
    } else {
      index += 1;
      packages.push({ name: first, lockPath: segments.slice(0, index).join('/') });
    }
  }
  return packages;
}

function assertExactBoundLockPackages(packageLock, boundNames) {
  const occurrences = new Map([...boundNames].map((name) => [name, new Set()]));

  for (const lockPath of Object.keys(packageLock.packages || {})) {
    if (lockPath === '') continue;
    if (referencesAikdnaScope(lockPath)) {
      const packages = parseLockPackagePath(lockPath);
      for (const { name, lockPath: packagePath } of packages.filter(({ name }) =>
        referencesAikdnaScope(name),
      )) {
        assert(AIKDNA_PACKAGE_RE.test(name), `AIKDNA lock package name invalid: ${lockPath}`);
        assert(boundNames.has(name), `unbound AIKDNA lock package: ${name}`);
        occurrences.get(name).add(packagePath);
      }
    }
  }

  for (const name of boundNames) {
    const paths = [...occurrences.get(name)].sort();
    assert(
      paths.length === 1,
      `bound AIKDNA lock package must appear exactly once: ${name} count=${paths.length} paths=[${paths.join(', ')}]`,
    );
    assert(
      paths[0] === `node_modules/${name}`,
      `bound AIKDNA lock package must be top-level: ${name} path=${paths[0]}`,
    );
  }

  for (const [lockPath, locked] of Object.entries(packageLock.packages || {})) {
    if (lockPath === '') continue;
    if (typeof locked?.resolved === 'string' && locked.resolved.startsWith('file:')) {
      const directMatch = lockPath.match(/^node_modules\/(@aikdna\/[^/]+)$/);
      assert(
        directMatch && boundNames.has(directMatch[1]),
        `unbound file lock package: ${lockPath}`,
      );
    }
  }
}

function verifyCandidateBinding(root) {
  const binding = readJson(path.join(root, BINDING_PATH));
  const packageJson = readJson(path.join(root, 'package.json'));
  const packageLock = readJson(path.join(root, 'package-lock.json'));

  assert(binding.schema === 'kdna.runtime-candidate-binding', 'candidate binding schema mismatch');
  assert(binding.schema_version === '0.1.0', 'candidate binding schema version mismatch');
  assert(Array.isArray(binding.packages) && binding.packages.length > 0, 'candidate binding is empty');

  for (const entry of binding.packages) {
    assert(
      typeof entry.name === 'string' && AIKDNA_PACKAGE_RE.test(entry.name),
      'candidate package name invalid',
    );
  }
  const directNames = aikdnaDependencyNames(packageJson.dependencies, 'direct dependencies');
  const bindingNames = binding.packages.map((entry) => entry.name);
  assertExactPackageNames('candidate binding', bindingNames, directNames);
  assertExactPackageNames(
    'lock root AIKDNA dependencies',
    aikdnaDependencyNames(packageLock.packages?.['']?.dependencies, 'lock root dependencies'),
    directNames,
  );
  const boundNames = new Set(bindingNames);
  assertExactBoundLockPackages(packageLock, boundNames);

  for (const entry of binding.packages) {
    assert(SEMVER_RE.test(entry.version || ''), `candidate version invalid: ${entry.name}`);
    assert(COMMIT_RE.test(entry.commit || ''), `candidate commit audit reference invalid: ${entry.name}`);
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
