// Test fixture, loaded via `NODE_OPTIONS=--require` by tests/cli.test.js to
// simulate Studio Core initIdentity failure modes that cannot be triggered
// portably from the CLI test suite:
//
//   already-exists / incomplete / corrupt
//                           stable pre-existing identity state codes
//   durability-unconfirmed  committed, re-verified identity; parent fsync failed
//   committed-inconsistent  committed files failed post-commit verification
//   write-failure / io-failure / kdf-failure / unrelated-eexist
//                           stable non-identity failure codes
//
// The hook patches the published @aikdna/kdna-studio-core module in the
// require cache before bin/kdna-studio.js loads it, so the CLI observes the
// injected failure exactly as it would observe the real one.

const mode = process.env.KDNA_TEST_INIT_FAILURE;

if (mode) {
  const core = require('@aikdna/kdna-studio-core');
  core.creator.initIdentity = () => {
    const specs = {
      'already-exists': {
        code: 'IDENTITY_ALREADY_EXISTS',
        identityVerified: true,
      },
      incomplete: {
        code: 'IDENTITY_INCOMPLETE',
        identityVerified: false,
      },
      corrupt: {
        code: 'IDENTITY_CORRUPT',
        identityVerified: false,
      },
      'durability-unconfirmed': {
        code: 'IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED',
        committed: true,
        identityVerified: true,
        durabilityConfirmed: false,
      },
      'committed-inconsistent': {
        code: 'IDENTITY_COMMITTED_INCONSISTENT',
        committed: true,
        identityVerified: false,
        durabilityConfirmed: false,
      },
      'write-failure': { code: 'ENOSPC' },
      'io-failure': { code: 'EIO' },
      'kdf-failure': { code: 'IDENTITY_KDF_FAILED' },
      'unrelated-eexist': { code: 'EEXIST' },
    };
    const spec = specs[mode];
    if (!spec) throw new Error(`mock-init-identity-failure: unknown mode ${mode}`);
    const err = new Error(`mock identity init failure (${mode})`);
    Object.assign(err, spec);
    throw err;
  };
}
