'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cbor = require('cbor-x');
const core = require('@aikdna/kdna-core');
const studio = require('@aikdna/kdna-studio-core');
const {
  assertRegistryReleaseReady,
  verifyCandidateBinding,
} = require('../scripts/runtime-candidate-binding');

const BIN = path.resolve(__dirname, '..', 'bin', 'kdna-studio.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-producer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  const project = studio.project.createProject('portable_judgment', 'domain', {
    judgmentCore: {
      highest_question: 'Which declared tradeoff controls this task?',
      worldview: ['Observed task facts remain authoritative.'],
      value_order: ['prevent irreversible harm', 'preserve reversibility'],
      judgment_role: {
        acts_as: 'a scoped judgment authority',
        does_not_act_as: ['a fact source'],
        responsibility: 'Order qualitative tradeoffs inside the declared scope.',
      },
    },
  });
  project.cards.push(
    studio.cards.createCard(
      'axiom',
      {
        one_sentence: 'Keep the exact declared decision boundary.',
        full_statement:
          'The exported asset must keep the exact declared decision boundary through runtime loading.',
        why: 'Changing the boundary changes the judgment.',
        confidence: 'high',
        evidence_type: 'practice',
        applies_when: ['Exporting an asset'],
        does_not_apply_when: ['Editing raw notes'],
        failure_risk: 'A consumer may apply the judgment outside its scope.',
      },
      'ax_portable_boundary',
    ),
  );
  fs.writeFileSync(
    path.join(projectDir, 'studio.project.json'),
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return { root, project, projectDir };
}

function exportAsset(projectDir, output) {
  return spawnSync(process.execPath, [BIN, 'export', projectDir, '--out', output], {
    encoding: 'utf8',
    env: { ...process.env },
  });
}

test('Studio CLI emits the current manifest, payload, digest, and Runtime contracts', (t) => {
  const { root, project, projectDir } = fixture(t);
  const assetPath = path.join(root, 'asset.kdna');
  const result = exportAsset(projectDir, assetPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(core.validate(assetPath).overall_valid, true);

  const unpacked = path.join(root, 'unpacked');
  core.unpack(assetPath, unpacked);
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'kdna.json'), 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'risk_level'), false, 'Core 0.20 manifest must not carry risk_level');
  assert.equal(Object.hasOwn(manifest, 'quality_badge'), false, 'Core 0.20 manifest must not carry quality_badge');
  const payload = cbor.decode(fs.readFileSync(path.join(unpacked, 'payload.kdnab')));
  const checksums = JSON.parse(fs.readFileSync(path.join(unpacked, 'checksums.json'), 'utf8'));

  assert.equal(manifest.format_version, '0.1.0');
  assert.deepEqual(manifest.compatibility, {
    min_loader_version: '0.20.0',
    profile: 'kdna.payload.judgment',
    profile_version: '0.1.0',
  });
  assert.equal(payload.profile, 'kdna.payload.judgment');
  assert.equal(payload.profile_version, '0.1.0');
  assert.equal(checksums.digest_profile, 'kdna.digest-basis.runtime-entry-set');
  assert.equal(checksums.digest_profile_version, '0.1.0');
  assert.equal(Object.hasOwn(checksums, 'asset_digest'), false);

  assert.deepEqual(
    Object.fromEntries(
      Object.keys(project.judgment_core).map((field) => [field, payload.core[field]]),
    ),
    project.judgment_core,
  );
  const sourceAxiom = project.cards[0];
  const runtimeAxiom = payload.core.axioms[0];
  for (const field of [
    'one_sentence',
    'full_statement',
    'why',
    'confidence',
    'evidence_type',
    'applies_when',
    'does_not_apply_when',
    'failure_risk',
  ]) {
    assert.deepEqual(runtimeAxiom[field], sourceAxiom.fields[field], field);
  }

  const capsule = core.load(assetPath, { profile: 'compact', as: 'json' });
  assert.equal(capsule.type, 'kdna.runtime-capsule');
  assert.equal(capsule.contract_version, '0.1.0');
});

test('Studio CLI binds exact unpublished Runtime candidates and blocks release', () => {
  const root = path.resolve(__dirname, '..');
  const evidence = verifyCandidateBinding(root);
  assert.deepEqual(
    evidence.packages.map((entry) => [entry.name, entry.version, entry.commit]),
    [
      [
        '@aikdna/kdna-core',
        '0.20.0',
        '1e77e3e0d486c330fe9f9262b514ef24c859d469',
      ],
      [
        '@aikdna/kdna-studio-core',
        '2.0.1',
        '06c771a24163ec81d31b4ec8e224f311f1836402',
      ],
    ],
  );
  assert.doesNotThrow(
    () => assertRegistryReleaseReady(root),
  );
});

