# AGENTS.md - Stendar-L (Public Protocol Repo)

## Repository scope

This repo contains only public protocol artifacts:

- `programs/stendar/` (Anchor program)
- `sdk/` (`@stendar/sdk`)
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
