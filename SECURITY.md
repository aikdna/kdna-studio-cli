# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in a KDNA project, please **do not** open a public issue.

Email: **security@aikdna.com**

We will respond within 48 hours and work with you on a coordinated disclosure timeline.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| latest  | ✅ Active support  |
| < latest| ❌ Upgrade required |

## Security Model

KDNA assets (.kdna files) and Work Packs may contain encrypted or licensed content. The security of these assets depends on:

1. **Ed25519 signatures** — for asset authenticity
2. **AES-256-GCM encryption** — for licensed/protected content
3. **Argon2id key derivation** — for password-protected assets (RFC-0009)

If you find a weakness in any of these mechanisms, please report it immediately.

## Best Practices for Contributors

- Never commit secrets, API keys, or credentials
- Use signed commits when possible
- Review your PRs for accidental inclusion of sensitive data
- Keep dependencies up to date

## Disclosure Policy

We follow a 90-day responsible disclosure timeline:
- Day 0: Report received
- Day 3: Initial acknowledgment
- Day 30: Fix developed
- Day 90: Public disclosure (coordinated with reporter)
