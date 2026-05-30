# @aikdna/kdna-studio-cli

Official Studio command-line authoring entry for KDNA.

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
kdna-studio card add my_domain axiom \
  --field one_sentence="Prefer specific evidence over broad claims" \
  --field applies_when='["reviewing content"]' \
  --field does_not_apply_when='["pure formatting"]' \
  --field failure_risk="generic advice"
kdna-studio card approve my_domain <card-id> --by expert --statement "I confirm this judgment."
kdna-studio lock my_domain
kdna-studio export my_domain --out dist/my_domain.kdna --sign
```

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
