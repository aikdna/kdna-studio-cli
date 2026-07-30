# Creation Command Contract

Status: unreleased `0.11.0` source candidate; not present in npm `latest`

The default `kdna-studio` Agent commands share one input and output contract.
They are an orchestration surface over Studio Core's Creation Engine, not a
second authoring implementation.

## Commands

| Command | Effect |
| --- | --- |
| `create-agent <workspace>` | Create and save a Creation Engine workspace. |
| `resume <workspace>` | Add purpose, materials, candidates, answers, relations, confirmations, examples, or a private export-plan update. |
| `status <workspace>` | Read readiness and the next unresolved decision. |
| `answer <workspace>` | Record one natural-language interview answer. |
| `review <workspace>` | Reclassify sources, promote or reject candidates, and record relation or confirmation review. |
| `try <workspace>` | Add/evaluate semantic examples, freeze an application plan, issue an exact-asset attempt, record a Consumer exact-asset observation, or record a separately signed application receipt. |
| `repair <workspace>` | Build a repair plan and apply explicit repairs. |
| `export-agent <workspace>` | Compile, verify, re-import, compare, and record a build receipt. |

Commands that accept structured input use exactly one of:

- `--input-file <path>`
- `--input-stdin`

`answer` also accepts plain text through either channel. Natural-language
content is rejected in argv. `--material <path>` may be repeated on
`create-agent` and `resume`. A current `.kdna` material is validated,
inspected, load-planned, authorized-loaded, and Studio-reimported before
complete source judgments become proposed derivation candidates. Protected
material accepts its secret only through `--password-stdin`.

Each regular material file is opened without following symlinks, checked and
read through one descriptor, and then used as one immutable byte snapshot.
For PDF and Word input, `content_hash` binds those original file bytes while
prompt-injection and sensitivity scans consume separately extracted transient
text. Neither raw bytes, extracted text, nor regex-matched excerpts are
persisted in the workspace; detection records stable indicator codes only.
Material is limited to 50 MiB per file and 50 MiB cumulatively per command.
File modification time is recorded as `source_updated_at` with
`time_basis: "file-metadata"`; explicit declared timestamps win. KDNA source
times come from its authorized manifest with `time_basis: "asset-manifest"`.
Representational material must also declare the exact `source_subject_id`,
`belongs_to_subject`, `represents_current_judgment`, authority, currentness,
scope and expiry needed by Studio Core's source-grounding gate.

A terminal Agent may first ingest material with unknown classification and
then submit `material_decisions` through the existing `review` command. Source
review may change only subject binding, ownership, representativeness,
authority, currentness, constraints, scope, split suggestion and expiry. It
cannot replace the source bytes, identity, title, kind, time, trust scan or
sensitivity. Every effective source review records a typed reviewer, reason,
before/after digests and changed fields in private Creation state.

On `create-agent`, one authorized KDNA source establishes fork lineage from
its asset ID, UID, version, and packaged-byte digest. With multiple KDNA
sources, the caller must provide an explicit `lineage` that exactly matches
one source. `resume` never changes lineage; later KDNA inputs are supporting
material. Source confirmation is never inherited.

`create-agent` accepts `mode`, `workflow_mode`, `created_by`, `workspace_id`, `version`,
`judgment_version`, `access`, and `lineage` as workspace options.
`workflow_mode` is `collaborative` or `autonomous`; it never changes the
source/claim truth represented by `mode` and never enters Runtime.
`created_by` has `{ "type": "agent|human|organization", "id": "...",
"name": "..." }`; the CLI maps that public snake-case field to Studio Core
without asking a user to know the SDK's JavaScript property spelling.

After an exact build, a same-semantic rebuild must advance the distributed
asset version while preserving both the semantic revision and
`judgment_version`. A terminal Agent does this through the existing private
workspace command:

```json
{
  "expected_revision": 7,
  "export_plan": {
    "version": "0.1.1"
  }
}
```

Studio Core remains authoritative for this transition. Reusing the last built
version, moving backward, or supplying an invalid version fails closed.
The update requires the current `expected_revision` and cannot be mixed with
another workspace mutation in the same operation. Changing only the export
plan does not renew judgment or application evidence; the exact rebuilt asset
still has to cross the format and application gates. Prepared, verified and
completed export operations bind the export plan that created them, so none
can be resumed or replayed after a plan advance. Exact Runtime verification
also compares the asset Manifest's distributed and judgment versions with the
current compiled plan.

Relations reference promoted JudgmentUnit IDs. New non-conflict relations are
proposed until `relation_decisions` records an `accepted` or `rejected`
decision with a reason. Conflict relations instead require
`resolve_conflicts` and an explicit resolution.

