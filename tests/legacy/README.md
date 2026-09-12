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

The current verification surface lives in `tests/current-components/` (driven by
`npm test`) and `tests/current/dependency-binding.test.js`.
