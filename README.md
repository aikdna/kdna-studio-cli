# @aikdna/kdna-studio-cli

Official Studio command-line entry for KDNA judgment asset creation — turns your notes, documents, works, and feedback into loadable `.kdna` files.

Two authoring paths: interview-first (articulate judgment directly) and distillation-first (provide content, find the patterns, review what belongs in scope).

Distillation-first authoring is domain-first: declare the target domain, owner scope, granularity, task scope, include areas, exclude areas, and load condition before extracting candidates. A single `.kdna` should stay scoped; complex work should compose multiple domain assets through a KDNA Cluster.

This package provides the `kdna-studio` command. It creates Studio projects,
imports evidence, manages judgment cards, records optional review/provenance
signals, compiles reviewed project content, and exports canonical `.kdna`
assets with build reports.

It is intentionally separate from `@aikdna/kdna-cli`:

| Package | Command | Role |
| --- | --- | --- |
| `@aikdna/kdna-cli` | `kdna` | Runtime CLI: inspect, validate, plan-load, load, pack, and unpack `.kdna` assets |
| `@aikdna/kdna-studio-cli` | `kdna-studio` | Authoring CLI: create, review, compile, and export `.kdna` files |
| `@aikdna/kdna-studio-core` | none | Studio SDK/compiler kernel used by apps and this CLI |

## Install

```bash
npm install -g @aikdna/kdna-studio-cli
```

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
kdna-studio source classify my_domain
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
  --field failure_risk="generic advice"
kdna-studio card approve my_domain --all --by expert --statement "I confirm this judgment."
kdna-studio export my_domain --format v1 --out dist/my_domain.kdna
```

Candidate promotion is scope-gated: only candidates with `status == accepted` and `scope_fit == true` are promoted to cards by default. Use `kdna-studio candidate override <project> <candidate-id>` only when a human intentionally overrides the scope gate.

The current Studio CLI export workflow uses approved cards as release evidence.
This is Studio project policy, not a KDNA Core v1 format-validity rule. Human
Lock and other provenance records are optional review evidence, not validity
requirements.

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

If you just installed and want to ship a v1 asset without an LLM:

```bash
# 1. Init identity (required for the export signature)
kdna-studio identity init --name "Your Name"

# 2. Create a project
kdna-studio create my_domain --name @yourscope/my_domain

# 3. Add at least one judgment card
kdna-studio card add . axiom \
  --field one_sentence='specific evidence outranks broad claims' \
  --field full_statement='Always cite the specific source that supports a judgment; broad claims without evidence are the most common cause of bad agent advice.' \
  --field why='because vague advice fails in production' \
  --field applies_when='["reviewing"]' \
  --field does_not_apply_when='["formatting"]' \
  --field failure_risk='praise without diagnosis' \
  --field confidence='high' \
  --field evidence_type='observation'

# 4. Approve and lock
kdna-studio card approve . --all --by me --statement "i confirm"

# 5. Export the v1 asset
kdna-studio export . --format v1 --out my_domain.kdna

# 6. Verify with the runtime CLI
kdna load my_domain.kdna --profile=compact
```

The first three AI commands (feynman, distill --ai, test, interview) work
without `KDNA_LLM_PROVIDER` / `KDNA_LLM_API_KEY` by passing `--no-llm`. They
return a structured but unsynthesised result. To enable real evaluation:

```bash
kdna-studio llm config --provider openai --model gpt-4 --key <your-key>
# or set KDNA_LLM_PROVIDER, KDNA_LLM_API_KEY, KDNA_LLM_MODEL
```

## Runtime Export Contract

`kdna-studio export --format v1` is the canonical runtime export path. It uses
`@aikdna/kdna-studio-core` to compile the Studio project into a KDNA Core v1
runtime asset and then packs it with `@aikdna/kdna-core`.

A KDNA Core v1 runtime export contains only these top-level entries:

- `mimetype`
- `kdna.json`
- `payload.kdnab`
- `checksums.json`

Authoring/source entries such as `KDNA_Core.json`, `KDNA_Patterns.json`, and
`source_cards` are not runtime distribution entries. They may exist in Studio
compile output or legacy imports, but they must not be emitted by the runtime
export path.

Being part of the official toolchain means this package is maintained by the
KDNA project. It does not make any specific asset endorsed or suitable for
every use case.

## Identity

```bash
kdna-studio identity init --name "Your Name"
kdna-studio identity show
```

## Import from existing KDNA or legacy folders

```bash
# Fork an existing .kdna asset (cards imported as draft — review before Studio export)
kdna-studio create forked --from-kdna ./parent.kdna --name @scope/forked

# Migrate a legacy JSON source folder
kdna-studio create migrated --from-folder ./old-domain-json --name @scope/migrated
```

## Related

- [KDNA Core](https://github.com/aikdna/kdna) — Official format specification
- [kdna-cli](https://github.com/aikdna/kdna-cli) — runtime CLI for inspect, validate, pack, unpack, and load
- [kdna-studio-core](https://github.com/aikdna/kdna-studio-core) — authoring SDK used by this CLI
- [kdna-studio-swift](https://github.com/aikdna/kdna-studio-swift) — native Swift counterpart
