'use strict';

// Shared, committed definitions for the gated CI legs. The receipt generator
// (scripts/ci-leg-receipt.js) and the independent verifier
// (scripts/verify-ci-leg-receipts.js) both read these; the verifier never
// trusts the generator's own view of them.

const path = require('node:path');

const BINDING_PATH = path.join('fixtures', 'runtime-candidates', 'binding.json');
const LOCK_PATH = 'package-lock.json';
const REGISTRY_PATH = path.join('fixtures', 'runtime-candidates', 'leg-registry.json');

const LEGS = Object.freeze({
  'candidate-sources': {
    object: 'runtime candidate authority that matches the shipped dependency graph',
    requires: Object.freeze(['KDNA_CORE_CANDIDATE_SOURCE', 'KDNA_STUDIO_CORE_CANDIDATE_SOURCE']),
    command: Object.freeze(['scripts/run-trusted-npm.js', 'run', 'verify:candidate-sources']),
  },
  'candidate-chain': {
    object: 'runtime candidate authority that matches the shipped dependency graph',
    requires: Object.freeze(['KDNA_CORE_CANDIDATE_SOURCE', 'KDNA_STUDIO_CORE_CANDIDATE_SOURCE']),
    command: Object.freeze(['scripts/run-trusted-npm.js', 'run', 'test:candidate-chain']),
  },
});

module.exports = { BINDING_PATH, LEGS, LOCK_PATH, REGISTRY_PATH };
