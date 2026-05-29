const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

let kdnaCore = null;
try { kdnaCore = require('@aikdna/kdna-core'); } catch { /* optional — runtime digest cross-verification */ }

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'kdna-studio.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || root,
    env: {
      ...process.env,
      KDNA_IDENTITY_DIR: path.join(options.tmp || os.tmpdir(), 'no-identity'),
      ...(options.env || {}),
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

// ── Identity ────────────────────────────────────────────────────────

test('identity init creates local creator identity', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const identityDir = path.join(tmp, 'identity');

  const result = run(['identity', 'init', '--name', 'Test Creator'], {
    tmp,
    env: { ...process.env, KDNA_IDENTITY_DIR: identityDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Creator identity initialized/);
  assert.match(result.stdout, /kdna:creator:ed25519:/);

  // Verify files were created
  assert.ok(fs.existsSync(path.join(identityDir, 'kdna.key')));
  assert.ok(fs.existsSync(path.join(identityDir, 'kdna.pub')));
  assert.ok(fs.existsSync(path.join(identityDir, 'creator.json')));
  const creatorJson = JSON.parse(fs.readFileSync(path.join(identityDir, 'creator.json'), 'utf8'));
  assert.match(creatorJson.creator_id, /^kdna:creator:ed25519:/);
  assert.equal(creatorJson.display_name, 'Test Creator');
  assert.equal(creatorJson.verified, false);

  // Double init should fail
  const result2 = run(['identity', 'init', '--name', 'Duplicate'], {
    tmp,
    env: { ...process.env, KDNA_IDENTITY_DIR: identityDir },
  });
  assert.equal(result2.status, 2);
  assert.match(result2.stderr, /already exists/);
});

test('identity show displays current identity', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const identityDir = path.join(tmp, 'identity');

  // Init first
  run(['identity', 'init', '--name', 'Test User'], {
    tmp,
    env: { ...process.env, KDNA_IDENTITY_DIR: identityDir },
  });

  const result = run(['identity', 'show'], {
    tmp,
    env: { ...process.env, KDNA_IDENTITY_DIR: identityDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.match(info.creator_id, /^kdna:creator:ed25519:/);
  assert.equal(info.display_name, 'Test User');
});

test('identity show fails when not initialized', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const result = run(['identity', 'show'], {
    tmp,
    env: { ...process.env, KDNA_IDENTITY_DIR: path.join(tmp, 'no-such') },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No identity found/);
});

// ── Create from folder ──────────────────────────────────────────────

test('create --from-folder imports legacy JSON source, outputs audit', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const sourceDir = path.join(tmp, 'legacy-source');
  fs.mkdirSync(sourceDir, { recursive: true });

  // Create legacy KDNA files
  const core = {
    meta: { domain: 'test', version: '0.1.0', created: '2026-01-01', purpose: 'test', load_condition: 'always' },
    axioms: [{
      id: 'ax_legacy',
      one_sentence: 'Test axiom from legacy folder.',
      full_statement: 'A complete testable explanation from a legacy source folder.',
      why: 'Without this legacy axiom, agent judgment defaults to untrained behavior.',
      applies_when: ['testing legacy import'],
      does_not_apply_when: ['production'],
      failure_risk: 'May produce incorrect results from untrained judgment.',
    }],
    ontology: [{ id: 'ont_legacy', one_sentence: 'Legacy concept.', essence: 'Operational meaning.', boundary: 'Not the opposite.', trigger_signal: 'keyword' }],
    boundaries: [{ id: 'bnd_legacy', scope: 'Legacy scope.', out_of_scope: 'Not covered by legacy.', acceptable_exceptions: [] }],
    stances: [],
  };
  fs.writeFileSync(path.join(sourceDir, 'KDNA_Core.json'), JSON.stringify(core));
  fs.writeFileSync(path.join(sourceDir, 'KDNA_Patterns.json'), JSON.stringify({
    meta: { domain: 'test', version: '0.1.0', created: '2026-01-01', purpose: 'patterns', load_condition: 'always' },
    misunderstandings: [{ id: 'ms_legacy', wrong: 'Legacy wrong belief.', correct: 'Correct understanding.', key_distinction: 'The key distinction between wrong and correct.' }],
    self_check: ['Did I verify the legacy import?'],
  }));

  const projectDir = path.join(tmp, 'project');
  const result = run(['create', projectDir, '--from-folder', sourceDir, '--name', '@test/legacy-import'], { tmp });
  assert.equal(result.status, 0, result.stderr);

  const output = JSON.parse(result.stdout);
  assert.ok(output.audit, 'must have audit info');
  assert.ok(output.audit.filesFound.includes('KDNA_Core.json'));
  assert.ok(output.audit.filesFound.includes('KDNA_Patterns.json'));
  assert.ok(output.imported > 0, `imported cards: ${output.imported}`);
  assert.equal(output.source_mode, 'source_folder');

  // Read project and verify cards were imported
  const projectPath = path.join(projectDir, 'studio.project.json');
  assert.ok(fs.existsSync(projectPath));
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  assert.equal(project.source_mode, 'source_folder');
  assert.ok(project.cards.length > 0);
  assert.equal(project.lineage.type, 'migrated');
});

// ── Create from KDNA ────────────────────────────────────────────────

test('create --from-kdna forks an existing .kdna asset', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // First create and export a "parent" project
  const parentTmp = tmpDir();
  t.after(() => fs.rmSync(parentTmp, { recursive: true, force: true }));
  const { projectDir: parentDir } = createLockedProject(t);
  const parentDist = path.join(parentTmp, 'dist');
  fs.mkdirSync(parentDist, { recursive: true });
  const parentKdna = path.join(parentDist, 'parent.kdna');
  run(['export', parentDir, '--out', parentKdna], { tmp: parentTmp });

  // Now fork from that .kdna
  const projectDir = path.join(tmp, 'forked-project');
  const result = run(['create', projectDir, '--from-kdna', parentKdna, '--name', '@test/fork'], { tmp });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created Studio project/);
  assert.match(result.stdout, /kdna_asset/);

  const projectPath = path.join(projectDir, 'studio.project.json');
  assert.ok(fs.existsSync(projectPath));
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  assert.equal(project.source_mode, 'kdna_asset');
  assert.ok(project.lineage, 'must have lineage');
  assert.equal(project.lineage.type, 'fork');
  assert.ok(project.lineage.parent_name, 'must record parent name');
});

// ── Card approve --sign ─────────────────────────────────────────────

test('card approve --sign binds Human Lock to creator identity', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const identityDir = path.join(tmp, 'identity');

  // Initialize creator identity
  const init = run(['identity', 'init', '--name', 'Signer'], {
    tmp,
    env: { ...process.env, KDNA_IDENTITY_DIR: identityDir },
  });
  assert.equal(init.status, 0, init.stderr);

  // Create project with an axiom
  const projectDir = path.join(tmp, 'project');
  let result = run(['create', projectDir, '--name', '@test/signed'], { tmp });
  assert.equal(result.status, 0, result.stderr);

  result = run([
    'card', 'add', projectDir, 'axiom',
    '--field', 'one_sentence=Prefer specific evidence over broad claims',
    '--field', 'full_statement=When evaluating a claim the agent must weigh the specificity of the supporting evidence. A narrow claim backed by concrete data should be preferred.',
    '--field', 'why=Without this axiom the agent may accept broad plausible-sounding claims as equally credible as narrow evidence-backed ones.',
    '--field', 'applies_when=["reviewing content"]',
    '--field', 'does_not_apply_when=["pure formatting"]',
    '--field', 'failure_risk=generic advice',
  ], { tmp });
  assert.equal(result.status, 0, result.stderr);
  const cardId = result.stdout.match(/Added card: (\S+)/)?.[1];

  // Approve with --sign
  result = run([
    'card', 'approve', projectDir, cardId,
    '--by', 'signer',
    '--statement', 'I confirm this judgment with my creator identity.',
    '--sign',
  ], {
    tmp,
    env: { ...process.env, KDNA_IDENTITY_DIR: identityDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /signed/);

  // Verify human_lock has creator_id and signature
  const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'studio.project.json'), 'utf8'));
  const lockedCard = project.cards.find(c => c.id === cardId);
  assert.ok(lockedCard.human_lock, 'must have human_lock');
  assert.ok(lockedCard.human_lock.creator_id, 'must have creator_id');
  assert.match(lockedCard.human_lock.creator_id, /^kdna:creator:ed25519:/);
  assert.ok(lockedCard.human_lock.signature, 'must have signature');
  assert.match(lockedCard.human_lock.signature, /^ed25519:/);
});

