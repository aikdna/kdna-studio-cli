'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TRUSTED_GIT_CANDIDATES = Object.freeze(
  process.platform === 'win32'
    ? [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
      ]
    : ['/usr/bin/git', '/bin/git'],
);

function authoritativeGitNullDevice(platform = process.platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

function authoritativeGitEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('GIT_')) delete environment[key];
  }
  environment.GIT_CONFIG_GLOBAL = authoritativeGitNullDevice();
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_REPLACE_REF_BASE = 'refs/replace/';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.LANG = 'C';
  environment.LC_ALL = 'C';
  environment.PATH = process.platform === 'win32' ? '' : '/usr/bin:/bin';
  return environment;
}

let trustedSystemGit;

function resolveTrustedSystemGit() {
  if (trustedSystemGit) return trustedSystemGit;
  const failures = [];
  for (const candidate of TRUSTED_GIT_CANDIDATES) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.lstatSync(resolved);
      assert.ok(path.isAbsolute(resolved), 'trusted Git path must be absolute');
      assert.ok(
        stat.isFile() && !stat.isSymbolicLink(),
        'trusted Git must resolve to a regular non-symlink file',
      );
      if (process.platform !== 'win32') {
        assert.ok((stat.mode & 0o111) !== 0, 'trusted Git must be executable');
        assert.equal(stat.uid, 0, 'trusted Git must be owned by root');
        assert.equal(stat.mode & 0o022, 0, 'trusted Git must not be group- or world-writable');
      }
      const result = spawnSync(resolved, ['--version'], {
        cwd: path.parse(resolved).root,
        encoding: 'utf8',
        env: authoritativeGitEnvironment({}),
        maxBuffer: 1024 * 1024,
        shell: false,
      });
      assert.equal(result.error, undefined, 'trusted Git version probe failed to start');
      assert.equal(result.signal, null, 'trusted Git version probe was interrupted');
      assert.equal(result.status, 0, 'trusted Git version probe failed');
      assert.equal(result.stderr, '', 'trusted Git version probe wrote unexpected stderr');
      assert.match(result.stdout.trim(), /^git version \d+(?:\.\d+)+(?:[.\s-].*)?$/);
      trustedSystemGit = resolved;
      return trustedSystemGit;
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`no trusted system Git executable is available (${failures.join('; ')})`);
}

function canonicalRepository(repository) {
  const resolved = path.resolve(repository);
  const stat = fs.lstatSync(resolved);
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'authoritative Git repository must be a regular non-symlink directory',
  );
  assert.equal(
    fs.realpathSync(resolved),
    resolved,
    'authoritative Git repository path must be canonical',
  );
  return resolved;
}

