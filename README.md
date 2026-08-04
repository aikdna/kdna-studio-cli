# @aikdna/kdna-studio-cli

> **Status:** Pre-release authoring toolchain. The published `0.11.0` is on
> npm `latest`, superseding the historical `0.10.2` incumbent after the
> 2026-08-02 publication.

Official terminal entry for KDNA judgment asset creation. The default Creation
Engine guides a user or terminal Agent from purpose and source material through
judgment review, boundary examples, confirmation, repair, a managed test
candidate, and final exact-byte delivery. It does not require the Studio app
or manual `.kdna` format editing.

Two creation paths remain useful: interview-first (articulate judgment
directly) and material-first (provide content, find the patterns, review what
belongs in scope).

Distillation-first authoring is domain-first: declare the target domain, owner scope, granularity, task scope, include areas, exclude areas, and load condition before extracting candidates. A single `.kdna` should stay scoped. Any future multi-asset use requires an explicit, separately admitted Host contract; it is not an implicit Studio export behavior.

This package provides the `kdna-studio` command. Its default Agent surface
speaks in purpose, material, judgment, boundary, example, confirmation, and
export terms. The existing project, evidence, candidate, and card commands
remain available as an expert authoring surface.

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

That command installs the published `0.11.0` from npm `latest`. Requires
Node.js 18 or later. To assess a future candidate, use this source repository
and its exact candidate
dependency coordinates; do not mix candidate documentation with npm `latest`.

## Usage

For a terminal Agent, start with the user's ordinary-language goal and an
optional explicit material path. The Host translates that request into private
machine input and generates stable technical coordinates. A normal user never
supplies a mode enum, Agent ID, operation ID, digest, schema, signing key,
receipt, seed, or benchmark coordinate.

```bash
# Stable public machine templates; do not inspect package source for shapes.
kdna-studio guide-agent --action create --json
# For every command below, the Host streams its private JSON/text request to
# stdin from memory. Private purpose, answers and judgments are not ordinary
# project files and never go in argv.
kdna-studio create-agent my_creation --input-stdin
kdna-studio inventory-agent my_creation --material ./notes.md \
  --input-stdin --json
# After exact inventory/policy approval, deliver only the accepted source.
private_material_file="$(mktemp)"
chmod 600 "$private_material_file"
trap 'rm -f "$private_material_file"' EXIT INT TERM
kdna-studio deliver-material my_creation \
  --input-stdin \
  --private-output-file "$private_material_file" --json
kdna-studio guide-agent my_creation --json
kdna-studio resume my_creation --json
kdna-studio status my_creation --json
kdna-studio answer my_creation --input-stdin
kdna-studio review my_creation --input-stdin
kdna-studio try my_creation --input-stdin
kdna-studio repair my_creation --input-stdin
kdna-studio export-agent my_creation --json
# Only after all three gates bind the same exact managed candidate:
kdna-studio finalize-agent my_creation --out dist/my_creation.kdna --json
```

For an approved named remote processor, the Host reads the mode-0600 temporary
file into that named model context and deletes it in `finally`. A dedicated
adapter may use fd 3 instead. This is Host-declared remote processing under the
named provider retention boundary; it is not verified-local or a claim that
model input is log-free. The generic CLI fails closed when separately attested
local processing is required.

The machine API uses a Host-generated, caller-stable operation coordinate.
Exact retry is inert while its semantic coordinate remains current; stale
semantic replay and changed input, material bytes, output path, or protection
mode fail closed. This is a Host automation contract, not a user prompt.

`status` reports the next unresolved decision plus the separate
`JUDGMENT_ACCEPTED`, `FORMAT_VALID`, and `APPLICATION_VERIFIED` gates.
`compile_ready` is only readiness to build a managed candidate. `export-agent`
can establish the exact-byte format gate but never writes an incomplete
candidate to the user's final path. Later official Host orchestration freezes
the `application-adoption-fidelity` plan, loads the exact managed bytes in a
fresh Consumer context, and obtains independent evaluation and scenario-local
stability evidence. The ordinary user does not assemble role keys, signatures,
plans, or receipts.

The machine-readable envelope exposes private Creation vocabulary and recovery
coordinates needed for another Agent to resume. It is not ordinary log
content. It does not return source bodies, absolute source paths, passwords,
decrypted payloads, or private keys. See
[Terminal Agent Creation](docs/TERMINAL_AGENT_CREATION.md) and the
[command contract](docs/CREATION_COMMAND_CONTRACT.md).

The expert authoring surface remains available:

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

## First small asset

Tell a compatible terminal Agent:

> Create a KDNA that keeps new titles to eight words or fewer. Use
> `./title-notes.md`. This current remote terminal Host may process that exact
> file under its named provider retention policy.
> Save the result as an ordinary local file, but do not publish or share it.

The Agent chooses the private machine fields, previews material without
reading it, binds the exact preview when it matches the user's stated
authorization, and shows the next meaningful semantic decision. It asks again
only for an unexpected scope, sensitive item, coverage gap, destination
change, or genuine ambiguity. One material file, one complete Judgment Unit,
no relation, and no correction can be sufficient. Zero-material
interview-first work, small collections, and paged large collections use the
same state machine; file count is not an acceptance score.

Verified local-only processing is available only through a separately trusted
local Host adapter. A remote terminal Host must fail before reading when the
user requires verified-local handling; fd 3 or a caller-supplied digest cannot
upgrade remote processing into a locality proof.

A review can confirm `reviewed-no-change`. Highest question, worldview, value
order, priority, exception, conflict, and other complex structures appear only
when the actual asset needs them.

An explicitly approved material source can also be a current packaged `.kdna`.
It is validated,
authorized-loaded, Studio-reimported, and converted into reviewable derivation
candidates without copying its raw payload into the workspace. Protected
source assets use `--password-stdin`. Directory shape alone does not declare
material historical, current, migrated, owned, or authoritative; every source
starts with an honest unknown/review state.

The expert `distill --ai` and `interview` commands can use a configured model
provider:

```bash
printf '%s\n' "$KDNA_LLM_API_KEY" | \
  kdna-studio llm config --provider openai --model gpt-4 --key-pipe
# Provider/model/key environment variables can also configure a one-shot run.
```

External AI providers must use a canonical HTTPS base URL. Plain HTTP is
accepted only for local development at the exact numeric loopback hosts
`127.0.0.1` or `[::1]`; `localhost`, LAN addresses, URL credentials, query
strings, and fragments are rejected. Provider redirects are not followed with
API keys or authoring material, and provider response bodies are not copied
into CLI errors.

The Creation Engine `try` command records semantic examples and their reviewed
results; it is separate from the retired Test Lab UI. Test Lab and Feynman
workshop implementations remain in the source repository
for research and regression coverage. Published releases up to and including
0.10.2 shipped them as CLI commands in the npm tarball; the published `0.11.0`
line removes them from the default CLI and from the npm release
tarball. The public CLI
contract remains the create, review, compile, and export path shown above.

## Runtime Export Contract

`kdna-studio export-agent` creates the managed candidate and may establish its
exact-byte `FORMAT_VALID` result. It is not Creation Accepted or
`CREATION_COMPLETE`; final delivery remains blocked until all three gates bind
that same candidate.
`kdna-studio export` remains the expert Studio-project export path. Both use
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

A configured machine-local identity is not inherited by `create` or `migrate`.
Use `--use-local-identity` only when that identity is intentionally the creator
for the current work. Signing and identity-management commands continue to
load identity explicitly.

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
