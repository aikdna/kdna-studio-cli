# Terminal Agent Creation

Status: shipped in the published `0.11.0` Studio CLI as the default Creation
Engine entry. A checked-in Skill is not proof that a particular Host can
complete the flow, and this guide is not an ordinary-user questionnaire.

## Start with the user's words

A normal request can be:

> Create a small KDNA that keeps my new article titles to eight words or fewer.
> Use `./title-notes.md`. This current remote Codex Host may process that file
> under its named provider retention policy. Save the
> final result as an ordinary local file; do not share or publish it.

The Host translates that request into private machine input. It does not ask
the user for a mode enum, workflow enum, Agent ID, operation ID, digest,
schema, signing key, receipt, seed, or application matrix.

Ask only when a meaningful fact is missing:

- Is the judgment the user's or organization's represented judgment, an
  interpretation of material, Agent-authored, or genuinely co-authored?
- Which explicit file or directory may be considered?
- Must material stay local-only, may it go to a named remote processor, and
  does the user require a separately trusted Host attestation?
- Should the final file be ordinary possession-load, protected, or remote?

In Runtime terminology, `access: public` means possession of the file is
sufficient to load it. It does not publish the asset to the Internet. Creation
never shares or publishes automatically.

## Private workspace

Choose one private workspace under the project root. The CLI excludes it from
material inventory and protects it from accidental Git staging.

```bash
kdna-studio guide-agent --action create --json
kdna-studio create-agent .kdna-creation/title-rule \
  --input-file /private/path/to/host-generated-create-input.json --json
```

The path shown above is illustrative. Private structured input uses stdin or a
mode-0600 file. Never place source text, judgments, passwords, or API keys in
argv or shell history.

If the workspace already exists:

```bash
kdna-studio guide-agent .kdna-creation/title-rule --json
```

The Host creates and persists technical actor and operation identifiers. The
user does not supply them. Follow `next_action.required_actor` and
`next_action.requires_user`; do not bypass an authority pause in prompt text.
Run `guide-agent` after state changes to obtain the supported public command
and template. Do not read package source or private workspace JSON to discover
machine fields.

## Material-first sequence

Zero material is valid. For one or more explicit paths, no content may be read
before inventory approval.

1. Create a content-free preview:

   ```bash
   kdna-studio inventory-agent .kdna-creation/title-rule \
     --material ./title-notes.md \
     --input-file /private/path/to/processing-policy.json --json
   ```

2. Show the user relative paths, exclusions, unsupported items, duplicates,
   batch continuation, the declared local or named-remote destination, and
   whether the Host fact is caller-declared or separately attested.
3. Bind the exact inventory digest through Host-owned private machine input.
   When the user's original instruction already covers the displayed path,
   processing destination, and boundary, this does not require a second
   digest-oriented user question. Ask again only for an unexpected path,
   sensitive item, unsupported coverage gap, destination drift, or genuine
   ambiguity.
4. The Host delivers only an accepted entry. A standard named-remote terminal
   Host uses a pre-created mode-0600 system-temporary file; this is a Host
   machine coordinate, not a user instruction:

   ```bash
   private_material_file="$(mktemp)"
   chmod 600 "$private_material_file"
   trap 'rm -f "$private_material_file"' EXIT INT TERM
   kdna-studio deliver-material .kdna-creation/title-rule \
     --input-file /private/path/to/delivery-request.json \
     --private-output-file "$private_material_file" --json
   ```

The Host reads that temporary file into the explicitly approved named model
context, subject to that provider's declared retention policy, and must delete
the file in `finally`. A dedicated Host adapter may instead provide fd 3; a
regular fd target must be mode 0600 or stricter and must not alias stdout or
stderr. This path keeps content out of CLI JSON/stdout/stderr/workspace,
but it is remote model processing—not “private model input”, log-free proof,
or verified-local evidence. A caller-supplied capability digest is only
`host-declared`; it cannot prove verified local-only processing. When verified
assurance is required, a separately trusted Host adapter is mandatory and the
generic CLI stops before reading.

Directory previews exclude VCS metadata, dependencies, build/cache output,
the Creation workspace, managed candidates, output paths, and secret-like
files by default. Unsupported or failed items remain visible while usable
items continue. File and byte limits are recoverable batch budgets; they are
not minimums or maximum logical source counts.

