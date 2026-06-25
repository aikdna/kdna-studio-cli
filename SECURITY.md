# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in KDNA, please **do not** open a public issue.

Email: **security@aikdna.com**

We will respond within 48 hours and work with you on a coordinated disclosure timeline.

## About This Package

This package (`kdna-studio-cli`) is a **CLI authoring tool** for creating, migrating, and exporting KDNA assets. Its security posture depends on:

- **`aikdna/kdna-core`** — crypto profiles, container validation, LoadPlan authorization
- **`aikdna/kdna-cli`** — protect/unlock/recover/license commands via Core

This package does NOT implement cryptographic primitives directly. For the canonical security model, see `aikdna/kdna`.

### API Key Handling

If you use the LLM features (`distill`, `interview`, etc.), provide your API key via:
- `KDNA_API_KEY` environment variable (preferred)
- `--key-pipe` (stdin, one-shot read)

The deprecated `--key` flag passes the key via process arguments and should not be used in automated environments.

## Best Practices

- Never commit secrets, API keys, or credentials
- Use signed commits when possible
- Review your PRs for accidental inclusion of sensitive data
- Keep dependencies up to date
