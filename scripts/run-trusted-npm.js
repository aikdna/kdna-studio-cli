#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { acquire } = require('./acquire-trusted-npm-release');
const { trustedTarballPath } = require('./trusted-npm-release');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');

async function main() {
  if (process.argv.length < 3) throw new Error('usage: run-trusted-npm.js <npm arguments...>');
  const root = require('node:path').resolve(__dirname, '..');
  const tarball = trustedTarballPath();
  await acquire(tarball);
  const invocation = resolveTrustedNpmInvocation(root, {
    tarballPath: tarball,
  });
  try {
    const result = spawnSync(
      invocation.command,
      [...invocation.prefixArgs, ...process.argv.slice(2)],
      {
        cwd: root,
        env: invocation.environment,
        stdio: 'inherit',
        shell: false,
      },
    );
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`trusted npm was interrupted by ${result.signal}`);
    process.exitCode = result.status;
  } finally {
    invocation.cleanup();
  }
}

main().catch((error) => {
  console.error(`Trusted npm invocation failed: ${error.message}`);
  process.exitCode = 1;
});
