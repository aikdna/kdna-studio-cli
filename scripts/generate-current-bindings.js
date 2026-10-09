#!/usr/bin/env node
'use strict';

// Rebuild the shipped dependency receipt from actual locked tar members. This
// records bytes; it does not establish registry publication or author identity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readTarFileEntries } = require('./runtime-candidate-binding');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

function generate() {
  const manifest = read('package.json'), lock = read('package-lock.json');
  const cli = manifest.name === '@aikdna/kdna-studio-cli';
  const target = cli ? 'src/public-bindings.json' : 'src/creation-engine/component-runtime-binding.json';
  const previous = read(target);
  const records = cli ? previous.archives : previous.packages;
  const packages = [];
  let contract;
  for (const [key, locked] of Object.entries(lock.packages)) {
    if (!key.startsWith('node_modules/') || locked.optional) continue;
    const name = key.slice('node_modules/'.length);
    assert(!name.includes('node_modules/'), 'nested dependency is not a single bound graph');
    const prior = records.find(entry => entry.name === name);
    assert(prior, `unreviewed dependency: ${name}`);
    const leaf = name.replace(/^@/u, '').replace('/', '-');
    const archive = locked.resolved.startsWith('file:')
      ? path.resolve(root, locked.resolved.slice(5))
      : path.join(root, 'vendor', `${leaf}-${locked.version}.tgz`);
    assert(path.dirname(archive) === path.join(root, 'vendor'), 'archive must be in vendor');
    const bytes = fs.readFileSync(archive);
    assert.equal(locked.integrity, 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'));
    const entries = readTarFileEntries(archive);
    const metadata = JSON.parse(entries.find(entry => entry.path === 'package/package.json').bytes);
    assert.equal(metadata.name, name); assert.equal(metadata.version, locked.version);
    if (name === '@aikdna/kdna-core') {
      contract = JSON.parse(entries.find(entry => entry.path === 'package/src/public-contract/generated-contract.json').bytes);
    }
    const files = entries.map(entry => ({ path: entry.path.slice('package/'.length),
      ...(cli ? { mode: entry.mode } : {}), bytes: entry.size, sha256: hash(entry.bytes) }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    packages.push(cli
      ? { name, version: metadata.version, files, sha256: hash(bytes), publicEntry: prior.publicEntry,
        dependencies: metadata.dependencies || {}, peerDependencies: metadata.peerDependencies || {},
        optionalDependencies: metadata.optionalDependencies || {} }
      : { name, version: metadata.version, archive_sha256: hash(bytes), files });
  }
  assert(contract, 'Core contract is required');
  const versions = Object.fromEntries(packages.filter(entry => entry.name.startsWith('@aikdna/'))
    .map(entry => [entry.name, entry.version]));
  const result = cli ? { tuple: contract.versionTuple, packages: versions, archives: packages }
    : { core_package_version: versions['@aikdna/kdna-core'], read_package_version: versions['@aikdna/kdna-read'],
      definition_digest: contract.component_semantics.definition_digest, packages, tuple: contract.versionTuple };
  return { target, result };
}

function main(argv = process.argv.slice(2)) {
  assert(argv.length === 0 || argv.length === 1 && argv[0] === '--write', 'usage: generate-current-bindings.js [--write]');
  const { target, result } = generate();
  if (argv[0] === '--write') fs.writeFileSync(path.join(root, target), JSON.stringify(result, null, 2) + '\n');
  else assert.deepEqual(read(target), result, 'dependency receipt differs; review archives then regenerate with --write');
  console.log(`Current dependency receipt verified: ${target}`);
}
if (require.main === module) main();
module.exports = { generate, main };
