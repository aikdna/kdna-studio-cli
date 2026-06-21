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
Lock, signatures, and quality claims are separate trust/provenance layers.

After export, use the runtime CLI:

```bash
kdna validate dist/my_domain.kdna --runtime
kdna plan-load dist/my_domain.kdna --json
kdna load dist/my_domain.kdna --profile=compact --as=prompt
```

`kdna-studio` is the CLI entry for Studio project authoring. `kdna` is the
runtime control plane for inspecting, validating, packing, unpacking, and
loading existing `.kdna` assets.

## Runtime Export Contract

`kdna-studio export --format v1` is the canonical runtime export path. It uses
`@aikdna/kdna-studio-core` to compile the Studio project into a KDNA Core v1
runtime asset and then packs it with `@aikdna/kdna-core`.

A v1 runtime export contains only these top-level entries:

- `mimetype`
- `kdna.json`
- `payload.kdnab`
- `checksums.json`

Authoring/source entries such as `KDNA_Core.json`, `KDNA_Patterns.json`, and
`source_cards` are not runtime distribution entries. They may exist in Studio
compile output or legacy imports, but they must not be emitted by the runtime
export path.

Signature, encryption, registry publishing, paid distribution, and private
assets are future/gated phases, not the current Core v1 baseline.

Being part of the official toolchain means this package is maintained by the
KDNA project. It does not make any specific asset trusted, endorsed, rated, or
safe for every use case.

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
