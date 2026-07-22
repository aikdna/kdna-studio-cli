// Test fixture, loaded via `NODE_OPTIONS=--require` by tests/cli.test.js to
// simulate Studio Core initIdentity failure modes that cannot be triggered
// portably from the CLI test suite:
//
//   durability-unconfirmed  the identity was committed by the atomic publish
//                           but the post-commit durability confirmation failed
//                           (machine-readable code, forward-compatible with
//                           Studio Core's IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED)
//   write-failure           a raw write/space failure (ENOSPC) with no identity
//                           committed
//
// The hook patches the published @aikdna/kdna-studio-core module in the
// require cache before bin/kdna-studio.js loads it, so the CLI observes the
// injected failure exactly as it would observe the real one.

const mode = process.env.KDNA_TEST_INIT_FAILURE;

if (mode) {
  const core = require('@aikdna/kdna-studio-core');
  core.creator.initIdentity = () => {
    let err;
    if (mode === 'durability-unconfirmed') {
      err = new Error('EIO: input/output error, fsync');
      err.code = 'IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED';
    } else if (mode === 'write-failure') {
      err = new Error('ENOSPC: no space left on device, write');
      err.code = 'ENOSPC';
    } else {
      err = new Error(`mock-init-identity-failure: unknown mode ${mode}`);
    }
    throw err;
  };
}
