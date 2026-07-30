# @aikdna/kdna-studio-cli

> **Status:** Pre-release authoring toolchain. This repository contains the
> unreleased `0.11.0` corrective candidate; the published incumbent remains
> `0.10.2`. Candidate behavior must not be described as already published.

Official terminal entry for KDNA judgment asset creation. The default Creation
Engine guides a user or terminal Agent from purpose and source material through
judgment review, boundary examples, confirmation, repair, and verified
`.kdna` export. It does not require the Studio app or manual schema editing.

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
npm install -g @aikdna/kdna-studio-cli@0.10.2
```

That command installs the published incumbent. To assess the unreleased
`0.11.0` candidate, use this source repository and its exact candidate
dependency coordinates; do not mix candidate documentation with npm `latest`.

## Usage

For a terminal Agent or a user who does not want to edit Studio internals,
start with a Creation Engine workspace:

```bash
# Purpose and natural-language content are passed by file or stdin, not argv.
kdna-studio create-agent my_creation --input-file purpose.json
kdna-studio resume my_creation --material ./notes.md
kdna-studio status my_creation --json
kdna-studio answer my_creation --input-file answer.txt
kdna-studio review my_creation --input-file review.json
kdna-studio try my_creation --input-file examples.json
kdna-studio repair my_creation --input-file repairs.json
kdna-studio export-agent my_creation --out dist/my_creation.kdna
```

Give each write a caller-stable `operation_id` in JSON or
`--operation-id <id>`. Exact retry is inert while its semantic coordinate
remains current; stale semantic replay and the same ID with different input,
material bytes, output path, force flag, or protection mode fail closed.

`status` reports the next unresolved decision plus the separate
`JUDGMENT_ACCEPTED`, `FORMAT_VALID`, and `APPLICATION_VERIFIED` gates.
`format_ready` remains a legacy compile-readiness alias and is never presented
as Core format validity. `export-agent` establishes the exact-byte format gate
but deliberately reports application verification and Creation completion as
not yet complete. Later `try` requests separately freeze the private
fresh-hidden free-response adoption-fidelity plan bound to the verified build
and exact asset, issue a one-use attempt after loading that exact final asset,
record the Consumer's separate exact-asset observation, and record the signed
Consumer/evaluator receipt. These phases cannot share one request.

The
machine-readable envelope is stable and deliberately exposes the creation
vocabulary plus non-secret material ownership/hash, correction, relation and
frozen test/application-plan evidence, persisted interview answers, and
incomplete operation recovery coordinates needed for another Agent to resume. Export
targets are persisted only as normalized paths relative to the workspace
parent. The result does not return source bodies or private material lookup
paths. See
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

## 5-minute first asset

If you just installed and want to begin without the Studio app, put the
following JSON in `purpose.json`:

```json
{
  "name": "@yourscope/review-judgment",
  "mode": "human-assisted",
  "purpose": {
    "objective": "Review an argument for evidential strength",
    "scope": "Long-form editorial review",
    "loading_condition": "Load when an Agent must evaluate whether an argument is adequately supported",
    "highest_question": "What evidence is strong enough for this claim?",
    "worldview": [
      "Claims should be proportional to their supporting evidence"
    ],
    "value_order": [
      "truthfulness",
      "specificity",
      "clarity"
    ],
    "judgment_role": {
      "acts_as": "an editorial evidence reviewer",
      "does_not_act_as": [
        "a source of invented facts"
      ],
      "responsibility": "Explain why the available evidence is or is not sufficient"
    },
    "global_boundaries": [
      "Do not invent evidence",
      "Do not replace subject-matter review"
    ]
  }
}
```

Then create and add material:

```bash
kdna-studio create-agent review_creation --input-file purpose.json
kdna-studio resume review_creation --material ./notes.md
kdna-studio status review_creation
```

The Creation Engine will name the next unresolved judgment or confirmation
step. A capable terminal Agent can prepare the structured `resume`, `review`,
`try`, and `repair` inputs while presenting each decision to the user in
ordinary language. Export is allowed only after creation acceptance.
An interview-first source-grounded flow records answers with `answer`, ingests
the exact answer bytes as `kind: "interview"`, and uses
`review.material_decisions` to classify source authority/currentness after
ingestion. The source bytes and identity cannot be replaced during review.

`--material` also accepts a current packaged `.kdna`. It is validated,
authorized-loaded, Studio-reimported, and converted into reviewable derivation
candidates without copying its raw payload into the workspace. Protected
source assets use `--password-stdin`. Historical source directories remain
provenance inputs; directory ingestion does not declare them current.

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
0.10.2 shipped them as CLI commands in the npm tarball; the current
development line removes them from the default CLI and from the npm release
tarball, effective with the next release after 0.10.2. The public CLI
contract remains the create, review, compile, and export path shown above.

## Runtime Export Contract

`kdna-studio export-agent` is the default accepted-creation export path.
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
