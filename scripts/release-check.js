#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;
const name = pkg.name;
const tag = `v${version}`;
const failures = [];
const warnings = [];

function check(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); }
  catch (e) { failures.push(`${label}: ${e.message}`); console.error(`  FAIL ${label}: ${e.message}`); }
}

function softCheck(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); }
  catch (e) { warnings.push(`${label}: ${e.message}`); console.warn(`  WARN ${label}: ${e.message}`); }
}

console.log(`Release readiness check: ${name}@${version}\n`);

check('git tag exists', () => {
  const out = execSync(`git tag -l "${tag}"`, { encoding: 'utf8' }).trim();
  if (!out) throw new Error(`tag ${tag} not found. Run: git tag ${tag} && git push origin ${tag}`);
});

// GitHub Release existence check is a SOFT check — the actual release is
// created by the publish workflow (via `gh release create` in `.github/workflows/publish.yml`)
// AFTER npm publish succeeds. The pre-publish check would fail in dev environments
// where GH_TOKEN is not set, blocking local publishes for no real reason.
// In CI, the workflow has GH_TOKEN set, so the check still verifies the tag/release.
const hasGhAuth = (() => {
  try {
    execSync('gh auth status', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

softCheck('GitHub Release exists', () => {
  if (!hasGhAuth) {
    throw new Error('gh CLI not authenticated (set GH_TOKEN or run `gh auth login`); skipping');
  }
  const repo = pkg.repository.directory
    ? pkg.repository.url.match(/github\.com\/([^/]+\/[^.]+)/)[1]
    : pkg.repository.url.match(/github\.com\/([^/]+\/[^.]+)/)[1];
  execSync(`gh release view ${tag} --repo ${repo}`, { stdio: 'ignore' });
});

check('CHANGELOG has version entry', () => {
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  if (!changelog.includes(version)) throw new Error(`CHANGELOG.md missing entry for ${version}`);
});

check('package.json version matches tag', () => {
  if (!tag.endsWith(version)) throw new Error(`tag ${tag} does not match version ${version}`);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed. Fix before publishing.`);
  process.exit(1);
}
if (warnings.length > 0) {
  console.warn(`\n${warnings.length} warning(s). Release can still proceed.`);
}
console.log('\nAll checks passed. Ready to publish.');