The current candidate does not provide offset continuation inside one text
file above the direct-processing byte limit. That item is explicitly
unsupported; the actionable fallback is an explicitly selected split copy
whose parts preserve ordering and full coverage. The CLI does not falsely
promise that resubmitting the same file advances an internal cursor.

Text uses strict UTF-8 and no silent prefix truncation. PDF and word-processing
capability is probed before delivery. Images, audio, video, and other
Host-observed sources require an exact source digest plus a bounded
observation that records tool/Host coordinate, coverage, uncertainty, and
observation digest. The observation never represents the source author.

## Build the bounded judgment

A valid asset may contain one complete Judgment Unit and no relation:

- statement and rationale;
- when it applies;
- when it does not apply or must exit;
- misuse risk;
- traceable source or explicit Agent inference;
- bounded counterexample search and residual uncertainty;
- explicit card type and confidence.

Do not invent a worldview, value hierarchy, conflict, priority, exception,
correction, or additional judgment to satisfy a sample shape. A current,
digest-bound review may record `reviewed-no-change`.

Use the structured machine actions returned by `resume`:

```bash
kdna-studio answer  <workspace> --input-file <private-answer.json> --json
kdna-studio review  <workspace> --input-file <private-review.json> --json
kdna-studio try     <workspace> --input-file <private-test.json> --json
kdna-studio repair  <workspace> --input-file <private-repair.json> --json
```

Human and organization representation requires the corresponding current
authority. Autonomous Agent-authored and interpretive work can continue with a
distinct independent evaluator Agent. The creating Agent cannot accept its
own held-out evaluation. Low confidence can be resolved through more evidence,
an honest narrower scope, or an explicit bounded uncertainty; it must not
deadlock merely because the workflow is autonomous.

## Three gates

Keep the status fields separate:

- `JUDGMENT_ACCEPTED` — current, source- and authority-honest judgments have
  applicable semantic and boundary evidence.
- `FORMAT_VALID` — the exact managed candidate is a valid, compatible Runtime
  asset container.
- `APPLICATION_VERIFIED` — an official Host loads those exact bytes in a fresh
  Consumer context and obtains independent applicable-dimension evaluation and
  pre-frozen stability evidence.

A loadable container without a current password may still be format-valid;
authorization and actual load belong to the third gate. Likewise, semantic
tests alone cannot establish Application Verified without actual Runtime
loading and Consumer use.

Coverage is based on the asset's structure and risk. It always proves
application plus boundary or exit and prevents over-application. Priority,
exception, conflict, authority-precedence, and high-risk cases are required
only when declared or applicable. At least one core or highest-risk scenario
has repeated stability evidence; every task does not need a fixed multi-seed
matrix.

## Managed candidate, verification, and delivery

Create the exact private test candidate:

```bash
kdna-studio export-agent <workspace> --json
```

`export-agent` does not accept `--out` and does not create a user delivery.
The official Host then orchestrates the required isolated Consumer and
independent evaluator against those exact managed bytes. The ordinary user
does not construct role keys, signatures, plans, or receipts. If the current
Host lacks that official adapter, report the Host-integration blocker instead
of using the creating Agent or a private benchmark as a substitute.

Only after all three gates bind the same semantic and asset digests:

```bash
kdna-studio finalize-agent <workspace> --out ./title-rule.kdna --json
```

Finalization atomically copies the already verified bytes. It does not
recompile, write inside the workspace, or ask for a redundant password just to
copy verified ciphertext. Stale receipts, replaced candidates, path aliases,
and partial transactions fail without leaving a target file.

## Recovery and lifecycle

After a crash or Agent handoff, call `resume`. The workspace either reopens an
authorized source capability and verifies the exact bytes or requests source
reauthorization. Chat context is not recovery evidence.

The current local Creation lifecycle is create, resume, revise, invalidate
stale confirmations/tests, retest, finalize, and recover the last valid state.
Stopping retains the private workspace. The CLI does not yet expose a general
workspace-abandon/delete command; application-attempt abandonment closes only
one interrupted Consumer attempt. Sharing, publication, deprecation,
revocation, marketplace distribution, and Studio App management are separate
capabilities.
