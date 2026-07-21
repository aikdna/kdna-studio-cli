# @aikdna/kdna-studio-cli

> **Status:** Pre-release authoring toolchain. This repository contains the
> unreleased `0.11.0` corrective candidate; the published incumbent remains
> `0.10.2`. Candidate behavior must not be described as already published.

Official Studio command-line entry for KDNA judgment asset creation — turns your notes, documents, works, and feedback into loadable `.kdna` files.

Two authoring paths: interview-first (articulate judgment directly) and distillation-first (provide content, find the patterns, review what belongs in scope).

Distillation-first authoring is domain-first: declare the target domain, owner scope, granularity, task scope, include areas, exclude areas, and load condition before extracting candidates. A single `.kdna` should stay scoped. Any future multi-asset use requires an explicit, separately admitted Host contract; it is not an implicit Studio export behavior.

This package provides the `kdna-studio` command. It creates Studio projects,
imports evidence, manages judgment cards, records optional review/provenance
signals, compiles project content, and exports canonical `.kdna`
assets with build reports.

It is intentionally separate from `@aikdna/kdna-cli`:

| Package | Command | Role |
| --- | --- | --- |
| `@aikdna/kdna-cli` | `kdna` | Runtime CLI: inspect, validate, plan-load, load, pack, and unpack `.kdna` assets |
| `@aikdna/kdna-studio-cli` | `kdna-studio` | Authoring CLI: create, review, compile, and export `.kdna` files |
| `@aikdna/kdna-studio-core` | none | Studio SDK/compiler kernel used by apps and this CLI |

## Install

```bash
npm install -g @aikdna/kdna-studio-cli@0.10.2
```

That command installs the published incumbent. To assess the unreleased
`0.11.0` candidate, use this source repository and its exact candidate
dependency coordinates; do not mix candidate documentation with npm `latest`.

## Usage

```bash
kdna-studio create my_domain --name @yourscope/my_domain
kdna-studio import my_domain ./notes.md
kdna-studio target declare my_domain \
  --category expression_writing \
  --scope personal \
  --granularity core_principles \
  --task "longform article review" \
  --include "argument structure,tone,revision" \
  --exclude "life habits,food preference"
kdna-studio source my_domain
kdna-studio distill my_domain --candidates candidates.json
kdna-studio candidate list my_domain
kdna-studio candidate accept my_domain <candidate-id>
kdna-studio candidate promote my_domain
kdna-studio card add my_domain axiom \
  --field one_sentence="Prefer specific evidence over broad claims" \
  --field full_statement="When reviewing content, prefer specific evidence over broad claims because unsupported generalizations make the judgment impossible to verify or improve." \
  --field why="Broad claims hide the actual reason for a judgment, so reviewers cannot tell whether the conclusion is evidence based, reusable, or merely plausible sounding." \
  --field applies_when='["reviewing content"]' \
  --field does_not_apply_when='["pure formatting"]' \
  --field failure_risk="generic advice" \
  --field confidence='high' \
  --field evidence_type='practice'
# Optional: record review provenance
kdna-studio card approve my_domain --all --by expert --statement "I confirm this judgment."
kdna-studio export my_domain --out dist/my_domain.kdna
```

Candidate promotion is scope-gated: only candidates with `status == accepted` and `scope_fit == true` are promoted to cards by default. Use `kdna-studio candidate override <project> <candidate-id>` only when a human intentionally overrides the scope gate.

The Studio CLI exports complete, non-deprecated cards. Human Lock and other
provenance records are optional review evidence, not creation permission or
format-validity requirements.

After export, use the runtime CLI:

```bash
kdna validate dist/my_domain.kdna --runtime
kdna plan-load dist/my_domain.kdna --json
kdna load dist/my_domain.kdna --profile=compact --as=prompt
```

`kdna-studio` is the CLI entry for Studio project authoring. `kdna` is the
runtime control plane for inspecting, validating, packing, unpacking, and
loading existing `.kdna` assets.

## 5-minute first asset

If you just installed and want to ship a KDNA asset without an LLM:

