# Retired test material (not part of the current verification surface)

The registry of retired material is `tests/retired.json` and the bytes
themselves live under `tests/legacy/`. None of it runs in `npm test`,
`npm run test:all`, `.github/workflows/ci.yml`, or
`.github/workflows/publish.yml`.

**The registry preserves the reviewed bytes and discloses earlier changes.** The
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
- `tests/legacy/numeric-fidelity/session-harness.js` (the helper module the retired numeric-fidelity suites
  require as `./session-harness`)
- `tests/legacy/numeric-fidelity/session-termination.test.js`
- `tests/legacy/numeric-fidelity/terminal.test.js`
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

`numeric-fidelity/session-harness.js` is a helper module rather than a test, so its (d)
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
entry registers the retired path (`file`), the SHA256 of its exact original Git
path bytes (`original_path_sha256`), the `sha256` of the preserved bytes (the retirement's
`retired_sha256`), the commit those bytes are claimed to come from
(`retired_from_commit`), a free-text `reason`, the registration date
(`retired_on`) and the review that accepted it (`review_reference`).

Registry schema `4.0.0` resolves `original_path_sha256` by hashing the raw path
bytes in the NUL-delimited Git tree at `retired_from_commit`. Exactly one
regular file under `tests/` must match. The resolved path, including its original
spelling, is then used for every historical blob, last-appearance, duplicate and
in-place replay check. This changes the registry representation, not history:
no neutral alias is substituted for a historical pathname. Literal
`original_path` fields, malformed digests, missing matches and unsafe paths are
rejected. Neither an equal basename nor an equal file-content digest can serve
as a substitute.

The session helper and session termination copies were previously changed only
to neutralize their synthetic labels; the registry keeps their reviewed hashes
and the existing per-entry explanation of those changes. This representation
migration does not change any preserved file bytes or add an acceptance claim.

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
- **(e) re-checkable** - two things, both machine-checkable, and nothing more.
  First, the copy under `tests/legacy/` hashes to the registered `sha256`, so the
  registered bytes cannot be deleted or edited. Second, `retired_from_commit` is
  the commit the file was retired from: the gate computes `C_last`, the newest
  commit on HEAD whose tree still carries the file at the resolved original path, and
  refuses any entry that names a different one - so a retirement cannot be
  anchored at an older retirement that a later one superseded - and the named
  commit has to be reachable from HEAD.

  That is the whole of what a machine can prove. It cannot prove that nobody wrote
  the file before the move, and no history-only rule can: a rewrite in a commit of
  its own followed by a "pure" move is indistinguishable from a file that was
  edited long before it was retired. The gate does not judge that; it prints it:

  - `KDNA-RETIREMENT-DIFF` - the first retirement changed the content while moving
    the file, with the complete diff;
  - `KDNA-RETIREMENT-PRIOR-WRITE` - the commit the entry names wrote the file at
    the original path itself, with the complete diff;
  - `KDNA-RETIREMENT-WINDOW` - every later commit in the retirement window (from
    the first retirement to HEAD) that modified or removed the retired copy, and
    `content_changed_in_window` counts them, the retirement's own rewrite
    included.

  A non-zero window, or a prior write, needs the reviewer's per-entry signature:
  `review_signature` is `no-content-change`, or `change-explained` with a
  `review_note` holding the reason. Entries that still lack one are printed as
  `KDNA-RETIREMENT-UNSIGNED` and may not enter a push batch. **Shape five -
  "rewrite one byte, then move the file" - is rc=0 with the change exposed and
  unsigned, never a red gate.** The refusal shapes are the other ones: a deleted
  registered file, a byte edited in the registered copy, an unregistered file
  under `tests/legacy/`, a `retired_from_commit` that is not `C_last`, and one
  that HEAD cannot reach.

  An entry whose bytes cannot be run where they used to live records that
  explicitly: `reeval_in_place: "not-possible"` with a `reeval_note` holding the
  reason, and the gate prints `KDNA-RETIREMENT-REEVAL-NOTE` instead of reporting a
  run it cannot make. `tests/legacy/numeric-fidelity/terminal.test.js` is such an entry: the
  helper it requires is retired material too, so the original path does not exist.

The exit code is about (a)-(c) and (e). (e) reads git history, so the checkout
that runs the gate has to carry it: `.github/workflows/ci.yml` fetches the full
history (`fetch-depth: 0`) rather than the default shallow clone.

Install with `npm ci --omit=optional`, which is what `.github/workflows/ci.yml`
and the README use. The component runtime deliberately requires the optional
native addon `cbor-extract` to be absent - a bare `npm ci` installs it and
`npm test` then fails with `CLI_OPTIONAL_DEPENDENCY_UNBOUND`. That is a design
assertion, not a cache property: a warm npm cache with `--omit=optional` is as
green as an empty one, and neither the gate nor the test run depends on the cache
being cold.

**This gate's green is stated against `npm ci --omit=optional`**, the install
that `ci.yml` and the README use, and against the absence of the optional native
addon `cbor-extract`, which is a design assertion
(`CLI_OPTIONAL_DEPENDENCY_UNBOUND` here, `CREATION_OPTIONAL_DEPENDENCY_UNBOUND` in
the core) rather than a defect. An empty npm cache is the discipline for judging
whether `npm ci` really installed from the committed bytes; it does not apply to
stating this gate's green, and it is not a condition of it.

`scripts/run-test-all.js` prints one `KDNA-CI-NOT-RUN:` receipt per registered
entry and fails the run if the registry does not hold. Re-activating an entry
starts by re-pointing the file at current objects and registering the move, not
by deleting the receipt.

The current verification surface lives in `tests/current-components/` and
`tests/current/` (driven by `npm test`) and the top-level `tests/*.test.js`
suites (driven by `npm run test:all`).
