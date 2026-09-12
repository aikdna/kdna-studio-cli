# Retired test material (not part of the current verification surface)

Everything below this directory is **retired**. None of it runs in `npm test`,
`npm run test:all`, `.github/workflows/ci.yml`, or `.github/workflows/publish.yml`.

These files are retained as historical material only. They exercise objects that
the committed graph no longer ships:

- the pre-component-semantics Studio CLI command surface (`project`, `card`,
  `identity`, `create-agent`, `answer`, `review`, `resume`, `export`, ...), which
  `bin/kdna-studio.js` replaced with the `session` / `verify` / `read` surface;
- the retired CLI session harness protocol (`tests/legacy/pd275/session-harness.js`
  expects session events and material kinds that the current session protocol
  does not emit).

The machine-readable retirement registry is `tests/retired.json`; the gate prints
one `KDNA-CI-NOT-RUN:` receipt line per registered entry. Any re-activation must
start by re-pointing these files at current objects, not by deleting the receipt.

Being red is not by itself a reason to be here. The gate only accepts an entry
while the red belongs to the retired object rather than to the move: (a) the
retired bytes are red when they are re-run from the path they were retired from,
where their relative requires still resolve, or (b) the failure output
explicitly names an object the entry declares absent. A file that is red only
because `git mv` broke its relative `require` satisfies neither and is refused.

The current verification surface lives in `tests/current-components/` (driven by
`npm test`) and `tests/current/dependency-binding.test.js`.