```bash
# 1. Create a project
kdna-studio create my_domain --name @yourscope/my_domain

# 2. Add at least one judgment card
kdna-studio card add my_domain axiom \
  --field one_sentence='specific evidence outranks broad claims' \
  --field full_statement='Always cite the specific source that supports a judgment; broad claims without evidence are the most common cause of bad agent advice.' \
  --field why='because vague advice fails in production' \
  --field applies_when='["reviewing"]' \
  --field does_not_apply_when='["formatting"]' \
  --field failure_risk='praise without diagnosis' \
  --field confidence='high' \
  --field evidence_type='practice'

# 3. Optional: approve and record Human Lock provenance
kdna-studio card approve my_domain --all --by me --statement "i confirm"

# 4. Export the asset
kdna-studio export my_domain --out my_domain.kdna

# 5. Verify with the runtime CLI
kdna load my_domain.kdna --profile=compact
```

The supported AI-assisted authoring commands are `distill --ai` and
`interview`. To configure their model provider:

```bash
printf '%s\n' "$KDNA_LLM_API_KEY" | \
  kdna-studio llm config --provider openai --model gpt-4 --key-pipe
# Provider/model/key environment variables can also configure a one-shot run.
```

Test Lab and Feynman workshop implementations remain in the source repository
for research and regression coverage. Published releases up to and including
0.10.2 shipped them as CLI commands in the npm tarball; the current
development line removes them from the default CLI and from the npm release
tarball, effective with the next release after 0.10.2. The public CLI
contract remains the create, review, compile, and export path shown above.

## Runtime Export Contract

`kdna-studio export` is the canonical runtime export path. It uses
`@aikdna/kdna-studio-core` to compile the Studio project into the current KDNA
runtime asset and then packs it with `@aikdna/kdna-core`.

A KDNA runtime export contains only these top-level entries:

- `mimetype`
- `kdna.json`
- `payload.kdnab`
- `checksums.json`

The current producer writes `format_version: 0.1.0`, payload profile
`kdna.payload.judgment` with `profile_version: 0.1.0`, and digest profile
`kdna.digest-basis.runtime-entry-set` with `digest_profile_version: 0.1.0`.
These compatibility coordinates are independent of package versions.

Authoring/source entries such as `KDNA_Core.json`, `KDNA_Patterns.json`, and
`source_cards` are not runtime distribution entries. They may exist in Studio
compile output or legacy imports, but they must not be emitted by the runtime
export path.

Being part of the official toolchain means this package is maintained by the
KDNA project. It does not make any specific asset endorsed or suitable for
every use case.

## Consumption sidecars

Studio can export route-card and consumer-index drafts for applications that
use the consumption runtime. These files are separate from the `.kdna` export
and are disabled by default. They are review inputs, not claims that an asset
is automatically suitable for a task or ready for a production runtime.

Use the KDNA CLI review and evaluation commands before an application enables
a sidecar entry.

## Identity

```bash
kdna-studio identity init --name "Your Name"
kdna-studio identity show
```

## Import from existing KDNA or legacy folders

```bash
# Fork an existing canonical .kdna asset (cards are imported as draft)
kdna-studio create forked --from-kdna ./parent.kdna --name @scope/forked

# Migrate a legacy JSON source folder
kdna-studio create migrated --from-folder ./old-domain-json --name @scope/migrated
```

Current `.kdna` imports also preserve explicitly declared `highest_question`,
`worldview`, ordered `value_order`, and `judgment_role` values in the editable
project. Re-export writes those values back exactly; Studio does not infer a
replacement judgment core from an axiom.

Imports preserve authored source references, `core_structure` relations,
pattern subtypes, scenario and case metadata, extended reasoning fields, and
source-authored evolution. Studio-only card state and lock audit records remain
authoring provenance and are not rewritten as Runtime judgment evolution.

## Related

- [KDNA Core](https://github.com/aikdna/kdna) — Official format specification
- [kdna-cli](https://github.com/aikdna/kdna-cli) — runtime CLI for inspect, validate, pack, unpack, and load
- [kdna-studio-core](https://github.com/aikdna/kdna-studio-core) — authoring SDK used by this CLI
- [kdna-studio-swift](https://github.com/aikdna/kdna-studio-swift) — native Swift counterpart
