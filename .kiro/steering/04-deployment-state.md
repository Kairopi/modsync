---
inclusion: always
---

# ModSync Deployment State (READ before any `devvit` CLI command)

The Reddit account, app slug, and test subreddit are locked. Do not change any of these without explicit user instruction.

## Connected accounts and resources

| Item | Value |
| ---- | ----- |
| Devvit CLI authenticated as | `u/Standard-Hotel6953` (verified via `npx devvit whoami`) |
| Test subreddit | `r/Modsynnow` (https://www.reddit.com/r/Modsynnow/, public, owner is the connected Reddit account) |
| App slug (immutable after first upload) | `modsync-set` |
| Brand name in copy / UI / docs | "ModSync" (display only — not the slug) |
| Token file location | `C:\Users\HP\.devvit\token` |

## Where each value appears (do not let any drift)

| Reference | Location | Value |
| --------- | -------- | ----- |
| App slug — `name` field | `devvit.json` line 3 | `modsync-set` |
| App slug — npm package name | `package.json` line 3 | `modsync-set` |
| App slug — lockfile root + first package | `package-lock.json` | `modsync-set` (both occurrences) |
| App slug — spec example | `.kiro/specs/modsync/design.md` (devvit.json sketch) | `modsync-set` |
| App slug — task acceptance | `.kiro/specs/modsync/tasks.md` (task 1.2) | `modsync-set` |
| Test subreddit — playtest target | `devvit.json` (added in task 1.2) | `Modsynnow` |
| Test subreddit — spec example | `.kiro/specs/modsync/design.md` | `Modsynnow` |
| Test subreddit — task acceptance | `.kiro/specs/modsync/tasks.md` (task 1.2) | `Modsynnow` |

If any subagent edits any of these fields to a different value, STOP and surface the conflict to the user. Do not silently rename.

## CLI commands the user has run (and their outcomes)

1. ✅ `npx devvit logout` — wiped a stale token from a prior account
2. ✅ `npx devvit login` — OAuth flow as `u/Standard-Hotel6953`, token saved
3. ✅ `npx devvit whoami` — confirmed `Logged in as u/Standard-Hotel6953`

## CLI commands the user has NOT yet run (gated)

- ❌ `npm run dev` (= `devvit playtest`) — DO NOT run until task 1.1 + 1.2 land. Running it now uploads a half-template / half-modsync bundle to Reddit's app directory under slug `modsync-set` permanently. First impression matters; we want the first upload to be the spec-aligned wiring, not the template stub.
- ❌ `devvit upload` (production deploy) — only after all tasks complete and the build is fully verified.

## After first `devvit upload` (will happen later)

After the first upload, Devvit auto-creates an app account `u/modsync-set`. The user must invite this account as a moderator of `r/Modsynnow` with full permissions before flipping `seedEnabled` on.

## Tokens to ignore

The user has pasted three different `npm create devvit@latest <token>` commands during this session. ALL THREE are wizard-shortcut tokens for fresh-scaffolded projects. They include a hardcoded project name encoded in protobuf field 2:

| Token | Hardcoded name | Action |
| ----- | -------------- | ------ |
| `Ch53eWR3MGpWRC10VkV1TWxkSmxNNDZhWngyU1pxQUESCm1vZHN5bi1jaHEaCG1vZC10b29s` | `modsyn-chq` (typo) | IGNORE |
| `Ch5yMHFPUWNsdXlXcTlMaEt2X0V4MHFRQ3NYZFd2NEESC21vZHN5bmMtc2V0Gghtb2QtdG9vbA==` | `modsync-set` | IGNORE (we already use this name in the existing workspace) |
| `Ch5tWWp3b1ZMZUhOU2d2aWRxUW5EYW5yR0FjczhEMVESC21vZHN5bi0tc2V0Gghtb2QtdG9vbA==` | `modsyn--set` (typo, double hyphen) | IGNORE |

Running ANY of these commands creates a fresh sibling directory and wipes the existing workspace's spec, steering, and hooks. We are past scaffolding. The auth token they embed is moot because we already have a saved token via `devvit login`.
