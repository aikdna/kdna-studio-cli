#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readAuthoritativeGitState } = require('./authoritative-git');
const {
  CANDIDATE_TAG_PREFIX,
  STABLE_VERSION_RE,
  validateCandidateReleaseContext,
  validateReleaseContext,
} = require('./release-policy');
const { assertRegistryReleaseReady } = require('./runtime-candidate-binding');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

try {
  assertRegistryReleaseReady(root);
  // The stable channel keeps its own gate unchanged; a canonical candidate
  // coordinate is checked by the candidate channel, which requires the same
  // release event, tag and commit binding on its own tag.
  const stable = STABLE_VERSION_RE.test(pkg.version || '');
  const tag = stable ? pkg.version : CANDIDATE_TAG_PREFIX + pkg.version;
  const git = readAuthoritativeGitState(root, tag, { environment: process.env });
  const context = stable
    ? validateReleaseContext({ pkg, changelog, env: process.env, git })
    : validateCandidateReleaseContext({ pkg, changelog, env: process.env, git });
  console.log(`Release context verified: ${context.name}@${context.version} ${context.commit}`);
} catch (error) {
  console.error(`Release context rejected: ${error.message}`);
  process.exitCode = 1;
}