// ── Blank create with default source_mode ───────────────────────────

test('create (blank) sets source_mode=blank by default', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = path.join(tmp, 'project');

  const result = run(['create', projectDir, '--name', '@test/blank'], { tmp });
  assert.equal(result.status, 0, result.stderr);

  const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'studio.project.json'), 'utf8'));
  assert.equal(project.source_mode, 'blank');
});

// ── export includes creator/lineage in manifest ─────────────────────

test('export includes creator and lineage in kdna.json', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const identityDir = path.join(tmp, 'identity');

  // Init identity
  run(['identity', 'init', '--name', 'Exporter'], {
    tmp,
    env: { ...process.env, KDNA_IDENTITY_DIR: identityDir },
  });

  // Create, add axiom, approve
  const projectDir = path.join(tmp, 'project');
  run(['create', projectDir, '--name', '@test/exported'], { tmp });
  run([
    'card', 'add', projectDir, 'axiom',
    '--field', 'one_sentence=Test axiom for lineage.',
    '--field', 'full_statement=This is a complete testable explanation for the agent to apply in judgment scenarios.',
    '--field', 'why=Without this axiom the agent would make incorrect judgment calls.',
    '--field', 'applies_when=["testing"]',
    '--field', 'does_not_apply_when=["not testing"]',
    '--field', 'failure_risk=test may pass incorrectly',
  ], { tmp });
  let result = run(['card', 'list', projectDir], { tmp });
  const cardId = result.stdout.match(/(\S+)\s+axiom/)?.[1];
  run(['card', 'approve', projectDir, cardId, '--by', 'tester', '--statement', 'Verified.'], { tmp });
  run(['lock', projectDir], { tmp });

  const distDir = path.join(tmp, 'dist');
  const outFile = path.join(distDir, 'exported.kdna');
  result = run(['export', projectDir, '--out', outFile], { tmp });
  assert.equal(result.status, 0, result.stderr);

  // Check exported kdna.json has new fields
  const exportedManifest = JSON.parse(fs.readFileSync(path.join(distDir, 'kdna.json'), 'utf8'));
  assert.equal(exportedManifest.authoring.source_mode, 'blank');
  assert.ok(exportedManifest.lineage, 'must have lineage');
  assert.equal(exportedManifest.lineage.type, 'original');
});

