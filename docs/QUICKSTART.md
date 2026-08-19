# Expert Creation Quickstart

Status: published `0.11.0` Studio CLI. This is the fastest path from your own
judgment to a validated, loadable `.kdna` asset. It assumes no LLM provider
and no Studio app; everything below runs with the two published CLIs only.

Target time: under 1 hour from empty directory to a loaded Runtime Capsule.
The command steps themselves take a few seconds; the real time is the thinking
you put into your judgment.

## Prerequisites

```bash
npm install -g @aikdna/kdna-cli @aikdna/kdna-studio-cli
```

Requires Node.js 22 or later.

## Path 1 — Manual card authoring (interview-first, no LLM)

Use this when you already know your judgment and just need to write it down
as an asset. "Interview-first" here means articulating your judgment directly;
the AI `interview` command (see [AI-assisted authoring](#ai-assisted-authoring))
is a separate, LLM-required surface.

```bash
# 1. Create the Studio project
kdna-studio create my_expertise --name @yourscope/my_expertise

# 2. Add one judgment card (an axiom with applicability boundaries)
kdna-studio card add my_expertise axiom \
  --field one_sentence="Prefer specific evidence over broad claims." \
  --field full_statement="When reviewing content, prefer specific evidence over broad claims because unsupported generalizations make the judgment impossible to verify or improve." \
  --field why="Broad claims hide the actual reason for a judgment." \
  --field applies_when='["reviewing content"]' \
  --field does_not_apply_when='["pure formatting"]' \
  --field failure_risk="generic advice" \
  --field confidence="high" \
  --field evidence_type="practice"

# 3. Review and approve for export
kdna-studio card list my_expertise
kdna-studio card approve my_expertise --all \
  --by your-id --statement "I confirm this judgment for export."

# 4. Export the .kdna asset
kdna-studio export my_expertise --out ./my_expertise.kdna
```

## Path 2 — Material-first authoring (distill candidates, no LLM)

Use this when you already have source material (notes, articles, reviews) and
want to extract candidate judgments, review them, then promote the ones you
accept into cards.

```bash
# 1. Create the project and declare a distillation target
kdna-studio create my_domain --name @yourscope/my_domain
kdna-studio target declare my_domain \
  --category expression_writing --scope personal \
  --granularity core_principles --task "longform article review" \
  --include "argument structure,tone,revision" \
  --exclude "life habits,food preference"

# 2. Load pre-generated candidates (JSON array)
kdna-studio distill my_domain --candidates ./candidates.json

# 3. Review candidates
kdna-studio candidate list my_domain
```

`candidates.json` is a JSON array; each item maps to one candidate:

```json
[
  {
    "id": "c1",
    "one_sentence": "Prefer specific evidence over broad claims",
    "full_statement": "When reviewing content, prefer specific evidence over broad claims because unsupported generalizations make the judgment impossible to verify or improve.",
    "suggested_card_type": "axiom",
    "confidence": "high",
    "why": "Broad claims hide the actual reason for a judgment.",
    "applies_when": ["reviewing content"],
    "does_not_apply_when": ["pure formatting"],
    "misuse_risk": "generic advice"
  }
]
```

> **Scope gate.** `distill` marks each candidate in or out of scope against the
> declared `target`. A candidate whose declared applicability does not textually
> match the target's `--include`/`--task` is shown `[OUT_OF_SCOPE]`. That is a
> review signal, not a dead end. Accept the candidate, then if it is still
> flagged out of scope, override the gate intentionally before promoting:

```bash
kdna-studio candidate accept my_domain <candidate-id>
kdna-studio candidate override my_domain <candidate-id>   # only if OUT_OF_SCOPE
kdna-studio candidate promote my_domain

# 4. Approve and export, same as Path 1
kdna-studio card approve my_domain --all \
  --by your-id --statement "I confirm this judgment for export."
kdna-studio export my_domain --out ./my_domain.kdna
```

## Validate and load (both paths)

```bash
kdna validate ./my_expertise.kdna
kdna plan-load ./my_expertise.kdna
kdna load ./my_expertise.kdna --profile=compact --as=prompt
```

Expected validation result:

```json
{
  "format_valid": true,
  "schema_valid": true,
  "payload_valid": true,
  "checksums_valid": true,
  "load_contract_valid": true,
  "overall_valid": true,
  "problems": []
}
```

## AI-assisted authoring

The expert `distill --ai` and `interview` commands use a configured external
model provider and require `kdna-studio llm config` (provider, model, API key,
base URL). They are optional; the two paths above do not need them.

```bash
printf '%s\n' "$KDNA_LLM_API_KEY" | \
  kdna-studio llm config --provider openai --model gpt-4o --key-pipe
```

External providers require an HTTPS base URL; plain HTTP is accepted only for
local development at `127.0.0.1` or `[::1]`.

## Next

- Load the result into an AI host:
  [15-minute agent guide](https://github.com/aikdna/kdna/blob/main/docs/15-minute-agent-guide.md).
- Full manual authoring walkthrough:
  [30-minute authoring guide](https://github.com/aikdna/kdna/blob/main/docs/30-minute-authoring-guide.md).