test('create --from-kdna preserves the declared judgment core without axiom synthesis', (t) => {
  const { root, project, projectDir } = fixture(t);
  const sourceAsset = path.join(root, 'source.kdna');
  assert.equal(exportAsset(projectDir, sourceAsset).status, 0);

  const importedProjectDir = path.join(root, 'imported-project');
  const imported = spawnSync(
    process.execPath,
    [BIN, 'create', importedProjectDir, '--from-kdna', sourceAsset, '--name', '@test/imported'],
    { encoding: 'utf8', env: { ...process.env } },
  );
  assert.equal(imported.status, 0, imported.stderr);

  const importedProject = JSON.parse(
    fs.readFileSync(path.join(importedProjectDir, 'studio.project.json'), 'utf8'),
  );
  assert.deepEqual(importedProject.judgment_core, project.judgment_core);
  assert.notEqual(
    importedProject.judgment_core.highest_question,
    importedProject.cards[0].fields.one_sentence,
    'highest_question must come from payload.core, not the first axiom',
  );

  const reexportedAsset = path.join(root, 'reexported.kdna');
  const reexported = exportAsset(importedProjectDir, reexportedAsset);
  assert.equal(reexported.status, 0, reexported.stderr);
  assert.equal(core.validate(reexportedAsset).overall_valid, true);
  const payload = core.load(reexportedAsset, { profile: 'full', as: 'json' }).context.payload;
  for (const field of ['highest_question', 'worldview', 'value_order', 'judgment_role']) {
    assert.deepEqual(payload.core[field], project.judgment_core[field], field);
  }
});

