# KDNA Studio CLI — typed current creation

The terminal Host consumes Studio 4.0.0-rc.components.1, Core 0.24.0-rc.component-semantics.2 and Read 0.3.0-rc.component-semantics.2. Ordinary prose and supported mechanism structures share the same current graph. Installation acceptance is a separate Host decision; exact content checks do not authenticate a provider process.

An external Agent records materials and proposes judgment groups with at least two meaningful alternatives. Selection and final adoption arrive through a separately owned live channel. Human-declared review and expressly delegated Agent editorial adoption are distinct modes:

```text
kdna-studio session --text ./notes.md --out ./new-export --human-fd 3
kdna-studio session --text ./notes.md --out ./new-export --agent-adoption-fd 3 --delegation-record ./delegation.json
```

The second mode requires an explicitly supplied JSON record `{ "coordinate": "…", "statement": "…" }` describing existing authorization. It records the Agent as an Agent. A descriptor, transcript or authorization statement is not an identity credential. Without a supplied fd, human mode uses the controlling terminal. `--synthetic-fixture` labels implementation fixtures; executing a test callback is not actual editorial adoption.

Only explicitly named ordinary UTF-8 `.txt`, `.md` and `.text` materials are opened. The private stdin/stdout Agent pipe carries operations, actual reply tickets and material bodies. The separate channel carries natural-language replies. The CLI supplies no model, remote service, automatic provider or global binary fallback.

Follow brief → materials → distinct alternatives → actual selection → complete current preview → fresh final adoption → export. Typed `method` is optional. Its absence, undeclared own arrays and explicit empty arrays remain distinct. Component structures use the shared Core grammar. Candidate-specific criteria stay inside their respective candidates; an empty overall formation condition set is not filled from branch conditions.

Export exclusively creates a new private directory. It writes exact Studio bytes and evidence, captures the saved asset again, calls Studio `completeSave`, writes `verification.json`, and writes version-2 `complete.json` last. Files and directory become read-only for their owner. Failure removes only the incomplete reservation made by that invocation. Library saving reports `accepted_with_live_context`, scoped to the actual process and saved-byte check. It does not prove storage durability, person identity or action authorization.

```text
kdna-studio verify --bundle ./new-export
kdna-studio read --bundle ./new-export --allow-read --judgment 1
```

Static reopening keeps `creation_accepted:not_evaluated` and `live_context:unavailable`; JSON cannot restore a one-use capability. `read` requires explicit `--allow-read`, delegates request admission, scope, exact selection and byte budgets to public Read, and grants no action authority. Format1, format-absent legacy evidence and old completion sidecars are noncurrent. Preserve their original accepted releases; never relabel them to this graph.

The full 12-package local `file:vendor` graph and SRI lock are supplied. Before loading upstream code or materials, the CLI checks complete installed member sets, bytes, versions and one shared Core resolution, and rejects unbound optional addons. The exact archive/member declarations are in `src/public-bindings.json`.

```text
npm ci --offline --ignore-scripts --omit=optional --no-audit --no-fund
npm test
npm run lint
npm pack --offline --ignore-scripts
```

An embedding that requires offline processing must independently deny network access; npm `--offline` alone is not a network boundary. No package lifecycle scripts or native optional packages are needed for this graph.

## Dependency coordinates and publication

A direct declaration is either an exact SemVer or an integrity-locked `file:` coordinate. Placement follows what the documented entry needs: these `file:` coordinates belong in `dependencies`, because `npm ci --omit=dev --omit=optional` followed by `npm test` still works with the development graph omitted, whereas a `devDependencies` placement would not survive `--omit=dev`. Peers declared by vendored members are bound to this repository's own coordinates through `overrides`, so an unreadable vendor archive fails locally instead of sending npm to the registry.

Before publishing a release from this repository every `file:` coordinate must be replaced by the **exact registry version**, because a consumer that installs the packed artifact from a registry has no `vendor/` directory next to it. `npm run check:publish-coordinates` reports the coordinates that are still local; the publish workflow runs that gate before a package can be pushed.

See [command contract](docs/CREATION_COMMAND_CONTRACT.md) and [Agent integration](docs/TERMINAL_AGENT_CREATION.md). Their JSONL is private transport, not a KDNA asset format. Historical project/card commands and runtime adapters stay outside the packed and default surface.
