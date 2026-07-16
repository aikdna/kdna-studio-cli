#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyCandidateBinding } = require('./runtime-candidate-binding');

const root = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env || process.env,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function npm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], options);
  return run('npm', args, options);
}

function pack(destination) {
  const output = npm(
    ['pack', '--silent', '--ignore-scripts', '--pack-destination', destination],
    { cwd: root },
  ).stdout.trim();
  return path.join(destination, output.split(/\r?\n/).at(-1));
}

function exportedCore(capsule) {
  const source = capsule.context.payload.core;
  return Object.fromEntries(
    ['highest_question', 'worldview', 'value_order', 'judgment_role'].map((field) => [
      field,
      source[field],
    ]),
  );
}

function main() {
  const binding = verifyCandidateBinding(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-candidate-chain-'));
  try {
    const firstPackDirectory = path.join(temporary, 'pack-first');
    const secondPackDirectory = path.join(temporary, 'pack-second');
    const consumer = path.join(temporary, 'consumer');
    const cache = path.join(temporary, 'empty-cache');
    for (const directory of [firstPackDirectory, secondPackDirectory, consumer, cache]) {
      fs.mkdirSync(directory, { recursive: true });
    }

    const firstCliTar = pack(firstPackDirectory);
    const secondCliTar = pack(secondPackDirectory);
    assert.deepEqual(fs.readFileSync(firstCliTar), fs.readFileSync(secondCliTar));

    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      `${JSON.stringify({ name: 'candidate-chain-consumer', version: '1.0.0', private: true }, null, 2)}\n`,
    );
    const candidateTars = binding.packages.map((entry) => path.join(root, entry.artifact));
    npm(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        cache,
        ...candidateTars,
        firstCliTar,
      ],
      { cwd: consumer },
    );
    npm(['ls', '--all'], { cwd: consumer });

    const core = require(path.join(consumer, 'node_modules/@aikdna/kdna-core'));
    const studio = require(path.join(consumer, 'node_modules/@aikdna/kdna-studio-core'));
    const cli = path.join(
      consumer,
      'node_modules/@aikdna/kdna-studio-cli/bin/kdna-studio.js',
    );
    assert.equal(require(path.join(consumer, 'node_modules/@aikdna/kdna-core/package.json')).version, '0.19.0');
    assert.equal(require(path.join(consumer, 'node_modules/@aikdna/kdna-studio-core/package.json')).version, '2.0.0');
    assert.equal(require(path.join(consumer, 'node_modules/@aikdna/kdna-studio-cli/package.json')).version, '0.10.0');

    const judgmentCore = {
      highest_question: 'Which declared tradeoff controls this exact task?',
      worldview: ['Observed task facts remain authoritative.'],
      value_order: ['prevent irreversible harm', 'preserve reversibility'],
      judgment_role: {
        acts_as: 'a scoped judgment authority',
        does_not_act_as: ['a fact source', 'a universal policy'],
        responsibility: 'Order qualitative tradeoffs inside the declared scope.',
      },
    };
    const projectDirectory = path.join(temporary, 'project');
    fs.mkdirSync(projectDirectory);
    const project = studio.project.createProject('candidate_chain', 'domain', {
      judgmentCore,
    });
    project.cards.push(
      studio.cards.createCard(
        'axiom',
        {
          one_sentence: 'Keep the exact declared decision boundary.',
          full_statement:
            'The exported asset must keep the exact declared decision boundary through runtime loading.',
          why: 'Changing the boundary changes the judgment.',
          confidence: 'high',
          evidence_type: 'practice',
          applies_when: ['Exporting an asset'],
          does_not_apply_when: ['Editing raw notes'],
          failure_risk: 'A consumer may apply the judgment outside its scope.',
        },
        'ax_candidate_chain',
      ),
    );
    fs.writeFileSync(
      path.join(projectDirectory, 'studio.project.json'),
      `${JSON.stringify(project, null, 2)}\n`,
    );

    const plainAsset = path.join(temporary, 'plain.kdna');
    run(process.execPath, [cli, 'export', projectDirectory, '--out', plainAsset]);
    assert.equal(core.validate(plainAsset).overall_valid, true);
    const plainCapsule = core.load(plainAsset, { profile: 'full', as: 'json' });
    assert.deepEqual(exportedCore(plainCapsule), judgmentCore);
    assert.equal(plainCapsule.context.manifest.compatibility.min_loader_version, '0.19.0');

    const importedDirectory = path.join(temporary, 'imported');
    run(process.execPath, [
      cli,
      'create',
      importedDirectory,
      '--from-kdna',
      plainAsset,
      '--name',
      '@test/candidate-chain-import',
    ]);
    const importedProject = JSON.parse(
      fs.readFileSync(path.join(importedDirectory, 'studio.project.json'), 'utf8'),
    );
    assert.deepEqual(importedProject.judgment_core, judgmentCore);

    const reexportedAsset = path.join(temporary, 'reexported.kdna');
    run(process.execPath, [cli, 'export', importedDirectory, '--out', reexportedAsset]);
    assert.equal(core.validate(reexportedAsset).overall_valid, true);
    assert.deepEqual(
      exportedCore(core.load(reexportedAsset, { profile: 'full', as: 'json' })),
      judgmentCore,
    );

    const password = 'candidate-chain-test-password';
    const encryptedAsset = path.join(temporary, 'encrypted.kdna');
    run(process.execPath, [
      cli,
      'export',
      projectDirectory,
      '--out',
      encryptedAsset,
      '--password',
      password,
    ]);
    assert.equal(core.validate(encryptedAsset).overall_valid, true);
    assert.equal(core.planLoad(encryptedAsset).state, 'needs_password');
    assert.throws(
      () => core.load(encryptedAsset, { password: 'wrong-password', profile: 'full', as: 'json' }),
      /decrypt|unwrap|integrity|KDNA_DECRYPT_FAILED/i,
    );
    assert.deepEqual(
      exportedCore(core.load(encryptedAsset, { password, profile: 'full', as: 'json' })),
      judgmentCore,
    );

    console.log('Runtime candidate chain verified from three reproducible tarballs and an empty cache');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main();
