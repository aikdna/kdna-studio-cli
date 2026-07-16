#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const {
  TRUSTED_NPM_URL,
  trustedTarballPath,
  verifyTrustedNpmTarball,
} = require('./trusted-npm-release');

const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

function destinationFromArguments(argv) {
  if (argv.length === 0) return trustedTarballPath();
  assert.equal(argv.length, 2, 'usage: acquire-trusted-npm-release.js [--out <tarball>]');
  assert.equal(argv[0], '--out', 'usage: acquire-trusted-npm-release.js [--out <tarball>]');
  return trustedTarballPath(argv[1] || '');
}

function download() {
  return new Promise((resolve, reject) => {
    const request = https.get(TRUSTED_NPM_URL, { headers: { 'accept-encoding': 'identity' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`trusted npm release download returned HTTP ${String(response.statusCode)}`));
        return;
      }
      if (response.headers.location || response.headers['content-encoding']) {
        response.resume();
        reject(new Error('trusted npm release download response was not canonical raw bytes'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) {
          request.destroy(new Error('trusted npm release download exceeded its size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error('trusted npm release download timed out')));
    request.on('error', reject);
  });
}

async function acquire(destination, options = {}) {
  try {
    verifyTrustedNpmTarball(destination);
    return destination;
  } catch {
    // Missing or invalid cache entries are replaced only after the exact release bytes verify.
  }
  const bytes = await (options.download || download)();
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    verifyTrustedNpmTarball(path.resolve(temporary));
    try {
      verifyTrustedNpmTarball(destination);
      return destination;
    } catch {
      fs.rmSync(destination, { force: true });
    }
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      try {
        verifyTrustedNpmTarball(destination);
        return destination;
      } catch {
        throw error;
      }
    }
    verifyTrustedNpmTarball(destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}

if (require.main === module) {
  acquire(destinationFromArguments(process.argv.slice(2)))
    .then((destination) => console.log(`Verified trusted npm release: ${destination}`))
    .catch((error) => {
      console.error(`Trusted npm release acquisition failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { acquire, destinationFromArguments, download };
