# @aikdna/kdna-studio-cli

Official Studio command-line entry for KDNA judgment asset creation — turns your notes, documents, works, and feedback into loadable .kdna domains.

Two authoring paths: interview-first (articulate your judgment directly) and distillation-first (provide content, find the patterns, confirm what's really you).

Distillation-first authoring is domain-first: declare the target domain, owner scope, granularity, task scope, include areas, exclude areas, and load condition before extracting candidates. A single `.kdna` should stay scoped; complex work should compose multiple domain assets through a KDNA Cluster.

This package provides the `kdna-studio` command. It creates Studio projects,
imports evidence, manages judgment cards, checks Human Lock, compiles locked
cards, and exports canonical `.kdna` assets with build reports.

It is intentionally separate from `@aikdna/kdna-cli`:

| Package | Command | Role |
| --- | --- | --- |
| `@aikdna/kdna-cli` | `kdna` | Runtime CLI: verify, install, load, compare, publish existing `.kdna` assets |
| `@aikdna/kdna-studio-cli` | `kdna-studio` | Authoring CLI: create, lock, compile, export trusted `.kdna` assets |
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
  --field applies_when='["reviewing content"]' \
  --field does_not_apply_when='["pure formatting"]' \
  --field failure_risk="generic advice"
kdna-studio card approve my_domain <card-id> --by expert --statement "I confirm this judgment."
kdna-studio lock my_domain
kdna-studio export my_domain --out dist/my_domain.kdna --sign
```

Candidate promotion is scope-gated: only candidates with `status == accepted` and `scope_fit == true` are promoted to cards by default. Use `kdna-studio candidate override <project> <candidate-id>` only when a human intentionally overrides the scope gate.

After export, use the runtime CLI:

```bash
kdna verify dist/my_domain.kdna --judgment
kdna publish dist/my_domain.kdna
```

`kdna-studio` is the CLI entry for trusted KDNA creation. `kdna` is the runtime
control plane for existing `.kdna` assets.

## Identity

```bash
kdna-studio identity init --name "Your Name"
kdna-studio identity show
```

## Import from existing KDNA or legacy folders

```bash
# Fork an existing .kdna asset (cards imported as draft — re-lock required)
kdna-studio create forked --from-kdna ./parent.kdna --name @scope/forked

# Migrate a legacy JSON source folder
kdna-studio create migrated --from-folder ./old-domain-json --name @scope/migrated
```

## Related

- [KDNA Protocol](https://github.com/aikdna/kdna) — specification and schemas
- [kdna-cli](https://github.com/aikdna/kdna-cli) — runtime CLI for verify, install, load, publish
- [kdna-studio-core](https://github.com/aikdna/kdna-studio-core) — authoring SDK used by this CLI
- [kdna-studio-swift](https://github.com/aikdna/kdna-studio-swift) — native Swift counterpart
