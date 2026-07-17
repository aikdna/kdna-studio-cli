'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');
const { resolveTrustedSystemGit } = require('./authoritative-git');
const {
  CANDIDATE_AUTHORITIES,
  CANDIDATE_WORKFLOW_PATH,
  readPinnedCandidateCommits,
} = require('./runtime-candidate-authority');
const {
  TRUSTED_NPM_INTEGRITY,
  TRUSTED_NPM_URL,
  TRUSTED_NPM_VERSION,
  extractTrustedNpmRelease,
  trustedTarballPath,
} = require('./trusted-npm-release');

const BINDING_PATH = 'fixtures/runtime-candidates/binding.json';
const AIKDNA_PACKAGE_RE = /^@aikdna\/[a-z0-9][a-z0-9._-]*$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
const CANDIDATE_ARTIFACT_RE = /^fixtures\/runtime-candidates\/[a-z0-9][a-z0-9._-]*\.tgz$/;
const CANDIDATE_PACK_STATUSES = Object.freeze([
  'candidate_source_pack_not_registry_artifact',
  'registry_artifact',
]);

function isValidCandidatePackStatus(status) {
  return CANDIDATE_PACK_STATUSES.includes(status);
}
const DEPENDENCY_MAP_NAMES = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]);
const STRICT_PACKAGE_INSTALL_EQUIVALENCE = Object.freeze({
  status: 'strict_install_equivalent',
  compared_fields: Object.freeze([
    'complete_entry_set',
    'canonical_path',
    'regular_file_type',
    'file_size',
    'file_mode',
    'file_bytes',
  ]),
  excluded_non_install_metadata: Object.freeze([
    'gzip_wrapper',
    'tar_mtime',
    'tar_uid',
    'tar_gid',
  ]),
});

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

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function createTrustedNodeEntry(nodeExecPath) {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'aikdna-trusted-node-'),
  );
  try {
    if (process.platform === 'win32') {
      const entry = path.join(directory, 'node.cmd');
      assert(!nodeExecPath.includes('"'), 'trusted Node executable path cannot contain quotes');
      fs.writeFileSync(entry, `@echo off\r\n"${nodeExecPath}" %*\r\n`, {
        flag: 'wx',
        mode: 0o700,
      });
      return Object.freeze({ directory, entry });
    }
    const entry = path.join(directory, 'node');
    fs.symlinkSync(nodeExecPath, entry, 'file');
    assert(
      fs.realpathSync(entry) === nodeExecPath,
      'trusted Node entry must resolve to the current Node executable',
    );
    return Object.freeze({ directory, entry });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function trustedNpmEnvironment({ baseEnvironment, nodeExecPath, nodeEntry, npmCliPath }) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase();
    if (
      normalized === 'node_options' ||
      normalized === 'node_path' ||
      normalized === 'npm_execpath' ||
      normalized === 'npm_node_execpath' ||
      normalized === 'npm_command' ||
      normalized.startsWith('npm_config_') ||
      normalized.startsWith('npm_lifecycle_') ||
      normalized.startsWith('npm_package_')
    ) {
      delete environment[key];
    }
  }
  const executableDirectories = [nodeEntry.directory, path.dirname(resolveTrustedSystemGit())];
  if (process.platform !== 'win32') executableDirectories.push('/usr/bin', '/bin');
  environment.PATH = [...new Set(executableDirectories)].join(path.delimiter);
  environment.NODE = nodeExecPath;
  environment.npm_execpath = npmCliPath;
  environment.npm_node_execpath = nodeExecPath;
  return Object.freeze(environment);
}