Every proposed candidate includes a non-empty private `contrary_evidence`
list. It records the attempted falsification, conflicting observation or
negative example that must be shown during review. It is persisted in Studio
Core and returned by `status`; it is not a Runtime Manifest or Payload field.

## Stable JSON result

`--json` emits one JSON object. Additive fields may be introduced in a
compatible release; the following names and meanings are stable:

```json
{
  "document_type": "kdna.creation-command-result",
  "contract_version": "0.1.0",
  "workspace": {
    "path": "editorial_creation",
    "mode": "human-assisted",
    "workflow_mode": "collaborative",
    "state": "needs_purpose",
    "revision": 1
  },
  "purpose": {},
    "materials": [],
    "judgments": [],
  "candidate_reviews": [],
  "boundaries": [],
  "relations": [],
  "split_recommendations": [],
  "examples": [],
  "test_plans": [],
  "application_plans": [],
  "application_attempts": [],
  "application_observations": [],
  "application_abandonments": [],
  "application_receipts": [],
  "interview_answers": [],
  "incomplete_operations": [],
  "confirmations": [],
  "readiness": {
    "compile_ready": false,
    "format_ready": false,
    "creation_accepted": false,
    "completion_gates": {
      "format_valid": false,
      "judgment_accepted": false,
      "application_verified": false,
      "creation_complete": false
    },
    "blocking": [],
    "warnings": []
  },
  "next_action": {
    "action": "set_purpose",
    "state": "needs_purpose",
    "reason": "Declare the purpose and loading condition.",
    "requires_user": true,
    "unresolved_ids": []
  }
}
```

The default result intentionally does not expose Studio card layout, workspace
schema details, source bodies, or private source lookup paths. It does expose
non-secret material hashes and ownership/currentness classification, candidate
and source-classification correction receipts, candidate correction receipts,
judgment source references and Agent-inference declarations, relation and split
decisions, expected creator labels,
observed creator labels, Core-derived case status/evaluator, frozen
test-plan semantic/definition coordinates,
persisted interview answers, and incomplete operation recovery coordinates.
An export recovery target is a normalized path relative to the workspace
parent, accompanied by the operation ID, phase, filenames, and exact asset
digest when verification has completed. A fresh Agent can therefore recover
the target from the workspace path without reading internal artifact files.
The entire JSON result is private Creation state and must not be copied into
ordinary logs or treated as Runtime content. Those bounded coordinates are
recovery evidence another terminal Agent needs
to detect stale confirmation after chat loss; they are not Runtime Manifest
fields. Expert commands remain available when a caller deliberately needs
lower-level controls.

`workspace.revision` is the optimistic-concurrency token. Any input containing
`confirmations` or a `test_results[].acceptance` must include
`expected_revision` equal to the revision returned by the last reviewed
`status --json`. Missing or stale revisions fail before mutation.

Creator labels classify the requested test case relative to the represented
judgment. `符合` means the request is in scope and the observed behavior
faithfully applies the judgment; `不符合` means the observed behavior
contradicts it; `超出范围` means the request itself crosses a declared scope
or boundary. A faithful refusal does not turn an out-of-scope request into
`符合`.

Every write accepts one caller-stable `operation_id` in JSON or
`--operation-id <id>`. The private receipt binds the effective request,
material snapshots, bounded output effects, and semantic coordinate. An exact
current retry is inert. Reusing an ID with changed input or after a semantic
correction fails closed with `operation_id_conflict`; it never reports an old
asset or mutation as current. If omitted, the CLI derives a private ID from the
request digest, so callers should provide distinct IDs for intentionally
separate identical actions.

Failures with `--json` use:

```json
{
  "document_type": "kdna.creation-command-error",
  "contract_version": "0.1.0",
  "error": {
    "code": "input_invalid",
    "message": "A safe, stable description."
  }
}
```

Error messages do not include source material, secrets, provider response
bodies, or credential details.

## Exit behavior

- `0` — command completed.
- `2` — invalid or unavailable input.
- `4` — an authorized confirmation or creation-acceptance gate is incomplete,
  or an operation ID conflicts with its private receipt.
- `5` — trust, compilation, Runtime verification, or semantic round-trip
  failure.

`--password` and `--password=<value>` are rejected. Protected export and
protected `.kdna` material use only `--password-stdin`, and it cannot share
stdin with `--input-stdin`.

## Export and completion gates

`export-agent` succeeds only when both conditions hold:

1. Runtime format verification passes.
2. Creation acceptance is current for the compiled semantic revision.

A successful build receipt records tool coordinates, artifact hash, semantic
revision, and the result of validate, inspect, plan-load, compact load, full
load, re-import, and semantic comparison.

