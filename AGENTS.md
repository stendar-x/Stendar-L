# AGENTS.md - Stendar-L (Public Protocol Repo)

## Repository scope

This repo contains only public protocol artifacts:

- `programs/stendar/` (Anchor program)
- `sdk/` (`@stendar-x/sdk`)
- `transparency/` (public methodology/docs)
- `security/` manifests
- protocol tests and CI

No frontend/backend app code, infra secrets, or operational configs belong here.

## Git workflow rules

- Always use a feature branch.
- Never push directly to `main`.
- Land changes via pull request only.
- Branch naming: `feat/<description>`, `fix/<description>`, `chore/<description>`.

### Commit conventions

- Use conventional commits with scope:
  - `program`, `sdk`, `transparency`, `security`, `tests`, `ci`
- Examples:
  - `feat(program): add partial liquidation instruction`
  - `fix(sdk): update direct client account parser`
  - `docs(transparency): update feature request data policy`

### IDL coupling requirement

If a PR changes the on-chain program and IDL, it must also update SDK types and `sdk/src/idl/stendar.json` in the same PR.

### Releases

- Tag releases with semver (`v0.1.0`, `v0.1.1`, ...)
- Publish SDK from `sdk/` after merge:
  - `npm --prefix sdk version patch`
  - `npm --prefix sdk publish`

## Security rules

Never commit secrets, keys, or env files. Specifically disallowed:

- `.env`, `.env.*`, `**/.env*`
- `*wallet*.json`, `*authority*.json`, `scheduler-wallet.json`
- infra configs that include private service secrets

Before committing:

- `git diff --cached --name-only`
- verify staged files do not include disallowed paths

## Validation commands

- `npm run test:regression`
- `npm --prefix sdk test`
- `npm run idl:check`

## Cursor Cloud specific instructions

This is a protocol-only repo (no frontend/backend apps to start). Development readiness means all tests pass.

### Two independent dependency trees

Root `package.json` and `sdk/package.json` have separate lockfiles. Always run `npm ci` at both locations after pulling changes.

### Running tests

All four CI-equivalent checks can be run without any external services, wallets, or Solana validator:

- **Protocol regression tests:** `npm run test:regression` (ts-mocha, pure PDA derivation logic)
- **SDK build + unit tests:** `npm --prefix sdk test` (builds TS then runs `node --test`)
- **Rust program tests:** `cargo test --manifest-path programs/stendar/Cargo.toml`
- **Audit gate:** `npm run audit:gate`

### Node.js deprecation warning

`ts-mocha` triggers a `[DEP0040] punycode` deprecation warning on Node 22+. This is harmless and can be ignored.

- **Scoped npm SDK installs**: Immediately after publishing `@stendar-x/sdk`, `npm view @stendar-x/sdk` may return 404 while the tarball URL already resolves. If installs fail during this window, use `https://registry.npmjs.org/@stendar-x/sdk/-/sdk-0.1.0.tgz` as a temporary lockfile source and retry normal semver installs later.

### Anchor / Solana CLI

Anchor CLI and Solana CLI are **not** required for running tests or SDK development. They are only needed if you are building the on-chain program (`anchor build`) or running on-chain integration tests (`anchor test`). The IDL check (`npm run idl:check`) requires a prior `anchor build` output in `target/idl/`.
