# Contributing to KDNA

This repository is the KDNA protocol specification. You can contribute at multiple levels.

## Prerequisites

- **Node.js >= 18** (check: `node --version`)
- **npm** (comes with Node.js)
- **Python 3** (needed for `.kdna` ZIP packaging; check: `python3 --version`)
- **Git** (for submitting PRs)

### Developer Setup

```bash
git clone https://github.com/aikdna/kdna.git
cd KDNA
npm install
npm test         # kdna-core unit tests
```

For CLI development, see the [kdna-cli](https://github.com/aikdna/kdna-cli) repository.

### Available Scripts

| Script | Purpose |
|--------|---------|
| `npm test` | Run kdna-core test suite |
| `npm run lint` | ESLint code quality check |
| `npm run format:check` | Prettier format validation |
| `npm run lint:examples` | Validate example domains via kdna-lint |
| `npm run validate:examples` | Schema-validate example domains |

## Contribution Types

### 1. Protocol Contribution
Improve the KDNA specification, schema, validators, CLI, loader, skills, or documentation.

**Scope:** SPEC.md, schema/*, packages/kdna-core/*, docs/*

### 2. Judgment Pattern Contribution
Submit a reusable judgment pattern — the smallest unit of KDNA.

**Template:**
```
Pattern ID: (e.g., discussion-vs-decision)
Surface Signal: (what the user says or what data shows)
Common Misread: (how ordinary AI gets this wrong)
Expert Frame: (how an expert re-interprets the signal)
Diagnostic Questions: (what to ask before acting)
Decision Boundary: (when to classify as unresolved)
Action Implication: (what follows from the judgment)
Positive Cases: (at least 2 examples where the pattern works)
Negative Cases: (at least 1 example where the pattern should NOT trigger)
```

**Submit to:** `benchmarks/judgment-benchmark.json` via PR

### 3. KDNA Example Contribution
Submit a packaged `.kdna` example candidate.

1. Create or adapt the judgment through the official toolchain.
2. Export a packaged `.kdna` file.
3. Run `kdna validate`, `kdna plan-load`, and `kdna load`.
4. Provide a release card: SHA256, usage commands, before/after evidence,
   applies/does-not-apply boundaries, known limitations, and provenance
   metadata.
5. Source JSON may be used for authoring or audit, but it is not the public
   consumption unit.

### 4. Case Contribution
Submit test cases that prove KDNA changes judgment.

Add entries to existing domain `tests/before-after.json` or submit new test files following the format:
```json
{
  "input": "...",
  "without_kdna": { "expected_approach": "...", "common_mistake": "..." },
  "with_kdna": { "expected_approach": "...", "signal_reading": "...", "diagnosis_path": "..." },
  "domain": "...",
  "trigger": "..."
}
```

### 5. Composition Contribution
Submit composition guidance for multiple packaged `.kdna` files.

1. Reference packaged `.kdna` files by file identity, version, and optional
   digest.
2. Include composition rules and routing questions.
3. Do not turn a source directory or registry entry into the user-facing asset.

### 6. Evaluation Report Contribution
Submit a report comparing agent judgment with and without KDNA.

Include: domain name, model used, test cases, baseline scores, KDNA-loaded scores, specific improvements observed.

## Quality Requirements

All contributions must:
- Pass `kdna dev validate` (for packages) or JSON schema validation (for clusters)
- Have unique IDs across the submission
- Include reasons for every banned term and key distinctions for every misunderstanding
- Not contain proprietary or private data
- Use clear domain boundaries

## License

- Code contributions: Apache 2.0
- Documentation and examples: CC BY 4.0
- Domain assets: Contributor's choice (CC BY 4.0 recommended for open domains)