function authoritativeGit(repository, args, options = {}) {
  const canonical = canonicalRepository(repository);
  const encoding = options.encoding === null ? null : 'utf8';
  const result = spawnSync(resolveTrustedSystemGit(), [
    '--no-replace-objects',
    '--literal-pathspecs',
    '-c',
    'core.useReplaceRefs=false',
    '-C',
    canonical,
    ...args,
  ], {
    cwd: path.parse(canonical).root,
    encoding,
    env: authoritativeGitEnvironment(options.environment),
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    shell: false,
  });
  assert.equal(result.error, undefined, 'authoritative Git command failed to start');
  assert.equal(result.signal, null, 'authoritative Git command was interrupted');
  assert.equal(result.status, 0, 'authoritative Git command failed');
  if (!options.allowStderr) {
    assert.equal(
      encoding === null ? result.stderr.length : result.stderr,
      encoding === null ? 0 : '',
      'authoritative Git command wrote unexpected stderr',
    );
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : result.stdout.trim();
}

function assertNoReplacementRefs(repository, options = {}) {
  assert.equal(
    authoritativeGit(
      repository,
      ['for-each-ref', '--format=%(refname)', 'refs/replace/'],
      options,
    ),
    '',
    'authoritative Git repository contains Git replacement refs',
  );
}

function assertNoHiddenIndexFlags(repository, options = {}) {
  const records = authoritativeGit(repository, ['ls-files', '-v', '-z'], {
    ...options,
    encoding: null,
  }).toString('utf8').split('\0').filter(Boolean);
  assert.deepEqual(
    records.filter((record) => !record.startsWith('H ')),
    [],
    'authoritative Git index contains assume-unchanged, skip-worktree, or non-ordinary entries',
  );
}

function materializeCommitTree(repository, expectedCommit, sourcePrefix, destination, options = {}) {
  const normalizedPrefix = sourcePrefix.split(path.sep).join('/');
  const args = ['ls-tree', '-r', '-t', '-z', '--full-tree', expectedCommit];
  if (normalizedPrefix) args.push('--', sourcePrefix);
  const listing = authoritativeGit(repository, args, {
    ...options,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  const destinationRoot = path.resolve(destination);
  const destinationStat = fs.lstatSync(destinationRoot);
  assert.ok(
    destinationStat.isDirectory() && !destinationStat.isSymbolicLink(),
    'commit materialization destination must be a regular non-symlink directory',
  );
  const seen = new Set();
  const records = [];
  let recordStart = 0;
  while (recordStart < listing.length) {
    const recordEnd = listing.indexOf(0, recordStart);
    assert.notEqual(recordEnd, -1, 'authoritative commit tree listing is not NUL terminated');
    assert.ok(recordEnd > recordStart, 'authoritative commit tree listing contains an empty record');
    records.push(listing.subarray(recordStart, recordEnd));
    recordStart = recordEnd + 1;
  }
  assert.ok(records.length > 0 && records.length <= 20_000, 'authoritative commit tree entry count is invalid');

  let regularFiles = 0;
  let totalBytes = 0;
  for (const record of records) {
    const separator = record.indexOf(9);
    assert.ok(separator > 0, 'authoritative commit tree record has no path separator');
    const header = record.subarray(0, separator).toString('ascii');
    const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([0-9a-f]{40})$/.exec(header);
    assert.ok(match, 'authoritative commit tree record header is invalid');
    const [, mode, type, objectId] = match;
    const canonicalEntry = record.subarray(separator + 1).toString('utf8');
    assert.ok(
      Buffer.from(canonicalEntry, 'utf8').equals(record.subarray(separator + 1)),
      'authoritative commit tree path is not valid UTF-8',
    );
    const isAncestorDirectory =
      Boolean(normalizedPrefix) &&
      mode === '040000' &&
      type === 'tree' &&
      normalizedPrefix.startsWith(`${canonicalEntry}/`);
    const isWithinPrefix =
      !normalizedPrefix ||
      isAncestorDirectory ||
      canonicalEntry === normalizedPrefix ||
      canonicalEntry.startsWith(`${normalizedPrefix}/`);
    assert.ok(isWithinPrefix, `authoritative commit tree escaped its source prefix: ${canonicalEntry}`);
    assert.ok(
      /^[\x21-\x7e]+$/.test(canonicalEntry) &&
        !canonicalEntry.includes('\\') &&
        !path.posix.isAbsolute(canonicalEntry) &&
        path.posix.normalize(canonicalEntry) === canonicalEntry &&
        !canonicalEntry.split('/').some((segment) => ['', '.', '..'].includes(segment)) &&
        !seen.has(canonicalEntry),
      `authoritative commit tree path is invalid: ${canonicalEntry}`,
    );
    const stripped = !normalizedPrefix
      ? canonicalEntry
      : isAncestorDirectory || canonicalEntry === normalizedPrefix
        ? ''
        : canonicalEntry.slice(normalizedPrefix.length + 1);
    if (mode === '040000') {
      assert.equal(type, 'tree', `authoritative commit directory type is invalid: ${canonicalEntry}`);
      if (stripped) {
        const output = path.join(destinationRoot, ...stripped.split('/'));
        fs.mkdirSync(output, { recursive: true, mode: 0o700 });
      }
    } else {
      assert.ok(
        (mode === '100644' || mode === '100755') && type === 'blob',
        `authoritative commit tree contains a symlink, gitlink, or unsupported mode: ${canonicalEntry}`,
      );
      assert.ok(stripped, 'authoritative source prefix must resolve to a directory');
      const output = path.join(destinationRoot, ...stripped.split('/'));
      const relative = path.relative(destinationRoot, output);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      const bytes = authoritativeGit(repository, ['cat-file', 'blob', objectId], {
        ...options,
        encoding: null,
        maxBuffer: 64 * 1024 * 1024,
      });
      totalBytes += bytes.length;
      assert.ok(totalBytes <= 128 * 1024 * 1024, 'authoritative commit tree is too large');
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(output, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
      regularFiles += 1;
    }
    seen.add(canonicalEntry);
  }
  if (normalizedPrefix) {
    assert.ok(seen.has(normalizedPrefix), 'authoritative source tree root is missing');
  }
  const requiredPath = normalizedPrefix
    ? `${normalizedPrefix}/${options.requiredPath || 'package.json'}`
    : options.requiredPath || 'package.json';
  assert.ok(seen.has(requiredPath), `authoritative required file is missing: ${requiredPath}`);
  assert.ok(regularFiles > 0, 'authoritative commit tree contains no files');
  return destinationRoot;
}

function readAuthoritativeGitState(repository, tag, options = {}) {
  assertNoReplacementRefs(repository, options);
  assertNoHiddenIndexFlags(repository, options);
  return Object.freeze({
    status: authoritativeGit(
      repository,
      ['status', '--porcelain', '--untracked-files=all'],
      options,
    ),
    head: authoritativeGit(repository, ['rev-parse', 'HEAD'], options),
    tagCommit: authoritativeGit(repository, ['rev-parse', `${tag}^{commit}`], options),
  });
}

module.exports = {
  assertNoHiddenIndexFlags,
  assertNoReplacementRefs,
  authoritativeGit,
  authoritativeGitEnvironment,
  authoritativeGitNullDevice,
  canonicalRepository,
  materializeCommitTree,
  readAuthoritativeGitState,
  resolveTrustedSystemGit,
};
