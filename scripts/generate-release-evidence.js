#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  materializeCommitTree,
  readAuthoritativeGitState,
} = require('./authoritative-git');
const { validatePackReport } = require('./release-evidence');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');

const defaultRoot = path.resolve(__dirname, '..');

function fail(message) {
  throw new Error(message);
}

function packIsolatedSource(npmInvocation, source, destination) {
  const packed = spawnSync(
    npmInvocation.command,
    [
      ...npmInvocation.prefixArgs,
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
      encoding: 'utf8',
      env: npmInvocation.environment,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    },
  );
  if (packed.error) fail(`npm pack failed: ${packed.error.message}`);
  if (packed.status !== 0) {
    fail(`npm pack exited ${String(packed.status)}: ${(packed.stderr || '').trim()}`);
  }
  let reports;
  try {
    reports = JSON.parse(packed.stdout);
  } catch {
    fail('npm pack output was not valid JSON');
  }
  if (!Array.isArray(reports) || reports.length !== 1 || !reports[0].filename) {
    fail('npm pack did not report one filename');
  }
  const artifact = path.join(destination, reports[0].filename);
  return Object.freeze({
    reportText: packed.stdout,
    artifact,
    bytes: fs.readFileSync(artifact),
  });
}

function assertReproduciblePackBytes(first, second) {
  if (!Buffer.isBuffer(first) || !Buffer.isBuffer(second) || !first.equals(second)) {
    fail('isolated npm packs of the authoritative commit are not byte-identical');
  }
}

function generateReleaseEvidence({
  root: requestedRoot,
  output: requestedOutput,
  artifact: requestedArtifact,
  environment = process.env,
}) {
  const root = path.resolve(requestedRoot);
  const output = path.resolve(requestedOutput);
  const artifact = path.resolve(requestedArtifact);
  for (const destination of [output, artifact]) {
    const relative = path.relative(root, destination);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      fail('release outputs must be outside the repository');
    }
  }
  if (output === artifact) fail('release evidence and artifact paths must differ');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const before = readAuthoritativeGitState(root, pkg.version, { environment });
  if (before.status) fail('worktree must be clean');
  const commit = before.head;
  if (environment.GITHUB_SHA !== commit) fail('GITHUB_SHA must equal the packed commit');
  if (before.tagCommit !== commit) fail('release tag must resolve to the packed commit');

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  const temp = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'kdna-studio-cli-pack-'),
  );
  const firstSource = path.join(temp, 'source-first');
  const secondSource = path.join(temp, 'source-second');
  const firstPackDestination = path.join(temp, 'packed-first');
  const secondPackDestination = path.join(temp, 'packed-second');
  let npmInvocation;
  let complete = false;
  let artifactCreated = false;
  let evidenceCreated = false;
  let retainedEvidence;
  try {
    for (const directory of [
      firstSource,
      secondSource,
      firstPackDestination,
      secondPackDestination,
    ]) {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    for (const source of [firstSource, secondSource]) {
      materializeCommitTree(root, commit, '', source, {
        environment,
        requiredPath: 'package.json',
      });
    }
    const committedPackage = JSON.parse(
      fs.readFileSync(path.join(firstSource, 'package.json'), 'utf8'),
    );
    if (committedPackage.name !== pkg.name || committedPackage.version !== pkg.version) {
      fail('committed package identity differs from the release worktree');
    }
    npmInvocation = resolveTrustedNpmInvocation(root);
    const firstPack = packIsolatedSource(
      npmInvocation,
      firstSource,
      firstPackDestination,
    );
    const secondPack = packIsolatedSource(
      npmInvocation,
      secondSource,
      secondPackDestination,
    );
    assertReproduciblePackBytes(firstPack.bytes, secondPack.bytes);
    const evidence = validatePackReport({
      reportText: firstPack.reportText,
      tarball: firstPack.bytes,
      pkg,
      source: { ref: environment.GITHUB_REF, commit },
    });
    validatePackReport({
      reportText: secondPack.reportText,
      tarball: secondPack.bytes,
      pkg,
      source: { ref: environment.GITHUB_REF, commit },
    });
    fs.copyFileSync(firstPack.artifact, artifact, fs.constants.COPYFILE_EXCL);
    artifactCreated = true;
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    evidenceCreated = true;
    if (!fs.readFileSync(artifact).equals(firstPack.bytes)) {
      fail('retained artifact differs from npm pack');
    }
    const after = readAuthoritativeGitState(root, pkg.version, { environment });
    if (after.status) fail('npm pack changed the repository');
    if (after.head !== commit || after.tagCommit !== commit) {
      fail('release Git authority changed during npm pack');
    }
    retainedEvidence = evidence;
    complete = true;
  } finally {
    if (npmInvocation) npmInvocation.cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
    if (!complete) {
      if (evidenceCreated) fs.rmSync(output, { force: true });
      if (artifactCreated) fs.rmSync(artifact, { force: true });
    }
  }
  return retainedEvidence;
}

function main(argv = process.argv) {
  const outIndex = argv.indexOf('--out');
  const artifactIndex = argv.indexOf('--artifact');
  if (argv.length !== 6 || outIndex < 0 || artifactIndex < 0) {
    fail('usage: generate-release-evidence.js --out <evidence> --artifact <tarball>');
  }
  const output = path.resolve(argv[outIndex + 1] || '');
  const artifact = path.resolve(argv[artifactIndex + 1] || '');
  generateReleaseEvidence({
    root: defaultRoot,
    output,
    artifact,
    environment: process.env,
  });
  console.log(`Release evidence written to ${output}; verified artifact retained at ${artifact}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release evidence rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { assertReproduciblePackBytes, generateReleaseEvidence, main };
