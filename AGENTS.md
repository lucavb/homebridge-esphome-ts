# AGENTS.md

## Committing

- `gpg failed to sign the data` here — the keyring is sandbox-blocked. Always `git commit --no-gpg-sign`.
- `npm run verify` is the full battery (lint, typecheck, build, format, tests, dist ESM smoke). Run it before every commit.
- Never push, close PRs or issues, or comment on GitHub — remote mutations are the user's.

## State

- Multi-phase work keeps its progress in `.slim/deepwork/` (gitignored). Read it before planning large work; update it after major steps.
- Review-enforced rules live in `CODING_STANDARDS.md` — read it before reviewing a diff.
