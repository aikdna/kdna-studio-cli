'use strict';

// The stable release gate is directional: the release commit must be an
// ancestor of origin/main. A commit that main descends from (a side branch, or
// a child of main that was never merged) is not an accepted release commit.
// The release commit does not have to be the current main tip.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  RELEASE_MAIN_REF,
  assertReleaseAncestorOfMain,
  fetchReleaseMain,
} = require('../scripts/authoritative-git');
const {
  CANDIDATE_TAG_PREFIX,
  validateCandidateReleaseContext,
  validateReleaseContext,
} = require('../scripts/release-policy');

const ROOT = path.resolve(__dirname, '..');
const HASH = 'a'.repeat(40);

function git(repository, args) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repositoryWithCommits(t, marker, count = 2) {
  const repository = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `kdna-main-ancestry-${marker}-`),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet', '--initial-branch=main']);
  git(repository, ['config', 'user.name', 'KDNA Test']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  const commits = [];
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(repository, `marker-${index}.txt`), `${marker}-${index}\n`);
    git(repository, ['add', '.']);
    git(repository, ['commit', '--quiet', '-m', `${marker}-${index}`]);
    commits.push(git(repository, ['rev-parse', 'HEAD']));
  }
  return { repository, commits };
}

function commitOn(repository, branch, name) {
  git(repository, ['switch', '--quiet', '-c', branch]);
  fs.writeFileSync(path.join(repository, `${name}.txt`), `${name}\n`);
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', name]);
  const commit = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['switch', '--quiet', 'main']);
  return commit;
}

function setOriginMain(repository, commit) {
  git(repository, ['update-ref', RELEASE_MAIN_REF, commit]);
}

function releaseInput(overrides = {}) {
  const version = '0.10.2';
  return {
    pkg: { name: '@aikdna/kdna-studio-cli', version },
    changelog: `# Changelog\n\n## ${version} (2026-07-15)\n`,
    env: {
      GITHUB_EVENT_NAME: 'release',
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_TAG_NAME: version,
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'false',
      GITHUB_REF: `refs/tags/${version}`,
      GITHUB_SHA: HASH,
    },
    git: { status: '', head: HASH, tagCommit: HASH },
    ancestry: { commit: HASH, mainCommit: HASH, ancestor: true },
    ...overrides,
  };
}

test('a non-tip main ancestor is accepted; latest main is not required', (t) => {
  const { repository, commits } = repositoryWithCommits(t, 'non-tip');
  setOriginMain(repository, commits[1]);
  assert.deepEqual(assertReleaseAncestorOfMain(repository, commits[0]), {
    commit: commits[0],
    mainCommit: commits[1],
    ancestor: true,
  });
  assert.deepEqual(assertReleaseAncestorOfMain(repository, commits[1]), {
    commit: commits[1],
    mainCommit: commits[1],
    ancestor: true,
  });
});

test('side-branch and unmerged-descendant commits fail by name', (t) => {
  const { repository, commits } = repositoryWithCommits(t, 'not-on-main');
  setOriginMain(repository, commits[1]);
  const side = commitOn(repository, 'side', 'side-work');
  const descendant = commitOn(repository, 'future', 'future-work');
  for (const commit of [side, descendant]) {
    assert.throws(
      () => assertReleaseAncestorOfMain(repository, commit),
      /RELEASE_COMMIT_NOT_ON_MAIN/,
    );
  }
  // The reverse relation holds for the descendant case - main is an ancestor
  // of the release commit - and the gate still refuses it. This asserts the
  // direction is release-commit -> origin/main, never the opposite.
  const reverse = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', commits[1], descendant],
    { cwd: repository, encoding: 'utf8', shell: false },
  );
  assert.equal(reverse.status, 0, reverse.stderr);
  assert.equal(reverse.stdout, '');
});

test('a missing or unreadable origin/main fails closed with a named refusal', (t) => {
  const { repository, commits } = repositoryWithCommits(t, 'missing-main');
  assert.throws(
    () => assertReleaseAncestorOfMain(repository, commits[0]),
    /RELEASE_MAIN_REF_UNREADABLE/,
  );
  const blob = git(repository, ['hash-object', '-w', '--stdin']);
  git(repository, ['update-ref', RELEASE_MAIN_REF, blob]);
  assert.throws(
    () => assertReleaseAncestorOfMain(repository, commits[0]),
    /RELEASE_MAIN_REF_UNREADABLE/,
  );
  assert.throws(
    () => assertReleaseAncestorOfMain(repository, 'not-a-commit'),
    /release commit must be a lowercase commit SHA/,
  );
});

test('fetchReleaseMain reads the remote main and fails closed without it', (t) => {
  const { repository, commits } = repositoryWithCommits(t, 'fetch-main');
  const origin = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'kdna-main-ancestry-origin-'),
  );
  t.after(() => fs.rmSync(origin, { recursive: true, force: true }));
  git(repository, ['init', '--quiet', '--bare', origin]);
  git(repository, ['remote', 'add', 'origin', origin]);
  git(repository, ['push', '--quiet', 'origin', 'main']);
  assert.deepEqual(fetchReleaseMain(repository), { mainCommit: commits[1] });
  assert.equal(git(repository, ['rev-parse', 'origin/main']), commits[1]);

  const emptyOrigin = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'kdna-main-ancestry-empty-'),
  );
  t.after(() => fs.rmSync(emptyOrigin, { recursive: true, force: true }));
  git(repository, ['init', '--quiet', '--bare', emptyOrigin]);
  git(repository, ['remote', 'set-url', 'origin', emptyOrigin]);
  assert.throws(() => fetchReleaseMain(repository), /RELEASE_MAIN_REF_UNREADABLE/);
});

test('the stable policy requires ancestry and the candidate policy is unchanged', () => {
  assert.throws(
    () => validateReleaseContext(releaseInput({ ancestry: undefined })),
    /RELEASE_MAIN_ANCESTRY_REQUIRED/,
  );
  assert.throws(
    () => validateReleaseContext(releaseInput({ ancestry: { ancestor: false, commit: HASH, mainCommit: HASH } })),
    /RELEASE_MAIN_ANCESTRY_REQUIRED/,
  );
  assert.throws(
    () => validateReleaseContext(releaseInput({ ancestry: { ancestor: true, commit: 'b'.repeat(40), mainCommit: HASH } })),
    /RELEASE_MAIN_ANCESTRY_REQUIRED/,
  );
  assert.equal(validateReleaseContext(releaseInput()).version, '0.10.2');

  const version = '4.0.0-rc.ancestry.1';
  const tag = `${CANDIDATE_TAG_PREFIX}${version}`;
  const candidate = {
    pkg: { name: '@aikdna/kdna-studio-cli', version },
    changelog: `# Changelog\n\n## ${version} (2026-10-18)\n`,
    env: {
      GITHUB_EVENT_NAME: 'release',
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_TAG_NAME: tag,
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'true',
      GITHUB_REF: `refs/tags/${tag}`,
      GITHUB_SHA: HASH,
    },
    git: { status: '', head: HASH, tagCommit: HASH },
  };
  assert.equal(validateCandidateReleaseContext(candidate).channel, 'candidate');
});

test('the publish workflow fetches origin/main with a node step before the gate', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /node scripts\/fetch-release-main\.js/);
  assert.ok(
    workflow.indexOf('fetch-release-main.js') < workflow.indexOf('run release:check'),
    'origin/main must be fetched before release:check',
  );
  assert.doesNotMatch(workflow, /run:\s*git\b/);
});
