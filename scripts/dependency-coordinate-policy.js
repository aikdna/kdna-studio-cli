#!/usr/bin/env node
'use strict';

// Dependency coordinate policy for the committed graph.
//
// Rule 1: every package that a committed member declares as a *required* peer
// dependency (a peer without `peerDependenciesMeta[<name>].optional`) and that
// this repository also declares directly must be bound by a root `overrides`
// entry resolving to this repository's own local coordinate. npm resolves such
// a peer range against the registry as soon as the local coordinate cannot be
// satisfied, which would break the offline-installable property of the
// vendored graph. Optional peers do not trigger that lookup (measured, see the
// accompanying regression test), so they are not required to carry an
// override.
//
// Rule 2: every direct declaration must be a checkable coordinate - either an
// exact SemVer, or a `file:` pin whose target exists, whose lockfile
// `resolved` equals the declared coordinate, and whose lockfile `integrity` is
// a complete sha512 digest. Floating ranges (`^`, `~`, `*`, `latest`, `x`
// wildcards, comparators, unions, hyphen ranges) are rejected. This rule
// restores the intent of the pre-component-semantics assertion that the
// retired runtime-candidate-hardening suite used to carry.
//
// Everything is checked against the committed bytes only; nothing here
// contacts the network.

const fs = require('node:fs');
const path = require('node:path');

const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]);

const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const FILE_COORDINATE_PREFIX = 'file:';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function directSpecs(manifest) {
  const specs = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      specs.set(name, { field, spec });
    }
  }
  return specs;
}

function isLocalBinding(spec, direct) {
  if (typeof spec !== 'string') return false;
  if (direct && spec === `$${direct.name}`) return true;
  return direct ? spec === direct.spec : false;
}

// Rule 1: peer coordinates must be bound to the local graph.
function peerBindingFindings({ manifest, lock }) {
  const direct = directSpecs(manifest);
  const overrides = manifest.overrides ?? {};
  const findings = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    for (const [name, range] of Object.entries(entry.peerDependencies ?? {})) {
      if (!direct.has(name)) continue;
      if (entry.peerDependenciesMeta?.[name]?.optional === true) continue;
      const local = { name, spec: direct.get(name).spec };
      if (isLocalBinding(overrides[name], local)) continue;
      findings.push({
        rule: 'unbound_peer_coordinate',
        name,
        declared_by: key,
        peer_range: range,
        override: Object.hasOwn(overrides, name) ? overrides[name] : null,
      });
    }
  }
  return findings;
}

function checkRepository(root) {
  const manifest = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  return [
    ...peerBindingFindings({ manifest, lock, root }),
    ...coordinateFindings({ manifest, lock, root }),
  ];
}

// Rule 2: direct declarations must be checkable coordinates.
function coordinateFindings({ manifest, lock, root }) {
  const findings = [];
  for (const [name, { field, spec }] of directSpecs(manifest)) {
    if (typeof spec !== 'string') {
      findings.push({ rule: 'non_string_spec', name, field, spec: null });
      continue;
    }
    if (EXACT_SEMVER_RE.test(spec)) continue;
    if (!spec.startsWith(FILE_COORDINATE_PREFIX)) {
      findings.push({ rule: 'floating_or_unpinned_range', name, field, spec });
      continue;
    }
    const target = spec.slice(FILE_COORDINATE_PREFIX.length);
    if (target.length === 0 || !fs.existsSync(path.resolve(root, target))) {
      findings.push({ rule: 'file_coordinate_target_missing', name, field, spec });
    }
    const locked = lock.packages?.[`node_modules/${name}`];
    if (locked?.resolved !== spec) {
      findings.push({
        rule: 'file_coordinate_lock_drift',
        name,
        field,
        spec,
        lock_resolved: locked?.resolved ?? null,
      });
    }
    if (!SHA512_INTEGRITY_RE.test(locked?.integrity ?? '')) {
      findings.push({
        rule: 'file_coordinate_without_sha512_integrity',
        name,
        field,
        spec,
        integrity: locked?.integrity ?? null,
      });
    }
  }
  return findings;
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? path.resolve(__dirname, '..') : path.resolve(argv[rootIndex + 1]);
  const findings = checkRepository(root);
  if (findings.length === 0) {
    console.log(`KDNA-DEPENDENCY-COORDINATES: ok root=${root} findings=0`);
    return 0;
  }
  console.log(
    `KDNA-DEPENDENCY-COORDINATES: findings=${findings.length} root=${root} ` +
      JSON.stringify(findings),
  );
  return argv.includes('--report-only') ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  DEPENDENCY_FIELDS,
  EXACT_SEMVER_RE,
  SHA512_INTEGRITY_RE,
  checkRepository,
  coordinateFindings,
  directSpecs,
  peerBindingFindings,
};
