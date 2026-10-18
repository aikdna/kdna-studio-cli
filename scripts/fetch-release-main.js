#!/usr/bin/env node
'use strict';

// The publish workflow checks out the release tag, so `origin/main` may not be
// a usable local ref. Fetch it explicitly before the release gate runs. A
// failed fetch or a missing main branch is a named refusal; the gate later
// reads the ref and refuses again if it is not a readable commit.

const path = require('node:path');
const { fetchReleaseMain } = require('./authoritative-git');

const root = path.resolve(__dirname, '..');

try {
  const { mainCommit } = fetchReleaseMain(root, { environment: process.env });
  console.log(`Release main ref verified: origin/main=${mainCommit}`);
} catch (error) {
  console.error(`Release main ref rejected: ${error.message}`);
  process.exitCode = 1;
}