This establishes `FORMAT_VALID`; it does not establish
`APPLICATION_VERIFIED` or `CREATION_COMPLETE`. The legacy `format_ready` field
means compile readiness only, while `creation_accepted` is the legacy alias
for `JUDGMENT_ACCEPTED`.

An application plan is frozen in a separate `try` request only after
`FORMAT_VALID`. It binds the exact build-receipt and asset digests,
fresh-hidden task input digests, free-response mode, risk, three-seed
direction/stability coverage, all fidelity dimensions, zero-tolerance
thresholds, the current judgment-evidence digest, and distinct pre-result
Creation, coordinator, Consumer, and evaluator Ed25519 public keys. Fresh
hidden tasks cannot reuse development semantic-test IDs. Creation and
coordinator sign the frozen key registry; the coordinator also signs the full
oracle/task/threshold/build/asset plan.

New private plans use only `adoption-fidelity`. Studio Core, not the CLI
caller, derives direction, scope, boundary, exception, priority,
authority-precedence, exit and overall adoption failures; safety, permission,
external-action and over-application violations; and noncritical direction
stability. Every failure/violation maximum is zero and stability is at least
90%. The signed without-KDNA lane is diagnostic: no score or improvement over
baseline can establish or block acceptance. Persisted score-comparison plans
remain readable only for historical audit and cannot satisfy the current
completion gate.

Completion then requires three separate `try` requests:

1. `application_attempt` plus `--asset <final.kdna>` lets Studio Core load the
   exact final bytes and issue a one-use challenge.
2. `application_observation` plus the same `--asset` lets Studio Core record
   the Consumer's separate exact-byte load and run coordinates.
3. `application_receipt` submits Consumer and evaluator signatures over that
   plan, challenge, observation, both task lanes, run coordinates, and
   evaluator-signed adoption-fidelity facts.

If the isolated Consumer runner exits after step 2 but before step 3, a
separate `try` request may provide `application_attempt_abandonment`. The
frozen coordinator signs the current attempt/challenge, exact observation,
plan/semantic/build/asset coordinates, stable reason code, concise reason, and
runner-failure evidence digest, repeated Consumer run/runner coordinates, and
a canonical UTC `abandoned_at`. Core accepts the signed time only within five
minutes of intake and not before the attempt or observation, then persists it
unchanged. It atomically records the immutable abandonment, marks the attempt
and observation `abandoned`, keeps `APPLICATION_VERIFIED` false, and returns
to `issue_application_attempt`.
No asset or password is accepted for this request. Unknown, replaced,
consumed, superseded, mismatched, replayed, unsigned, extra-field, and
non-coordinator inputs fail closed.
The signed timestamp is a coordinator-key claim, not external time-authority
evidence.

For a protected asset, steps 1 and 2 require `--password-stdin`; the secret is
transient and never enters JSON, the operation receipt, stdout, or the
workspace. Authorization failures are reported separately from application
judgment failures. A plaintext shadow cannot satisfy either exact-byte load.
Caller-supplied status fields are rejected; Studio Core derives the gate.
Signatures prove only that the corresponding private keys signed the facts.
Initial key enrollment is trust-on-first-use; neither signatures nor role
labels authenticate real-world identity or prove process independence. The
Host or benchmark must retain separate private-key and process-isolation
evidence.

During an exact dirty-source development checkpoint, an immutable WP0
candidate runtime derives the complete private `development_baseline` from
its adjacent, exact-tree-verified runtime receipt. A caller may omit the field
or repeat the exact bound value, but cannot introduce or override it. A source
checkout without that adjacent runtime receipt rejects caller-supplied
baseline claims instead of minting candidate evidence. Studio Core then
validates the derived projection against the loaded Core, Studio Core, and
Studio CLI package/version coordinates. This field is development evidence
only; it is never compiled into a Runtime Manifest, Payload, or Capsule. A
released installation normally omits it.

Semantic comparison includes purpose loading condition and scope, exclusions,
judgment core, accepted relations, every current judgment, creator, and
lineage.

Export is a resumable private three-phase operation: `prepared`, `verified`,
then `completed`. `prepared` durably records deterministic candidate/backup
names and the prior output digest before generation. `verified` binds the exact
candidate bytes that passed Core validation, inspection, load planning,
authorized compact/full loading, Studio re-import, and semantic comparison.
Only those digest-bound bytes may be published; protected mode therefore never
substitutes a plaintext shadow asset. `completed` binds the installed output,
build receipt, readiness, and current semantic coordinate.

Each phase syncs its file and parent directory before the next phase. A retry
after process death reconciles only journal-named regular files whose digests
match the receipt, preserving the exact encrypted bytes instead of
regenerating them. Unknown, replaced, stale, or symlinked recovery state fails
closed. Successful filesystem sync calls cannot guarantee survival of
storage-hardware failure.
