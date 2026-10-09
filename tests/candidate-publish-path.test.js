'use strict';

// The candidate publication channel. It is deliberately separate from the
// stable publisher: a candidate evidence document can never satisfy the stable
// validator and stable evidence can never satisfy the candidate validator. Both
// channels still share the registry policy, the pack evidence format and the
// never-defaulted publish tag.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { validateCandidateBinding } = require('../scripts/candidate-release-binding');
const {
  candidateReleaseDecision,
  publishVerifiedCandidate,
} = require('../scripts/publish-candidate-artifact');
const { parseTarFiles } = require('../scripts/release-evidence');
const { expectedE404 } = require('../scripts/registry-policy');
const { CANDIDATE_TAG_PREFIX } = require('../scripts/release-policy');
const { releaseDecision } = require('../scripts/publish-verified-artifact');

const ROOT = path.resolve(__dirname, '..');
const HASH = 'a'.repeat(40);
const CANDIDATE_VERSION = '4.0.0-rc.components.2';

function writeTarString(header, offset, length, value) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
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

function tarball() {
  // The Studio CLI pack has required members, so the fixture carries them.
  const required = [
    'LICENSE',
    'NOTICE',
    'README.md',
    'bin/kdna-studio.js',
    'package.json',
    'src/terminal-workspace.js',
    'src/component-operations.js',
    'src/public-bindings.json',
    'docs/CREATION_COMMAND_CONTRACT.md',
    'docs/TERMINAL_AGENT_CREATION.md',
  ];
  return zlib.gzipSync(Buffer.concat([
    ...required.map((name) => tarEntry({ name: `package/${name}`, content: `${name}\n` })),
    Buffer.alloc(1024),
  ]));
}

function candidateEvidence(bytes = tarball()) {
  const files = parseTarFiles(bytes);
  return {
    schema: 'kdna.studio-cli.candidate-evidence',
    version: '1.0',
    source: { ref: `candidate:${HASH}`, commit: HASH },
    package: { name: '@aikdna/kdna-studio-cli', version: CANDIDATE_VERSION },
    artifact: {
      filename: `aikdna-kdna-studio-cli-${CANDIDATE_VERSION}.tgz`,
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      packed_size: bytes.length,
      unpacked_size: files.reduce((total, file) => total + file.size, 0),
      file_count: files.length,
      files,
    },
  };
}

function candidateInput(overrides = {}) {
  const version = overrides.pkg?.version || CANDIDATE_VERSION;
  const tag = `${CANDIDATE_TAG_PREFIX}${version}`;
  return {
    pkg: { name: '@aikdna/kdna-studio-cli', version, ...overrides.pkg },
    changelog: overrides.changelog ?? `# Changelog\n\n## ${version} (2026-10-09)\n`,
    env: {
      GITHUB_EVENT_NAME: 'release',
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_TAG_NAME: tag,
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'true',
      GITHUB_REF: `refs/tags/${tag}`,
      GITHUB_SHA: HASH,
      ...overrides.env,
    },
    git: { status: '', head: HASH, tagCommit: HASH, ...overrides.git },
  };
}

test('candidate evidence binds to the candidate release event, tag and commit', () => {
  const bytes = tarball();
  const evidence = candidateEvidence(bytes);
  assert.equal(validateCandidateBinding({ evidence, ...candidateInput() }), evidence);

  for (const input of [
    candidateInput({ env: { RELEASE_IS_PRERELEASE: 'false' } }),
    candidateInput({ env: { RELEASE_TAG_NAME: CANDIDATE_VERSION } }),
    candidateInput({ env: { GITHUB_REF: 'refs/heads/main' } }),
    candidateInput({ env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }),
    candidateInput({ env: { RELEASE_EVENT_ACTION: 'created' } }),
    candidateInput({ env: { RELEASE_IS_DRAFT: 'true' } }),
    candidateInput({ git: { status: ' M package.json' } }),
    candidateInput({ git: { tagCommit: 'b'.repeat(40) } }),
    candidateInput({ changelog: `# Changelog\n\n## ${CANDIDATE_VERSION}\n\n## ${CANDIDATE_VERSION}\n` }),
    candidateInput({ changelog: '# Changelog\n\n## 4.0.0-rc.other.1\n' }),
  ]) {
    assert.throws(() => validateCandidateBinding({ evidence, ...input }));
  }

  // Evidence that is itself well formed but bound to something else is stale.
  const other = 'b'.repeat(40);
  const otherVersion = '4.0.0-rc.other.1';
  assert.throws(
    () => validateCandidateBinding({
      evidence: {
        ...evidence,
        package: { ...evidence.package, version: otherVersion },
        artifact: {
          ...evidence.artifact,
          filename: `aikdna-kdna-studio-cli-${otherVersion}.tgz`,
        },
      },
      ...candidateInput(),
    }),
    /evidence version is stale/,
  );
  assert.throws(
    () => validateCandidateBinding({
      evidence: { ...evidence, source: { ref: `candidate:${other}`, commit: other } },
      ...candidateInput(),
    }),
    /evidence commit is stale/,
  );
});

