# Terminal Agent integration

The live private Agent transport creates through Studio; it is not a public asset wire format. Keep stdin/stdout private. The Agent owns substantive authoring and interpretation of actual reviewer language. The CLI has no model or keyword classifier.

Use an approved exact local installation. Start with explicit source files and a new output directory. Use a separately owned fd3 for either `--human-fd 3`, or `--agent-adoption-fd 3 --delegation-record FILE` when the Agent has express editorial authority. Preserve the actual actor. A delegated Agent must never be represented as a human. An interview reads the selected live adoption channel and records question plus answer as private material.

Each newline-terminated Agent frame has unique `id`, `op`, and `data`. Wait for a result or the live reply ticket. The first `ready` event provides the workspace and explicit materials. Material references are one-based ordinals; judgment, alternative and component references use stable local keys.

| op | data |
| --- | --- |
| brief | `{title,scope}` |
| interview | `{title,question}` |
| propose | `{localKey,alternatives:[alternative,alternative,...]}` |
| revise | `{localKey,baseRevision,alternatives,explanation}` |
| review | `{}`; request actual selection or final adoption |
| preview | `{}`; show complete current mapping before final adoption |
| status | `{}` |
| export | `{}`; save, re-capture and complete once, then exit |

Each alternative has `{localKey,title,subject,scope,statement,rationale,materials:[1]}`. At least two substantive alternatives are required. Optional fields are `method`, `formationRule`, `publicSources`, `publicNotices`; all other fields reject. `materials` is the only CLI adapter, converted to Studio material references. Never send protocol IDs, public profile definitions, native carriers, evidence digests or compiler context.

`method` is `{method:{term},components?,bindings?}`. A component has `{localKey,type,content,statement?}`; content uses the exact current public item/edge/discriminator types. Types are taxonomy, candidate-set and discriminator-set. The latter uses `candidateSetLocalKey` within this judgment. A binding is `{componentLocalKey,role}` and targets this judgment. Missing method is valid when no method applies. Missing own arrays mean undeclared; explicit `[]` means declared empty; null and owned undefined reject. Core alone determines content interpretation and valid shared grammar.

`formationRule:{conditions:[{kind:'interpreted',statement}]}` makes the authored statement a formation rule rather than an invented fixed result. An explicit empty condition set stays empty. Do not AND candidate-specific conditions into a global prerequisite. Public sources/notices are explicitly authored public identity and notice records, documented by Studio; private source paths and interview bodies must not be automatically published.

During `review`, the CLI emits `adoption_reply` with actual text, the current Studio review and a fresh `replyTo` ticket. Then send one interpretation:

```json
{"id":"choose-current","op":"interpret","data":{"replyTo":"COPY_CURRENT_TICKET","kind":"select","choices":[{"judgmentLocalKey":"observation","alternativeLocalKey":"preserve"}]}}
```

Select chooses exactly one current alternative for every group. Other supported kinds are `note`, `reject`, `confirm`, without `choices`. To revise, record the actual feedback, send a current `revise` operation, select again, request a fresh preview, then obtain a fresh final reply. A final confirmation binds the exact current preview, alternatives, context and adoption channel. The Agent interprets real language; it cannot fabricate a reviewer reply, role, message/review id or final digest through its pipe.

The pending review receives its final result after interpretation. There is no separate interpretation success reply. Reusing ids/tickets, changing role/channel, replacing the current review, EOF or input errors reject. Agent termination while waiting abandons the unexported session. Keep one request active; excess queued frames reject. No automatic decision or persistent replay/resume exists.

Export creates one exclusive private bundle and obtains `accepted_with_live_context` only after actual saved-byte readback. Static `verify` always retains `live_context:unavailable` and `creation_accepted:not_evaluated`; it cannot resurrect the capability. Core/Read and static evidence consistency remain separate from actual Agent adoption, verified identity, action permission, Authoring Fit/G4B and publication readiness. Legacy format1 and old completion markers require their original accepted graph and cannot be relabeled current.
