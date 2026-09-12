# Retired test material (not part of the current verification surface)

The registry of retired material is `tests/retired.json` and the bytes
themselves live under `tests/legacy/`. None of it runs in `npm test`,
`npm run test:all`, `.github/workflows/ci.yml`, or
`.github/workflows/publish.yml`.

**Every copy registered here is the pre-retirement file, byte for byte.** The
eight that had been rewritten on the way into `tests/legacy/` - relative
requires, `__dirname` paths and the path to `bin/kdna-studio.js` re-pointed to
the new depth - were restored to the bytes their original paths carried, and
criterion (e) below records, for every entry, the complete diff the move itself
had produced, so that content change is on the record instead of inside a hash.
Nothing under `tests/legacy/` is ever run, so a retired copy never needs its
relative requires to resolve from the new depth: adapting a copy for its new home
is a content change the gate prints and an independent reviewer has to sign, not
something the gate can rule out by itself.

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
- **(e) re-checkable** - the copy under `tests/legacy/` hashes to the registered
  `sha256`, so the registered bytes cannot be deleted or edited without the gate
  going red; and `retired_from_commit` is the commit the file was retired from.
  The gate checks that the named commit's tree really carries the file at
  `original_path` (and that HEAD reaches it), and it derives the move as the
  commit whose parent that is (`--no-renames --diff-filter=D`).

  This is the whole of what a machine can prove about a retirement. It cannot
  prove that nobody wrote the file before the move: a rewrite in a commit of its
  own followed by a "pure" move is indistinguishable from a file that was edited
  long before it was retired, and no history-only rule can tell the two apart.
  The gate does not claim to. It **exposes** it instead: for every entry it
  prints the complete diff of the file between `retired_from_commit` and the move
  commit - and the diff of the named commit's own write, when that commit wrote
  the file - counts the differing lines, and names the entries whose diff is not
  empty and whose `review_signature` does not cover it. Those entries are
  **unsigned**: an independent reviewer has to sign each one `no-content-change`,
  or `change-explained` with a `review_note` holding the reason, before the entry
  may enter a push batch. A gate that is green is not a claim that nothing was
  written; it is a claim that everything written is on the record and attributed.

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
