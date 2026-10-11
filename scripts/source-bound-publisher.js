#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateArtifact } = require('./release-evidence');
const { readTarFileEntriesFromBytes } = require('./runtime-candidate-binding');

const REGISTRY = 'https://registry.npmjs.org/';
const VERSIONS = Object.freeze({
  '@aikdna/kdna-studio-core': '4.0.0',
  '@aikdna/kdna-studio-cli': '0.13.0',
});
const PUBLICATION_ENVIRONMENT = Object.freeze([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL',
  'CI', 'GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID', 'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID', 'GITHUB_SERVER_URL', 'GITHUB_SHA', 'GITHUB_OUTPUT',
  'GITHUB_WORKFLOW_REF', 'RUNNER_ENVIRONMENT', 'NODE_AUTH_TOKEN',
]);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function read(file) {
  assert(path.isAbsolute(file) && fs.realpathSync(file) === file, 'publisher path must be canonical');
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    stat.size <= 64 * 1024 * 1024, 'publisher input must be a bounded regular file');
  return fs.readFileSync(file);
}

function publishingManifest(evidence, tarball) {
  validateArtifact(evidence, tarball);
  const entries = readTarFileEntriesFromBytes(tarball);
  const entry = entries.find((file) => file.path === 'package/package.json');
  assert(entry, 'publisher package manifest missing');
  const manifest = JSON.parse(entry.bytes.toString('utf8'));
  assert(manifest.name === evidence.package.name && manifest.version === evidence.package.version,
    'publisher package identity mismatch');
  assert(Object.hasOwn(VERSIONS, manifest.name) && VERSIONS[manifest.name] === manifest.version,
    'publisher stable coordinate invalid');
  assert(!Object.hasOwn(manifest, 'publishConfig') && !Object.hasOwn(manifest, 'dist') &&
    !Object.hasOwn(manifest, 'tag'), 'publisher manifest contains conflicting metadata');
  assert(!Object.hasOwn(manifest, 'gitHead') || manifest.gitHead === evidence.source.commit,
    'publisher packed source identity conflicts');
  return { ...manifest, gitHead: evidence.source.commit };
}

// The existing trusted-npm resolver authenticates every byte in this tree.
// Do not resolve a library from the product's dependencies or global npm.
function publishingLibrary(npmInvocation) {
  assert(npmInvocation.command === process.execPath &&
    Array.isArray(npmInvocation.prefixArgs) && npmInvocation.prefixArgs.length === 1,
  'publisher trusted invocation invalid');
  const cli = npmInvocation.prefixArgs[0];
  read(cli);
  assert(path.basename(cli) === 'npm-cli.js' && path.basename(path.dirname(cli)) === 'bin',
    'publisher trusted CLI path invalid');
  const library = path.resolve(path.dirname(cli), '..', 'node_modules', 'libnpmpublish', 'lib', 'index.js');
  read(library);
  return library;
}

function publicationEnvironment(npmInvocation, directory, environment) {
  const clean = {};
  for (const key of PUBLICATION_ENVIRONMENT) {
    if (typeof environment[key] === 'string') clean[key] = environment[key];
  }
  return {
    ...clean,
    HOME: directory,
    PATH: npmInvocation.environment.PATH,
    NODE_OPTIONS: '',
    NODE_PATH: '',
    LC_ALL: 'C',
    LANG: 'C',
  };
}

function publishSourceBoundArtifact({ evidence, tarball, bindCurrent, tag, npmInvocation,
  runner = spawnSync, environment = process.env, temporaryRoot = fs.realpathSync(os.tmpdir()) }) {
  bindCurrent(evidence);
  assert.equal(tag, 'latest', 'source-bound publisher requires explicit latest');
  const manifest = publishingManifest(evidence, tarball);
  const libraryPath = publishingLibrary(npmInvocation);
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'aikdna-source-bound-publish-'));
  fs.chmodSync(directory, 0o700);
  try {
    const artifactPath = path.join(directory, 'retained.tgz');
    const manifestPath = path.join(directory, 'manifest.json');
    fs.writeFileSync(artifactPath, tarball, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
    bindCurrent(evidence);
    const result = runner(npmInvocation.command,
      [__filename, libraryPath, manifestPath, artifactPath, sha256(tarball)], {
        cwd: directory,
        env: publicationEnvironment(npmInvocation, directory, environment),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 300_000,
        shell: false,
      });
    assert(result && !result.error && result.signal == null && result.status === 0,
      'source-bound publication failed');
    return { status: 0 };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Same manifest + retained-buffer API used by the audited CLI stable publisher.
async function publishVerified({ libraryPath, manifestPath, artifactPath, artifactSha256,
  token, library = null }) {
  assert(path.isAbsolute(libraryPath), 'publisher library path must be absolute');
  assert(typeof token === 'string' && token !== '' && !/[\r\n\0]/u.test(token),
    'publisher token missing or invalid');
  assert(/^[0-9a-f]{64}$/u.test(artifactSha256 || ''), 'publisher artifact digest invalid');
  const bytes = read(artifactPath);
  assert.equal(sha256(bytes), artifactSha256, 'publisher retained artifact digest mismatch');
  const manifest = JSON.parse(read(manifestPath).toString('utf8'));
  assert(Object.hasOwn(VERSIONS, manifest.name) && VERSIONS[manifest.name] === manifest.version &&
    /^[a-f0-9]{40}$/u.test(manifest.gitHead || ''), 'publisher target identity invalid');
  assert(!Object.hasOwn(manifest, 'publishConfig') && !Object.hasOwn(manifest, 'dist') &&
    !Object.hasOwn(manifest, 'tag'), 'publisher manifest contains conflicting metadata');
  const publisher = library || require(libraryPath);
  assert(typeof publisher.publish === 'function', 'publisher audited library unavailable');
  await publisher.publish(manifest, bytes, {
    '//registry.npmjs.org/:_authToken': token,
    access: 'public',
    algorithms: ['sha512'],
    defaultTag: 'latest',
    npmVersion: '11.17.0',
    provenance: true,
    registry: REGISTRY,
  });
  return true;
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 4, 'publisher arguments invalid');
  const token = process.env.NODE_AUTH_TOKEN;
  delete process.env.NODE_AUTH_TOKEN;
  await publishVerified({ libraryPath: argv[0], manifestPath: argv[1],
    artifactPath: argv[2], artifactSha256: argv[3], token });
}
if (require.main === module) main().catch(() => {
  console.error('Source-bound stable publication rejected');
  process.exitCode = 1;
});

module.exports = { publishingManifest, publishingLibrary, publicationEnvironment,
  publishSourceBoundArtifact, publishVerified };
