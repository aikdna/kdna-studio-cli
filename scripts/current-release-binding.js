'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertReleaseAncestorOfMain, readAuthoritativeGitState } = require('./authoritative-git');
const { validateEvidence } = require('./release-evidence');
const { validateReleaseContext } = require('./release-policy');

function validateCurrentBinding({ evidence: rawEvidence, pkg, changelog, env, git, ancestry }) {
  const evidence = validateEvidence(rawEvidence);
  const context = validateReleaseContext({ pkg, changelog, env, git, ancestry });
  if (evidence.package.name !== context.name) throw new Error('release evidence name is stale');
  if (evidence.package.version !== context.version) throw new Error('release evidence version is stale');
  if (evidence.source.ref !== context.ref) throw new Error('release evidence ref is stale');
  if (evidence.source.commit !== context.commit) throw new Error('release evidence commit is stale');
  return evidence;
}

function readCurrentBinding({ root, evidence, env = process.env }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const tag = pkg.version;
  const git = readAuthoritativeGitState(root, tag, { environment: env });
  const ancestry = assertReleaseAncestorOfMain(root, git.head, { environment: env });
  return validateCurrentBinding({
    evidence,
    pkg,
    changelog,
    env,
    git,
    ancestry,
  });
}

module.exports = { readCurrentBinding, validateCurrentBinding };
