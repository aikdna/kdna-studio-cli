#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  assertPackageTarInstallEquivalent,
  resolveTrustedNpmInvocation,
  verifyCandidateBinding,
} = require('./runtime-candidate-binding');
const {
  CANDIDATE_AUTHORITIES,
  readPinnedCandidateCommits,
} = require('./runtime-candidate-authority');
const {
  assertNoHiddenIndexFlags,
  assertNoReplacementRefs,
  authoritativeGit,
  materializeCommitTree,
} = require('./authoritative-git');

const root = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: options.encoding === null ? null : 'utf8',
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    shell: false,
  });
  assert.equal(result.error, undefined, `${options.label || 'command'} failed to start`);
  assert.equal(result.signal, null, `${options.label || 'command'} was interrupted`);
  assert.equal(result.status, 0, `${options.label || 'command'} failed`);
  if (!options.allowStderr) {
    assert.equal(
      options.encoding === null ? result.stderr.length : result.stderr,
      options.encoding === null ? 0 : '',
      `${options.label || 'command'} wrote unexpected stderr`,
    );
  }
  return result.stdout;
}

function git(repository, args, options = {}) {
  return authoritativeGit(repository, args, {
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
  });
}

function assertCleanPinnedRepository(repository, expectedCommit, packageSubdirectory) {
  const stat = fs.lstatSync(repository);
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'candidate source repository must be a regular non-symlink directory',
  );
  assert.equal(
    fs.realpathSync(repository),
    repository,
    'candidate source repository path must be canonical',
  );
  assertNoReplacementRefs(repository);
  assert.equal(
    git(repository, ['rev-parse', 'HEAD']),
    expectedCommit,
    'candidate source HEAD does not match the CI pin',
  );
  assert.equal(
    git(repository, ['rev-parse', `${expectedCommit}^{commit}`]),
    expectedCommit,
    'candidate source pin is not an exact commit',
  );
  assert.equal(
    git(repository, ['status', '--porcelain', '--untracked-files=all']),
    '',
    'candidate source worktree is not clean',
  );
  assertNoHiddenIndexFlags(repository);
  const source = path.resolve(repository, packageSubdirectory);
  const relative = path.relative(repository, source);
  assert.ok(
    !relative.startsWith('..') && !path.isAbsolute(relative),
    'candidate package path escapes its repository',
  );
  const sourceStat = fs.lstatSync(source);
  assert.ok(
    sourceStat.isDirectory() && !sourceStat.isSymbolicLink(),
    'candidate package path must be a regular non-symlink directory',
  );
  assert.equal(fs.realpathSync(source), source, 'candidate package path is not canonical');
  const packageManifest = packageSubdirectory
    ? `${packageSubdirectory.split(path.sep).join('/')}/package.json`
    : 'package.json';
  git(repository, ['cat-file', '-e', `${expectedCommit}:${packageManifest}`]);
  return Object.freeze({ repository, source });
}

function materializeCommitPackage(repository, expectedCommit, packageSubdirectory, destination) {
  return materializeCommitTree(
    repository,
    expectedCommit,
    packageSubdirectory,
    destination,
    { requiredPath: 'package.json' },
  );
}

function packOnce(invocation, source, destination) {
  const stdout = run(
    invocation.command,
    [
      ...invocation.prefixArgs,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      destination,
      '--registry=https://registry.npmjs.org/',
      '--@aikdna:registry=https://registry.npmjs.org/',
    ],
    {
      cwd: source,
      env: invocation.environment,
      label: 'candidate source pack',
    },
  );
  const reports = JSON.parse(stdout);
  assert.equal(reports.length, 1, 'candidate source pack must emit one artifact');
  const report = reports[0];
  assert.equal(typeof report.filename, 'string', 'candidate source pack filename is missing');
  return fs.readFileSync(path.join(destination, report.filename));
}

function verifyCandidateSources(options = {}) {
  const repositoryRoot = options.root || root;
  const environment = options.environment || process.env;
  const binding = verifyCandidateBinding(repositoryRoot);
  const byName = new Map(binding.packages.map((entry) => [entry.name, entry]));
  const pinned = readPinnedCandidateCommits(repositoryRoot);
  const invocation = resolveTrustedNpmInvocation(repositoryRoot, {
    tarballPath: options.tarballPath,
  });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-candidate-source-pack-'));
  try {
    for (const authority of CANDIDATE_AUTHORITIES) {
      const sourceRoot = environment[authority.sourceEnvironment];
      assert.ok(sourceRoot, `${authority.sourceEnvironment} is required`);
      const repository = path.resolve(sourceRoot);
      const expectedCommit = pinned.get(authority.name);
      const boundPackage = byName.get(authority.name);
      assertCleanPinnedRepository(repository, expectedCommit, authority.sourcePackageSubdirectory);

      const leaf = authority.name.split('/').at(-1);
      const isolatedSources = [
        path.join(temporary, `${leaf}-source-first`),
        path.join(temporary, `${leaf}-source-second`),
      ];
      for (const isolatedSource of isolatedSources) {
        fs.mkdirSync(isolatedSource, { mode: 0o700 });
        materializeCommitPackage(
          repository,
          expectedCommit,
          authority.sourcePackageSubdirectory,
          isolatedSource,
        );
      }
      const packageManifest = JSON.parse(
        fs.readFileSync(path.join(isolatedSources[0], 'package.json'), 'utf8'),
      );
      assert.equal(packageManifest.name, authority.name, `candidate source package mismatch: ${authority.name}`);
      assert.equal(packageManifest.version, authority.version, `candidate source version mismatch: ${authority.name}`);
      assert.equal(boundPackage?.commit, expectedCommit);

      const packDestinations = [
        path.join(temporary, `${leaf}-pack-first`),
        path.join(temporary, `${leaf}-pack-second`),
      ];
      for (const destination of packDestinations) fs.mkdirSync(destination);
      const sourcePacks = isolatedSources.map((source, index) =>
        packOnce(invocation, source, packDestinations[index]));
      assert.deepEqual(
        sourcePacks[0],
        sourcePacks[1],
        `candidate source packs are not byte-identical: ${authority.name}`,
      );
      const checkedArtifact = fs.readFileSync(
        path.join(repositoryRoot, boundPackage.artifact),
      );
      const comparison = assertPackageTarInstallEquivalent(
        checkedArtifact,
        sourcePacks[0],
        {
          referenceLabel: `checked candidate artifact ${authority.name}`,
          candidateLabel: `candidate source pack ${authority.name}`,
        },
      );
      assert.equal(
        comparison.entry_count,
        JSON.parse(
          fs.readFileSync(path.join(repositoryRoot, authority.evidencePath), 'utf8'),
        ).pack.entry_count,
        `candidate source pack entry count differs from evidence: ${authority.name}`,
      );
      assertCleanPinnedRepository(repository, expectedCommit, authority.sourcePackageSubdirectory);
      console.log(
        `${authority.name}: ${comparison.status}; entries=${comparison.entry_count}; ` +
          `excluded=${comparison.excluded_non_install_metadata.join(',')}`,
      );
    }
    return binding;
  } finally {
    invocation.cleanup();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  assert.deepEqual(argv, [], 'usage: verify-runtime-candidate-sources.js');
  return verifyCandidateSources();
}

if (require.main === module) main();

module.exports = {
  assertCleanPinnedRepository,
  main,
  materializeCommitPackage,
  packOnce,
  verifyCandidateSources,
};
