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
  const payload = cbor.decode(fs.readFileSync(path.join(unpacked, 'payload.kdnab')));
  const checksums = JSON.parse(fs.readFileSync(path.join(unpacked, 'checksums.json'), 'utf8'));

  assert.equal(manifest.format_version, '0.1.0');
  assert.deepEqual(manifest.compatibility, {
    min_loader_version: '0.18.1',
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
  assert.match(result.stderr, /Not a current \.kdna asset/);
  assert.equal(fs.existsSync(importedProject), false);
});
