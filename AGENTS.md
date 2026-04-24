# AGENTS.md

## Purpose

This file defines lightweight guidance for AI agents working in the T4 monorepo.
T4 is currently internal-only. Optimize for fast iteration, short feedback loops, and practical reliability.

## Project Priorities

1. Developer velocity first.
2. Reliability where it protects active team workflows.
3. Keep behavior predictable enough for day-to-day use.

If tradeoffs are needed, choose the option that unblocks the team while avoiding obvious breakage in core paths.

## Done Criteria (Internal)

- Run only the checks relevant to the change scope.
- Prefer targeted validation over full-suite validation unless the change is broad or risky.
- Do not claim behavior changed unless it was verified through a command, test, or manual check.
- Update docs only when behavior, commands, or workflows materially changed.
- Avoid release-grade hardening steps unless explicitly requested for a release task.

## Recommended Validation by Change Type

- UI-only tweak:
  - `bun run typecheck` for touched packages
  - quick manual verification in the affected flow
- Server/provider logic:
  - focused tests around changed code paths
  - `bun run typecheck`
- Shared contracts/types:
  - focused tests plus typecheck across dependent packages
- Broad or risky refactor:
  - run `bun run fmt`, `bun run lint`, `bun run typecheck`, and `bun run test`

Use judgment. For small internal iterations, fast targeted checks are preferred.

## Architecture Snapshot

- `apps/server`: provider sessions, orchestration, websocket server
- `apps/web`: React/Vite UI and session UX
- `apps/desktop`: Electron shell and desktop integrations
- `packages/contracts`: schemas/contracts only (no runtime logic)
- `packages/shared`: shared runtime utilities

Prefer extracting reusable shared logic over copy-paste fixes.

## Provider Runtime Notes

T4 presents one orchestration and websocket surface and routes provider-native behavior through adapters and managers.

- Codex: `apps/server/src/codexAppServerManager.ts`
- GitHub Copilot: `apps/server/src/copilotAcpManager.ts`
- OpenCode: `apps/server/src/opencodeAcpManager.ts`
- Kimi: `apps/server/src/kimiAcpManager.ts`
- Pi SDK: `apps/server/src/piSdkManager.ts`
- shared routing: `apps/server/src/provider/Layers/ProviderService.ts`
- websocket boundary: `apps/server/src/wsServer.ts`

When adding provider support, prefer native app-server or ACP style integrations where possible.

## Working Style for Agents

- Inspect relevant code before editing.
- Keep changes focused and avoid unnecessary churn.
- If required context is missing, ask one minimal clarifying question.
- Do not leave placeholder TODOs unless explicitly requested as staged work.
- For review tasks, report concrete findings with file references.

## Documentation Expectations

- Keep docs practical and lightweight for internal development.
- Update only docs that are directly affected by the change.
- If docs are obviously stale in touched areas, fix them in the same change.

## T4 Init Snapshot

- Workspace root: `T4-Code`
- Package manager: `bun`
- Common scripts: `fmt`, `lint`, `typecheck`, `test`, `dev:web`, `dev:server`, `dev:desktop`

Keep this file aligned with current workflows and project goals.
