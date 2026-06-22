# Contributing

This is the KDNA Studio CLI repository. Contribution guidelines follow the [main KDNA repo](https://github.com/aikdna/kdna/blob/main/CONTRIBUTING.md).

Key points:
- Submit changes via pull request to `main`.
- Sign off commits: `git commit -s`.
- Do NOT restore legacy commands, registry, v2 support.
- Studio CLI changes must be verified with `npm test` (21 tests).
- Include verification commands in PR description.

## Repository-specific notes
- The Studio CLI depends on `@aikdna/kdna-studio-core` for compilation and export.
- Card type definitions live in the Studio Core, not here.
- The `bin/kdna-studio.js` file is the CLI entry point.
