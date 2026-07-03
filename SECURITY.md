# Security Policy

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, use one of these private channels:

- **GitHub Private Vulnerability Reporting**: Go to the [Security Advisories](https://github.com/aikdna/kdna-studio-cli/security/advisories/new) page
- **Email**: security@aikdna.com

We aim to respond within 72 hours and provide a timeline for resolution within
1 week. Please do not disclose the vulnerability publicly until we have had a
chance to address it.

## Supported Versions

We actively support the latest mainline release for security updates.

| Component | Supported Versions |
|-----------|-------------------|
| KDNA Protocol | Latest tagged release in `aikdna/kdna` |
| kdna-studio-cli | Latest mainline release |
| kdna-studio-core | Latest mainline release |
| kdna-cli | Latest minor release |

Older versions may receive critical security patches on a case-by-case basis.

## About This Package

This package (`kdna-studio-cli`) is a **CLI authoring tool** for creating, migrating, and exporting KDNA assets. Its security posture depends on:

- **`aikdna/kdna-core`** — crypto profiles, container validation, LoadPlan authorization
- **`aikdna/kdna-cli`** — protect/unlock/recover/license commands via Core

This package does NOT implement cryptographic primitives directly. For the
canonical security model, see
[GOVERNANCE.md](https://github.com/aikdna/kdna/blob/main/docs/GOVERNANCE.md)
in the main protocol repository.

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
