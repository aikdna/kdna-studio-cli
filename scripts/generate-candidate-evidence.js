#!/usr/bin/env node
'use strict';

// A source-bound prerelease preflight. It grants no publication authority and
// uses a schema the stable publisher rejects before a registry lookup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAuthoritativeGitState, materializeCommitTree } = require('./authoritative-git');
const { validateCandidateCoordinate } = require('./release-policy');
const { validateCandidatePackReport, validateCandidateArtifact } = require('./release-evidence');
const { packIsolatedSource, assertReproduciblePackBytes } = require('./generate-release-evidence');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');
const { verifyCurrentBinding } = require('./verify-current-candidate-sources');
const root = path.resolve(__dirname, '..');

function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 4, 'usage: generate-candidate-evidence.js --out <evidence> --artifact <tarball>');
  assert.equal(argv[0], '--out'); assert.equal(argv[2], '--artifact');
  const [output, artifact] = [argv[1], argv[3]].map(value => path.resolve(value));
  for (const destination of [output, artifact]) {
    const relative = path.relative(root, destination);
    assert(relative && (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)), 'candidate outputs must be outside repository');
    assert(!fs.existsSync(destination), 'candidate output already exists');
  }
  assert.notEqual(output, artifact);
  verifyCurrentBinding();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  validateCandidateCoordinate({ pkg, changelog: fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') });
  const before = readAuthoritativeGitState(root, 'HEAD');
  assert.equal(before.status, '', 'candidate worktree must be clean');
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-candidate-evidence-'));
  const invocation = resolveTrustedNpmInvocation(root);
  let completed = false, artifactCreated = false, evidenceCreated = false;
  try {
    const packs = [];
    for (const label of ['first', 'second']) {
      const source = path.join(temporary, 'source-' + label), destination = path.join(temporary, 'pack-' + label);
      fs.mkdirSync(source); fs.mkdirSync(destination);
      materializeCommitTree(root, before.head, '', source, { requiredPath: 'package.json' });
      const committed = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
      assert.equal(committed.name, pkg.name); assert.equal(committed.version, pkg.version);
      packs.push(packIsolatedSource(invocation, source, destination));
    }
    assertReproduciblePackBytes(packs[0].bytes, packs[1].bytes);
    const source = { ref: `candidate:${before.head}`, commit: before.head };
    const evidence = validateCandidatePackReport({ reportText: packs[0].reportText, tarball: packs[0].bytes, pkg, source });
    validateCandidatePackReport({ reportText: packs[1].reportText, tarball: packs[1].bytes, pkg, source });
    validateCandidateArtifact(evidence, packs[0].bytes);
    assert.deepEqual(readAuthoritativeGitState(root, 'HEAD'), before, 'candidate Git authority changed while packing');
    fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(packs[0].artifact, artifact, fs.constants.COPYFILE_EXCL); artifactCreated = true;
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); evidenceCreated = true;
    assert(fs.readFileSync(artifact).equals(packs[0].bytes));
    completed = true;
    console.log(`Candidate preflight: ${pkg.name}@${pkg.version}; commit=${before.head}; members=${evidence.artifact.file_count}; publication=not_authorized`);
    return evidence;
  } finally {
    invocation.cleanup(); fs.rmSync(temporary, { recursive: true, force: true });
    if (!completed) { if (artifactCreated) fs.rmSync(artifact); if (evidenceCreated) fs.rmSync(output); }
  }
}
if (require.main === module) { try { main(); } catch (error) { console.error(`Candidate preflight rejected: ${error.message}`); process.exitCode = 1; } }
module.exports = { main };
