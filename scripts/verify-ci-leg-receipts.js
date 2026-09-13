#!/usr/bin/env node
'use strict';

// Independent gate over the CI leg receipt mechanism.
//
// The receipt generator (scripts/ci-leg-receipt.js) and the registered test receipts
// printed by tests/publish-hardening.test.js are never trusted about their own verdict.
// This verifier recomputes, from the committed bytes, the unavailability codes each leg
// may be held at, then requires the machine-readable receipt to agree: the leg name, the
// class, the registered reason and object, the code set in both directions, and the sha256
// digests of the exact committed input files the receipt claims to have read.
//
// Two independent properties keep a registration from becoming a permanent cover:
//
//   * The code sets are compared in both directions, so a code the gate computes but the
//     registry does not name, or a registered code that is no longer true, is a finding.
//     This is what makes the release-pack-evidence registration falsifiable without
//     running the pack: the code is a pure function of the committed package.json, so the
//     first stable release makes it disappear and the registration must go with it.
//   * For every registered workflow leg this verifier builds a sandbox in which the
//     registered codes no longer hold and requires the gate to run the leg instead of
//     printing not_run.
//
// usage: node scripts/verify-ci-leg-receipts.js [--root <tree>]

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BINDING_PATH,
  LEGS,
  LOCK_PATH,
  PACKAGE_PATH,
  REGISTRY_PATH,
  TEST_RECEIPTS,
  entryExpired,
  registeredNotRunFor,
  sameCodeSet,
  unavailabilityCodes,
} = require('./ci-leg-definitions');

const RECEIPT_PREFIX = 'KDNA-CI-RECEIPT: ';
const NOT_RUN_PREFIX = 'KDNA-CI-NOT-RUN:';
const DIGEST_INPUTS = Object.freeze([BINDING_PATH, LOCK_PATH, PACKAGE_PATH, REGISTRY_PATH]);
const GATE_SCRIPTS = Object.freeze([
  'ci-leg-receipt.js',
  'ci-leg-definitions.js',
  'release-policy.js',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function digestOf(root, relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
}

function expectedDigests(root) {
  return Object.fromEntries(DIGEST_INPUTS.map((relative) => [relative, digestOf(root, relative)]));
}

function registryOf(root) {
  return readJson(path.join(root, REGISTRY_PATH));
}

function registrationFor(root, leg) {
  return (registryOf(root).entries ?? []).find((entry) => entry.leg === leg);
}

function onlyLine(stdout, prefix) {
  const lines = stdout.split('\n').filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, `expected exactly one ${prefix} line, got ${lines.length}:\n${stdout}`);
  return lines[0];
}

function parseReceipt(stdout) {
  return JSON.parse(onlyLine(stdout, RECEIPT_PREFIX).slice(RECEIPT_PREFIX.length));
}

function runGenerator(root, leg, environment) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'ci-leg-receipt.js'), leg], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  });
}

function environmentWith(definition) {
  const environment = { ...process.env };
  for (const name of definition.requires) environment[name] = `<verify-ci-leg-receipts:${name}>`;
  return environment;
}

function environmentWithout(definition) {
  const environment = { ...process.env };
  for (const name of definition.requires) delete environment[name];
  return environment;
}

