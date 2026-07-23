'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findingsForText,
  scanPackedArtifact,
  scanTree,
} = require('../scripts/check-current-protocol-names');

const ROOT = path.resolve(__dirname, '..');

test('removed localhost transport exception is not retained in the exact allowlist', () => {
  const providerRoute = ['v', '1'].join('');
  const allowlist = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'scripts', 'third-party-name-allowlist.json'), 'utf8'),
  );
  assert.equal(
    allowlist.some((entry) =>
      entry.file === 'src/llm/config.js' &&
      entry.text === `http://localhost:11434/${providerRoute}`),
    false,
  );
});

test('KDNA-owned retired names are isolated to exact frozen history', () => {
  const thirdParty = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'scripts', 'third-party-name-allowlist.json'), 'utf8'),
  );
  const frozenHistory = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'scripts', 'frozen-history-name-allowlist.json'), 'utf8'),
  );
  const retiredProfile = ['judgment', 'profile', ['v', '1'].join('')].join('-');

  assert.equal(thirdParty.some((entry) => entry.text === retiredProfile), false);
  assert.deepEqual(
    frozenHistory.map(({ file, text, count }) => ({ file, text, count })),
    [{ file: 'CHANGELOG.md', text: retiredProfile, count: 1 }],
  );
});

test('repository and actual npm tar contain only current KDNA-owned names', () => {
  assert.deepEqual(scanTree(ROOT), []);
  assert.deepEqual(scanPackedArtifact(ROOT), []);
});

test('naming gate rejects content, tag templates, identifiers, and filenames', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-name-hostile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const generation = ['v', '3'].join('');
  const implementation = ['write', 'V', '4', 'Profile'].join('');
  const template = ['v', '${version}'].join('');
  fs.writeFileSync(
    path.join(root, 'src', `profile-${generation}.js`),
    `const name = '${generation}';\nconst tag = \`${template}\`;\nconst ${implementation} = true;\n`,
  );

  const findings = scanTree(root);
  assert.ok(findings.some((finding) => finding.rule === 'generation-style label'));
  assert.ok(findings.some((finding) => finding.rule === 'generation-style tag template'));
  assert.ok(
    findings.some((finding) => finding.rule === 'generation-style implementation identifier'),
  );
  assert.ok(findings.some((finding) => finding.file.includes(`profile-${generation}.js`)));
});

test('third-party allowlisting is exact and does not hide adjacent owned labels', () => {
  const generation = ['v', '8'].join('');
  const allowlist = [
    {
      file: 'src/provider.js',
      text: `https://provider.invalid/${generation}`,
      count: 1,
      reason: 'Provider-owned route.',
    },
  ];
  assert.deepEqual(
    findingsForText(
      'src/provider.js',
      `const url = 'https://provider.invalid/${generation}';`,
      allowlist,
    ),
    [],
  );
  assert.equal(
    findingsForText(
      'src/provider.js',
      `const url = 'https://provider.invalid/${generation}';\nconst profile = 'kdna-${generation}';`,
      allowlist,
    ).length,
    1,
  );
  assert.throws(
    () => findingsForText(
      'src/provider.js',
      `const first = 'https://provider.invalid/${generation}';\nconst second = 'https://provider.invalid/${generation}';`,
      allowlist,
    ),
    /count mismatch/,
  );
});
