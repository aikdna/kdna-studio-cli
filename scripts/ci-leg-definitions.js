'use strict';

// Shared, committed definitions for the gated CI legs and for the receipts a committed
// test emits for itself.
//
// The registry (fixtures/runtime-candidates/leg-registry.json) is the only authority that
// may hold a leg at not_run. scripts/ci-leg-receipt.js is the gate for the CI workflow
// legs; tests/publish-hardening.test.js emits its own receipts only through
// registeredNotRunFor() below. scripts/verify-ci-leg-receipts.js re-derives every code
// from the committed bytes and refuses a receipt that disagrees.
//
// A not_run outcome requires BOTH an explicit registration AND the exact set of
// unavailability codes recomputed from the committed bytes, compared in both directions.
// A code the gate computes but the registry does not name, or a registered code that is no
// longer true, makes the leg run instead. A gate cannot manufacture a permanent not_run
// out of a condition of its own.

const fs = require('node:fs');
const path = require('node:path');
const { STABLE_VERSION_RE } = require('./release-policy');

const BINDING_PATH = path.join('fixtures', 'runtime-candidates', 'binding.json');
const LOCK_PATH = 'package-lock.json';
const PACKAGE_PATH = 'package.json';
const REGISTRY_PATH = path.join('fixtures', 'runtime-candidates', 'leg-registry.json');

const CODE_DIRECT_COORDINATES_NOT_REGISTRY_SEMVER =
  'aikdna_direct_coordinates_are_not_registry_semver';
const CODE_AUTHORITY_DIFFERS_FROM_INSTALLED_GRAPH =
  'candidate_authority_differs_from_installed_graph';
const CODE_COMMITTED_VERSION_IS_NOT_STABLE_SEMVER =
  'committed_version_is_not_stable_semver';

const CANDIDATE_OBJECT =
  'runtime candidate authority that matches the shipped dependency graph';

const LEGS = Object.freeze({
  'candidate-sources': {
    object: CANDIDATE_OBJECT,
    requires: Object.freeze(['KDNA_CORE_CANDIDATE_SOURCE', 'KDNA_STUDIO_CORE_CANDIDATE_SOURCE']),
    command: Object.freeze(['scripts/run-trusted-npm.js', 'run', 'verify:candidate-sources']),
  },
  'candidate-chain': {
    object: CANDIDATE_OBJECT,
    requires: Object.freeze(['KDNA_CORE_CANDIDATE_SOURCE', 'KDNA_STUDIO_CORE_CANDIDATE_SOURCE']),
    command: Object.freeze(['scripts/run-trusted-npm.js', 'run', 'test:candidate-chain']),
  },
});

// Receipts a committed test prints for itself. They are registered and verified exactly
// like the workflow legs; `emitted_by` names the committed file that prints them and
// `command` is the command that reproduces them.
const TEST_RECEIPTS = Object.freeze({
  'release-pack-evidence': {
    object: 'the packed release artifact evidence of the committed release coordinate',
    emitted_by: path.join('tests', 'publish-hardening.test.js'),
    command: Object.freeze(['--test', '--test-reporter=tap', path.join('tests', 'publish-hardening.test.js')]),
  },
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function coordinates(entries) {
  return entries
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, version]) => `${name}@${version}`)
    .join(',');
}

function authorityCoordinates(root) {
  const binding = readJson(path.join(root, BINDING_PATH));
  return coordinates(binding.packages.map(({ name, version }) => [name, version]));
}

function shippedCoordinates(root) {
  const lock = readJson(path.join(root, LOCK_PATH));
  return coordinates(
    Object.entries(lock.packages)
      .filter(([key]) => key.startsWith('node_modules/@aikdna/'))
      .map(([key, entry]) => [key.slice('node_modules/'.length), entry.version]),
  );
}