function resolveTrustedNpmInvocation(root, options = {}) {
  assert(
    options && typeof options === 'object' && !Array.isArray(options),
    'trusted npm options must be an object',
  );
  const nodeExecPath = path.resolve(options.nodeExecPath || process.execPath);
  assert(path.isAbsolute(nodeExecPath), 'trusted Node executable path must be absolute');
  const nodeStat = fs.lstatSync(nodeExecPath);
  assert(
    nodeStat.isFile() && !nodeStat.isSymbolicLink(),
    'trusted Node executable must be a regular non-symlink file',
  );
  assert(fs.realpathSync(nodeExecPath) === nodeExecPath, 'trusted Node executable path must be canonical');
  const rootReal = fs.realpathSync(root);
  const tarball = trustedTarballPath(options.tarballPath);
  assert(
    tarball !== rootReal && !isWithin(rootReal, tarball),
    'trusted npm release tarball must be outside the repository',
  );
  const extracted = extractTrustedNpmRelease(tarball);
  let nodeEntry;
  try {
    nodeEntry = createTrustedNodeEntry(nodeExecPath);
    return Object.freeze({
      command: nodeExecPath,
      prefixArgs: Object.freeze([extracted.cliPath]),
      environment: trustedNpmEnvironment({
        baseEnvironment: options.environment || process.env,
        nodeExecPath,
        nodeEntry,
        npmCliPath: extracted.cliPath,
      }),
      cleanup: () => {
        fs.rmSync(nodeEntry.directory, { recursive: true, force: true });
        extracted.cleanup();
      },
    });
  } catch (error) {
    extracted.cleanup();
    throw error;
  }
}

function strictRegistryLookup(name, version, options = {}) {
  const runner = options.runner || spawnSync;
  const invocation = resolveTrustedNpmInvocation(options.root || path.resolve(__dirname, '..'), {
    tarballPath: options.tarballPath,
    nodeExecPath: options.nodeExecPath,
    environment: options.environment,
  });
  let result;
  try {
    result = runner(
      invocation.command,
      [
        ...invocation.prefixArgs,
        'view',
        `${name}@${version}`,
        'name',
        'version',
        'dist.integrity',
        '--json',
        '--loglevel=silent',
        '--registry=https://registry.npmjs.org/',
        '--@aikdna:registry=https://registry.npmjs.org/',
      ],
      {
        encoding: 'utf8',
        env: invocation.environment,
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 30_000,
      },
    );
  } finally {
    invocation.cleanup();
  }
  assert(result && !result.error, 'registry dependency lookup failed');
  assert(
    result.status === 0 && result.signal == null,
    'registry dependency lookup was not successful',
  );
  assert(
    typeof result.stdout === 'string' && result.stdout.trim(),
    'registry dependency lookup returned no JSON',
  );
  assert(result.stderr === '', 'registry dependency lookup wrote unexpected stderr');
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    throw new Error('registry dependency lookup must return one complete JSON document');
  }
  assert(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata),
    'registry dependency metadata must be an object',
  );
  const fields = Object.keys(metadata).sort();
  assert(
    JSON.stringify(fields) === JSON.stringify(['dist.integrity', 'name', 'version']),
    'registry dependency metadata fields are not exact',
  );
  return metadata;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pathSegments(relativePath) {
  return relativePath.split(/[\\/]/);
}

function assertAuthorityFile(file, expectedRealPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`${label} is missing`);
  }
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  assert(stat.nlink === 1, `${label} must have exactly one hard link`);
  assert(fs.realpathSync(file) === expectedRealPath, `${label} escapes its canonical path`);
}

function tarString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function tarOctal(block, offset, length, field, label) {
  const raw = tarString(block, offset, length).trim();
  assert(/^[0-7]+$/.test(raw), `${label} ${field} is invalid`);
  const value = Number.parseInt(raw, 8);
  assert(Number.isSafeInteger(value) && value >= 0, `${label} ${field} is invalid`);
  return value;
}

function validateOptionalTarOctal(block, offset, length, field, label) {
  const raw = tarString(block, offset, length).trim();
  if (raw === '') return;
  assert(/^[0-7]+$/.test(raw), `${label} ${field} is invalid`);
  const value = Number.parseInt(raw, 8);
  assert(Number.isSafeInteger(value) && value >= 0, `${label} ${field} is invalid`);
}