test('Studio CLI refuses a packaged asset with a non-current payload profile', (t) => {
  const { root, projectDir } = fixture(t);
  const assetPath = path.join(root, 'asset.kdna');
  assert.equal(exportAsset(projectDir, assetPath).status, 0);

  const tamperedDir = path.join(root, 'tampered');
  core.unpack(assetPath, tamperedDir);
  const payloadPath = path.join(tamperedDir, 'payload.kdnab');
  const payload = cbor.decode(fs.readFileSync(payloadPath));
  payload.profile = ['judgment', 'profile', ['v', '9'].join('')].join('-');
  fs.writeFileSync(payloadPath, cbor.encode(payload));
  fs.writeFileSync(
    path.join(tamperedDir, 'checksums.json'),
    `${JSON.stringify(core.buildChecksums(tamperedDir), null, 2)}\n`,
  );
  const tamperedAsset = path.join(root, 'tampered.kdna');
  core.pack(tamperedDir, tamperedAsset);
  assert.equal(core.validate(tamperedAsset).overall_valid, false);

  const importedProject = path.join(root, 'imported');
  const result = spawnSync(
    process.execPath,
    [BIN, 'create', importedProject, '--from-kdna', tamperedAsset, '--name', '@test/imported'],
    { encoding: 'utf8', env: { ...process.env } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported payload profile/);
  assert.equal(fs.existsSync(importedProject), false);
});

test('create --from-kdna imports a legacy asset and preserves all pattern subtypes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-full-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Build a comprehensive legacy .kdna inline exercising every card type
  const srcDir = path.join(root, 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'mimetype'), 'application/vnd.kdna.asset');

  const cbor = require('cbor-x');
  const payload = {
    profile: ['judgment','profile',['v','1'].join('')].join('-'),
    core: {
      highest_question: 'What is the right action?',
      axioms: [
        { id: 'ax_01', one_sentence: 'Preserve reversibility.', full_statement: 'Always preserve reversibility.', why: 'Irreversible harm.', applies_when: [], does_not_apply_when: [], failure_risk: 'Irreversible consequence' },
        { id: 'ax_02', one_sentence: 'Minimize intervention.', full_statement: 'Intervene minimally.', why: 'Excess causes resistance.', applies_when: ['complex'], does_not_apply_when: ['emergency'], failure_risk: 'Paralysis' },
      ],
      ontology: [{ id: 'ont_01', one_sentence: 'Action ontology.', essence: 'Actions change state.', boundary: 'Scope only.', trigger_signal: 'Decision fork' }],
      frameworks: [{ id: 'fw_01', name: 'Decision framework', when_to_use: 'Multi-option context', steps: ['identify','evaluate','choose'] }],
      stances: [{ id: 'st_01', statement: 'Default to restraint.', applies_when: ['high uncertainty'] }],
      boundaries: [{ id: 'bd_01', scope: 'Professional decisions', out_of_scope: 'Personal relationships', acceptable_exceptions: ['life safety'] }],
      risk_model: { risks: [{ id: 'risk_01', name: 'Over-control', description: 'Excessive rules', mitigation: 'Periodic review' }] },
    },
    patterns: [
      { type: 'term', term: 'wuwei', definition: 'Effortless action', id: 't_01' },
      { type: 'banned_term', term: 'should', why: 'Prescriptive', replace_with: 'consider', id: 'bt_01' },
      { type: 'failure_pattern', id: 'fp_01', name: 'Overstepping', one_sentence: 'Do not overstep.', what_it_looks_like: 'Adding constraints.', how_to_fix: 'Remove constraints.', failure_risk: 'Loss of autonomy' },
      { type: 'design_pattern', id: 'dp_01', name: 'Minimal design', one_sentence: 'Design minimally.', what_it_looks_like: 'Complex rules.', how_to_fix: 'Simplify.', failure_risk: 'Complexity explosion' },
      { type: 'response_pattern', id: 'rp_01', name: 'Pause response', one_sentence: 'Pause before responding.', what_it_looks_like: 'Immediate reaction.', how_to_fix: 'Insert a delay.', failure_risk: 'Impulse override' },
      { type: 'stopping_pattern', id: 'sp_01', name: 'Stop at sufficiency', one_sentence: 'Stop when enough.', what_it_looks_like: 'Perpetual refinement.', how_to_fix: 'Define done.', failure_risk: 'Never shipping' },
      { type: 'completion_pattern', id: 'cp_01', name: 'Finish release', one_sentence: 'Release when complete.', what_it_looks_like: 'Holding indefinitely.', how_to_fix: 'Declare completion.', failure_risk: 'Unreleased value' },
      { id: 'ms_01', wrong: 'Assuming intent', correct: 'Observe behavior', key_distinction: 'Intent vs behavior', why: 'Cannot read minds', applies_when: [], does_not_apply_when: [], failure_risk: 'Misattribution' },
    ],
    scenarios: [{ id: 'sc_01', name: 'Team conflict', trigger: 'Disagreement', action: 'Facilitate resolution', expected: 'Alignment' }],
    cases: [{ id: 'cs_01', title: 'Restraint avoided escalation', scenario: 'Customer complaint', input: 'Angry message', expected: 'De-escalated response' }],
    reasoning: {
      reasoning_chains: [{ id: 'rc_01', axiom: 'ax_01', one_sentence: 'Walk through.', logic: 'If A then B', so_what: 'Choose B' }],
      self_check: ['Did I consider all options?', 'Is this reversible?', 'Would a reasonable person agree?'],
    },
    evolution: { stages: [{ id: 'ev_01', name: 'Initial draft', level: 'alpha', description: 'First pass.', indicators: [] }] },
  };
  fs.writeFileSync(path.join(srcDir, 'payload.kdnab'), cbor.encode(payload));

  const manifest = {
    kdna_version: '1.0', asset_id: 'kdna:test:full-fixture', asset_uid: 'urn:uuid:00000000-0000-4000-8000-ffffffffffff',
    asset_type: 'domain', title: 'Full Legacy Fixture', version: '0.1.0', judgment_version: '0.1.0',
    compatibility: { profile: ['judgment','profile',['v','1'].join('')].join('-') },
    payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
    access: 'public', language: 'en', license: { type: 'CC-BY-4.0' }, lineage: { type: 'original' },
    creator: { name: 'Test', id: 'test' }, created_at: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(srcDir, 'kdna.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(srcDir, 'checksums.json'), JSON.stringify(core.buildChecksums(srcDir), null, 2) + '\n');

  const legacyKdna = path.join(root, 'full.kdna');
  core.pack(srcDir, legacyKdna);

  // Core 0.20 must reject it
  assert.equal(core.validate(legacyKdna).overall_valid, false, 'Core 0.20 must reject legacy format');

  // Studio create --from-kdna must succeed
  const projectDir = path.join(root, 'project');
  const result = spawnSync(process.execPath,
    [BIN, 'create', projectDir, '--from-kdna', legacyKdna, '--name', '@test/full'],
    { encoding: 'utf8', env: { ...process.env } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'studio.project.json'), 'utf8'));
  const cards = project.cards || [];
  assert.equal(cards.length, 22, `expected 23 cards, got ${cards.length}`);

  // Pattern subtypes
  for (const sub of ['failure_pattern','design_pattern','response_pattern','stopping_pattern','completion_pattern']) {
    const match = cards.some(c => c.type === 'pattern' && c.fields?.type === sub);
    assert.ok(match, `missing legacy subtype ${sub}`);
  }

  // Verify no missing worldview writes
  assert.equal('worldview' in (project.judgment_core || {}), false);
  assert.equal('value_order' in (project.judgment_core || {}), false);
  assert.equal('judgment_role' in (project.judgment_core || {}), false);

  // Self check count and content
  const scs = cards.filter(c => c.type === 'self_check');
  assert.equal(scs.length, 3, 'expected 3 self_checks from 3 strings');
  assert.ok(scs.every(sc => typeof sc.fields?.check === 'string' && sc.fields.check.length > 0));

  // Reasoning chain
  assert.ok(cards.some(c => c.type === 'reasoning' && c.fields?.axiom === 'ax_01'), 'reasoning chain present');

  // CLI re-opens project
  const listResult = spawnSync('npx', ['kdna-studio', 'card', 'list', projectDir],
    { encoding: 'utf8', env: { ...process.env } },
  );
  assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
});