test('the two publication channels are mutually exclusive', () => {
  const bytes = tarball();
  const candidate = candidateEvidence(bytes);
  // The stable publisher validates the stable schema before any registry call.
  assert.throws(
    () => releaseDecision({
      evidence: candidate,
      tarball: bytes,
      bindCurrent: () => {},
      lookup: () => {
        throw new Error('the registry must not be reached');
      },
    }),
    /release evidence schema mismatch/,
  );
  // The candidate publisher requires the candidate schema.
  assert.throws(
    () => candidateReleaseDecision({
      evidence: { ...candidate, schema: 'kdna.studio-cli.release-evidence' },
      tarball: bytes,
      bindCurrent: () => {},
      lookup: () => {
        throw new Error('the registry must not be reached');
      },
    }),
    /release evidence schema mismatch/,
  );
});

test('a candidate publishes only when the exact coordinate is absent and skips identical bytes', () => {
  const bytes = tarball();
  const evidence = candidateEvidence(bytes);
  let bound = 0;
  const bindCurrent = (value) => {
    bound += 1;
    assert.equal(value, evidence);
  };
  const absent = candidateReleaseDecision({
    evidence,
    tarball: bytes,
    bindCurrent,
    lookup: () => ({
      status: 1,
      stdout: JSON.stringify({ error: expectedE404(evidence) }),
      stderr: '',
    }),
  });
  assert.equal(absent.shouldPublish, true);
  assert.equal(absent.decision, 'publish');

  const identical = candidateReleaseDecision({
    evidence,
    tarball: bytes,
    bindCurrent,
    lookup: () => ({
      status: 0,
      stdout: JSON.stringify({
        name: evidence.package.name,
        version: evidence.package.version,
        'dist.integrity': evidence.artifact.integrity,
        'dist.shasum': evidence.artifact.shasum,
      }),
      stderr: '',
    }),
  });
  assert.equal(identical.shouldPublish, false);
  assert.equal(identical.decision, 'skip-identical');
  assert.equal(bound, 2);

  // A digest collision is still a hard stop, exactly as on the stable channel.
  assert.throws(() => candidateReleaseDecision({
    evidence,
    tarball: bytes,
    bindCurrent,
    lookup: () => ({
      status: 0,
      stdout: JSON.stringify({
        name: evidence.package.name,
        version: evidence.package.version,
        'dist.integrity': evidence.artifact.integrity,
        'dist.shasum': '0'.repeat(40),
      }),
      stderr: '',
    }),
  }));
});

test('the candidate publisher never reaches latest', () => {
  const bytes = tarball();
  const evidence = candidateEvidence(bytes);
  let publishArgs = null;
  publishVerifiedCandidate({
    evidence,
    tarball: bytes,
    artifactPath: path.join(ROOT, 'candidate-artifact.tgz'),
    tag: 'components-preview',
    bindCurrent: () => {},
    publish: (args) => {
      publishArgs = args;
      return { status: 0 };
    },
  });
  assert.ok(publishArgs.includes('--tag=components-preview'), publishArgs.join(' '));
  assert.ok(publishArgs.includes('--provenance'));

  for (const tag of ['latest', 'next', '']) {
    assert.throws(() => publishVerifiedCandidate({
      evidence,
      tarball: bytes,
      artifactPath: path.join(ROOT, 'candidate-artifact.tgz'),
      tag,
      bindCurrent: () => {},
      publish: () => {
        throw new Error('npm must not run');
      },
    }));
  }
});

test('the publish workflow selects the channel the release event names', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.match(
    workflow,
    /github\.event\.release\.prerelease && 'candidate:generate-evidence' \|\| 'release:generate-evidence'/u,
  );
  assert.match(
    workflow,
    /github\.event\.release\.prerelease && 'scripts\/publish-candidate-artifact\.js' \|\| 'scripts\/publish-verified-artifact\.js'/u,
  );
  assert.match(
    workflow,
    /--tag \$\{\{ github\.event\.release\.prerelease && 'components-preview' \|\| 'latest' \}\}/u,
  );
});