function readTarFileEntriesFromBytes(compressed, label = 'candidate tar') {
  assert(Buffer.isBuffer(compressed), `${label} bytes must be a Buffer`);
  let archive;
  try {
    archive = zlib.gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  } catch {
    throw new Error(`${label} gzip stream is invalid`);
  }
  const entries = [];
  const paths = new Set();
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert(
        archive.subarray(offset).every((byte) => byte === 0),
        `${label} has data after its end marker`,
      );
      terminated = true;
      break;
    }
    const storedChecksum = tarOctal(header, 148, 8, 'header checksum', label);
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    assert(storedChecksum === actualChecksum, `${label} header checksum mismatch`);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    assert(
      entryPath &&
        /^[\x21-\x7e]+$/.test(entryPath) &&
        !entryPath.includes('\\') &&
        !path.posix.isAbsolute(entryPath) &&
        path.posix.normalize(entryPath) === entryPath &&
        !entryPath.split('/').some((segment) => ['', '.', '..'].includes(segment)) &&
        !paths.has(entryPath),
      `${label} entry path invalid: ${entryPath}`,
    );
    const mode = tarOctal(header, 100, 8, 'entry mode', label);
    validateOptionalTarOctal(header, 108, 8, 'uid', label);
    validateOptionalTarOctal(header, 116, 8, 'gid', label);
    validateOptionalTarOctal(header, 136, 12, 'mtime', label);
    const size = tarOctal(header, 124, 12, 'entry size', label);
    const type = header[156];
    assert(type === 0 || type === 48, `${label} entry type is unsupported: ${entryPath}`);
    assert(
      mode === 0o644 || mode === 0o755,
      `${label} entry mode is unsupported: ${entryPath}`,
    );
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    assert(bodyEnd <= archive.length, `${label} entry is truncated: ${entryPath}`);
    paths.add(entryPath);
    entries.push(
      Object.freeze({
        path: entryPath,
        mode,
        size,
        bytes: Buffer.from(archive.subarray(bodyStart, bodyEnd)),
      }),
    );
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  assert(terminated, `${label} end marker is missing`);
  assert(entries.length > 0, `${label} contains no regular files`);
  return Object.freeze(entries);
}

function readTarFileEntries(artifact) {
  return readTarFileEntriesFromBytes(fs.readFileSync(artifact));
}

function assertPackageTarInstallEquivalent(referenceBytes, candidateBytes, options = {}) {
  assert(
    options && typeof options === 'object' && !Array.isArray(options),
    'package install equivalence options must be an object',
  );
  const referenceEntries = readTarFileEntriesFromBytes(
    referenceBytes,
    options.referenceLabel || 'checked candidate artifact',
  );
  const candidateEntries = readTarFileEntriesFromBytes(
    candidateBytes,
    options.candidateLabel || 'candidate source pack',
  );
  const referenceByPath = new Map(referenceEntries.map((entry) => [entry.path, entry]));
  const candidateByPath = new Map(candidateEntries.map((entry) => [entry.path, entry]));
  const referencePaths = [...referenceByPath.keys()].sort();
  const candidatePaths = [...candidateByPath.keys()].sort();
  assert(
    JSON.stringify(candidatePaths) === JSON.stringify(referencePaths),
    'candidate source pack complete entry set differs from the checked artifact',
  );
  for (const entryPath of referencePaths) {
    const reference = referenceByPath.get(entryPath);
    const candidate = candidateByPath.get(entryPath);
    assert(
      candidate.size === reference.size,
      `candidate source pack file size differs: ${entryPath}`,
    );
    assert(
      candidate.mode === reference.mode,
      `candidate source pack file mode differs: ${entryPath}`,
    );
    assert(
      candidate.bytes.equals(reference.bytes),
      `candidate source pack file bytes differ: ${entryPath}`,
    );
  }
  return Object.freeze({
    ...STRICT_PACKAGE_INSTALL_EQUIVALENCE,
    entry_count: referencePaths.length,
  });
}

function tarPackageManifest(artifact) {
  const manifests = readTarFileEntries(artifact).filter(
    (entry) => entry.path === 'package/package.json',
  );
  assert(manifests.length === 1, 'candidate tar package manifest is missing or duplicated');
  return JSON.parse(manifests[0].bytes.toString('utf8'));
}

function decodedVariants(value) {
  if (typeof value !== 'string') return [];
  const candidates = [];
  let candidate = value;
  for (let depth = 0; depth <= value.length; depth += 1) {
    candidates.push(candidate);
    const decoded = candidate.replace(/(?:%[0-9A-Fa-f]{2})+/g, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
      }
    });
    if (decoded === candidate) break;
    candidate = decoded;
  }
  return candidates.map((valueToCheck) => valueToCheck.replaceAll('\\', '/'));
}

function aikdnaReferences(value) {
  const references = [];
  const pattern =
    /(?:^|[^A-Za-z0-9._-])(@aikdna\/[A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[^A-Za-z0-9._-])/gi;
  for (const candidate of decodedVariants(value)) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(candidate)) !== null) references.push(match[1]);
  }
  return [...new Set(references)];
}

