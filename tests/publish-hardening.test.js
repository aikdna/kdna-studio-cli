'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  readCurrentBinding,
  validateCurrentBinding,
} = require('../scripts/current-release-binding');
const {
  REQUIRED_STUDIO_CLI_PACK_MEMBERS,
  assertStudioCliPackMembers,
  parseTarFiles,
  validateArtifact,
  validatePackReport,
} = require('../scripts/release-evidence');
const { validateReleaseContext } = require('../scripts/release-policy');
const {
  assertReproduciblePackBytes,
  generateReleaseEvidence,
} = require('../scripts/generate-release-evidence');
const {
  assertNoHiddenIndexFlags,
  authoritativeGitEnvironment,
  authoritativeGitNullDevice,
  resolveTrustedSystemGit,
} = require('../scripts/authoritative-git');
const { evaluateRegistryResult, expectedE404 } = require('../scripts/registry-policy');
const { resolveTrustedNpmInvocation } = require('../scripts/runtime-candidate-binding');
const {
  TRUSTED_NPM_INTEGRITY,
  TRUSTED_NPM_URL,
  TRUSTED_NPM_VERSION,
} = require('../scripts/trusted-npm-release');
const {
  lookupArguments,
  publishArguments,
  publishCandidate,
  releaseDecision,
} = require('../scripts/publish-verified-artifact');

const ROOT = path.resolve(__dirname, '..');
const HASH = 'a'.repeat(40);

test('authoritative Git selects a Git-compatible null device on every platform', () => {
  assert.equal(authoritativeGitNullDevice('win32'), 'NUL');
  assert.equal(authoritativeGitNullDevice('linux'), '/dev/null');
  assert.equal(authoritativeGitNullDevice('darwin'), '/dev/null');
  assert.equal(
    authoritativeGitEnvironment({}).GIT_CONFIG_GLOBAL,
    authoritativeGitNullDevice(process.platform),
  );
  assert.equal(authoritativeGitEnvironment({}).GIT_REPLACE_REF_BASE, 'refs/replace/');
});

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length <= length, `tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, '0');
  assert.ok(octal.length < length, `tar numeric field is too large: ${value}`);
  header.write(octal, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function tarEntry({ name, content = Buffer.alloc(0), type = '0' }) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function tarGzip(entries, { endBlocks = 2 } = {}) {
  return zlib.gzipSync(
    Buffer.concat([...entries.map((entry) => tarEntry(entry)), Buffer.alloc(512 * endBlocks)]),
  );
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(`0 ${body}`);
  while (true) {
    const record = `${length} ${body}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record);
    length = actual;
  }
}

function releaseTarball() {
  return tarGzip(
    REQUIRED_STUDIO_CLI_PACK_MEMBERS.map((member) => ({
      name: `package/${member}`,
      content: member === 'package.json' ? '{"name":"studio-release"}\n' : `${member}\n`,
    })),
  );
}

test('Studio CLI pack members are fail-closed and package metadata has no library entry', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.main, undefined);
  const files = REQUIRED_STUDIO_CLI_PACK_MEMBERS.map((member) => ({ path: member, size: 1 }));
  assert.doesNotThrow(() => assertStudioCliPackMembers(files));
  assert.throws(
    () => assertStudioCliPackMembers(files.filter((file) => file.path !== 'bin/kdna-studio.js')),
    /missing required member: bin\/kdna-studio\.js/,
  );
  assert.throws(
    () => assertStudioCliPackMembers([...files, { path: 'index.js', size: 1 }]),
    /phantom library entry/,
  );
});

function releaseInput(overrides = {}) {
  const version = overrides.pkg?.version || '0.10.2';
  return {
    pkg: { name: '@aikdna/kdna-studio-cli', version, ...overrides.pkg },
    changelog: overrides.changelog ?? `# Changelog\n\n## ${version} (2026-07-15)\n`,
    env: {
      GITHUB_EVENT_NAME: 'release',
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_TAG_NAME: version,
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'false',
      GITHUB_REF: `refs/tags/${version}`,
      GITHUB_SHA: HASH,
      ...overrides.env,
    },
    git: { status: '', head: HASH, tagCommit: HASH, ...overrides.git },
  };
}

