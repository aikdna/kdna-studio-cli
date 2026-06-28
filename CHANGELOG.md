# Changelog

## v0.8.7 (2026-06-28)

Phase 12 audit follow-up — closes the residual halves of #62
and a follow-on aesthetic round-trip gap. Bumps
`@aikdna/kdna-studio-core` to `^1.7.6` (which carries the
matching #145 fix on the export side).

- **#62** (residual) `cmdFeynman` no longer `fail()`s when the
  card has no `feynmann_restatement`. The command now hands the
  card off to the evaluator (which auto-synthesises a restatement
  from the card's own text via `synthFeynmanRestatement` in
  feynman.js) and surfaces the synthesised text in a warning.
  A caller without a configured LLM gets a structured result
  instead of a hard exit.
- **#145** (residual) `cardsFromV1Payload` now reads
  `failure_risk` / `applies_when` / `does_not_apply_when`
  off the imported `failure_modes` entry, so a Studio project
  that round-trips a misunderstanding card through
  `migrate --format v1` and a later `create --from-kdna` keeps
  all three fields.
- **#55 (aesthetic round-trip)** `importFromFolder` now imports
  `patterns.aesthetics`. Prior version dropped the field; the
  parallel `cardsFromV1Payload` and `cardsFromLegacyPayload`
  paths both read it, so a domain that authored aesthetic
  cards in the `KDNA_Patterns.json` shape would lose them
  on `create --from-folder`.

## v0.8.6 (2026-06-28)

Phase 12 audit follow-up. Closes 7 issues filed against this
repo (#62, #63, #64, #65, #66, #67, #68, #69 — note: #66 is
closed in kdna-studio-core 1.7.5; the comment fix in this CLI
is the consumer-side part of the same fix). Bumps
`@aikdna/kdna-studio-core` to `^1.7.5`.

- **#62** `feynman` no longer fails on every card. When the card
  has no `feynmann_restatement`, the LLM evaluator now synthesises
  one from the card's own `one_sentence` / `full_statement` and
  returns a score with structured suggestions. Combined with the
  fixed error message, the command now works end-to-end without
  pre-step.
- **#63** `cardsFromLegacyPayload` now imports `stance` and
  `framework` cards in addition to the 7 it already handled.
- **#64** All 49 `for (const x of (EXPR || []))` loops now guard
  with `Array.isArray(EXPR) ? EXPR : []`. A truthy non-array
  (e.g. an object) no longer crashes with "object is not iterable".
- **#65** `mkdtempSync` calls now go through a `trackTempDir()`
  helper. The process registers a single `process.on('exit')`
  (plus SIGINT/SIGTERM) handler that removes every tracked
  directory. `process.exit()` from `fail()` no longer leaks
  `/tmp/kdna-migrate-*` or `/tmp/kdna-v1-*`.
- **#66** (Comment update + consumer fix.) The command source
  classify now reads `project.evidence_materials || project.evidence`
  and the comment is updated to reflect the canonical field name.
  The actual write is fixed in kdna-studio-core 1.7.5.
- **#67** `importFromKdna`'s legacy fallback (no `payload.kdnab`)
  now reads `KDNA_Core.json`, `KDNA_Patterns.json`,
  `KDNA_Scenarios.json`, `KDNA_Cases.json`, `KDNA_Reasoning.json`,
  and `KDNA_Evolution.json` and imports every card type they
  carry. Prior version read only 5 of the 14 types and dropped
  9 silently.
- **#68** `feynmann` error message no longer points at the
  non-existent "feynman authoring command"; it points at the
  working `card update --field feynman_restatement='<json>'`
  path.
- **#69** The source classify comment no longer reverses the
  evidence / evidence_materials canonical/legacy relationship.

## v0.8.5 (2026-06-28)

Phase 11 audit follow-up. Closes 5 issues filed against the
kdna-studio-cli repo (#57, #58, #59, #60, #61).

- **#57** Documented why `cardsFromV1Payload` (raw object pass-through)
  and `cardsFromLegacyPayload` (explicit field construction) are
  intentionally asymmetric. The v1 producer normalises every card's
  fields into a canonical shape, so the v1 importer does not have
  to re-construct; the legacy importer has to handle the loose
  field shapes that the legacy source format allowed.
- **#58** `buildV1Manifest` now delegates its core field shape
  to kdna-studio-core's `buildManifest`. The two manifest
  construction paths now share a single source of truth for the
  fields they produce.
- **#59** The `migrate` usage line and the `cmdMigrate` error
  message now advertise `--sign` and `--passphrase-stdin` (the
  code already accepted them; the help text did not).
- **#60** `importFromKdna` now extracts the source's
  `KDNA_Patterns.json` / `KDNA_Reasoning.json` /
  `KDNA_Evolution.json` entries and stores them as
  `project.source_patterns` / `project.source_reasoning` /
  `project.source_evolution`. The next export forwards them to
  `compileDomain` so `evolution.changelog` / `version_notes` /
  reasoning_chains round-trip through the v1 export path.

## v0.8.4 (2026-06-28)

Phase 10 audit follow-up. Closes 7 issues filed against the
kdna-studio-cli repo (#49-#55) plus the 17th (P2 #56) that tracks
doc/help-text drift as a class of bugs.

- **#49 \`feynman.js\` reads the canonical \`feynman_restatement\` field.**
  Prior version read \`card.feynman_text\` (a field nothing in the
  codebase ever wrote) and flattened \`card.one_sentence\` / \`card.full_statement\`
  — both fields actually live under \`card.fields\`. The AI evaluator
  always received an empty restatement and a blank axiom.
- **#50 \`cmdTest\` now calls \`ai.testlab.testPreset\`** for the
  non-baseline presets. The exported \`testPreset\` function was dead
  code, and the help text advertised names (\`baseline\` / \`edge\` /
  \`contradiction\`) that did not match the actual preset keys in
  testlab.js (\`baseline\` / \`edge_case\` / \`contradiction\`). \`--preset edge\`
  silently ran the contradiction branch before this fix.
- **#51 \`importFile\` now closes the file descriptor on every exit
  path.** Prior version closed the fd only on success; a single
  readSync failure under a 300-file bulk import leaked an fd and could
  exhaust the per-process limit.
- **#53 \`for...of\` over \`self_check\` arrays now guards with
  \`Array.isArray\`.** A truthy non-array field (e.g. a single
  \`{question: ...}\` object) would crash with "object is not iterable".
- **#54 \`--allow-incomplete\` now actually bypasses the critical
  axiom-field check.** Prior version read the flag *after* the
  check, so the check always rejected the run before bypass could
  take effect. The flag is now read up front; when present the
  critical-missing check is downgraded to a warning.
- **#55 v1 export encryption password now resolves from
  \`KDNA_PASSPHRASE\` / \`KDNA_PASSWORD\` env vars**, matching the
  signing path. Prior version only consulted the inline flag, so a
  caller who set \`KDNA_PASSPHRASE\` for signing found the v1
  encryption silently null.

## v0.8.3 (2026-06-28)

This release closes 16 issues filed against the v0.8.x line (issues #36
through #48, plus one follow-up surfaced by an internal round-trip
review on the same day). Bumps `@aikdna/kdna-studio-core` from `^1.7.1`
to `^1.7.2`; that release ships the matching `lockCard` schema gate,
`buildPayload` completeness fix, and the `JUDGMENT_CARD_TYPES_FOR_COMPILE`
unification that this CLI's `migrate` / `export --format v1` paths
relied on. Without the dep bump, the fixes below would only run when
the CLI happened to load the dev src/ tree, not the published
artifact.

### Fixed (CLI surface)

- **#36 risk_model "object is not iterable"** — `cardsFromV1Payload` and
  the `importFromFolder` risk loop now accept `risk_model` as either an
  array or `{risks: [...]}` instead of blindly doing `arr.risks || []`.
- **#37 non-standard filenames** — `importFromFolder` now fails fast
  with a directory listing when none of the expected KDNA_* files are
  present, instead of silently importing nothing.
- **#38 `create --from-kdna` dropping 8+ card types** — `importFromKdna`
  now prefers `payload.kdnab` (v1) over the legacy KDNA_Core.json /
  KDNA_Patterns.json split, so boundary / risk / aesthetic / ontology /
  scenario / case / reasoning / evolution_stage / stance / framework /
  term / banned_term cards round-trip from a v1 asset. Legacy split
  files are still honoured as a fallback.
- **#39 candidate promote empty axiom** — `candidate promote` now writes
  a non-empty placeholder into `full_statement` / `why` / `failure_risk`
  and empty arrays (not empty strings) into `applies_when` /
  `does_not_apply_when` so the migrate Human Lock gate stops rejecting
  every promoted candidate.
- **#40 feynman command reading the wrong field** — the `feynman` check
  now reads `card.feynman_restatement` (the field the system actually
  writes) instead of `card.feynman_text` (which nothing ever wrote).
- **#42 evidence vs evidence_materials mismatch** — `source classify`
  now reads `project.evidence_materials` (the field the `import`
  command writes), falling back to `project.evidence` for legacy data.
- **#43 reasoning_chains round-trip** — `importFromFolder` now writes
  the field names that `compileReasoning` actually reads
  (`axiom` / `chain` / `principle` / `concrete_action`) so reasoning
  chains survive a `migrate --format v1` round-trip instead of being
  silently rewritten as fallback axiom-derived chains.
- **#44 protect help text + recover fallback** — `kdna-cli` `protect`
  help text and the `recover` fallback now reference `payload.kdnab`
  (the canonical encryption target) instead of the obsolete
  `KDNA_Core.json`. (The fix lives in `kdna-cli`; this release keeps
  the cross-repo behaviour consistent.)
- **#45 `--password-stdin` TTY hang** — both the `export --format v1`
  path and the help text now refuse up front on a TTY instead of
  waiting forever for stdin.
- **#46 `migrate` tmpDir leak on non-v1 failure** — `cmdMigrate` is
  wrapped in `try { ... } finally { ... }` so a mid-migrate failure
  (missing critical axiom fields, gate block, signing error) cleans
  up `/tmp/kdna-migrate-*` instead of leaking it.
- **#47 passphrase in `ps aux`** — new `resolvePassphrase` helper
  accepts `--passphrase-stdin` and `KDNA_PASSPHRASE` env var. The
  legacy `--passphrase <value>` form is kept for backward compatibility
  but prints a warning at runtime.
- **#48 manifestForSigning mismatch** — `manifestForSigning` now strips
  `_source` and recursively strips `authoring.content_digest` so the
  signing payload matches `kdna-core#manifestForSignature` /
  `manifestForDigest`. Prevents false-positive signature rejections.

### Tests
- `tests/cli.test.js` updated to read `reasoning.self_check` (singular,
  matches the canonical schema) instead of `self_checks` (legacy
  schema).

## v0.8.2 (2026-06-27)

### Changed
- Bump `@aikdna/kdna-studio-core` dep floor from `^1.7.0` to `^1.7.1`. The
  1.7.1 release ships the PC-3 fix (`exportRuntimeAsset` no longer
  injects the legacy placeholder into `core.highest_question` when
  the author has not set `load_condition`); without the dep bump, the
  v0.8.1 CLI keeps resolving the bundled 1.7.0 nested copy and the
  fix never reaches consumers.

## v0.8.1 (2026-06-27)

### Fixed
- **BUG-11: `kdna-studio export --password-stdin` was a no-op when used alone.** The previous parser required `--password <value>` to be set before `--password-stdin` would take effect, so callers using the recommended `--password-stdin` path got `password = null` and the export ran unencrypted (the B2 scrypt envelope was bypassed). The parser now resolves the two flags independently: `--password-stdin` alone reads from stdin; `--password <pw>` is the (insecure) inline form; `--passphrase <pw>` is a legacy alias. If both are present, `--password-stdin` wins (explicit intent). Also: `--password-stdin` is now detected via `args.includes()` rather than `option()` so the boolean flag is not rejected with `Missing value for --password-stdin`.

## v0.8.0 (2026-06-27)
- B2: `--password` now performs real scrypt-based encryption (no longer stub)
  - Removes fail-early stub; wires password to `exportRuntime.exportRuntimeAsset`
  - E2E test: 8-step round-trip (export → planLoad → load → wrong-pw fail-closed)
- Deps: bump @aikdna/kdna-studio-core to ^1.7.0, @aikdna/kdna-core to ^0.15.0

## v0.7.0 (2026-06-26)

### Features
- Feat: binary evidence import.
- Feat: one_sentence warning.

### Security (PR #27)
- **Fix: SECURITY.md — remove incorrect crypto claims.** kdna-studio-cli is a CLI
  authoring tool; it does NOT implement crypto primitives. The previous SECURITY.md
  claimed Ed25519 signatures / AES-256-GCM / Argon2id which were not implemented
  in this package. Replaced with accurate description pointing to `aikdna/kdna-core`
  and `aikdna/kdna-cli` as the real security dependencies.

### Security (CQ-S1, CQ-S2, CQ-T4 — commits 59aafc3, b7ecd08)
- **Fix (P0): API key handling — `bin/kdna-studio.js` `resolveApiKey()`** with priority
  `KDNA_API_KEY` env var → `--key-pipe` stdin → deprecated `--key` flag (with warning).
  Previously, `--key` was the only option and exposed secrets in shell history + `ps`.
- **Fix (P0): provider key isolation — `src/llm/config.js` `PROVIDER_NATIVE_KEYS`** table
  with strict per-provider env var mapping. Previously, `config.js:49` had
  cross-provider fallback (`OPENAI_API_KEY || ANTHROPIC_API_KEY || DEEPSEEK_API_KEY`)
  which leaked keys across providers.
- **Fix: empty catch blocks gain diagnostic logging** in `src/llm/config.js` and
  `bin/kdna-studio.js`. Previously, all 5 empty catch blocks silently swallowed errors.

### Quality (PR #26)
- **Fix: NP-3 tarball — `package.json` `files` excludes `tests/`.** Previously, the
  npm tarball shipped test files.
- **Fix (P0): `importFromKdna` size limit** — 50 MiB cap via `fs.statSync` before
  `readFileSync`. Prevents OOM on large .kdna files.
- **Fix: `cmdDistill` size limit** — same 50 MiB cap.
- **Fix: `cmdImport` streaming** — `fs.readSync(fd, buf, 0, 120000, 0)` instead of
  full `readFileSync`. Prevents OOM on large source files.

### Security (PR #28)
- **Fix: public-surface guardrail config real SHA-256 hashes.** Replaced 5 placeholder
  hashes in `scripts/public-surface.config.json` with 7 real SHA-256 hashes (for
  `aikdna/kdna-{x,lab,registry,releases,writing,prompt_diagnosis,agent_safety}`).
  Previously, the guardrail silently passed for any input because no forbidden pattern
  hash matched.

## v0.6.5 (2026-06-22)
- Fix: import detects and skips binary files
## v0.6.4 (2026-06-22)

### Fixed
- Pattern export: compilePatterns() in studio-core 1.5.11 maps pattern cards to payload.
- Depends on `@aikdna/kdna-studio-core ^1.5.11`.

---

## v0.6.3 (2026-06-22)

### Added
- Pattern to valid card types (CARD_TYPES in studio-core 1.5.10).

---

## v0.6.2 (2026-06-22)

### Added
- Pattern card type (`pattern`) for reusable judgment pattern cards.

### Fixed
- Export data loss: stances were hardcoded to empty array during compile, now correctly extracted from locked stance cards.
- Per-type field requirements now enforced for all 9 card types during card operations.

---

## v0.6.1 (2026-06-21)

### Added
- Per-type required field validation for all card types (not just axiom).

### Fixed
- `card approve --all` help text and error messages now visible in default CLI usage output. Previously the `--all` flag worked but was undocumented in the first-run help surface.

### Changed
- Dependency synced to `@aikdna/kdna-studio-core@^1.5.8`.

---

## v0.6.0 (2026-06-21)

### Added
- **v1 `.kdna` export path.** `kdna-studio export <project> --out <file.kdna> --format v1` produces a Core v1 container (`application/vnd.kdna.asset`) through the deterministic `@aikdna/kdna-core` packer. The export validates all gates (Human Lock, schema, checksums) and writes a single `.kdna` file ready for `kdna load`.
- **`--allow-incomplete` flag on export.** Permits v1 export even when Human Lock has uncovered gaps. Intended for development iteration; production exports should not use this flag.
- **AI distillation pipeline.** A full distillation workflow for extracting judgment candidates from evidence materials:
  - `target declare` — declare a distillation target with domain category, scope, granularity, and task scope. Accepts `--include`, `--exclude`, and `--load-condition` for scope gating.
  - `source classify` — classify imported evidence by relevance against the declared target.
  - `distill --ai` — run AI-powered distillation to extract axiom, boundary, misunderstanding, and self-check candidates.
  - `distill --candidates <file.json>` — import candidates from a JSON file for manual review.
  - `candidate list|accept|reject|override|promote` — review cycle for distillation output. `promote` converts accepted candidates into Studio cards.
- **`target show`** — display the current distillation target for a project.
- **Feynman restatement evaluation.** `kdna-studio feynman <project> <card-id>` evaluates a card's Human Lock statement against the Feynman clarity criteria (scored 0–5, threshold 4/5 for publishability). Reports per-criterion pass/fail and suggestions.
- **Interview workflow.** `kdna-studio interview <project> [--stage distill|clarify|correct|replay]` runs structured AI interviews to refine judgment content.
- **Test lab.** `kdna-studio test <project> --input "<text>" [--preset baseline|edge|contradiction]` runs adversarial testing against the domain's judgment logic.
- **LLM configuration.** `kdna-studio llm config --provider <name> [--model <name>] [--key <api-key>] [--url <base-url>]` and `kdna-studio llm show` for managing the AI provider used by distillation, interview, feynman, and test commands.
- **Creator identity management.** `kdna-studio identity init --name "Your Name" [--passphrase <phrase>]` generates Ed25519 keypair. `kdna-studio identity show` displays current identity. Keys support optional passphrase encryption.
- **Sensitive content filter.** `kdna-studio filter <project>` scans imported evidence for PII, credentials, tokens, and other sensitive patterns. Warnings are also emitted during `import`.
- **Card strict template.** `kdna-studio card add <project> axiom --template axiom-strict` populates all required axiom fields with `<TBD: field>` placeholders for partial cards.
- **Card required-field validation.** `card add` now checks that all required fields for the card type are populated. Use `--no-strict` to bypass for draft cards.
- **Batch card approval.** `kdna-studio card approve <project> --all --by <id> --statement <text>` locks all unlocked cards in a single operation.

### Changed
- **`kdna-studio migrate` now requires axiom governance fields.** Migration rejects source directories where any axiom card is missing `applies_when`, `does_not_apply_when`, or `failure_risk`. These fields are required for domain routing by `kdna-loader`. The error message lists missing cards and instructs the author to add them in the source files first.
- **`kdna-studio migrate --format v1`** uses the canonical `exportRuntimeAsset` + `core.pack` path, producing a validated `.kdna` container. The old v2 compile path is only used when `--format v1` is not specified.
- `kdna-studio export` (without `--format v1`) recomputes `content_digest` after adding `README.md`, `LICENSE`, and `mimetype`, so the manifest, receipt, and provenance report all agree with the final ZIP contents.
- Export writes companion files (`build-receipt.json`, `kdna.json`, `provenance-report.json`, `quality-gate-report.json`, `human-lock-report.json`, `eval-report.json`) alongside the `.kdna` output for traceability.
- `kdna-studio migrate` no longer compiles v2 output when `--format v1` is specified. v1 export happens before the compile gate.
- `card approve` now accepts `--sign` for cryptographic Human Lock signing and `--passphrase` for encrypted private keys.
- `card unlock` records an audit trail entry with `by`, `statement`, and timestamp.
- Help surface removed references to "trusted", "registry-published", and v2-only concepts in favor of the v1 `.kdna` file model.

### Fixed
- UUID v7 generation for asset IDs now uses a correct timestamp-ordered implementation.
- v1 export path ordering resolved: `absOut` is computed before the compile gate so the output file path is correct.
- Missing `src/` directory in npm package (v0.3.1 regression) — the full `src/ai/` and `src/llm/` trees are included.
- `@aikdna/kdna-core` added as a direct dependency for v1 export (was only a devDependency).

### Removed
- Legacy v2 `--sign` export path removed from the default help surface. v1 `.kdna` export with Human Lock signing is the canonical release path.

---

## v0.5.9 (2026-06-21)

### Changed
- Expose `card approve --all` in CLI help.

## v0.5.8 (2026-06-21)

### Changed
- Studio CLI contribution model aligned with the v1 `.kdna` file model.
- Core dependency synced to latest.

## v0.5.7 (2026-06-20)

### Removed
- Legacy v2 `--sign` export from the default help surface so first-run Studio users see the v1 `.kdna` export path.

## v0.5.6 (2026-06-20)

### Changed
- Clarify that Studio approval/Human Lock is release evidence for the Studio workflow, not a KDNA Core v1 format-validity requirement.
- Remove outdated `kdna-studio lock` and trusted/publish-oriented wording from the public README.

---

## v0.5.0 (2026-06-18)

### Added
- `kdna-studio migrate --format v1` for v1 container export.
- v1 export path stable: projects are packed into `.kdna` containers via `@aikdna/kdna-core`.

### Fixed
- UUID v7 generation, absolute output path resolution, and v1 entry ordering in export.
- v1 export now runs before the v2 compile gate; `--format v1` skips v2 compile.

## v0.4.1 (2026-06-18)

### Fixed
- `@aikdna/kdna-core` added as direct dependency for v1 export path.

## v0.3.3 (2026-06-18)

### Changed
- Package description updated to remove "trusted .kdna" language.

## v0.3.1 (2026-06-17)

### Fixed
- Missing `src/` directory in published npm package.

## v0.3.0 (2026-06-17)

### Added
- AI authoring features: sensitive content filter and multi-format evidence import.
- Dependency on `@aikdna/kdna-studio-core@^1.5.0`.
- `kdna-studio import <project> <source-file-or-dir>` for evidence ingestion.
- `kdna-studio create <name>` for domain project scaffolding.