function referencesAikdnaScope(value) {
  return aikdnaReferences(value).length > 0;
}

function assertDependencyMaps(container, label, directVersions, requireFormalMap = false) {
  for (const mapName of DEPENDENCY_MAP_NAMES) {
    for (const [name, spec] of Object.entries(container?.[mapName] || {})) {
      const nameReferences = aikdnaReferences(name);
      const specReferences = aikdnaReferences(spec);
      assert(
        specReferences.length === 0,
        `${label} contains an AIKDNA alias or encoded dependency spec: ${mapName}.${name}`,
      );
      if (nameReferences.length === 0) continue;
      assert(
        nameReferences.length === 1 && nameReferences[0] === name && AIKDNA_PACKAGE_RE.test(name),
        `${label} AIKDNA package name invalid: ${name}`,
      );
      assert(directVersions.has(name), `${label} references undeclared AIKDNA package: ${name}`);
      assert(
        !requireFormalMap || mapName === 'dependencies',
        `${label} AIKDNA package must be a formal dependency: ${name}`,
      );
      assert(
        spec === directVersions.get(name),
        `${label} AIKDNA dependency spec mismatch: ${name}`,
      );
    }
  }
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

function assertExactAikdnaLockPackages(packageLock, directNames, boundNames, directVersions) {
  const directSet = new Set(directNames);
  const occurrences = new Map(directNames.map((name) => [name, new Set()]));

  for (const [lockPath, locked] of Object.entries(packageLock.packages || {})) {
    if (lockPath === '') continue;
    if (referencesAikdnaScope(lockPath)) {
      const packages = parseLockPackagePath(lockPath);
      for (const { name, lockPath: packagePath } of packages.filter(({ name }) =>
        referencesAikdnaScope(name),
      )) {
        assert(AIKDNA_PACKAGE_RE.test(name), `AIKDNA lock package name invalid: ${lockPath}`);
        assert(directSet.has(name), `unbound AIKDNA lock package: ${name}`);
        occurrences.get(name).add(packagePath);
      }
    }
    const lockedNameReferences = aikdnaReferences(locked?.name);
    if (lockedNameReferences.length > 0) {
      assert(
        lockedNameReferences.length === 1 &&
          lockedNameReferences[0] === locked.name &&
          AIKDNA_PACKAGE_RE.test(locked.name),
        `AIKDNA lock package name invalid: ${lockPath}`,
      );
      assert(
        lockPath === `node_modules/${locked.name}`,
        `AIKDNA lock entry name/path mismatch: ${lockPath} name=${locked.name}`,
      );
      assert(directSet.has(locked.name), `unbound AIKDNA lock package: ${locked.name}`);
    }
    const resolvedReferences = aikdnaReferences(locked?.resolved);
    if (resolvedReferences.length > 0) {
      assert(
        resolvedReferences.length === 1 && directSet.has(resolvedReferences[0]),
        `unbound AIKDNA lock resolution: ${lockPath}`,
      );
      assert(
        lockPath === `node_modules/${resolvedReferences[0]}`,
        `AIKDNA lock resolution/path mismatch: ${lockPath}`,
      );
    }
    assertDependencyMaps(locked, `lock package ${lockPath}`, directVersions);
  }

  for (const name of directNames) {
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
    if (lockPath === '' || typeof locked?.resolved !== 'string') continue;
    if (locked.resolved.startsWith('file:')) {
      const directMatch = lockPath.match(/^node_modules\/(@aikdna\/[^/]+)$/);
      assert(
        directMatch && boundNames.has(directMatch[1]),
        `unbound file lock package: ${lockPath}`,
      );
    }
  }
}

function verifyCandidateBinding(root) {
  const rootReal = fs.realpathSync(root);
  const bindingPath = path.join(root, ...pathSegments(BINDING_PATH));
  const expectedBindingReal = path.join(rootReal, ...pathSegments(BINDING_PATH));
  assertAuthorityFile(bindingPath, expectedBindingReal, 'candidate binding');
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const workflowPath = path.join(root, ...pathSegments(CANDIDATE_WORKFLOW_PATH));
  assertAuthorityFile(packagePath, path.join(rootReal, 'package.json'), 'package manifest');
  assertAuthorityFile(lockPath, path.join(rootReal, 'package-lock.json'), 'package lock');
  assertAuthorityFile(
    workflowPath,
    path.join(rootReal, ...pathSegments(CANDIDATE_WORKFLOW_PATH)),
    'candidate source workflow',
  );
  const pinnedCommits = readPinnedCandidateCommits(root);
  const candidateEvidenceByName = new Map();
  for (const authority of CANDIDATE_AUTHORITIES) {
    const evidencePath = path.join(root, ...pathSegments(authority.evidencePath));
    assertAuthorityFile(
      evidencePath,
      path.join(rootReal, ...pathSegments(authority.evidencePath)),
      `candidate source evidence ${authority.name}`,
    );
    candidateEvidenceByName.set(authority.name, readJson(evidencePath));
  }
  const binding = readJson(bindingPath);
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);

  assert(packageLock.lockfileVersion === 3, 'package lock must use lockfileVersion 3');
  assert(
    packageLock.packages && typeof packageLock.packages === 'object',
    'package lock packages graph is missing',
  );
  assert(
    !Object.hasOwn(packageLock, 'dependencies'),
    'legacy top-level package lock dependencies are not permitted',
  );
  assert(
    packageLock.name === packageJson.name && packageLock.version === packageJson.version,
    'package lock identity mismatch',
  );
  assert(
    packageLock.packages['']?.name === packageJson.name &&
      packageLock.packages['']?.version === packageJson.version,
    'package lock root identity mismatch',
  );

  assert(binding.schema === 'kdna.runtime-candidate-binding', 'candidate binding schema mismatch');
  assert(binding.schema_version === '0.1.0', 'candidate binding schema version mismatch');
  assert(
    Array.isArray(binding.packages) && binding.packages.length > 0,
    'candidate binding is empty',
  );

  const directNames = aikdnaDependencyNames(packageJson.dependencies, 'direct dependencies');
  const directVersions = new Map(directNames.map((name) => [name, packageJson.dependencies[name]]));
  const directSet = new Set(directNames);
  assertDependencyMaps(packageJson, 'package manifest', directVersions, true);
  const bindingNames = binding.packages.map((entry) => entry.name);
  for (const name of bindingNames) {
    assert(
      typeof name === 'string' && AIKDNA_PACKAGE_RE.test(name),
      'candidate package name invalid',
    );
  }
  const uniqueBindingNames = [...new Set(bindingNames)];
  assert(
    uniqueBindingNames.length === bindingNames.length,
    'candidate binding contains duplicate packages',
  );
  assertExactPackageNames(
    'candidate binding',
    bindingNames,
    CANDIDATE_AUTHORITIES.map((authority) => authority.name),
  );
  const extraBindings = bindingNames.filter((name) => !directSet.has(name));
  assert(
    extraBindings.length === 0,
    `candidate binding contains non-direct packages: ${extraBindings.join(', ')}`,
  );

  assertExactPackageNames(
    'lock root AIKDNA dependencies',
    aikdnaDependencyNames(packageLock.packages?.['']?.dependencies, 'lock root dependencies'),
    directNames,
  );
  assertDependencyMaps(packageLock.packages?.[''], 'lock root', directVersions, true);
  const boundNames = new Set(bindingNames);
  assertExactAikdnaLockPackages(packageLock, directNames, boundNames, directVersions);

  for (const name of directNames) {
    const declared = packageJson.dependencies[name];
    assert(SEMVER_RE.test(declared || ''), `direct dependency must use exact SemVer: ${name}`);
    assert(
      packageLock.packages?.['']?.dependencies?.[name] === declared,
      `lock root dependency mismatch: ${name}`,
    );
    const locked = packageLock.packages?.[`node_modules/${name}`];
    assert(locked?.version === declared, `lock package version mismatch: ${name}`);
    assert(INTEGRITY_RE.test(locked.integrity || ''), `lock package integrity invalid: ${name}`);
    if (!boundNames.has(name)) {
      assert(
        locked.resolved === canonicalRegistryUrl(name, declared),
        `unbound AIKDNA dependency must use the canonical registry: ${name}`,
      );
    }
  }

  for (const entry of binding.packages) {
    assert(SEMVER_RE.test(entry.version || ''), `candidate version invalid: ${entry.name}`);
    assert(
      COMMIT_RE.test(entry.commit || ''),
      `candidate commit audit reference invalid: ${entry.name}`,
    );
    const authority = CANDIDATE_AUTHORITIES.find((candidate) => candidate.name === entry.name);
    const pinnedCommit = pinnedCommits.get(entry.name);
    const candidateEvidence = candidateEvidenceByName.get(entry.name);
    assert(authority && pinnedCommit && candidateEvidence, `candidate authority missing: ${entry.name}`);
    assert(
      authority.version === entry.version && entry.commit === pinnedCommit,
      `candidate commit does not match the CI pin: ${entry.name}`,
    );
    const registryArtifact = candidateEvidence.registry_artifact;
    const isPublishedRegistryArtifact =
      registryArtifact !== null &&
      typeof registryArtifact === 'object' &&
      registryArtifact.name === entry.name &&
      registryArtifact.version === entry.version &&
      typeof registryArtifact.publish_time === 'string' &&
      typeof registryArtifact.registry_url === 'string' &&
      typeof registryArtifact.tarball_url === 'string' &&
      INTEGRITY_RE.test(registryArtifact.integrity || '') &&
      /^[0-9a-f]{40}$/.test(registryArtifact.shasum || '');
    assert(
      registryArtifact === null || isPublishedRegistryArtifact,
      `candidate registry artifact evidence invalid: ${entry.name}`,
    );
    assert(
      candidateEvidence.evidence_kind === 'candidate_source_pack' &&
        candidateEvidence.package === entry.name &&
        candidateEvidence.version === entry.version &&
        candidateEvidence.git_head === pinnedCommit &&
        candidateEvidence.source_authority === 'exact_git_commit_tree' &&
        candidateEvidence.source_worktree_clean === true,
      `candidate source evidence mismatch: ${entry.name}`,
    );
    assert(
      typeof entry.artifact === 'string' &&
        CANDIDATE_ARTIFACT_RE.test(entry.artifact) &&
        /^[\x21-\x7e]+$/.test(entry.artifact) &&
        !entry.artifact.includes('\\') &&
        !path.isAbsolute(entry.artifact) &&
        path.posix.normalize(entry.artifact) === entry.artifact &&
        !entry.artifact.split('/').some((segment) => ['', '.', '..'].includes(segment)),
      `candidate artifact path invalid: ${entry.name}`,
    );

    const candidateDirectoryRelative = 'fixtures/runtime-candidates';
    const candidateDirectory = path.join(root, ...pathSegments(candidateDirectoryRelative));
    const expectedDirectoryReal = path.join(rootReal, ...pathSegments(candidateDirectoryRelative));
    let directoryStat;
    try {
      directoryStat = fs.lstatSync(candidateDirectory);
    } catch {
      throw new Error('candidate artifact directory is missing');
    }
    assert(
      directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
      'candidate artifact directory must be a regular non-symlink directory',
    );
    assert(
      fs.realpathSync(candidateDirectory) === expectedDirectoryReal,
      'candidate artifact directory escapes the repository',
    );
    const artifact = path.join(root, ...pathSegments(entry.artifact));
    const expectedArtifactReal = path.join(rootReal, ...pathSegments(entry.artifact));
    assertAuthorityFile(artifact, expectedArtifactReal, `candidate artifact ${entry.name}`);
    const bytes = fs.readFileSync(artifact);
    assert(
      entry.integrity === `sha512-${digest(bytes, 'sha512', 'base64')}`,
      `candidate integrity mismatch: ${entry.name}`,
    );
    assert(
      entry.sha256 === digest(bytes, 'sha256', 'hex'),
      `candidate sha256 mismatch: ${entry.name}`,
    );
    const entries = readTarFileEntries(artifact);
    const unpackedSize = entries.reduce((total, candidate) => total + candidate.size, 0);
    const expectedFilename =
      `${entry.name.slice(1).replace('/', '-')}-${entry.version}.tgz`;
    assert(
      candidateEvidence.pack?.status && isValidCandidatePackStatus(candidateEvidence.pack.status) &&
        candidateEvidence.pack?.npm_client === TRUSTED_NPM_VERSION &&
        candidateEvidence.pack?.npm_release_url === TRUSTED_NPM_URL &&
        candidateEvidence.pack?.npm_release_integrity === TRUSTED_NPM_INTEGRITY &&
        candidateEvidence.pack?.filename === expectedFilename &&
        candidateEvidence.pack?.size === bytes.length &&
        candidateEvidence.pack?.unpacked_size === unpackedSize &&
        candidateEvidence.pack?.entry_count === entries.length &&
        candidateEvidence.pack?.sha1 === digest(bytes, 'sha1', 'hex') &&
        candidateEvidence.pack?.sha256 === entry.sha256 &&
        candidateEvidence.pack?.sha512 === entry.integrity &&
        candidateEvidence.pack?.reproducible_runs === 2 &&
        JSON.stringify(candidateEvidence.pack?.source_equivalence) ===
          JSON.stringify(STRICT_PACKAGE_INSTALL_EQUIVALENCE),
      `candidate pack evidence mismatch: ${entry.name}`,
    );

    const packedPackage = tarPackageManifest(artifact);
    assert(packedPackage.name === entry.name, `candidate tar package name mismatch: ${entry.name}`);
    assert(
      packedPackage.version === entry.version,
      `candidate tar version mismatch: ${entry.name}`,
    );
    assert(
      packageJson.dependencies?.[entry.name] === entry.version,
      `package dependency mismatch: ${entry.name}`,
    );

    const locked = packageLock.packages?.[`node_modules/${entry.name}`];
    assert(locked.integrity === entry.integrity, `lock package integrity mismatch: ${entry.name}`);
    const allowedResolutions = new Set([
      `file:${entry.artifact}`,
      canonicalRegistryUrl(entry.name, entry.version),
    ]);
    assert(
      allowedResolutions.has(locked.resolved),
      `lock package resolution invalid: ${entry.name}`,
    );
  }

  if (fs.existsSync(path.join(root, 'node_modules'))) verifyInstalledAikdnaGraph(root);
  return binding;
}

