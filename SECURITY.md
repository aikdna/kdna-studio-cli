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

The current source candidate, `@aikdna/kdna-studio-cli@0.13.0-rc.components.1`,
is a terminal Host for typed Studio creation, bundle verification and explicit
Read. Its current commands are `session`, `verify` and `read`, with `help`,
`--help` and `--version`. The [command contract](docs/CREATION_COMMAND_CONTRACT.md)
defines their inputs and rejection boundaries.

The current graph binds Studio `4.0.0-rc.components.1`, Core
`0.24.0-rc.component-semantics.2` and Read `0.3.0-rc.component-semantics.2`:

- Core admits captured asset bytes; Studio owns creation, saved-byte completion
  and evidence checks; Read owns request admission, scope, exact selection and
  disclosure budgets. `read` requires explicit `--allow-read` permission.
- Before loading dependencies or materials, the Host checks installed member
  sets, bytes, versions and the shared Core resolution against
  [`src/public-bindings.json`](src/public-bindings.json). Archive equality is a
  local content observation. Installation approval and provider-process trust
  remain separate Host decisions.
- Session operations use a private Agent pipe and a separate live adoption
  channel. Human-declared review and explicitly delegated Agent adoption are
  distinct records. File descriptors, transcripts and delegation statements do
  not authenticate a person, Agent or provider process.
- Reopened bundle consistency does not restore live creation acceptance or
  establish identity, action authorization or storage durability. Embeddings
  that require offline processing must enforce network restrictions themselves;
  npm's `--offline` option is not a network boundary.

Treat materials, stdout JSON, adoption replies, stderr previews and exported
bundles as private data. The current entry supplies no model provider,
credential-configuration workflow, encryption/licensing commands or action
execution.

This package does NOT implement cryptographic primitives directly. For the
canonical security model, see
[GOVERNANCE.md](https://github.com/aikdna/kdna/blob/main/docs/GOVERNANCE.md)
in the main protocol repository.

### Credential Handling for Published 0.11.0

Deployments retaining published `@aikdna/kdna-studio-cli@0.11.0` should keep its
[versioned credential-handling policy](https://github.com/aikdna/kdna-studio-cli/blob/d6914ea132d2dc0dad717db03a0320b1d6a06ef9/SECURITY.md#api-key-handling)
and command documentation. That policy covers the older LLM workflows such as
`distill` and `interview`: use `--key-pipe` or the documented provider environment
variable instead of exposing an API key in `--key` or `-k`. It also prohibits
passwords and identity passphrases in process arguments and specifies
`--password-stdin` and `--passphrase-stdin` for those inputs.

These are the published 0.11.0 policy's inputs, not flags or commands offered by
the current typed `session`/`verify`/`read` entry. The supported-version and
case-by-case security-update policy above still applies.

## Best Practices

- Never commit secrets, API keys, or credentials
- Use signed commits when possible
- Review your PRs for accidental inclusion of sensitive data
- Keep dependencies up to date
