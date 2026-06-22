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

## Developer Certificate of Origin (DCO)

All commits must include a `Signed-off-by:` line. Use `git commit -s` to add it automatically.

This certifies that you wrote the code or have the right to submit it under the project's license (Apache-2.0). No CLA is required.