// ── E2E: Blank workflow with runtime content_digest check ──────────

test('E2E blank: create → approve → lock → export → runtime digest match', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const projectDir = path.join(tmp, 'project');
  let result = run(['create', projectDir, '--name', '@test/e2e-blank'], { tmp });
  assert.equal(result.status, 0, result.stderr);

  // Add axiom with full fields
  result = run([
    'card', 'add', projectDir, 'axiom',
    '--field', 'one_sentence=E2E blank axiom.',
    '--field', 'full_statement=A complete testable explanation for the end-to-end blank workflow test.',
    '--field', 'why=Without this axiom the end-to-end test would not validate blank creation.',
    '--field', 'applies_when=["e2e testing"]',
    '--field', 'does_not_apply_when=["production"]',
    '--field', 'failure_risk=e2e test may incorrectly pass',
  ], { tmp });
  assert.equal(result.status, 0, result.stderr);
  const cardId = result.stdout.match(/Added card: (\S+)/)?.[1];

  // Add a misunderstanding
  result = run([
    'card', 'add', projectDir, 'misunderstanding',
    '--field', 'wrong=E2E tests are unnecessary.',
    '--field', 'correct=E2E tests catch integration issues not visible in unit tests.',
    '--field', 'key_distinction=E2E tests validate the full pipeline, not individual functions.',
  ], { tmp });
  assert.equal(result.status, 0, result.stderr);

  // Approve all cards
  let cards = run(['card', 'list', projectDir], { tmp });
  for (const line of cards.stdout.trim().split('\n')) {
    const id = line.split(/\s+/)[0];
    result = run(['card', 'approve', projectDir, id, '--by', 'tester', '--statement', 'Confirmed.'], { tmp });
    assert.equal(result.status, 0, result.stderr);
  }

  // Lock and export
  result = run(['lock', projectDir], { tmp });
  assert.equal(result.status, 0, result.stderr);

  const outFile = path.join(tmp, 'blank.kdna');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  result = run(['export', projectDir, '--out', outFile], { tmp });
  assert.equal(result.status, 0, result.stderr);

  // ── Verify: source_mode, lineage, digest chain ────────────
  const distDir = path.dirname(outFile);
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'kdna.json'), 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(path.join(distDir, 'build-receipt.json'), 'utf8'));
  const provenance = JSON.parse(fs.readFileSync(path.join(distDir, 'provenance-report.json'), 'utf8'));

  assert.equal(manifest.authoring.source_mode, 'blank');
  assert.equal(manifest.lineage.type, 'original');
  assert.match(manifest.content_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(manifest.content_digest, receipt.content_digest, 'manifest vs receipt digest mismatch');
  assert.equal(manifest.content_digest, provenance.content_digest, 'manifest vs provenance digest mismatch');
  assert.equal(manifest.authoring.compiler, '@aikdna/kdna-studio-core');
  assert.equal(manifest.authoring.human_confirmed, true);

  // ── Runtime cross-verification: content digest consistency ──
  // Compute content digest from the .kdna ZIP entries and verify it
  // matches the manifest, receipt, and provenance report.
  if (kdnaCore) {
    const reader = kdnaCore.createKdnaAssetReader();
    const asset = reader.openSync(outFile);
    const runtimeResult = reader.verifySync(asset);
    const runtimeDigest = runtimeResult.content_digest;

    assert.ok(runtimeDigest, 'runtime content_digest must be present');
    assert.match(runtimeDigest, /^sha256:[0-9a-f]{64}$/, 'runtime content_digest must be valid sha256');

    // Read ZIP-internal manifest (avoid sidecar timing issues)
    const zipManifest = JSON.parse(asset.readEntry('kdna.json').toString());
    assert.equal(zipManifest.content_digest, receipt.content_digest,
      `ZIP manifest digest != receipt digest`);
    assert.equal(zipManifest.content_digest, provenance.content_digest,
      `ZIP manifest digest != provenance digest`);

    // Verify: runtime computed digest matches ZIP manifest
    assert.equal(zipManifest.content_digest, runtimeDigest,
      `ZIP manifest content_digest (${zipManifest.content_digest.slice(0, 20)}...) != runtime computed (${runtimeDigest.slice(0, 20)}...) — trust chain broken`);
  } else {
    console.log('  (kdna-core not available, skipping runtime assetReader cross-verification)');
  }
});

