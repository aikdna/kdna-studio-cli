# Changelog

## v0.6.5 (2026-06-22)
- Fix: import detects and skips binary files

# Changelog

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