function verifyInstalledAikdnaGraph(root) {
  const rootReal = fs.realpathSync(root);
  const packagePath = path.join(root, 'package.json');
  assertAuthorityFile(packagePath, path.join(rootReal, 'package.json'), 'package manifest');
  const packageJson = readJson(packagePath);
  const directNames = aikdnaDependencyNames(packageJson.dependencies, 'direct dependencies');
  const directVersions = new Map(directNames.map((name) => [name, packageJson.dependencies[name]]));
  for (const [name, version] of directVersions) {
    assert(SEMVER_RE.test(version || ''), `direct dependency must use exact SemVer: ${name}`);
  }
  assertDependencyMaps(packageJson, 'package manifest', directVersions, true);

  const occurrences = new Map(directNames.map((name) => [name, []]));
  const visitedNodeModules = new Set();
  const visitedManifests = new Set();

  function inspectInstalledManifest(packageDirectory, manifestPath) {
    const manifestStat = fs.lstatSync(manifestPath);
    assert(
      manifestStat.isFile() && !manifestStat.isSymbolicLink(),
      `installed package manifest must be a regular non-symlink file: ${manifestPath}`,
    );
    assert(
      manifestStat.nlink === 1,
      `installed package manifest must have exactly one hard link: ${manifestPath}`,
    );
    const manifestReal = fs.realpathSync(manifestPath);
    if (visitedManifests.has(manifestReal)) return;
    visitedManifests.add(manifestReal);
    const manifest = readJson(manifestPath);
    const references = aikdnaReferences(manifest.name);
    if (references.length === 0) return;
    assert(
      references.length === 1 &&
        references[0] === manifest.name &&
        AIKDNA_PACKAGE_RE.test(manifest.name),
      `installed AIKDNA package name invalid: ${String(manifest.name)}`,
    );
    assert(
      directVersions.has(manifest.name),
      `installed undeclared AIKDNA package: ${manifest.name}`,
    );
    const expectedDirectory = path.join(rootReal, 'node_modules', ...manifest.name.split('/'));
    const actualDirectory = fs.realpathSync(packageDirectory);
    assert(
      actualDirectory === expectedDirectory,
      `installed AIKDNA package is not at its canonical top-level path: ${manifest.name} ${actualDirectory}`,
    );
    assert(
      manifest.version === directVersions.get(manifest.name),
      `installed AIKDNA package version mismatch: ${manifest.name}`,
    );
    occurrences.get(manifest.name).push(actualDirectory);
  }

  function scanPackage(packageDirectory) {
    const packageStat = fs.lstatSync(packageDirectory);
    assert(
      packageStat.isDirectory() && !packageStat.isSymbolicLink(),
      `installed package path must be a regular non-symlink directory: ${packageDirectory}`,
    );
    scanForNestedNodeModules(packageDirectory);
  }

  function scanForNestedNodeModules(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name === 'package.json') {
        inspectInstalledManifest(directory, entryPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`installed package tree contains a symlink: ${entryPath}`);
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase() === 'node_modules') {
        assert(
          entry.name === 'node_modules',
          `node_modules path has non-canonical case: ${entryPath}`,
        );
        scanNodeModules(entryPath);
      } else {
        scanForNestedNodeModules(entryPath);
      }
    }
  }

  function scanNodeModules(nodeModules) {
    const nodeModulesStat = fs.lstatSync(nodeModules);
    assert(
      nodeModulesStat.isDirectory() && !nodeModulesStat.isSymbolicLink(),
      `node_modules must be a regular non-symlink directory: ${nodeModules}`,
    );
    const nodeModulesReal = fs.realpathSync(nodeModules);
    assert(
      nodeModulesReal === path.join(rootReal, path.relative(root, nodeModules)),
      `node_modules escapes the installation root: ${nodeModules}`,
    );
    assert(
      !visitedNodeModules.has(nodeModulesReal),
      `node_modules graph contains a cycle: ${nodeModules}`,
    );
    visitedNodeModules.add(nodeModulesReal);

    for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
      const entryPath = path.join(nodeModules, entry.name);
      if (entry.name === '.bin') {
        assert(
          entry.isDirectory() && !entry.isSymbolicLink(),
          `.bin must be a regular non-symlink directory: ${entryPath}`,
        );
        assert(
          fs.realpathSync(entryPath) === path.join(nodeModulesReal, '.bin'),
          `.bin escapes its canonical path: ${entryPath}`,
        );
        for (const executable of fs.readdirSync(entryPath, { withFileTypes: true })) {
          const executablePath = path.join(entryPath, executable.name);
          if (executable.isSymbolicLink()) {
            let executableStat;
            try {
              executableStat = fs.statSync(executablePath);
            } catch {
              throw new Error(`.bin contains a broken symlink: ${executablePath}`);
            }
            assert(
              executableStat.isFile(),
              `.bin symlink must target a regular file: ${executablePath}`,
            );
            const executableReal = fs.realpathSync(executablePath);
            assert(
              executableReal.startsWith(`${rootReal}${path.sep}`),
              `.bin symlink escapes the installation root: ${executablePath}`,
            );
          } else {
            assert(executable.isFile(), `.bin must not contain directories: ${executablePath}`);
          }
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`installed package graph contains a symlink: ${entryPath}`);
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('@')) {
        for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
          const scopedPath = path.join(entryPath, scopedEntry.name);
          assert(
            scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink(),
            `installed scoped package path must be a regular non-symlink directory: ${scopedPath}`,
          );
          scanPackage(scopedPath);
        }
      } else {
        scanPackage(entryPath);
      }
    }
  }

  const rootNodeModules = path.join(root, 'node_modules');
  assert(fs.existsSync(rootNodeModules), 'node_modules is missing');
  scanNodeModules(rootNodeModules);
  for (const name of directNames) {
    const paths = occurrences.get(name);
    assert(
      paths.length === 1,
      `installed AIKDNA package must appear exactly once: ${name} count=${paths.length}`,
    );
  }
  return Object.freeze(
    Object.fromEntries(directNames.map((name) => [name, directVersions.get(name)])),
  );
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
  }

  const lookup = registryLookup || strictRegistryLookup;
  for (const entry of binding.packages) {
    const metadata = lookup(entry.name, entry.version);
    assert(metadata.name === entry.name, `registry package name mismatch: ${entry.name}`);
    assert(metadata.version === entry.version, `registry package version mismatch: ${entry.name}`);
    assert(
      metadata['dist.integrity'] === entry.integrity,
      `registry integrity mismatch: ${entry.name}`,
    );
  }
  return binding;
}

module.exports = {
  BINDING_PATH,
  STRICT_PACKAGE_INSTALL_EQUIVALENCE,
  assertPackageTarInstallEquivalent,
  assertRegistryReleaseReady,
  canonicalRegistryUrl,
  resolveTrustedNpmInvocation,
  readTarFileEntries,
  readTarFileEntriesFromBytes,
  strictRegistryLookup,
  verifyCandidateBinding,
  verifyInstalledAikdnaGraph,
};