// ── E2E: Fork workflow ────────────────────────────────────────────

test('E2E fork: parent → fork → approve → export → lineage check', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // Step 1: Create and export a parent domain
  const parentDir = path.join(tmp, 'parent');
  let result = run(['create', parentDir, '--name', '@test/parent-domain'], { tmp });
  result = run([
    'card', 'add', parentDir, 'axiom',
    '--field', 'one_sentence=Parent axiom for forking test.',
    '--field', 'full_statement=A complete testable explanation from the parent domain for fork lineage verification.',
    '--field', 'why=Without this parent axiom the fork test would have no source to verify lineage against.',
    '--field', 'applies_when=["fork testing"]',
    '--field', 'does_not_apply_when=["not forking"]',
    '--field', 'failure_risk=forked content may lose lineage',
  ], { tmp });
  const pCards = run(['card', 'list', parentDir], { tmp });
  for (const line of pCards.stdout.trim().split('\n')) {
    const id = line.split(/\s+/)[0];
    run(['card', 'approve', parentDir, id, '--by', 'tester', '--statement', 'Parent OK.'], { tmp });
  }
  run(['lock', parentDir], { tmp });
  const parentKdna = path.join(tmp, 'parent.kdna');
  fs.mkdirSync(path.dirname(parentKdna), { recursive: true });
  result = run(['export', parentDir, '--out', parentKdna], { tmp });
  assert.equal(result.status, 0, result.stderr);

  // Step 2: Fork from parent
  const forkDir = path.join(tmp, 'forked');
  result = run(['create', forkDir, '--from-kdna', parentKdna, '--name', '@test/forked-domain'], { tmp });
  assert.equal(result.status, 0, result.stderr);

  const fProject = JSON.parse(fs.readFileSync(path.join(forkDir, 'studio.project.json'), 'utf8'));
  assert.equal(fProject.source_mode, 'kdna_asset');
  assert.equal(fProject.lineage.type, 'fork');
  assert.equal(fProject.lineage.parent_name, '@test/parent-domain');

  // Step 3: Approve and export fork
  const fCards = run(['card', 'list', forkDir], { tmp });
  for (const line of fCards.stdout.trim().split('\n')) {
    const id = line.split(/\s+/)[0];
    run(['card', 'approve', forkDir, id, '--by', 'tester', '--statement', 'Fork confirmed.'], { tmp });
  }
  run(['lock', forkDir], { tmp });
  const forkKdna = path.join(tmp, 'forked.kdna');
  fs.mkdirSync(path.dirname(forkKdna), { recursive: true });
  result = run(['export', forkDir, '--out', forkKdna], { tmp });
  assert.equal(result.status, 0, result.stderr);

  // Step 4: Verify lineage in exported fork
  const fManifest = JSON.parse(fs.readFileSync(path.join(tmp, 'kdna.json'), 'utf8'));
  assert.equal(fManifest.authoring.source_mode, 'kdna_asset');
  assert.equal(fManifest.lineage.type, 'fork');
  assert.equal(fManifest.lineage.parent_name, '@test/parent-domain');
  assert.match(fManifest.content_digest, /^sha256:/);
});

