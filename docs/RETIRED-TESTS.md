# Retired test material (not part of the current verification surface)

The registry of retired material is `tests/retired.json` and the bytes
themselves live under `tests/legacy/`. None of it runs in `npm test`,
`npm run test:all`, `.github/workflows/ci.yml`, or
`.github/workflows/publish.yml`.

**Every registered copy is the pre-retirement file, byte for byte.** Criterion
(e) below checks that against the object store, and it is the point of a
retirement: the repository keeps *that* test, not a version of it that was
adapted to its new home. Nothing under `tests/legacy/` is ever run, so a retired
copy does not need its relative requires, or the paths it resolves from
`__dirname`, to work from the new depth - and a retirement that rewrites them to
make the new location loadable is refused, because the bytes it preserved are
then no longer the bytes the original path carried. A file that would only fit
`tests/legacy/` after being adapted is not retired at all.

Nine files are registered:

- `tests/legacy/cli.test.js`
- `tests/legacy/creation-agent-cli.test.js`
- `tests/legacy/current/shared-evidence.test.js`
- `tests/legacy/e2e-export-completeness.test.js`
- `tests/legacy/pd275/session-harness.js` (the helper module the pd275 suites
  require as `./session-harness`)
- `tests/legacy/pd275/session-termination.test.js`
- `tests/legacy/pd275/terminal.test.js`
- `tests/legacy/protocol-producer.test.js`
- `tests/legacy/public-package-surface.test.js`

They exercise objects the committed graph no longer ships: the
pre-component-semantics Studio CLI command surface (`project`, `card`,
`identity`, `create-agent`, `answer`, `review`, `resume`, `export`, ...) that
`bin/kdna-studio.js` replaced with the `session` / `verify` / `read` surface, the
retired creation-CLI implementation behind it, the retired CLI session harness
protocol, the retired protocol producer transport, and the retired
runtime-candidate authority binding for the 3.0.0 / 0.21.0 graph (whose verifier
now stops on `unbound file lock package: node_modules/@aikdna/kdna-read`). They
are therefore red against the committed graph. That redness is the reason the
retirement exists; the gate records it as an observation and never reads it -
see the delivery report's section on why these suites are red, which is an
observation rather than a verdict.

`pd275/session-harness.js` is a helper module rather than a test, so its (d)
receipt reports a pass because running a module with no test in it executes
nothing. Its reason records that; it stays retired with the suites that require
it.

The completeness suite that was once here is **not** retired: it was re-pointed
at the committed candidate fixture and moved back to
`tests/runtime-candidate-binding-completeness.test.js`, because the coverage it
carried (the binding rejects hostile lock graphs) still applies to the current
script.

## What a retirement has to register

A retirement is a **preservation** claim, not a story about a red run. Every
entry registers the retired path (`file`), the original path it was retired from
(`original_path`), the `sha256` of the preserved bytes (the retirement's
`retired_sha256`), the commit those bytes are claimed to come from
(`retired_from_commit`), a free-text `reason`, the registration date
(`retired_on`) and the review that accepted it (`review_reference`).

`scripts/verify-retirement-registry.js` reads **no test output**. Earlier
revisions tried to decide, from the judged artifact's own output, whether a run
failed *because* the retired object is gone. That is not decidable that way: a
failing test's title, a `console.log` the test itself prints, a stack frame
naming its own file, a diagnostic note a harness prints on import, and a
specifier the move rewrote can each be made to name any object at all, and each
was in turn accepted as proof. The gate checks five things from files, hashes and
the object store:

- **(a) preserved** - the file at the registered path hashes to the registered
  `sha256`, so a retirement can never quietly delete or rewrite the bytes it
  claims to keep;
- **(b) complete** - every file under `tests/legacy/` is registered, so nothing
  can be dropped into the retired directory without a receipt;
- **(c) not a fake retirement** - the original path does not still carry the
  registered bytes, so the file really is out of the current surface rather than
  being registered while it keeps running;
- **(d) re-evaluable** - the registered bytes are put back at the original path
  and run. A passing run is printed as `KDNA-RETIREMENT-RESTORABLE: <file>`: the
  entry is not stale, so restore it or record why it stays retired. (d) is a
  receipt, never an acceptance condition;
- **(e) zero rewrite** - the copy under `tests/legacy/` has to be the file that
  was at the original path, byte for byte. *Which* commit that means is pinned by
  the gate rather than trusted to the entry: the retirement commit is derived
  from history as the newest commit that removes the file from its original
  location (`--no-renames --diff-filter=D`) **while its parent carries exactly
  the registered bytes**, and `retired_from_commit` has to be that commit's
  parent verbatim - so a commit cannot be picked by hand, older or newer, to make
  rewritten bytes look original. The registered `sha256` must equal the `sha256`
  of that parent's blob at `original_path`, read out of the object store (`git
  rev-parse <commit>:<path>`, `git cat-file blob`, sha256 of those bytes) rather
  than out of the working tree, so neither editing the copy under `tests/legacy/`
  nor rewriting it while moving it can make the claim true. The named commit must
  also be one in which the file was **not written**: a rewrite in the commit
  immediately before the move ("rewrite one byte, then move it") is refused,
  because the bytes a retirement would preserve were written while the file was
  still a current test. An entry that fails (e) is refused, and the disposition
  is to put the pre-retirement bytes back under `tests/legacy/`; a file that
  would only retire after being adapted is not retired at all.

The last clause is as far as history goes. A write that is separated from the
move by another commit cannot be told apart from a file that was legitimately
edited earlier and retired later, so the gate does not pretend to; it prints the
derived retirement commit and its parent in the receipt, which makes the write
that produced the preserved bytes visible for review.

The exit code is about (a)-(c) and (e). (e) reads git history, so the checkout
that runs the gate has to carry it: `.github/workflows/ci.yml` fetches the full
history (`fetch-depth: 0`) rather than the default shallow clone.

`scripts/run-test-all.js` prints one `KDNA-CI-NOT-RUN:` receipt per registered
entry and fails the run if the registry does not hold. Re-activating an entry
starts by re-pointing the file at current objects and registering the move, not
by deleting the receipt.

The current verification surface lives in `tests/current-components/` and
`tests/current/` (driven by `npm test`) and the top-level `tests/*.test.js`
suites (driven by `npm run test:all`).
