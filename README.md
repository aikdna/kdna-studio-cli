# KDNA Studio CLI — typed current creation

Studio CLI `0.13.0` consumes Studio Core `4.0.0`, Core `0.37.2` and Read `0.11.3`. Ordinary prose and supported mechanism structures share container `0.5.0` / Read grammar `0.6.4`. Core/Read package versions identify implementation bytes and do not establish interchange with NativeSections container `0.6.0` / Read `0.7.0`, or import/reuse of another CLI's output. Installation acceptance is a separate Host decision; exact content checks do not authenticate a provider process.

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

The full 12-package dependency graph uses exact registry coordinates and an integrity lock; the committed vendor archives anchor its member receipt. Before loading upstream code or materials, the CLI checks complete installed member sets, bytes, versions and one shared Core resolution, and rejects unbound optional addons. The exact archive/member declarations are in `src/public-bindings.json`.

Install with registry access using the locked coordinates:

```text
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm test
npm run lint
npm pack --offline --ignore-scripts
```

For an offline install, add `--offline` to `npm ci` only after the npm cache contains every required locked artifact with its matching integrity. The committed `vendor/` archives alone neither populate that cache nor redirect the registry URLs in the lock.

An embedding that requires offline processing must independently deny network access; npm `--offline` alone is not a network boundary. No package lifecycle scripts or native optional packages are needed for this graph.

## Dependency coordinates and publication

The current package and lock use exact registry versions. Runtime packages belong in `dependencies`, and `overrides` bind their required peers to the same root coordinates. Integrity-locked `file:` coordinates used by local candidate/test fixtures are separate from this registry installation graph.

`npm run check:publish-coordinates` rejects local dependency declarations in a publishable package, because a registry consumer has no repository `vendor/` directory next to the packed artifact. The publish workflow runs that gate and requires the registry to serve the exact locked dependency integrities.

See [command contract](docs/CREATION_COMMAND_CONTRACT.md) and [Agent integration](docs/TERMINAL_AGENT_CREATION.md). Their JSONL is private transport, not a KDNA asset format. Historical project/card commands and runtime adapters stay outside the packed and default surface.


## Source and release verification

The dependency graph binds Studio Core `4.0.0`, Core `0.37.2`, Read
`0.11.3` and `fast-uri` `3.1.8`. The current source ledger is
`fixtures/runtime-candidates/current-sources.json`; `npm run verify:candidate-sources`
rebuilds its exact Git package trees and compares every installed tar member.
`npm run check:current-bindings` independently recomputes the complete dependency
member receipt. These checks execute for the current graph; historical
registry fixtures and their retired API remain separate test material.

In the stable release context, `npm run release:generate-evidence -- --out
<outside-repository-evidence.json> --artifact <outside-repository-package.tgz>`
creates two byte-identical packs from exact committed blobs and validates their
independently parsed contents. It requires a clean checkout, the exact version
tag and the matching release commit. The stable publisher also requires a
published, non-draft, non-prerelease event and exact registry dependency
integrities. Prerelease evidence cannot enter that publisher. Local checks do
not establish registry availability, verified editorial identity, real human
acceptance or permission to publish.