// Code 1: the committed graph declares its own @aikdna dependencies as vendored file:
// coordinates, while the leg's verifier (scripts/runtime-candidate-binding.js) accepts
// only an exact SemVer registry coordinate. Read from the committed manifest.
function directCoordinatesAreNotRegistrySemver(root) {
  const manifest = readJson(path.join(root, PACKAGE_PATH));
  const direct = Object.entries(manifest.dependencies ?? {})
    .filter(([name]) => name.startsWith('@aikdna/'));
  const offenders = direct
    .filter(([, spec]) => !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(spec))
    .map(([name, spec]) => `${name}=${spec}`);
  return { holds: offenders.length > 0, detail: offenders };
}

// Code 2: the candidate authority the leg would verify is not the graph the lock installs.
function candidateAuthorityDiffersFromInstalledGraph(root) {
  const authority = authorityCoordinates(root);
  const shipped = shippedCoordinates(root);
  return { holds: authority !== shipped, detail: { authority, shipped } };
}

// Code 3: the committed version is a release candidate, and the release policy only
// produces release coordinates and pack evidence for a stable canonical SemVer.
function committedVersionIsNotStableSemver(root) {
  const { version } = readJson(path.join(root, PACKAGE_PATH));
  return { holds: !STABLE_VERSION_RE.test(version ?? ''), detail: { version } };
}

/** Recompute, from the committed bytes alone, the unavailability codes of one receipt. */
function unavailabilityCodes(root, leg) {
  const codes = [];
  const detail = {};
  const registry = new Map([
    [CODE_DIRECT_COORDINATES_NOT_REGISTRY_SEMVER, directCoordinatesAreNotRegistrySemver],
    [CODE_AUTHORITY_DIFFERS_FROM_INSTALLED_GRAPH, candidateAuthorityDiffersFromInstalledGraph],
    [CODE_COMMITTED_VERSION_IS_NOT_STABLE_SEMVER, committedVersionIsNotStableSemver],
  ]);
  const applicable = Object.hasOwn(TEST_RECEIPTS, leg)
    ? [CODE_COMMITTED_VERSION_IS_NOT_STABLE_SEMVER]
    : [CODE_DIRECT_COORDINATES_NOT_REGISTRY_SEMVER, CODE_AUTHORITY_DIFFERS_FROM_INSTALLED_GRAPH];
  for (const code of applicable) {
    const computed = registry.get(code)(root);
    if (computed.holds) {
      codes.push(code);
      detail[code] = computed.detail;
    }
  }
  return { codes: [...new Set(codes)].sort(), detail };
}

function loadRegistry(root) {
  return readJson(path.join(root, REGISTRY_PATH));
}

function registrationFor(root, leg) {
  return (loadRegistry(root).entries ?? []).find((entry) => entry.leg === leg);
}

function entryExpired(registration, today = new Date().toISOString().slice(0, 10)) {
  return Boolean(registration) && registration.review_by < today;
}

function sameCodeSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((code, index) => code === b[index]);
}

/**
 * The registration that authorises a not_run for `leg`, or null when the receipt may not
 * be printed: no entry, an expired entry, or a code set that does not agree both ways.
 */
function registeredNotRunFor(root, leg, codes) {
  const registration = registrationFor(root, leg);
  if (registration?.class !== 'not_run') return null;
  if (entryExpired(registration)) return null;
  if (!sameCodeSet(codes, registration.unavailable_codes ?? [])) return null;
  return registration;
}

module.exports = {
  BINDING_PATH,
  CODE_AUTHORITY_DIFFERS_FROM_INSTALLED_GRAPH,
  CODE_COMMITTED_VERSION_IS_NOT_STABLE_SEMVER,
  CODE_DIRECT_COORDINATES_NOT_REGISTRY_SEMVER,
  LEGS,
  LOCK_PATH,
  PACKAGE_PATH,
  REGISTRY_PATH,
  TEST_RECEIPTS,
  authorityCoordinates,
  entryExpired,
  registrationFor,
  registeredNotRunFor,
  sameCodeSet,
  shippedCoordinates,
  unavailabilityCodes,
};
