'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANDIDATE_WORKFLOW_PATH = path.join('.github', 'workflows', 'ci.yml');
const CANDIDATE_AUTHORITIES = Object.freeze([
  Object.freeze({
    name: '@aikdna/kdna-core',
    version: '0.21.0',
    repository: 'aikdna/kdna',
    repositoryEnvironment: 'KDNA_CORE_CANDIDATE_REPOSITORY',
    commitEnvironment: 'KDNA_CORE_CANDIDATE_COMMIT',
    evidencePath: path.join(
      'fixtures',
      'runtime-candidates',
      'kdna-core-0.21.0.evidence.json',
    ),
    sourceEnvironment: 'KDNA_CORE_CANDIDATE_SOURCE',
    sourcePackageSubdirectory: path.join('packages', 'kdna-core'),
  }),
  Object.freeze({
    name: '@aikdna/kdna-studio-core',
    version: '2.0.4',
    repository: 'aikdna/kdna-studio-core',
    repositoryEnvironment: 'KDNA_STUDIO_CORE_CANDIDATE_REPOSITORY',
    commitEnvironment: 'KDNA_STUDIO_CORE_CANDIDATE_COMMIT',
    evidencePath: path.join(
      'fixtures',
      'runtime-candidates',
      'kdna-studio-core-2.0.4.evidence.json',
    ),
    sourceEnvironment: 'KDNA_STUDIO_CORE_CANDIDATE_SOURCE',
    sourcePackageSubdirectory: '',
  }),
]);

function readPinnedCandidateCommits(root) {
  const workflow = fs.readFileSync(path.join(root, CANDIDATE_WORKFLOW_PATH), 'utf8');
  return new Map(
    CANDIDATE_AUTHORITIES.map((authority) => {
      const escapedRepositoryEnvironment = authority.repositoryEnvironment
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedCommitEnvironment = authority.commitEnvironment
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedRepository = authority.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `${escapedRepositoryEnvironment}:\\s*${escapedRepository}\\s*\\r?\\n` +
          `\\s*${escapedCommitEnvironment}:\\s*([a-f0-9]{40})(?:\\s|$)`,
        'gi',
      );
      const refs = [...workflow.matchAll(pattern)].map((match) => match[1].toLowerCase());
      const distinct = [...new Set(refs)];
      if (refs.length === 0 || distinct.length !== 1) {
        throw new Error(
          `CI must pin every ${authority.name} candidate source to one repository and full commit.`,
        );
      }
      return [authority.name, distinct[0]];
    }),
  );
}

module.exports = {
  CANDIDATE_AUTHORITIES,
  CANDIDATE_WORKFLOW_PATH,
  readPinnedCandidateCommits,
};
