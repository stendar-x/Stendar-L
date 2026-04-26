# AGENTS.md

## Repository structure

- `programs/stendar/` — Anchor on-chain program (Rust)
- `sdk/` — `@stendar-x/sdk` TypeScript SDK
- `transparency/` — public methodology and data-handling documentation
- `security/` — collateral listing manifests and schema
- `tests/` — protocol regression tests

## Build and test

Two independent dependency trees exist at the root and `sdk/`. Install both after cloning:

```bash
npm ci
npm --prefix sdk ci
```

All CI-equivalent checks run without external services, wallets, or a Solana validator:

| Check | Command |
|-------|---------|
| Protocol regression tests | `npm run test:regression` |
| Revolving lifecycle integration (validator required) | `npm run test:revolving` |
| SDK build + unit tests | `npm --prefix sdk test` |
| Rust program tests | `cargo test --manifest-path programs/stendar/Cargo.toml` |
| Audit gate | `npm run audit:gate` |

The IDL check (`npm run idl:check`) requires a prior `anchor build` output in `target/idl/`.
The revolving lifecycle test (`npm run test:revolving`) requires Anchor-compatible integration test setup (e.g. running via `anchor test` / local validator context).

`ts-mocha` triggers a `[DEP0040] punycode` deprecation warning on Node 22+. This is harmless.

## Code conventions

- Branch naming: `feat/<description>`, `fix/<description>`, `chore/<description>`
- Conventional commits with scope: `program`, `sdk`, `transparency`, `security`, `tests`, `ci`
- If a change touches the on-chain program and IDL, also update SDK types and `sdk/src/idl/stendar.json` in the same change.
- Anchor CLI and Solana CLI are required for building (`anchor build`) and on-chain integration tests (`anchor test`), but not for running the test suite above.

## Security

Never commit secrets, keys, or env files:

- `.env`, `.env.*`, `**/.env*`
- `*wallet*.json`, `*authority*.json`, `*-keypair.json`

Before committing, run `git diff --cached --name-only` and verify no disallowed paths are staged.
