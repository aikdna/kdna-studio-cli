'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, invoke, prepare, save } = require('../pd275/session-harness');
const legacyRoot = path.resolve(__dirname, '../../../fixtures/legacy-shared-evidence');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const corePin = 'b2cecb761e599d8711114d7288d6caf627b1aa01620699ecb1fca49ac3bb6ba0';
const readPin = '1595075677dc1359c2df751ec54a706b55ffff6bfc77d117e16464fb16a5c96e';
let current;
function verification(bundle, expected = 0) {
  const result = invoke(['verify', '--bundle', bundle]);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function copyBundle(name) {
  const directory = path.join(ROOT, name); fs.mkdirSync(directory);
  for (const file of fs.readdirSync(current)) {
    const p = path.join(directory, file); fs.copyFileSync(path.join(current, file), p); fs.chmodSync(p, 0o600);
  }
  return directory;
}
test('public CLI creates the shared format from real separate synthetic human and Agent channels', async () => {
  const { session, preview } = await prepare(undefined, true);
  await session.op('export'); const result = await session.finished;
  assert.equal(result.status, 0, result.stderr); current = session.directory;
  const bytes = fs.readFileSync(path.join(current, 'asset.kdna'));
  const evidence = JSON.parse(fs.readFileSync(path.join(current, 'creation-evidence.json')));
  const binding = JSON.parse(fs.readFileSync(path.join(current, 'binding.json')));
  assert.equal(evidence.format, 'kdna.studio-creation-evidence/1');
  assert.equal(evidence.synthetic_fixture, true);
  assert.equal(evidence.compiler.provider, 'javascript');
  assert.equal(evidence.compiler.version, '3.1.0-rc.cross-provider.1');
  assert.equal(evidence.compiler.artifact_sha256, 'UNKNOWN');
  assert.equal(evidence.core.reference_contract.core.artifact_sha256, corePin);
  assert.equal(evidence.core.reference_contract.read.artifact_sha256, readPin);
  assert.equal(evidence.core.implementation.artifact.sha256, corePin);
  assert.equal(preview.result.artifact_digest, 'sha256:' + digest(bytes));
  assert.equal(binding.asset_digest, preview.result.artifact_digest);
  const verified = verification(current);
  assert.equal(verified.evidence_format, evidence.format);
  assert.equal(verified.provider_assertion, 'declared_not_authenticated');
  assert.equal(verified.compiler_artifact_sha256, 'UNKNOWN');
  assert.equal(verified.confirmation, 'claimed_unverified');
  assert.equal(verified.identity, 'not_verified');
  assert.equal(verified.creation_accepted, 'not_evaluated');
  assert.equal(verified.action_authorization, 'not_evaluated');
  save('shared-produced', { directory: current, artifactSha256: digest(bytes), verified, syntheticTransportOnly: true });
});
test('new CLI consumes exact original legacy producer bytes without inventing implementation provenance', () => {
  const origin = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'ORIGIN.json')));
  const directory = path.join(ROOT, 'actual-legacy-bundle'); fs.mkdirSync(directory);
  const names = { 'artifact.kdna': 'asset.kdna', 'evidence.json': 'creation-evidence.json', 'binding.json': 'binding.json', 'verification.json': 'verification.json' };
  for (const file of origin.files) {
    const bytes = fs.readFileSync(path.join(legacyRoot, file.name));
    assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256);
    fs.writeFileSync(path.join(directory, names[file.name]), bytes);
  }
  fs.writeFileSync(path.join(directory, 'complete.json'), JSON.stringify({ kind: 'private-studio-export-bundle', version: 1 }));
  const evidenceBefore = fs.readFileSync(path.join(directory, 'creation-evidence.json'));
  assert.equal(Object.hasOwn(JSON.parse(evidenceBefore), 'format'), false);
  const verified = verification(directory);
  assert.equal(verified.evidence_format, 'studio-blank-material-evidence/legacy');
  assert.equal(verified.implementation_artifact_sha256, 'UNKNOWN');
  assert.equal(verified.compiler_artifact_sha256, 'UNKNOWN');
  assert.equal(verified.confirmation, 'claimed_unverified'); assert.equal(verified.identity, 'not_verified');
  const allowed = invoke(['read', '--bundle', directory, '--allow-read', '--judgment', '1']);
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  assert.equal(JSON.parse(allowed.stdout).envelope.status, 'ready');
  assert.deepEqual(fs.readFileSync(path.join(directory, 'creation-evidence.json')), evidenceBefore);
  save('legacy-consumed', { directory, origin, verified, evidenceUntouched: true });
});
test('unsupported shared format stays rejected through the public CLI', () => {
  const directory = copyBundle('unsupported-format');
  const p = path.join(directory, 'creation-evidence.json'); const evidence = JSON.parse(fs.readFileSync(p));
  evidence.format = 'kdna.studio-creation-evidence/unsupported'; fs.writeFileSync(p, JSON.stringify(evidence));
  assert.equal(verification(directory, 3).reason, 'CREATION_EVIDENCE_FORMAT_UNSUPPORTED');
});
test('provider declaration tampering and substituted external binding cannot unlock Read', () => {
  for (const mutation of ['provider', 'external-binding']) {
    const directory = copyBundle('tamper-' + mutation);
    const p = path.join(directory, mutation === 'provider' ? 'creation-evidence.json' : 'binding.json');
    const value = JSON.parse(fs.readFileSync(p));
    if (mutation === 'provider') value.core.implementation.artifact.sha256 = 'a'.repeat(64);
    else value.evidence_digest = 'sha256:' + 'b'.repeat(64);
    fs.writeFileSync(p, JSON.stringify(value));
    const result = invoke(['read', '--bundle', directory, '--allow-read']);
    assert.equal(result.status, 3, result.stderr); const rejected = JSON.parse(result.stdout);
    assert.equal(rejected.reason, 'CREATION_BINDING_MISMATCH'); assert.equal(rejected.envelope, undefined);
  }
});
test.after(() => console.log(JSON.stringify({ shared_evidence_root: ROOT, completed_bundle: current, legacy_origin: 'actual original producer execution; no deleted format fields' })));
