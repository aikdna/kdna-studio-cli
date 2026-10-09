'use strict';

const EXPECTED_PACKAGE_NAME = '@aikdna/kdna-studio-cli';
const COMMIT_RE = /^[0-9a-f]{40}$/;
const CANDIDATE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*$/u;
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateReleaseContext({ pkg, changelog, env, git }) {
  assert(pkg && typeof pkg === 'object' && !Array.isArray(pkg), 'package.json must be an object');
  assert(pkg.name === EXPECTED_PACKAGE_NAME, `package name must be ${EXPECTED_PACKAGE_NAME}`);
  assert(STABLE_VERSION_RE.test(pkg.version || ''), 'package version must be stable canonical SemVer');
  const version = pkg.version;
  const tag = version;
  const ref = `refs/tags/${tag}`;

  assert(env.GITHUB_EVENT_NAME === 'release', 'GITHUB_EVENT_NAME must be release');
  assert(env.RELEASE_EVENT_ACTION === 'published', 'release action must be published');
  assert(env.RELEASE_TAG_NAME === tag, `release tag must be exactly ${tag}`);
  assert(env.RELEASE_IS_DRAFT === 'false', 'draft releases cannot publish');
  assert(env.RELEASE_IS_PRERELEASE === 'false', 'prereleases cannot publish');
  assert(env.GITHUB_REF === ref, `GITHUB_REF must be exactly ${ref}`);
  assert(COMMIT_RE.test(env.GITHUB_SHA || ''), 'GITHUB_SHA must be a lowercase commit SHA');
  assert(git.status === '', 'worktree must be clean');
  assert(COMMIT_RE.test(git.head || ''), 'HEAD must be a lowercase commit SHA');
  assert(COMMIT_RE.test(git.tagCommit || ''), 'release tag must resolve to a commit');
  assert(git.tagCommit === git.head, `${tag} must resolve to HEAD`);
  assert(env.GITHUB_SHA === git.head, 'GITHUB_SHA must equal HEAD and the release tag commit');

  const heading = new RegExp(`^## ${escapeRegExp(version)}(?: \\(\\d{4}-\\d{2}-\\d{2}\\))?$`, 'gm');
  assert([...changelog.matchAll(heading)].length === 1, `CHANGELOG must contain one ## ${version}`);
  const finalized = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)(?: \(\d{4}-\d{2}-\d{2}\))?$/gm)];
  assert(finalized[0]?.[1] === version, `${version} must be the first finalized CHANGELOG entry`);
  return Object.freeze({ name: pkg.name, version, tag, ref, commit: git.head });
}


// Candidate preparation is deliberately not a release event, tag or permission.
// Stable publication still uses validateReleaseContext and rejects every RC.
function validateCandidateCoordinate({ pkg, changelog }) {
  assert(pkg?.name === EXPECTED_PACKAGE_NAME, 'candidate package name mismatch');
  assert(CANDIDATE_VERSION_RE.test(pkg.version || ''), 'candidate must have an exact canonical prerelease coordinate');
  const heading = new RegExp(`^## ${escapeRegExp(pkg.version)}(?: \\(\\d{4}-\\d{2}-\\d{2}\\))?$`, 'gm');
  assert([...changelog.matchAll(heading)].length === 1, 'candidate CHANGELOG coordinate missing or duplicated');
  const first = changelog.match(/^## (.+)$/m)?.[0];
  assert(first && new RegExp(heading.source).test(first), 'candidate must be first CHANGELOG entry');
  return Object.freeze({ name: pkg.name, version: pkg.version, status: 'candidate_preflight_only' });
}

module.exports = {
  CANDIDATE_VERSION_RE,
  validateCandidateCoordinate,
  COMMIT_RE,
  EXPECTED_PACKAGE_NAME,
  STABLE_VERSION_RE,
  validateReleaseContext,
};
