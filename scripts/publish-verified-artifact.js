#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readCurrentBinding } = require('./current-release-binding');
const { validateArtifact } = require('./release-evidence');
const { evaluateRegistryResult } = require('./registry-policy');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');

const REGISTRY = 'https://registry.npmjs.org/';
const PREVIEW_TAG = 'components-preview';
const STABLE_TAG = 'latest';

// The publish tag is never defaulted: npm would otherwise fall back to
// `latest`, which would silently move a stable consumer onto a candidate. A
// candidate coordinate may only carry the preview tag and a stable coordinate
// may only carry `latest`.
function resolvePublishTag(tag, version) {
  assert(
    typeof tag === 'string' && tag !== '',
    'a publish tag is required; the default tag is never used',
  );
  const candidate = /-/u.test(String(version));
  if (tag === STABLE_TAG) {
    assert(!candidate, 'latest may only be published for a stable version');
    return tag;
  }
  assert.equal(tag, PREVIEW_TAG, 'unapproved publish tag');
  assert(candidate, 'the preview tag is reserved for a candidate coordinate');
  return tag;
}

function publishArguments(artifactPath, tag) {
  return [
    'publish',
    artifactPath,
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
    `--tag=${tag}`,
    `--registry=${REGISTRY}`,
    `--@aikdna:registry=${REGISTRY}`,
  ];
}

function lookupArguments(spec) {
  return [
    'view',
    spec,
    'name',
    'version',
    'dist.integrity',
    'dist.shasum',
    '--json',
    '--loglevel=silent',
    `--registry=${REGISTRY}`,
    `--@aikdna:registry=${REGISTRY}`,
  ];
}

function releaseDecision({ evidence, tarball, bindCurrent, lookup }) {
  bindCurrent(evidence);
  validateArtifact(evidence, tarball);
  const spec = `${evidence.package.name}@${evidence.package.version}`;
  return evaluateRegistryResult(lookup(lookupArguments(spec)), evidence);
}

function publishCandidate({ evidence, tarball, artifactPath, bindCurrent, publish, tag }) {
  bindCurrent(evidence);
  validateArtifact(evidence, tarball);
  const resolved = resolvePublishTag(tag, evidence.package.version);
  const result = publish(publishArguments(artifactPath, resolved));
  if (result?.error) throw new Error(`npm publish failed: ${result.error.message}`);
  if (result?.status !== 0) throw new Error(`npm publish exited ${String(result?.status)}`);
}

function main() {
  const evidenceIndex = process.argv.indexOf('--evidence');
  const artifactIndex = process.argv.indexOf('--artifact');
  const tagIndex = process.argv.indexOf('--tag');
  if (process.argv.length !== 8 || evidenceIndex < 0 || artifactIndex < 0 || tagIndex < 0) {
    throw new Error(
      'usage: publish-verified-artifact.js --evidence <json> --artifact <tgz> --tag <tag>',
    );
  }
  const root = path.resolve(__dirname, '..');
  const evidencePath = path.resolve(process.argv[evidenceIndex + 1] || '');
  const artifactPath = path.resolve(process.argv[artifactIndex + 1] || '');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const tag = resolvePublishTag(process.argv[tagIndex + 1], evidence.package.version);
  const npmInvocation = resolveTrustedNpmInvocation(root);
  try {
    const bindCurrent = (candidate) => readCurrentBinding({ root, evidence: candidate });
    const decision = releaseDecision({
      evidence,
      tarball: fs.readFileSync(artifactPath),
      bindCurrent,
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
      console.log(`Registry publication policy: ${decision.decision}`);
      return;
    }

    publishCandidate({
      evidence,
      tarball: fs.readFileSync(artifactPath),
      artifactPath,
      bindCurrent,
      tag,
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
    console.error(`Verified artifact publication rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  PREVIEW_TAG,
  STABLE_TAG,
  lookupArguments,
  publishArguments,
  publishCandidate,
  releaseDecision,
  resolvePublishTag,
};
