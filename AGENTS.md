# AGENTS.md

## Repository structure

- `programs/stendar/` — Anchor on-chain program (Rust)
- `sdk/` — `@stendar-x/sdk` TypeScript SDK
- `transparency/` — public methodology and data-handling documentation
- `security/` — collateral listing manifests, build verification, and schemas
- `tests/` — protocol regression tests

## Build and test

Two independent dependency trees exist at the root and `sdk/`. Install both after cloning:

```bash
npm ci
npm --prefix sdk ci
```

For a full local CI-equivalent pass, run:

```bash
npm run test:ci
npm --prefix sdk test
cargo test --manifest-path programs/stendar/Cargo.toml
```

GitHub CI also runs release-guard checks that ensure testing-only program features
and instructions are excluded from deployable builds.

`npm run test:ci` expands to the root gate commands:

- `npm run test:security-scripts`
- `npm run test:pending:deterministic`
- `npm run test:regression`
- `npm run idl:check:if-present`
- `npm run audit:gate`

Checks that require Anchor artifacts or integration context:

- `npm run idl:check` requires `target/idl/stendar.json` from a prior `anchor build`.
- `npm run test:revolving` requires Anchor-compatible integration setup and a funded
  wallet context.
- `Anchor.toml` defaults provider cluster to `devnet` and wallet to
  `~/.config/solana/id.json`.

`ts-mocha` triggers a `[DEP0040] punycode` deprecation warning on Node 22+. This is harmless.

Anchor CLI and Solana CLI are required for building (`anchor build`) and on-chain integration tests (`anchor test`), but not for running the test suite above.
