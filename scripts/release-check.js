#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readAuthoritativeGitState } = require('./authoritative-git');
const { validateReleaseContext } = require('./release-policy');
const { assertRegistryReleaseReady } = require('./runtime-candidate-binding');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

try {
  assertRegistryReleaseReady(root);
  const tag = pkg.version;
  const context = validateReleaseContext({
    pkg,
    changelog,
    env: process.env,
    git: readAuthoritativeGitState(root, tag, { environment: process.env }),
  });
  console.log(`Release context verified: ${context.name}@${context.version} ${context.commit}`);
} catch (error) {
  console.error(`Release context rejected: ${error.message}`);
  process.exitCode = 1;
}
