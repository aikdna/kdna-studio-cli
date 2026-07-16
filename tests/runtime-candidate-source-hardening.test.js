'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const zlib = require('node:zlib');
const {
  assertPackageTarInstallEquivalent,
} = require('../scripts/runtime-candidate-binding');
const {
  CANDIDATE_AUTHORITIES,
  readPinnedCandidateCommits,
} = require('../scripts/runtime-candidate-authority');
const {
  assertCleanPinnedRepository,
} = require('../scripts/verify-runtime-candidate-sources');

const ROOT = path.resolve(__dirname, '..');

function git(repository, args) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createSourceRepository(t) {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-source-authority-')),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'KDNA Test']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    '{"name":"@aikdna/source-fixture","version":"1.0.0"}\n',
  );
  fs.writeFileSync(path.join(repository, 'index.js'), "'use strict';\nmodule.exports = true;\n");
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'first source']);
  const first = git(repository, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repository, 'index.js'), "'use strict';\nmodule.exports = false;\n");
  git(repository, ['commit', '--quiet', '-am', 'second source']);
  const second = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['checkout', '--quiet', '--detach', first]);
  return { repository, first, second };
}

function writeTarString(header, offset, length, value) {
  Buffer.from(value).copy(header, offset, 0, length);
}

function writeTarOctal(header, offset, length, value) {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function tarGzip(content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, 'package/index.js');
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, body.length);
  writeTarOctal(header, 136, 12, 0);
  header[156] = 0x30;
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return zlib.gzipSync(Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
    Buffer.alloc(1024),
  ]));
}

test('candidate source authority rejects replacement refs, dirty trees, and wrong commits', async (t) => {
  await t.test('replacement ref', (t) => {
    const source = createSourceRepository(t);
    git(source.repository, ['replace', source.first, source.second]);
    assert.throws(
      () => assertCleanPinnedRepository(source.repository, source.first, ''),
      /replacement refs/,
    );
  });
  await t.test('dirty tree', (t) => {
    const source = createSourceRepository(t);
    fs.writeFileSync(path.join(source.repository, 'dirty.txt'), 'not committed\n');
    assert.throws(
      () => assertCleanPinnedRepository(source.repository, source.first, ''),
      /worktree is not clean/,
    );
  });
  await t.test('wrong commit', (t) => {
    const source = createSourceRepository(t);
    assert.throws(
      () => assertCleanPinnedRepository(source.repository, source.second, ''),
      /HEAD does not match the CI pin/,
    );
  });
});

test('candidate source equivalence rejects install-byte drift', () => {
  assert.throws(
    () => assertPackageTarInstallEquivalent(tarGzip('expected\n'), tarGzip('rejected\n')),
    /file bytes differ/,
  );
});

test('CI binds both exact candidate sources and separates trusted tooling from Node 18', () => {
  const pinned = readPinnedCandidateCommits(ROOT);
  assert.deepEqual([...pinned.keys()].sort(), CANDIDATE_AUTHORITIES.map(({ name }) => name).sort());
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /node: \['18\.20\.8', '22\.23\.1'\]/);
  assert.match(workflow, /node-version: '22\.23\.1'/);
  assert.match(workflow, /node-version: '\$\{\{ matrix\.node \}\}'/);
  assert.match(workflow, /KDNA_CORE_CANDIDATE_SOURCE/);
  assert.match(workflow, /KDNA_STUDIO_CORE_CANDIDATE_SOURCE/);
  assert.match(workflow, /run-product-tests\.js/);
  assert.match(workflow, /if: matrix\.node == '18\.20\.8'\n\s+run: npm run test:candidate-chain/);
  assert.doesNotMatch(workflow, /if: matrix\.node == '18\.20\.8'\n\s+run: node scripts\/run-trusted-npm/);
  const verifier = fs.readFileSync(
    path.join(ROOT, 'scripts/verify-runtime-candidate-sources.js'),
    'utf8',
  );
  assert.match(verifier, /source-first/);
  assert.match(verifier, /source-second/);
  assert.match(verifier, /candidate source packs are not byte-identical/);
  assert.match(verifier, /assertPackageTarInstallEquivalent/);
});

test('every acceptance workflow action is immutable and Node coordinates are exact', () => {
  for (const relative of [
    '.github/workflows/ci.yml',
    '.github/workflows/publish.yml',
    '.github/workflows/codeql-js.yml',
    '.github/workflows/public-surface.yml',
  ]) {
    const workflow = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const actions = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map(
      (match) => match[1],
    );
    assert.ok(actions.length > 0, `${relative} must use at least one pinned action`);
    for (const action of actions) {
      assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/, `${relative}: ${action}`);
    }
  }
  const publish = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.match(publish, /node-version: '22\.23\.1'/);
  assert.doesNotMatch(publish, /node-version:\s*(?:18|22)\s*$/m);
  const publicSurface = fs.readFileSync(
    path.join(ROOT, '.github/workflows/public-surface.yml'),
    'utf8',
  );
  assert.match(publicSurface, /node-version: '22\.23\.1'/);
  assert.match(publicSurface, /acquire-trusted-npm-release\.js --out/);
  assert.match(publicSurface, /KDNA_TRUSTED_NPM_TARBALL=/);
  assert.match(publicSurface, /check-current-protocol-names\.js/);
});
