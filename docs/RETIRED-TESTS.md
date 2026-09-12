# Retired test material (not part of the current verification surface)

The registry of retired material is `tests/retired.json` and the bytes themselves
live under `tests/legacy/`. None of it runs in `npm test`, `npm run test:all`,
`.github/workflows/ci.yml`, or `.github/workflows/publish.yml`.

These files exercise objects the committed graph no longer ships:

- the pre-component-semantics Studio CLI command surface (`project`, `card`,
  `identity`, `create-agent`, `answer`, `review`, `resume`, `export`, ...), which
  `bin/kdna-studio.js` replaced with the `session` / `verify` / `read` surface,
  and the retired creation-CLI implementation behind it;
- the retired CLI session harness protocol (`tests/legacy/pd275/session-harness.js`
  expects session events and material kinds that the current session protocol
  does not emit), together with the harness module the retired pd275 suites
  require;
- the retired runtime-candidate authority binding for the 3.0.0 / 0.21.0 graph,
  whose verifier now stops on `unbound file lock package:
  node_modules/@aikdna/kdna-read`.

The completeness suite that was once here is **not** retired: it was re-pointed
at the committed candidate fixture and moved back to
`tests/runtime-candidate-binding-completeness.test.js`, because the coverage it
carried (the binding rejects hostile lock graphs) still applies to the current
script.

## What a retirement has to register

A retirement is a **preservation** claim, not a story about a red run. Every
entry registers the retired path (`file`), the original path it was retired from
(`original_path`), the `sha256` of the preserved bytes, a free-text `reason`, the
registration date (`retired_on`) and the review that accepted it
(`review_reference`).

`scripts/verify-retirement-registry.js` reads **no test output**. Earlier
revisions tried to decide, from the judged artifact's own output, whether a run
failed *because* the retired object is gone. That is not decidable that way: a
failing test's title, a `console.log` the test itself prints, a stack frame
naming its own file, a diagnostic note a harness prints on import, and a
specifier the move rewrote can each be made to name any object at all, and each
was in turn accepted as proof. The gate now checks four things from files and
hashes:

- **(a) preserved** - the file at the registered path hashes to the registered
  `sha256`, so a retirement can never quietly delete or rewrite the bytes it
  claims to keep;
- **(b) complete** - every file under `tests/legacy/` is registered, including
  `pd275/session-harness.js`, so nothing can be dropped into the retired
  directory without a receipt;
- **(c) not a fake retirement** - the original path does not still carry the
  registered bytes, so the file really is out of the current surface rather than
  being registered while it keeps running;
- **(d) re-evaluable** - the registered bytes are put back at the original path
  and run. A passing run is printed as `KDNA-RETIREMENT-RESTORABLE: <file>`: the
  entry is not stale, so restore it or record why it stays retired. (d) is a
  receipt, never an acceptance condition; the exit code is about (a)-(c).

`pd275/session-harness.js` is a helper module rather than a test, so its (d)
receipt reports a pass because running a module with no test in it executes
nothing. Its reason records that; it stays retired with the suites that require
it.

`scripts/run-test-all.js` prints one `KDNA-CI-NOT-RUN:` receipt per registered
entry and fails the run if the registry does not hold. Re-activating an entry
starts by re-pointing the file at current objects and registering the move, not
by deleting the receipt.

The current verification surface lives in `tests/current-components/` and
`tests/current/` (driven by `npm test`) and the top-level `tests/*.test.js`
suites (driven by `npm run test:all`).
