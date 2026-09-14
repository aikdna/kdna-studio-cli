'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The receipt mechanism is only worth as much as the gate that consumes it.
// These cases replace the receipt generator with stubs and require
// scripts/verify-ci-leg-receipts.js to go red; the authentic generator must
// stay green. A gate that only checked "the receipt file exists" would pass
// every case below.

const root = path.resolve(__dirname, '..');
const consumer = path.join(root, 'scripts', 'verify-ci-leg-receipts.js');
const generator = path.join(root, 'scripts', 'ci-leg-receipt.js');

function sandboxTree({ removeRegisteredCodes = false } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-leg-receipts-'));
  const files = [
    'package.json',
    'package-lock.json',
    'fixtures/runtime-candidates/binding.json',
    'fixtures/runtime-candidates/leg-registry.json',
  ];
  for (const relative of files) {
    fs.mkdirSync(path.dirname(path.join(sandbox, relative)), { recursive: true });
    fs.copyFileSync(path.join(root, relative), path.join(sandbox, relative));
  }
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
  for (const name of ['ci-leg-receipt.js', 'ci-leg-definitions.js', 'release-policy.js']) {
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(sandbox, 'scripts', name));
  }
  // The leg command is shimmed: these cases are about the receipt mechanism,
  // not about reproducing candidate artifacts.
  fs.writeFileSync(path.join(sandbox, 'scripts', 'run-trusted-npm.js'), "'use strict';\nprocess.exit(0);\n");
  // The registered test receipt is shimmed the same way: the consumer checks that the
  // committed test prints exactly the receipt the registration authorises.
  const registry = JSON.parse(fs.readFileSync(path.join(sandbox, 'fixtures/runtime-candidates/leg-registry.json'), 'utf8'));
  const testReceipt = registry.entries.find((entry) => entry.leg === 'release-pack-evidence');
  fs.mkdirSync(path.join(sandbox, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, 'tests', 'publish-hardening.test.js'),
    [
      "'use strict';",
      `console.log('KDNA-CI-NOT-RUN: release-pack-evidence reason=${testReceipt.reason} ` +
        `object=${testReceipt.object} unavailable=${testReceipt.unavailable_codes.join(',')}');`,
      // No process.exit here: stdout to a pipe is asynchronous, so exiting would
      // truncate the receipt the consumer has to read.
      '',
    ].join('\n'),
  );
  if (removeRegisteredCodes) {
    // Both candidate codes are removed: every direct @aikdna coordinate becomes an exact
    // SemVer and the candidate authority is re-pinned to the shipped graph.
    const manifest = JSON.parse(fs.readFileSync(path.join(sandbox, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith('@aikdna/')) manifest.dependencies[name] = '1.2.3';
    }
    fs.writeFileSync(path.join(sandbox, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const lock = JSON.parse(fs.readFileSync(path.join(sandbox, 'package-lock.json'), 'utf8'));
    const shipped = Object.entries(lock.packages)
      .filter(([key]) => key.startsWith('node_modules/@aikdna/'))
      .map(([key, entry]) => ({ name: key.slice('node_modules/'.length), version: entry.version }));
    const binding = JSON.parse(fs.readFileSync(path.join(sandbox, 'fixtures/runtime-candidates/binding.json'), 'utf8'));
    binding.packages = shipped.map((entry) => ({ ...binding.packages[0], ...entry }));
    fs.writeFileSync(
      path.join(sandbox, 'fixtures/runtime-candidates/binding.json'),
      `${JSON.stringify(binding, null, 2)}\n`,
    );
  }
  return sandbox;
}

function runConsumer(tree) {
  return spawnSync(process.execPath, [consumer, '--root', tree], { encoding: 'utf8' });
}

function withSandbox(options, body) {
  const sandbox = sandboxTree(options);
  try {
    return body(sandbox);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

test('the authentic generator satisfies the independent consumer', () => {
  withSandbox({}, (sandbox) => {
    const result = runConsumer(sandbox);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /KDNA-CI-LEG-RECEIPTS: ok/);
  });
});

test('registered test receipts must be actual unique TAP stdout lines', () => {
  for (const mutation of ['silence', 'duplicate', 'quoted', 'title']) {
    withSandbox({}, (sandbox) => {
      const file = path.join(sandbox, 'tests/publish-hardening.test.js');
      const source = fs.readFileSync(file, 'utf8');
      const receipt = source.match(/console\.log\('([^']+)'\);/u)[1];
      const changed = {
        silence: "'use strict';\n",
        duplicate: source + `console.log(${JSON.stringify(receipt)});\n`,
        quoted: `console.log(${JSON.stringify('# ' + receipt)});\n`,
        title: `require('node:test')(${JSON.stringify(receipt)}, () => {});\n`,
      }[mutation];
      assert.notEqual(changed, source);
      fs.writeFileSync(file, changed);
      const result = runConsumer(sandbox);
      assert.equal(result.status, 1, `${mutation}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /test_receipt_line/);
    });
  }
});

test('a generator that always prints success makes the gate red', () => {
  withSandbox({}, (sandbox) => {
    fs.writeFileSync(
      path.join(sandbox, 'scripts', 'ci-leg-receipt.js'),
      "'use strict';\nconsole.log(`KDNA-CI-OK: ${process.argv[2]} success`);\nprocess.exit(0);\n",
    );
    const result = runConsumer(sandbox);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /receipt_unreadable|not_run_line|not_run_class/);
  });
});

test('a generator that prints a fabricated not_run receipt makes the gate red', () => {
  withSandbox({}, (sandbox) => {
    fs.writeFileSync(
      path.join(sandbox, 'scripts', 'ci-leg-receipt.js'),
      [
        "'use strict';",
        'const leg = process.argv[2];',
        "console.log(`KDNA-CI-NOT-RUN: ${leg} reason=retired_runtime_candidate_authority object=runtime candidate authority that matches the shipped dependency graph authority=@aikdna/kdna-core@0.21.0 shipped=@aikdna/kdna-core@0.21.0`);",
        "console.log('KDNA-CI-RECEIPT: ' + JSON.stringify({ leg, class: 'not_run', reason: 'retired_runtime_candidate_authority', object: 'runtime candidate authority that matches the shipped dependency graph', authority: '@aikdna/kdna-core@0.21.0', shipped: '@aikdna/kdna-core@0.21.0', inputs: {} }));",
        'process.exit(0);',
        '',
      ].join('\n'),
    );
    const result = runConsumer(sandbox);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /receipt_input_digest|not_run_codes|not_run_reason|receipt_unreadable/);
  });
});

test('a generator that prints nothing and exits 0 makes the gate red', () => {
  withSandbox({}, (sandbox) => {
    fs.writeFileSync(path.join(sandbox, 'scripts', 'ci-leg-receipt.js'), "'use strict';\nprocess.exit(0);\n");
    const result = runConsumer(sandbox);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /receipt_unreadable/);
  });
});

test('a generator whose condition is inverted is caught once the registered mismatch is gone', () => {
  const source = fs.readFileSync(generator, 'utf8');
  const mutated = source.replace(
    'const registration = registeredNotRunFor(root, leg, computed.codes);',
    'const registration = registrationFor(root, leg);',
  );
  assert.notEqual(mutated, source, 'the hostile mutation must actually change the generator');

  withSandbox({ removeRegisteredCodes: true }, (sandbox) => {
    fs.writeFileSync(path.join(sandbox, 'scripts', 'ci-leg-receipt.js'), mutated);
    const result = runConsumer(sandbox);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /run_class|not_run_class|not_run_is_permanent|falsification_class/);
  });

  // On the committed graph the mutated generator prints the same not_run line
  // the authentic one would; the consumer still goes red, because its
  // falsification pass re-pins the authority inside its own sandbox and the
  // mutated generator refuses to run the leg there.
  withSandbox({}, (sandbox) => {
    fs.writeFileSync(path.join(sandbox, 'scripts', 'ci-leg-receipt.js'), mutated);
    const result = runConsumer(sandbox);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /not_run_is_permanent/);
  });
});

test('a generator that keeps the true verdict but reports the wrong status makes the gate red', () => {
  const source = fs.readFileSync(generator, 'utf8');
  const mutated = source.replace(
    '      status: result.status,',
    '      status: result.status + 1,',
  );
  assert.notEqual(mutated, source, 'the hostile mutation must actually change the generator');
  withSandbox({ removeRegisteredCodes: true }, (sandbox) => {
    fs.writeFileSync(path.join(sandbox, 'scripts', 'ci-leg-receipt.js'), mutated);
    const result = runConsumer(sandbox);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /run_status/);
  });
});

test('a registration without an expiry is rejected', () => {
  withSandbox({}, (sandbox) => {
    const registryPath = path.join(sandbox, 'fixtures', 'runtime-candidates', 'leg-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    delete registry.entries[0].review_by;
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const result = runConsumer(sandbox);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /registration_without_expiry/);
  });
});

test('a leg that is not registered cannot be suppressed', () => {
  withSandbox({}, (sandbox) => {
    const registryPath = path.join(sandbox, 'fixtures', 'runtime-candidates', 'leg-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.entries = registry.entries.filter((entry) => entry.leg !== 'candidate-sources');
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const result = runConsumer(sandbox);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /leg_not_registered/);
    // Without the registration the generator runs the leg instead of printing
    // a receipt, so the suppression attempt is visible in the generator too.
    const generatorRun = spawnSync(
      process.execPath,
      [path.join(sandbox, 'scripts', 'ci-leg-receipt.js'), 'candidate-sources'],
      { cwd: sandbox, env: { ...process.env, KDNA_CORE_CANDIDATE_SOURCE: 'x', KDNA_STUDIO_CORE_CANDIDATE_SOURCE: 'y' }, encoding: 'utf8' },
    );
    assert.equal(generatorRun.status, 0);
    assert.doesNotMatch(generatorRun.stdout, /KDNA-CI-NOT-RUN/);
    assert.match(generatorRun.stdout, /KDNA-CI-RECEIPT: .*"class":"run"/);
  });
});
