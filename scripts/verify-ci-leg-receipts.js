#!/usr/bin/env node
'use strict';

// Independent gate over the CI leg receipt mechanism.
//
// The receipt generator (scripts/ci-leg-receipt.js) is never trusted about its
// own verdict. This verifier recomputes, from the committed bytes, what each
// leg's outcome has to be, then requires the generator's machine-readable
// receipt to agree - including the sha256 digests of the exact input files, the
// registered reason and object, and the authority/shipped coordinates.
//
// It also proves the not_run mechanism is not self-suppressing: for every
// registered leg it builds a sandbox in which the candidate authority has been
// re-pinned to the shipped graph and requires the generator to run the leg
// instead of printing not_run.
//
// usage: node scripts/verify-ci-leg-receipts.js [--root <tree>]

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BINDING_PATH, LEGS, LOCK_PATH, REGISTRY_PATH } = require('./ci-leg-definitions');

const RECEIPT_PREFIX = 'KDNA-CI-RECEIPT: ';
const NOT_RUN_PREFIX = 'KDNA-CI-NOT-RUN: ';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function coordinates(entries) {
  return entries
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, version]) => `${name}@${version}`)
    .join(',');
}

function authorityOf(root) {
  const binding = readJson(path.join(root, BINDING_PATH));
  return coordinates(binding.packages.map(({ name, version }) => [name, version]));
}

function shippedOf(root) {
  const lock = readJson(path.join(root, LOCK_PATH));
  return coordinates(
    Object.entries(lock.packages)
      .filter(([key]) => key.startsWith('node_modules/@aikdna/'))
      .map(([key, entry]) => [key.slice('node_modules/'.length), entry.version]),
  );
}

function digestOf(root, relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
}

function expectedDigests(root) {
  return { [BINDING_PATH]: digestOf(root, BINDING_PATH), [LOCK_PATH]: digestOf(root, LOCK_PATH) };
}

function registryOf(root) {
  return readJson(path.join(root, REGISTRY_PATH));
}

function onlyLine(stdout, prefix) {
  const lines = stdout.split('\n').filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, `expected exactly one ${prefix}line, got ${lines.length}:\n${stdout}`);
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

function checkConfigMissing(root, leg, definition, findings) {
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

function checkReceipt(root, leg, definition, registration, findings) {
  const authority = authorityOf(root);
  const shipped = shippedOf(root);
  const registered = registration?.class === 'not_run';
  const expected = registered && authority !== shipped ? 'not_run' : 'run';
  const result = runGenerator(root, leg, environmentWith(definition));
  if (result.error) throw result.error;
  if (!(result.pid > 0)) findings.push({ leg, check: 'generator_not_spawned' });

  let receipt;
  try {
    receipt = parseReceipt(result.stdout);
  } catch (error) {
    findings.push({ leg, check: 'receipt_unreadable', detail: error.message });
    return undefined;
  }
  if (receipt.leg !== leg) findings.push({ leg, check: 'receipt_leg', detail: receipt.leg });
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
    if (receipt.class !== 'not_run') findings.push({ leg, check: 'not_run_class', detail: receipt.class });
    if (receipt.reason !== registration.reason) findings.push({ leg, check: 'not_run_reason', detail: String(receipt.reason) });
    if (receipt.object !== registration.object) findings.push({ leg, check: 'not_run_object', detail: String(receipt.object) });
    if (receipt.authority !== authority) findings.push({ leg, check: 'not_run_authority', detail: String(receipt.authority) });
    if (receipt.shipped !== shipped) findings.push({ leg, check: 'not_run_shipped', detail: String(receipt.shipped) });
    if (!registration.trigger) findings.push({ leg, check: 'registration_without_trigger' });
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(registration.review_by ?? '')) {
      findings.push({ leg, check: 'registration_without_expiry', detail: String(registration.review_by) });
    } else if (registration.review_by < new Date().toISOString().slice(0, 10)) {
      findings.push({ leg, check: 'registration_expired', detail: registration.review_by });
    }
    return receipt;
  }

  const legRun = spawnSync(process.execPath, [...definition.command], {
    cwd: root,
    env: environmentWith(definition),
    stdio: 'inherit',
  });
  if (receipt.class !== 'run') findings.push({ leg, check: 'run_class', detail: receipt.class });
  if (receipt.status !== result.status) findings.push({ leg, check: 'run_status', detail: String(receipt.status) });
  if (result.status !== legRun.status) {
    findings.push({ leg, check: 'run_not_the_leg', detail: `generator=${result.status} leg=${legRun.status}` });
  }
  return receipt;
}

// The not_run outcome must be impossible once the registered mismatch is gone.
function checkNotRunIsFalsifiable(root, leg, definition, findings) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-ci-leg-'));
  try {
    for (const relative of ['package.json', LOCK_PATH, BINDING_PATH, REGISTRY_PATH]) {
      fs.mkdirSync(path.dirname(path.join(sandbox, relative)), { recursive: true });
      fs.copyFileSync(path.join(root, relative), path.join(sandbox, relative));
    }
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    for (const relative of ['ci-leg-receipt.js', 'ci-leg-definitions.js']) {
      fs.copyFileSync(path.join(root, 'scripts', relative), path.join(sandbox, 'scripts', relative));
    }
    // Re-pin the candidate authority to the shipped graph.
    const lock = readJson(path.join(sandbox, LOCK_PATH));
    const shippedPackages = Object.entries(lock.packages)
      .filter(([key]) => key.startsWith('node_modules/@aikdna/'))
      .map(([key, entry]) => ({ name: key.slice('node_modules/'.length), version: entry.version }));
    const binding = readJson(path.join(sandbox, BINDING_PATH));
    binding.packages = shippedPackages.map((entry) => ({ ...binding.packages[0], ...entry }));
    fs.writeFileSync(path.join(sandbox, BINDING_PATH), `${JSON.stringify(binding, null, 2)}\n`);
    // The leg command is shimmed: this check is about the gate's decision, not
    // about reproducing the candidate artifacts.
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
        detail: 'the authority was re-pinned to the shipped graph and the gate still refused to run the leg',
      });
      return;
    }
    const receipt = parseReceipt(result.stdout);
    if (receipt.class !== 'run') findings.push({ leg, check: 'falsification_class', detail: receipt.class });
  } catch (error) {
    findings.push({ leg, check: 'falsification_error', detail: error.message });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function verify(root) {
  const findings = [];
  const registry = registryOf(root);
  const registered = new Set((registry.entries ?? []).map((entry) => entry.leg));
  for (const leg of Object.keys(LEGS)) {
    if (!registered.has(leg)) findings.push({ leg, check: 'leg_not_registered' });
  }
  for (const entry of registry.entries ?? []) {
    if (!Object.hasOwn(LEGS, entry.leg)) findings.push({ leg: entry.leg, check: 'registration_for_unknown_leg' });
  }
  const receipts = [];
  for (const [leg, definition] of Object.entries(LEGS)) {
    checkConfigMissing(root, leg, definition, findings);
    const registration = (registry.entries ?? []).find((entry) => entry.leg === leg);
    const receipt = checkReceipt(root, leg, definition, registration, findings);
    if (receipt) receipts.push(receipt);
    if (registration?.class === 'not_run') checkNotRunIsFalsifiable(root, leg, definition, findings);
  }
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
  authorityOf,
  expectedDigests,
  registryOf,
  shippedOf,
  verify,
};