test('create --from-kdna imports a minimal legacy fixture and fails on unknown profiles', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Build a minimal legacy judgment-profile-v1 .kdna inline
  const srcDir = path.join(root, 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'mimetype'), 'application/vnd.kdna.asset');
  fs.writeFileSync(path.join(srcDir, 'kdna.json'), JSON.stringify({
    kdna_version: '1.0',
    asset_id: 'kdna:test:legacy-fixture',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    asset_type: 'domain',
    title: 'Test Legacy Fixture',
    version: '0.1.0',
    judgment_version: '0.1.0',
    compatibility: { profile: ['judgment','profile',['v','1'].join('')].join('-') },
    payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
    access: 'public',
    language: 'en',
    license: { type: 'CC-BY-4.0' },
    lineage: { type: 'original' },
    creator: { name: 'Test', id: 'test' },
    created_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n');

  const cbor = require('cbor-x');
  const payload = {
    profile: ['judgment','profile',['v','1'].join('')].join('-'),
    core: {
      highest_question: 'What is the right action?',
      axioms: [
        { id: 'ax_test_01', one_sentence: 'Preserve reversibility.', full_statement: 'Always preserve reversibility.', why: 'Irreversible harm cannot be undone.', applies_when: [], does_not_apply_when: [], failure_risk: 'Irreversible consequence' },
      ],
    },
    patterns: [
      { type: 'term', term: 'wuwei', definition: 'Effortless action' },
      { type: 'banned_term', term: 'should', why: 'Prescriptive language', replace_with: 'consider' },
      { type: 'failure_pattern', id: 'fp_01', name: 'Overstepping', one_sentence: 'Do not overstep.', what_it_looks_like: 'Adding unnecessary constraints.', how_to_fix: 'Remove constraints.', failure_risk: 'Loss of autonomy' },
      { type: 'design_pattern', id: 'dp_01', name: 'Minimal design', one_sentence: 'Design minimally.', what_it_looks_like: 'Complex rules.', how_to_fix: 'Simplify.', failure_risk: 'Complexity explosion' },
      { id: 'ms_test_01', wrong: 'Assuming intent', correct: 'Observe behavior', key_distinction: 'Intent vs behavior', why: 'Cannot read minds', applies_when: [], does_not_apply_when: [], failure_risk: 'Misattribution' },
    ],
    reasoning: {
      reasoning_chains: [{ id: 'rc_01', axiom: 'ax_test_01', one_sentence: 'Walk through the decision.', logic: 'If A then B', so_what: 'Choose B' }],
      self_check: ['Did I consider all options?', 'Is this action reversible?'],
    },
  };
  fs.writeFileSync(path.join(srcDir, 'payload.kdnab'), cbor.encode(payload));
  fs.writeFileSync(path.join(srcDir, 'checksums.json'), JSON.stringify(core.buildChecksums(srcDir), null, 2) + '\n');
  const legacyKdna = path.join(root, 'legacy.kdna');
  core.pack(srcDir, legacyKdna);

  // Core 0.20 must reject it
  assert.equal(core.validate(legacyKdna).overall_valid, false, 'Core 0.20 must reject legacy asset');

  // Studio create --from-kdna must succeed
  const projectDir = path.join(root, 'project');
  const result = spawnSync(
    process.execPath,
    [BIN, 'create', projectDir, '--from-kdna', legacyKdna, '--name', '@test/legacy'],
    { encoding: 'utf8', env: { ...process.env } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'studio.project.json'), 'utf8'));
  const cards = project.cards || [];
  assert.equal(cards.length, 9, `expected 10 cards, got ${cards.length}`);
  assert.ok(cards.some(c => c.type === 'pattern' && c.fields?.type === 'failure_pattern'), 'failure_pattern subtype');
  assert.ok(cards.some(c => c.type === 'pattern' && c.fields?.type === 'design_pattern'), 'design_pattern subtype');
  assert.ok(cards.some(c => c.type === 'misunderstanding'), 'misunderstanding');
  assert.ok(cards.some(c => c.type === 'self_check'), 'self_check');
  assert.ok(cards.some(c => c.type === 'reasoning'), 'reasoning');
  assert.equal(project.judgment_core?.highest_question, 'What is the right action?');
  assert.equal('worldview' in (project.judgment_core || {}), false, 'missing worldview must be absent, not [] or null');
});