function checkRegistrationShape(leg, registration, findings) {
  if (!registration) {
    findings.push({ leg, check: 'leg_not_registered' });
    return;
  }
  if (registration.class !== 'not_run') findings.push({ leg, check: 'registration_class', detail: String(registration.class) });
  if (typeof registration.reason !== 'string' || registration.reason.length < 16) {
    findings.push({ leg, check: 'registration_without_reason' });
  }
  if (!Array.isArray(registration.unavailable_codes) || registration.unavailable_codes.length === 0) {
    findings.push({ leg, check: 'registration_without_codes' });
  }
  if (typeof registration.trigger !== 'string' || registration.trigger.length < 64) {
    findings.push({ leg, check: 'registration_without_trigger' });
  }
  if (typeof registration.basis !== 'string' || registration.basis.length < 64) {
    findings.push({ leg, check: 'registration_without_basis' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(registration.review_by ?? '')) {
    findings.push({ leg, check: 'registration_without_expiry', detail: String(registration.review_by) });
  } else if (entryExpired(registration)) {
    findings.push({ leg, check: 'registration_expired', detail: registration.review_by });
  }
}

function checkCodeAgreement(root, leg, registration, findings) {
  const computed = unavailabilityCodes(root, leg);
  for (const code of computed.codes) {
    if (!(registration?.unavailable_codes ?? []).includes(code)) {
      findings.push({ leg, check: 'unregistered_unavailability_code', detail: code });
    }
  }
  for (const code of registration?.unavailable_codes ?? []) {
    if (!computed.codes.includes(code)) {
      findings.push({ leg, check: 'registered_code_no_longer_true', detail: code });
    }
  }
  return computed;
}

function checkConfigMissing(root, leg, definition, findings) {
  if (definition.requires.length === 0) return;
  const result = runGenerator(root, leg, environmentWithout(definition));
  if (result.status !== 2) {
    findings.push({ leg, check: 'config_missing_exit', detail: `expected exit 2, got ${result.status}` });
  }
  if (!result.stderr.includes(`KDNA-CI-CONFIG-MISSING: ${leg} missing=`)) {
    findings.push({ leg, check: 'config_missing_diagnostic', detail: result.stderr.trim() });
  }
  if (result.stdout.includes(RECEIPT_PREFIX) || result.stdout.includes(NOT_RUN_PREFIX)) {
    findings.push({ leg, check: 'config_missing_emitted_receipt', detail: result.stdout.trim() });
  }
}

function checkReceipt(root, leg, definition, registration, computed, findings) {
  const expected = registeredNotRunFor(root, leg, computed.codes) ? 'not_run' : 'run';
  const environment = environmentWith(definition);
  const result = runGenerator(root, leg, environment);
  if (result.error) throw result.error;
  if (!(result.pid > 0)) findings.push({ leg, check: 'generator_not_spawned' });

  let receipt;
  try {
    receipt = parseReceipt(result.stdout);
  } catch (error) {
    findings.push({ leg, check: 'receipt_unreadable', detail: `${error.message} | status=${result.status}` });
    return undefined;
  }
  if (receipt.leg !== leg) findings.push({ leg, check: 'receipt_leg', detail: String(receipt.leg) });
  try {
    assert.deepEqual(receipt.inputs, expectedDigests(root));
  } catch {
    findings.push({
      leg,
      check: 'receipt_input_digest',
      detail: 'the receipt is not bound to the sha256 digests of the committed input files',
    });
  }

  if (expected === 'not_run') {
    if (result.status !== 0) findings.push({ leg, check: 'not_run_exit', detail: String(result.status) });
    try {
      onlyLine(result.stdout, NOT_RUN_PREFIX);
    } catch (error) {
      findings.push({ leg, check: 'not_run_line', detail: error.message });
    }
    if (receipt.class !== 'not_run') findings.push({ leg, check: 'not_run_class', detail: String(receipt.class) });
    if (receipt.reason !== registration.reason) findings.push({ leg, check: 'not_run_reason', detail: String(receipt.reason) });
    if (receipt.object !== definition.object) findings.push({ leg, check: 'not_run_object', detail: String(receipt.object) });
    if (!sameCodeSet(receipt.unavailable_codes ?? [], registration.unavailable_codes ?? [])) {
      findings.push({ leg, check: 'not_run_codes', detail: (receipt.unavailable_codes ?? []).join(',') });
    }
    return receipt;
  }

  const legRun = spawnSync(process.execPath, [...definition.command], {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  if (receipt.class !== 'run') findings.push({ leg, check: 'run_class', detail: String(receipt.class) });
  if (receipt.status !== result.status) findings.push({ leg, check: 'run_status', detail: String(receipt.status) });
  if (result.status !== legRun.status) {
    findings.push({ leg, check: 'run_not_the_leg', detail: `gate=${result.status} leg=${legRun.status}` });
  }
  return receipt;
}

// A registered test receipt is checked against the committed test that prints it: the
// command must exit 0 and print exactly one receipt line carrying the registered reason,
// so the registration - not the test's own condition - is what produced the not_run.
function checkTestReceipt(root, leg, definition, registration, computed, findings, runCache) {
  const expected = registeredNotRunFor(root, leg, computed.codes) ? 'not_run' : 'run';
  // One committed test file can print more than one registered receipt, so its run is
  // shared between them. The test is spawned as its own Node process, and
  // NODE_TEST_CONTEXT is removed so this verifier can also be driven from inside a
  // node:test run (the authenticity suite does exactly that) without Node refusing the
  // nested test file.
  const cacheKey = definition.command.join(' ');
  if (!runCache.has(cacheKey)) {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    runCache.set(cacheKey, spawnSync(process.execPath, [...definition.command], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
    }));
  }
  const result = runCache.get(cacheKey);
  if (result.error) throw result.error;
  if (expected !== 'not_run') {
    findings.push({
      leg,
      check: 'test_receipt_registration_no_longer_holds',
      detail: `the committed test must run for real now (status=${result.status})`,
    });
    return;
  }
  if (result.status !== 0) findings.push({ leg, check: 'test_receipt_exit', detail: String(result.status) });
  let line;
  try {
    // One committed test file can carry more than one registered receipt, so the check is
    // "exactly one receipt line for this leg", not "one receipt line in the run".
    const lines = result.stdout
      .split('\n')
      .filter((candidate) => candidate.startsWith(`${NOT_RUN_PREFIX} ${leg} `));
    assert.equal(lines.length, 1, `expected exactly one ${leg} receipt line, got ${lines.length}`);
    [line] = lines;
  } catch (error) {
    findings.push({
      leg,
      check: 'test_receipt_line',
      detail: `${error.message} | stderr=${result.stderr.trim().slice(0, 400)}`,
    });
    return;
  }
  if (!line.includes(`reason=${registration.reason}`)) {
    findings.push({ leg, check: 'test_receipt_reason', detail: line.slice(0, 200) });
  }
}

// Reverse cases: mutate one committed fact at a time and require the recomputation - and
// the registration check built on it - to stop authorising the receipt.
function checkReverseCases(root, findings) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-ci-leg-reverse-'));
  try {
    for (const relative of DIGEST_INPUTS) {
      fs.mkdirSync(path.dirname(path.join(sandbox, relative)), { recursive: true });
      fs.copyFileSync(path.join(root, relative), path.join(sandbox, relative));
    }
    // 1. A stable committed version removes the prerelease code.
    const manifest = readJson(path.join(sandbox, PACKAGE_PATH));
    manifest.version = '1.2.3';
    fs.writeFileSync(path.join(sandbox, PACKAGE_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
    const stable = unavailabilityCodes(sandbox, 'release-pack-evidence');
    if (stable.codes.length !== 0) {
      findings.push({ leg: 'release-pack-evidence', check: 'reverse_case_stable_version', detail: stable.codes.join(',') });
    }
    if (registeredNotRunFor(sandbox, 'release-pack-evidence', stable.codes) !== null) {
      findings.push({ leg: 'release-pack-evidence', check: 'reverse_case_registration_survives', detail: 'a stable version still authorised the receipt' });
    }
    // 2. Exact SemVer direct coordinates plus a re-pinned authority remove both candidate
    //    codes.
    const binding = readJson(path.join(sandbox, BINDING_PATH));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith('@aikdna/')) {
        const installed = readJson(path.join(root, LOCK_PATH)).packages?.[`node_modules/${name}`]?.version;
        manifest.dependencies[name] = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(installed ?? '')
          ? installed
          : '1.2.3';
      }
    }
    fs.writeFileSync(path.join(sandbox, PACKAGE_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
    // Re-pin the candidate authority to exactly the shipped graph, so the authority no
    // longer differs from it.
    const shippedPackages = Object.entries(readJson(path.join(root, LOCK_PATH)).packages)
      .filter(([key]) => key.startsWith('node_modules/@aikdna/'))
      .map(([key, entry]) => ({ name: key.slice('node_modules/'.length), version: entry.version }));
    binding.packages = shippedPackages.map((entry) => ({ ...binding.packages[0], ...entry }));
    fs.writeFileSync(path.join(sandbox, BINDING_PATH), `${JSON.stringify(binding, null, 2)}\n`);
    for (const leg of ['candidate-sources', 'candidate-chain']) {
      const codes = unavailabilityCodes(sandbox, leg);
      if (codes.codes.length !== 0) {
        findings.push({ leg, check: 'reverse_case_registry_coordinates', detail: codes.codes.join(',') });
      }
      if (registeredNotRunFor(sandbox, leg, codes.codes) !== null) {
        findings.push({ leg, check: 'reverse_case_registration_survives', detail: 'a registry-coordinate graph still authorised the receipt' });
      }
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// The not_run outcome must be impossible once the registered codes are gone.
function checkNotRunIsFalsifiable(root, leg, definition, findings) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-ci-leg-'));
  try {
    for (const relative of DIGEST_INPUTS) {
      fs.mkdirSync(path.dirname(path.join(sandbox, relative)), { recursive: true });
      fs.copyFileSync(path.join(root, relative), path.join(sandbox, relative));
    }
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    for (const name of GATE_SCRIPTS) {
      fs.copyFileSync(path.join(root, 'scripts', name), path.join(sandbox, 'scripts', name));
    }
    // Exact SemVer direct coordinates: the first registered code is gone.
    const manifest = readJson(path.join(sandbox, PACKAGE_PATH));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith('@aikdna/')) manifest.dependencies[name] = '1.2.3';
    }
    fs.writeFileSync(path.join(sandbox, PACKAGE_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
    // Re-pin the candidate authority to the shipped graph: the second code is gone.
    const lock = readJson(path.join(sandbox, LOCK_PATH));
    const shippedPackages = Object.entries(lock.packages)
      .filter(([key]) => key.startsWith('node_modules/@aikdna/'))
      .map(([key, entry]) => ({ name: key.slice('node_modules/'.length), version: entry.version }));
    const binding = readJson(path.join(sandbox, BINDING_PATH));
    binding.packages = shippedPackages.map((entry) => ({ ...binding.packages[0], ...entry }));
    fs.writeFileSync(path.join(sandbox, BINDING_PATH), `${JSON.stringify(binding, null, 2)}\n`);
    // The leg command is shimmed: this check is about the gate's decision, not about
    // reproducing the candidate artifacts.
    fs.writeFileSync(
      path.join(sandbox, 'scripts', 'run-trusted-npm.js'),
      "'use strict';\nprocess.exit(0);\n",
    );
    const result = runGenerator(sandbox, leg, environmentWith(definition));
    if (result.status !== 0) findings.push({ leg, check: 'falsification_exit', detail: String(result.status) });
    if (result.stdout.includes(NOT_RUN_PREFIX)) {
      findings.push({
        leg,
        check: 'not_run_is_permanent',
        detail: 'the registered codes were removed and the gate still refused to run the leg',
      });
      return;
    }
    const receipt = parseReceipt(result.stdout);
    if (receipt.class !== 'run') findings.push({ leg, check: 'falsification_class', detail: String(receipt.class) });
  } catch (error) {
    findings.push({ leg, check: 'falsification_error', detail: error.message });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function verify(root) {
  const findings = [];
  const registry = registryOf(root);
  const known = new Set([...Object.keys(LEGS), ...Object.keys(TEST_RECEIPTS)]);
  for (const entry of registry.entries ?? []) {
    if (!known.has(entry.leg)) findings.push({ leg: entry.leg, check: 'registration_for_unknown_leg' });
  }
  const receipts = [];
  for (const [leg, definition] of Object.entries(LEGS)) {
    const registration = registrationFor(root, leg);
    checkRegistrationShape(leg, registration, findings);
    const computed = checkCodeAgreement(root, leg, registration, findings);
    checkConfigMissing(root, leg, definition, findings);
    const receipt = checkReceipt(root, leg, definition, registration, computed, findings);
    if (receipt) receipts.push(receipt);
    if (registration?.class === 'not_run') checkNotRunIsFalsifiable(root, leg, definition, findings);
  }
  const testRunCache = new Map();
  for (const [leg, definition] of Object.entries(TEST_RECEIPTS)) {
    const registration = registrationFor(root, leg);
    checkRegistrationShape(leg, registration, findings);
    const computed = checkCodeAgreement(root, leg, registration, findings);
    checkTestReceipt(root, leg, definition, registration, computed, findings, testRunCache);
  }
  checkReverseCases(root, findings);
  return { findings, receipts };
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? path.resolve(__dirname, '..') : path.resolve(argv[rootIndex + 1]);
  const { findings, receipts } = verify(root);
  if (findings.length > 0) {
    console.log(`KDNA-CI-LEG-RECEIPTS: findings=${findings.length} root=${root} ${JSON.stringify(findings)}`);
    return 1;
  }
  const classes = receipts.map((receipt) => `${receipt.leg}=${receipt.class}`).join(',');
  console.log(`KDNA-CI-LEG-RECEIPTS: ok root=${root} legs=${receipts.length} ${classes}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  expectedDigests,
  registryOf,
  verify,
};
