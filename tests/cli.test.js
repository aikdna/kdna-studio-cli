const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'kdna-studio.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || root,
    env: {
      ...process.env,
      KDNA_IDENTITY_DIR: path.join(options.tmp || os.tmpdir(), 'no-identity'),
    },
    encoding: 'utf8',
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-cli-'));
}

function createLockedProject(t) {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = path.join(tmp, 'project');
  let result = run(['create', projectDir, '--name', '@test/example'], { tmp });
  assert.equal(result.status, 0, result.stderr);

  const evidencePath = path.join(tmp, 'evidence.md');
  fs.writeFileSync(evidencePath, 'Evidence that specific claims should outrank broad claims.');
  result = run(['import', projectDir, evidencePath], { tmp });
  assert.equal(result.status, 0, result.stderr);

  result = run([
    'card',
    'add',
    projectDir,
    'axiom',
    '--field',
    'one_sentence=Prefer specific evidence over broad claims',
    '--field',
    'full_statement=When evaluating a claim the agent must weigh the specificity of the supporting evidence. A narrow claim backed by concrete data should be preferred over a broad claim supported only by general principles.',
    '--field',
    'why=Without this axiom the agent may accept broad plausible-sounding claims as equally credible as narrow evidence-backed ones leading to false balance.',
    '--field',
    'applies_when=["reviewing content"]',
    '--field',
    'does_not_apply_when=["pure formatting"]',
    '--field',
    'failure_risk=generic advice',
  ], { tmp });
  assert.equal(result.status, 0, result.stderr);
  const cardId = result.stdout.match(/Added card: (\S+)/)?.[1];
  assert.ok(cardId, result.stdout);

  result = run([
    'card',
    'approve',
    projectDir,
    cardId,
    '--by',
    'expert',
    '--statement',
    'I confirm this judgment.',
  ], { tmp });
  assert.equal(result.status, 0, result.stderr);

  return { tmp, projectDir, cardId };
}

test('prints help', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /kdna-studio/);
  assert.match(result.stdout, /export <project>/);
});

test('rejects unknown commands with input error', () => {
  const result = run(['unknown']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command/);
});

test('creates a Studio project and rejects accidental overwrite', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = path.join(tmp, 'project');

  let result = run(['create', projectDir, '--name', '@test/example'], { tmp });
  assert.equal(result.status, 0, result.stderr);
  const projectPath = path.join(projectDir, 'studio.project.json');
  assert.ok(fs.existsSync(projectPath));
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  assert.equal(project.name, '@test/example');

  result = run(['create', projectDir, '--name', '@test/example'], { tmp });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Directory already exists/);
});

test('blocks compile and export until judgment cards are Human Locked', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = path.join(tmp, 'project');
  let result = run(['create', projectDir, '--name', '@test/example'], { tmp });
  assert.equal(result.status, 0, result.stderr);

  result = run([
    'card',
    'add',
    projectDir,
    'axiom',
    '--field',
    'one_sentence=Prefer specific evidence over broad claims',
  ], { tmp });
  assert.equal(result.status, 0, result.stderr);

  result = run(['lock', projectDir], { tmp });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Human Lock Gate blocked export/);

  result = run(['compile', projectDir, '--out', path.join(tmp, 'build')], { tmp });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Human Lock Gate blocked compile/);
});

test('runs the trusted authoring workflow through compile and export', (t) => {
  const { tmp, projectDir, cardId } = createLockedProject(t);

  let result = run(['card', 'list', projectDir], { tmp });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${cardId}\\s+axiom\\s+locked\\s+locked`));

  result = run(['lock', projectDir], { tmp });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Human Lock Gate passed/);

  const buildDir = path.join(tmp, 'build');
  result = run(['compile', projectDir, '--out', buildDir], { tmp });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(buildDir, 'kdna.json')));
  assert.ok(fs.existsSync(path.join(buildDir, 'KDNA_CARD.json')));
  assert.ok(fs.existsSync(path.join(buildDir, 'reports', 'provenance-report.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'kdna.json'), 'utf8'));
  assert.equal(manifest.authoring.compiler, '@aikdna/kdna-studio-core');
  assert.equal(manifest.authoring.human_confirmed, true);
  assert.ok(manifest.authoring.human_lock_count >= 1);

  // Content digest must be present and non-trivial
  assert.ok(manifest.content_digest, 'manifest must have content_digest');
  assert.match(manifest.content_digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(manifest.authoring.content_digest, 'authoring must have content_digest');

  const outFile = path.join(tmp, 'dist', 'example.kdna');
  result = run(['export', projectDir, '--out', outFile], { tmp });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(outFile));
  const zipMagic = fs.readFileSync(outFile).subarray(0, 4).toString('hex');
  assert.equal(zipMagic, '504b0304');
  const receipt = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'build-receipt.json'), 'utf8'));
  assert.equal(receipt.signature_status, 'unsigned');
  assert.match(receipt.asset_digest, /^sha256:/);

  // ── Digest chain consistency ──────────────────────────────────
  // All three sources MUST agree on content_digest.
  const exportedManifest = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'kdna.json'), 'utf8'));
  const exportedProvenance = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'provenance-report.json'), 'utf8'));
  assert.equal(exportedManifest.content_digest, receipt.content_digest,
    'manifest.content_digest !== build-receipt.content_digest');
  assert.equal(exportedProvenance.content_digest, receipt.content_digest,
    'provenance-report.content_digest !== build-receipt.content_digest');
  assert.ok(exportedManifest.content_digest.startsWith('sha256:'),
    'content_digest must be sha256: prefix');
  assert.equal(exportedManifest.content_digest.length, 71,
    'content_digest must be sha256: + 64 hex chars');
});

test('refuses signing without runtime identity keys', (t) => {
  const { tmp, projectDir } = createLockedProject(t);
  const outFile = path.join(tmp, 'dist', 'signed.kdna');
  const result = run(['export', projectDir, '--out', outFile, '--sign'], { tmp });
  assert.equal(result.status, 5);
  assert.match(result.stderr, /Signing requires KDNA identity keys/);
});
