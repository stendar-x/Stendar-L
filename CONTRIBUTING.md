# Contributing

## Development setup

1. Install Node.js 20+ and npm.
2. Install Rust toolchain and Solana/Anchor tooling if you are modifying on-chain code.
3. Run `npm ci` at repo root and `npm --prefix sdk ci`.

## Pull requests

- Create a feature branch from `main`.
- Keep changes focused; include tests with every functional change.
- If a change modifies the on-chain program/IDL, update SDK types and `sdk/src/idl/stendar.json` in the same PR.
- Run:
  - `npm run test:regression`
  - `npm --prefix sdk test`

## Security reporting

Do not open public issues for vulnerabilities. Contact the maintainers privately.