function git(repository, args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', shell: false });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createReleaseRepository(t, marker) {
  const repository = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `studio-cli-release-${marker}-`),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'KDNA Test']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    `${JSON.stringify({ name: '@aikdna/kdna-studio-cli', version: '0.10.2' }, null, 2)}\n`,
  );
  for (const member of REQUIRED_STUDIO_CLI_PACK_MEMBERS.filter(
    (candidate) => candidate !== 'package.json',
  )) {
    const destination = path.join(repository, member);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${member}\n`);
  }
  fs.writeFileSync(path.join(repository, 'CHANGELOG.md'), '# Changelog\n\n## 0.10.2 (2026-07-17)\n');
  fs.writeFileSync(path.join(repository, 'marker.txt'), `${marker}\n`);
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', marker]);
  const commit = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['tag', '0.10.2', commit]);
  return { repository, commit };
}

function candidateEvidence(bytes = releaseTarball()) {
  const files = parseTarFiles(bytes);
  return {
    schema: 'kdna.studio-cli.release-evidence',
    version: '1.0',
    source: { ref: 'refs/tags/0.10.2', commit: HASH },
    package: { name: '@aikdna/kdna-studio-cli', version: '0.10.2' },
    artifact: {
      filename: 'aikdna-kdna-studio-cli-0.10.2.tgz',
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      packed_size: bytes.length,
      unpacked_size: files.reduce((total, file) => total + file.size, 0),
      file_count: files.length,
      files,
    },
  };
}

function packReport(bytes, files = parseTarFiles(bytes)) {
  return [{
    name: '@aikdna/kdna-studio-cli',
    version: '0.10.2',
    filename: 'aikdna-kdna-studio-cli-0.10.2.tgz',
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
    size: bytes.length,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    entryCount: files.length,
    files,
  }];
}

function evidenceForUntrustedBytes(bytes) {
  const evidence = candidateEvidence();
  return {
    ...evidence,
    artifact: {
      ...evidence.artifact,
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      packed_size: bytes.length,
    },
  };
}

test('publish workflow is release-only, serialized, pinned, and publishes one verified tarball', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /release:\n\s+types: \[published\]/);
  assert.match(workflow, /github\.workflow.*github\.event\.release\.tag_name/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.doesNotMatch(workflow, /npm install --global|npm_execpath/);
  assert.match(workflow, /acquire-trusted-npm-release\.js --out/);
  assert.match(workflow, /KDNA_TRUSTED_NPM_TARBALL=/);
  assert.match(workflow, /run-trusted-npm\.js ci --ignore-scripts/);
  assert.match(workflow, /run-trusted-npm\.js run test:all/);
  assert.match(workflow, /run-trusted-npm\.js run test:candidate-chain/);
  assert.ok(
    workflow.indexOf('run test:all') < workflow.indexOf('run test:candidate-chain') &&
      workflow.indexOf('run test:candidate-chain') < workflow.indexOf('run release:generate-evidence'),
    'complete tests and candidate-chain smoke must precede release evidence',
  );
  assert.match(workflow, /run-trusted-npm\.js run release:generate-evidence --/);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['release:generate-evidence'], 'node scripts/generate-release-evidence.js');
  assert.equal(scripts['release:publish-verified'], 'node scripts/publish-verified-artifact.js');
  assert.doesNotMatch(scripts['test:all'], /(?:^|\s)npm(?:\s|$)/);
  assert.doesNotMatch(scripts.prepublishOnly, /(?:^|\s)npm(?:\s|$)/);
  assert.equal(TRUSTED_NPM_VERSION, '11.17.0');
  assert.equal(TRUSTED_NPM_URL, 'https://registry.npmjs.org/npm/-/npm-11.17.0.tgz');
  assert.equal(
    TRUSTED_NPM_INTEGRITY,
    'sha512-PurxiZexEHDTE4SSaLI3ZrnbAGiZfeyUcQcxcP5D+hfytNAze/D1IzDuInTn9XVLIbAQUnQuSPXJx02LHjLvQw==',
  );
  assert.match(workflow, /kdna-studio-cli-release\.tgz/g);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /run:\s*git\b/);
});

test('release Git authority ignores hostile environment injection and rejects replacement refs', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX fake executable fixture');
    return;
  }
  const release = createReleaseRepository(t, 'release-authority');
  const attacker = createReleaseRepository(t, 'attacker-authority');
  const hostileBin = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'studio-release-hostile-path-'),
  );
  t.after(() => fs.rmSync(hostileBin, { recursive: true, force: true }));
  const fakeGit = path.join(hostileBin, 'git');
  fs.writeFileSync(
    fakeGit,
    '#!/bin/sh\ncase "$*" in *rev-parse*) printf "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n";; esac\nexit 0\n',
    { mode: 0o700 },
  );
  const evidence = candidateEvidence();
  evidence.source.commit = release.commit;
  const environment = {
    ...process.env,
    ...releaseInput({ env: { GITHUB_SHA: release.commit } }).env,
    GIT_DIR: path.join(attacker.repository, '.git'),
    GIT_WORK_TREE: attacker.repository,
    GIT_INDEX_FILE: path.join(attacker.repository, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: path.join(attacker.repository, '.git', 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(attacker.repository, '.git', 'objects'),
    GIT_REPLACE_REF_BASE: 'refs/attacker-replacements/',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.useReplaceRefs',
    GIT_CONFIG_VALUE_0: 'true',
    PATH: `${hostileBin}${path.delimiter}${process.env.PATH}`,
  };
  const oldHead = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: release.repository,
    encoding: 'utf8',
    env: { ...environment, PATH: process.env.PATH },
    shell: false,
  });
  assert.equal(oldHead.status, 0, oldHead.stderr);
  assert.equal(oldHead.stdout.trim(), attacker.commit);
  assert.equal(
    readCurrentBinding({ root: release.repository, evidence, env: environment }),
    evidence,
  );
  assert.notEqual(resolveTrustedSystemGit(), fakeGit);

  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'visible-release-change\n');
  assert.throws(
    () => readCurrentBinding({ root: release.repository, evidence, env: environment }),
    /worktree must be clean/,
  );
  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'release-authority\n');

  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'hidden-release-change\n');
  git(release.repository, ['update-index', '--assume-unchanged', 'marker.txt']);
  assert.throws(
    () => readCurrentBinding({ root: release.repository, evidence, env: environment }),
    /index contains assume-unchanged, skip-worktree, or non-ordinary entries/,
  );
  git(release.repository, ['update-index', '--no-assume-unchanged', 'marker.txt']);
  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'release-authority\n');

  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'replacement\n');
  git(release.repository, ['add', 'marker.txt']);
  git(release.repository, ['commit', '--quiet', '-m', 'replacement']);
  const replacement = git(release.repository, ['rev-parse', 'HEAD']);
  git(release.repository, ['checkout', '--quiet', '--detach', release.commit]);
  git(release.repository, ['replace', release.commit, replacement]);
  assert.throws(
    () => readCurrentBinding({ root: release.repository, evidence, env: environment }),
    /contains Git replacement refs/,
  );
});

test('release evidence entry rejects hidden worktree changes and packs exact commit blobs', (t) => {
  const release = createReleaseRepository(t, 'release-evidence-source');
  const outputRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'studio-cli-release-output-'),
  );
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const output = path.join(outputRoot, 'evidence.json');
  const artifact = path.join(outputRoot, 'release.tgz');
  const environment = {
    ...process.env,
    ...releaseInput({ env: { GITHUB_SHA: release.commit } }).env,
  };
  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'hidden-release-evidence-change\n');
  git(release.repository, ['update-index', '--assume-unchanged', 'marker.txt']);
  assert.throws(
    () => generateReleaseEvidence({
      root: release.repository,
      output,
      artifact,
      environment,
    }),
    /index contains assume-unchanged, skip-worktree, or non-ordinary entries/,
  );
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(artifact), false);

  git(release.repository, ['update-index', '--no-assume-unchanged', 'marker.txt']);
  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'release-evidence-source\n');
  fs.writeFileSync(
    path.join(release.repository, '.git', 'info', 'attributes'),
    'marker.txt export-ignore\npackage.json export-subst\n',
  );
  const evidence = generateReleaseEvidence({
    root: release.repository,
    output,
    artifact,
    environment,
  });
  assert.equal(evidence.source.commit, release.commit);
  assert.equal(evidence.source.ref, 'refs/tags/0.10.2');
  assert.ok(fs.existsSync(output));
  assert.ok(fs.existsSync(artifact));
  const files = parseTarFiles(fs.readFileSync(artifact)).map((entry) => entry.path);
  assert.ok(files.includes('marker.txt'));
});

test('release Git index authority accepts only ordinary cached entries', (t) => {
  const release = createReleaseRepository(t, 'ordinary-index-authority');
  assert.doesNotThrow(() => assertNoHiddenIndexFlags(release.repository));

  git(release.repository, ['switch', '--quiet', '-c', 'conflicting-index']);
  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'conflicting-index\n');
  git(release.repository, ['commit', '--quiet', '-am', 'conflicting index']);
  git(release.repository, ['switch', '--quiet', '--detach', release.commit]);
  fs.writeFileSync(path.join(release.repository, 'marker.txt'), 'detached-index\n');
  git(release.repository, ['commit', '--quiet', '-am', 'detached index']);
  const merge = spawnSync('git', ['merge', 'conflicting-index'], {
    cwd: release.repository,
    encoding: 'utf8',
    shell: false,
  });
  assert.notEqual(merge.status, 0);
  assert.match(git(release.repository, ['ls-files', '-v']), /^M marker\.txt/m);
  assert.throws(
    () => assertNoHiddenIndexFlags(release.repository),
    /index contains assume-unchanged, skip-worktree, or non-ordinary entries/,
  );
});

test('release evidence requires byte-identical isolated npm packs', () => {
  const bytes = Buffer.from('authoritative release bytes');
  assert.doesNotThrow(() => assertReproduciblePackBytes(bytes, Buffer.from(bytes)));
  assert.throws(
    () => assertReproduciblePackBytes(bytes, Buffer.from('different release bytes')),
    /not byte-identical/,
  );
  const source = fs.readFileSync(
    path.join(ROOT, 'scripts/generate-release-evidence.js'),
    'utf8',
  );
  assert.match(source, /const firstSource =/);
  assert.match(source, /const secondSource =/);
  assert.equal(source.split('packIsolatedSource(').length - 1, 3);
  assert.match(source, /packIsolatedSource\(\s*npmInvocation,\s*firstSource,/);
  assert.match(source, /packIsolatedSource\(\s*npmInvocation,\s*secondSource,/);
  assert.match(source, /assertReproduciblePackBytes\(firstPack\.bytes, secondPack\.bytes\)/);
});

test('every release Git consumer uses the centralized authority helper', () => {
  for (const file of [
    'scripts/current-release-binding.js',
    'scripts/generate-release-evidence.js',
    'scripts/release-check.js',
    'scripts/verify-runtime-candidate-sources.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /authoritative-git/);
    assert.doesNotMatch(source, /execFileSync\(['"]git['"]|spawnSync\(['"]git['"]/);
  }
  const authoritySource = fs.readFileSync(
    path.join(ROOT, 'scripts/authoritative-git.js'),
    'utf8',
  );
  assert.match(authoritySource, /resolveTrustedSystemGit\(\)/);
  assert.doesNotMatch(authoritySource, /spawnSync\(['"]git['"]/);
  const namingSource = fs.readFileSync(
    path.join(ROOT, 'scripts/check-current-protocol-names.js'),
    'utf8',
  );
  assert.doesNotMatch(namingSource, /execFileSync\(['"](?:npm|tar)['"]/);
  assert.match(namingSource, /resolveTrustedNpmInvocation/);
  assert.match(namingSource, /readTarFileEntries/);
  const evidenceSource = fs.readFileSync(
    path.join(ROOT, 'scripts/generate-release-evidence.js'),
    'utf8',
  );
  assert.match(evidenceSource, /materializeCommitTree\(root, commit, '', source/);
  assert.match(evidenceSource, /packIsolatedSource/);
  assert.match(evidenceSource, /assertReproduciblePackBytes/);
});

test('every audited npm child receives the controlled execution environment', () => {
  const consumers = new Map([
    ['scripts/run-trusted-npm.js', ['env: invocation.environment', 1]],
    ['scripts/generate-release-evidence.js', ['env: npmInvocation.environment', 1]],
    ['scripts/check-current-protocol-names.js', ['env: invocation.environment', 1]],
    ['scripts/publish-verified-artifact.js', ['env: npmInvocation.environment', 1]],
    ['scripts/verify-runtime-candidate-sources.js', ['env: invocation.environment', 1]],
    ['scripts/runtime-candidate-binding.js', ['env: invocation.environment', 1]],
  ]);
  for (const [file, [needle, expected]] of consumers) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(source.split(needle).length - 1, expected, file);
  }
});

test('release auth chain isolates the publish credential from the lookup environment', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/publish-verified-artifact.js'), 'utf8');
  // lookup spawn keeps the scrubbed environment: npm view needs no auth
  const lookupEnv = source.indexOf("env: npmInvocation.environment");
  assert.ok(lookupEnv >= 0, 'lookup child must keep the scrubbed environment');
  const afterLookup = source.slice(lookupEnv + 30);
  // publish spawn after lookup must NOT use the scrubbed environment
  const publishSpawns = afterLookup.match(/env: npmInvocation\.environment/g);
  assert.equal(publishSpawns, null, 'publish child must not use the scrubbed environment');
  // the publish spawn argument list must not contain the token
  assert.doesNotMatch(source, /NODE_AUTH_TOKEN/);
  // the workflow must not nest the publisher through run-trusted-npm
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.doesNotMatch(workflow, /run-trusted-npm\.js run release:publish-verified/);
  assert.match(workflow, /node scripts\/publish-verified-artifact\.js/);
});

test('release context binds package, changelog, event, tag ref, HEAD, and workflow SHA', () => {
  assert.deepEqual(validateReleaseContext(releaseInput()), {
    name: '@aikdna/kdna-studio-cli',
    version: '0.10.2',
    tag: '0.10.2',
    ref: 'refs/tags/0.10.2',
    commit: HASH,
  });
  for (const input of [
    releaseInput({ env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }),
    releaseInput({ env: { RELEASE_TAG_NAME: '1.9.0' } }),
    releaseInput({ env: { GITHUB_REF: 'refs/heads/main' } }),
    releaseInput({ env: { GITHUB_SHA: 'b'.repeat(40) } }),
    releaseInput({ git: { status: ' M package.json' } }),
    releaseInput({ git: { tagCommit: 'b'.repeat(40) } }),
    releaseInput({ changelog: '# Changelog\n\n## 1.9.0\n' }),
  ]) {
    assert.throws(() => validateReleaseContext(input));
  }
});

test('current binding rejects stale evidence before registry lookup', () => {
  const bytes = releaseTarball();
  const evidence = candidateEvidence(bytes);
  assert.equal(validateCurrentBinding({ evidence, ...releaseInput() }), evidence);
  let calls = 0;
  assert.throws(() =>
    releaseDecision({
      evidence,
      tarball: bytes,
      bindCurrent: () => {
        throw new Error('stale release');
      },
      lookup: () => {
        calls += 1;
      },
    }),
  );
  assert.equal(calls, 0);
});

test('pack evidence independently parses a real npm tgz and rejects changed bytes', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-release-pack-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const npmInvocation = resolveTrustedNpmInvocation(ROOT);
  t.after(() => npmInvocation.cleanup());
  const packed = spawnSync(
    npmInvocation.command,
    [
      ...npmInvocation.prefixArgs,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      temp,
      '--registry=https://registry.npmjs.org/',
      '--@aikdna:registry=https://registry.npmjs.org/',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: npmInvocation.environment,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const [report] = JSON.parse(packed.stdout);
  const bytes = fs.readFileSync(path.join(temp, report.filename));
  const evidence = validatePackReport({
    reportText: packed.stdout,
    tarball: bytes,
    pkg: { name: '@aikdna/kdna-studio-cli', version: '0.10.2' },
    source: { ref: 'refs/tags/0.10.2', commit: HASH },
  });
  assert.equal(validateArtifact(evidence, bytes), evidence);
  assert.throws(() => validateArtifact(evidence, Buffer.from('changed')), /size|integrity|shasum/);
  assert.throws(
    () =>
      validateArtifact(
        { ...evidence, artifact: { ...evidence.artifact, unpacked_size: evidence.artifact.unpacked_size + 1 } },
        bytes,
      ),
    /unpacked size mismatch/,
  );
  assert.throws(
    () => validateArtifact({ ...evidence, artifact: { ...evidence.artifact, filename: '../release.tgz' } }, bytes),
    /filename mismatch/,
  );
});

test('independent tar parser supports PAX paths and GNU long names', () => {
  const paxPath = `package/nested/${'p'.repeat(96)}.js`;
  const paxBytes = tarGzip([
    { name: 'PaxHeader', type: 'x', content: paxRecord('path', paxPath) },
    { name: 'package/placeholder', content: 'pax' },
  ]);
  assert.deepEqual(parseTarFiles(paxBytes), [{ path: paxPath.slice('package/'.length), size: 3 }]);

  const longPath = `package/nested/${'g'.repeat(96)}.js`;
  const longNameBytes = tarGzip([
    { name: '././@LongLink', type: 'L', content: `${longPath}\0` },
    { name: 'package/placeholder', content: 'gnu' },
  ]);
  assert.deepEqual(parseTarFiles(longNameBytes), [{ path: longPath.slice('package/'.length), size: 3 }]);
});

test('independent tar parser rejects non-gzip, truncation, checksum damage, bad endings, duplicates, and unsafe paths', () => {
  const valid = releaseTarball();
  const tar = zlib.gunzipSync(valid);
  const checksumDamage = Buffer.from(tar);
  checksumDamage[0] ^= 1;
  const cases = [
    ['non-gzip', Buffer.from('ordinary bytes'), /gzip/],
    ['truncated gzip', valid.subarray(0, valid.length - 8), /gzip/],
    ['truncated tar entry', zlib.gzipSync(tar.subarray(0, 520)), /truncated tar entry/],
    ['header checksum', zlib.gzipSync(checksumDamage), /checksum/],
    [
      'missing second end block',
      tarGzip([{ name: 'package/package.json', content: '{}' }], { endBlocks: 1 }),
      /end marker/,
    ],
    [
      'duplicate path',
      tarGzip([
        { name: 'package/package.json', content: '{}' },
        { name: 'package/package.json', content: '[]' },
      ]),
      /duplicate/,
    ],
    ['parent traversal', tarGzip([{ name: 'package/../escape.js', content: 'x' }]), /unsafe/],
    ['absolute-like path', tarGzip([{ name: 'package//escape.js', content: 'x' }]), /unsafe/],
    ['backslash path', tarGzip([{ name: 'package/..\\escape.js', content: 'x' }]), /unsafe/],
    ['symbolic link', tarGzip([{ name: 'package/link', type: '2', content: '' }]), /unsupported/],
  ];
  for (const [name, bytes, pattern] of cases) {
    assert.throws(() => parseTarFiles(bytes), pattern, name);
  }
});

test('pack JSON and retained evidence must exactly match the independently parsed tar manifest', () => {
  const bytes = releaseTarball();
  const report = packReport(bytes);
  report[0].files = [{ path: 'README.md', size: report[0].files[0].size }];
  assert.throws(
    () =>
      validatePackReport({
        reportText: JSON.stringify(report),
        tarball: bytes,
        pkg: { name: '@aikdna/kdna-studio-cli', version: '0.10.2' },
        source: { ref: 'refs/tags/0.10.2', commit: HASH },
      }),
    /file report/,
  );

  const evidence = candidateEvidence(bytes);
  const drifted = {
    ...evidence,
    artifact: {
      ...evidence.artifact,
      files: [{ path: 'README.md', size: evidence.artifact.files[0].size }],
    },
  };
  assert.throws(() => validateArtifact(drifted, bytes), /missing required member/);
});

test('non-tar bytes cannot reach registry lookup or npm publication even with matching outer hashes', () => {
  const bytes = Buffer.from('ordinary strings are not npm tarballs');
  const evidence = evidenceForUntrustedBytes(bytes);
  let lookupCalls = 0;
  let publishCalls = 0;
  assert.throws(
    () =>
      releaseDecision({
        evidence,
        tarball: bytes,
        bindCurrent: () => evidence,
        lookup: () => {
          lookupCalls += 1;
        },
      }),
    /gzip/,
  );
  assert.throws(
    () =>
      publishCandidate({
        evidence,
        tarball: bytes,
        artifactPath: '/tmp/not-reached.tgz',
        bindCurrent: () => evidence,
        publish: () => {
          publishCalls += 1;
        },
      }),
    /gzip/,
  );
  assert.equal(lookupCalls, 0);
  assert.equal(publishCalls, 0);
});

test('registry policy publishes only on the exact npm 11 E404 and skips only identical bytes', () => {
  const bytes = releaseTarball();
  const evidence = candidateEvidence(bytes);
  const absent = { status: 1, stdout: JSON.stringify({ error: expectedE404(evidence) }), stderr: '' };
  assert.deepEqual(evaluateRegistryResult(absent, evidence), {
    decision: 'publish',
    shouldPublish: true,
  });
  const present = {
    status: 0,
    stdout: JSON.stringify({
      name: evidence.package.name,
      version: evidence.package.version,
      'dist.integrity': evidence.artifact.integrity,
      'dist.shasum': evidence.artifact.shasum,
    }),
    stderr: '',
  };
  assert.deepEqual(evaluateRegistryResult(present, evidence), {
    decision: 'skip-identical',
    shouldPublish: false,
  });
  for (const result of [
    { ...absent, stderr: 'npm error code E401\n' },
    { status: 2, stdout: '', stderr: 'outage' },
    { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') },
    { ...present, stdout: `${present.stdout}\ntrailing` },
    { ...present, stdout: present.stdout.replace(evidence.artifact.shasum, 'b'.repeat(40)) },
  ]) {
    assert.throws(() => evaluateRegistryResult(result, evidence));
  }
});

test('registry lookup and publication use the official registry and the exact tarball', () => {
  assert.deepEqual(lookupArguments('@aikdna/kdna-studio-cli@0.10.0'), [
    'view',
    '@aikdna/kdna-studio-cli@0.10.0',
    'name',
    'version',
    'dist.integrity',
    'dist.shasum',
    '--json',
    '--loglevel=silent',
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ]);
  assert.deepEqual(publishArguments('/tmp/exact.tgz'), [
    'publish',
    '/tmp/exact.tgz',
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ]);
});