// ── E2E: Migrate workflow ─────────────────────────────────────────

test('E2E migrate: source folder → import → approve → export → verify', (t) => {
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // Step 1: Create legacy source folder
  const sourceDir = path.join(tmp, 'legacy');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'KDNA_Core.json'), JSON.stringify({
    meta: { domain: 'legacy_test', version: '0.3.0', created: '2026-01-01', purpose: 'Legacy migrate test', load_condition: 'always' },
    axioms: [{
      id: 'ax_mig', one_sentence: 'Migrated axiom for E2E test.',
      full_statement: 'A complete testable explanation for the migrated legacy axiom in the end-to-end workflow.',
      why: 'Without this migrated axiom the e2e test cannot verify legacy folder migration.',
      applies_when: ['legacy migration testing'], does_not_apply_when: ['not migrating'],
      failure_risk: 'migrated content may not be re-locked',
    }],
    ontology: [],
    stances: [],
  }));
  fs.writeFileSync(path.join(sourceDir, 'KDNA_Patterns.json'), JSON.stringify({
    meta: { domain: 'legacy_test', version: '0.3.0', created: '2026-01-01', purpose: 'legacy patterns', load_condition: 'always' },
    misunderstandings: [{ id: 'ms_mig', wrong: 'Legacy wrong belief.', correct: 'Correct understanding.', key_distinction: 'The key difference between legacy wrong and correct behavior.' }],
    self_check: ['Is the migrated content properly re-locked?'],
  }));

  // Step 2: Import via --from-folder
  const projectDir = path.join(tmp, 'imported');
  let result = run(['create', projectDir, '--from-folder', sourceDir, '--name', '@test/e2e-migrate'], { tmp });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.ok(audit.imported > 0, `No cards imported: ${result.stdout}`);
  assert.equal(audit.source_mode, 'source_folder');

  // Verify project has source_folder mode
  const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'studio.project.json'), 'utf8'));
  assert.equal(project.source_mode, 'source_folder');
  assert.equal(project.lineage.type, 'migrated');

  // Step 3: Approve and export
  const cards = run(['card', 'list', projectDir], { tmp });
  for (const line of cards.stdout.trim().split('\n')) {
    const id = line.split(/\s+/)[0];
    result = run(['card', 'approve', projectDir, id, '--by', 'tester', '--statement', 'Migrated content confirmed.'], { tmp });
    assert.equal(result.status, 0, result.stderr);
  }
  result = run(['lock', projectDir], { tmp });
  assert.equal(result.status, 0, result.stderr);

  const outFile = path.join(tmp, 'migrated.kdna');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  result = run(['export', projectDir, '--out', outFile], { tmp });
  assert.equal(result.status, 0, result.stderr);

  // Verify exported manifest
  const distDir = path.dirname(outFile);
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'kdna.json'), 'utf8'));
  assert.equal(manifest.authoring.source_mode, 'source_folder');
  assert.equal(manifest.lineage.type, 'migrated');
  assert.match(manifest.content_digest, /^sha256:/);
  assert.equal(manifest.authoring.human_confirmed, true);

  // Digest chain
  const receipt = JSON.parse(fs.readFileSync(path.join(distDir, 'build-receipt.json'), 'utf8'));
  assert.equal(manifest.content_digest, receipt.content_digest);
});
