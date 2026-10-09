#!/usr/bin/env node
'use strict';

// The candidate publication channel, kept separate from the stable publisher
// (scripts/publish-verified-artifact.js). A candidate evidence document can
// never satisfy the stable validator and stable evidence can never satisfy this
// one, so the two channels stay mutually exclusive while sharing the registry
// policy, the pack evidence format and the never-defaulted publish tag.
//
// This publisher adds no authority of its own: the release event, the preview
// tag and the commit that tag resolves to are re-derived from the repository
// (scripts/candidate-release-binding.js) and the artifact is re-hashed and
// re-parsed from its own bytes before any registry call.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readCandidateBinding } = require('./candidate-release-binding');
const { validateCandidateArtifact } = require('./release-evidence');
const { evaluateRegistryResult } = require('./registry-policy');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');
const {
  lookupArguments,
  publishArguments,
  resolvePublishTag,
} = require('./publish-verified-artifact');

function candidateReleaseDecision({ evidence, tarball, bindCurrent, lookup }) {
  bindCurrent(evidence);
  validateCandidateArtifact(evidence, tarball);
  const spec = `${evidence.package.name}@${evidence.package.version}`;
  return evaluateRegistryResult(lookup(lookupArguments(spec)), evidence, { candidate: true });
}

function publishVerifiedCandidate({
  evidence,
  tarball,
  artifactPath,
  tag,
  bindCurrent,
  publish,
}) {
  bindCurrent(evidence);
  validateCandidateArtifact(evidence, tarball);
  const resolved = resolvePublishTag(tag, evidence.package.version);
  const result = publish(publishArguments(artifactPath, resolved));
  if (result?.error) throw new Error(`npm publish failed: ${result.error.message}`);
  if (result?.status !== 0) throw new Error(`npm publish exited ${String(result?.status)}`);
}

function main(argv = process.argv) {
  const evidenceIndex = argv.indexOf('--evidence');
  const artifactIndex = argv.indexOf('--artifact');
  const tagIndex = argv.indexOf('--tag');
  if (argv.length !== 8 || evidenceIndex < 0 || artifactIndex < 0 || tagIndex < 0) {
    throw new Error(
      'usage: publish-candidate-artifact.js --evidence <json> --artifact <tgz> --tag <tag>',
    );
  }
  const root = path.resolve(__dirname, '..');
  const evidencePath = path.resolve(argv[evidenceIndex + 1] || '');
  const artifactPath = path.resolve(argv[artifactIndex + 1] || '');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const npmInvocation = resolveTrustedNpmInvocation(root);
  try {
    const decision = candidateReleaseDecision({
      evidence,
      tarball: fs.readFileSync(artifactPath),
      bindCurrent: (candidate) => readCandidateBinding({ root, evidence: candidate }),
      lookup: (args) =>
        spawnSync(npmInvocation.command, [...npmInvocation.prefixArgs, ...args], {
          encoding: 'utf8',
          env: npmInvocation.environment,
          maxBuffer: 1024 * 1024,
          shell: false,
          timeout: 30_000,
        }),
    });
    if (!decision.shouldPublish) {
      console.log(`Candidate registry publication policy: ${decision.decision}`);
      return;
    }
    publishVerifiedCandidate({
      evidence,
      tarball: fs.readFileSync(artifactPath),
      artifactPath,
      tag: argv[tagIndex + 1],
      bindCurrent: (candidate) => readCandidateBinding({ root, evidence: candidate }),
      publish: (args) =>
        spawnSync(npmInvocation.command, [...npmInvocation.prefixArgs, ...args], {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          shell: false,
          stdio: 'inherit',
        }),
    });
  } finally {
    npmInvocation.cleanup();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Candidate publication rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  candidateReleaseDecision,
  publishVerifiedCandidate,
};
