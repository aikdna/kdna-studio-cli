'use strict';

// The candidate channel of the release gate. The stable channel keeps
// scripts/current-release-binding.js unchanged; this module binds a candidate
// evidence document to the candidate release event, its preview tag and the
// commit the tag resolves to, using the same shared release policy.

const fs = require('node:fs');
const path = require('node:path');
const { readAuthoritativeGitState } = require('./authoritative-git');
const { validateEvidence } = require('./release-evidence');
const { CANDIDATE_TAG_PREFIX, validateCandidateReleaseContext } = require('./release-policy');

function validateCandidateBinding({ evidence: rawEvidence, pkg, changelog, env, git }) {
  const evidence = validateEvidence(rawEvidence, { candidate: true });
  const context = validateCandidateReleaseContext({ pkg, changelog, env, git });
  if (evidence.package.name !== context.name) throw new Error('candidate evidence name is stale');
  if (evidence.package.version !== context.version) {
    throw new Error('candidate evidence version is stale');
  }
  if (evidence.source.commit !== context.commit) {
    throw new Error('candidate evidence commit is stale');
  }
  if (evidence.source.ref !== `candidate:${context.commit}`) {
    throw new Error('candidate evidence ref is stale');
  }
  return evidence;
}

function readCandidateBinding({ root, evidence, env = process.env }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const tag = `${CANDIDATE_TAG_PREFIX}${pkg.version}`;
  const git = readAuthoritativeGitState(root, tag, { environment: env });
  return validateCandidateBinding({
    evidence,
    pkg,
    changelog,
    env,
    git,
  });
}

module.exports = { readCandidateBinding, validateCandidateBinding };
