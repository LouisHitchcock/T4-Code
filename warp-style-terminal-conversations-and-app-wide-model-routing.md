# Warp-Style Terminal Conversations and App-Wide Model Routing

## Summary

This fork should mirror the current Warp behavior in four ways: terminal commands can live inside the conversation, attached terminal state becomes automatic context, active PTYs can be shared with the agent, and model selection can fall back through a predefined chain before user-visible failure. The Warp behaviors this plan is intentionally matching are documented in Warp’s Agent Mode, Blocks as Context, Full Terminal Use, Model Choice, and BYOK docs: https://docs.warp.dev/features/warp-ai/agent-mode, https://docs.warp.dev/agents/using-agents/agent-context/blocks-as-context, https://docs.warp.dev/agents/full-terminal-use, https://docs.warp.dev/agent-platform/capabilities/model-choice, https://docs.warp.dev/support-and-community/plans-and-billing/bring-your-own-api-key.

The implementation should be split into three coordinated workstreams: thread-attached terminal runs and `!` execution, agent-facing terminal control with a safe auto-approve toggle, and one app-wide local-first model routing chain with API fallbacks. Existing direct provider/model flows stay intact for compatibility, but CUT3 gains a new app-default routing mode and a first-class terminal conversation layer.

## Workstream 1: Terminal Runs Become First-Class Conversation Artifacts

- Add a new orchestration read-model concept for thread terminal runs instead of overloading chat messages or generic work-log activities.
- Define `OrchestrationTerminalRun` in `packages/contracts/src/orchestration.ts` with: `id`, `threadId`, `terminalId`, `source`, `origin`, `command`, `cwd`, `attachedToConversation`, `status`, `createdAt`, `updatedAt`, `completedAt`, `exitCode`, `exitSignal`, and `previewText`.
- Add new orchestration commands and events for terminal lifecycle:
  - `thread.terminal.run`
  - `thread.terminal.attach`
  - `thread.terminal.detach`
  - `thread.terminal.status-updated`
  - `thread.terminal.output-appended`
  - `thread.terminal.completed`
- Keep full transcript persistence in the existing terminal log files under `apps/server/src/terminal/Layers/Manager.ts`; do not store full PTY history in the projection DB or main snapshot payload.
- Add a non-mutating terminal inspection method in `packages/contracts/src/ws.ts` and `packages/contracts/src/ipc.ts`:
  - `terminal.inspect`
  - response shape: `threadId`, `terminalId`, `status`, `history`, `cwd`, `command`, `startedAt`, `completedAt`, `exitCode`, `exitSignal`
- Extend `apps/server/src/wsServer.ts` to expose `terminal.inspect` without spawning or restarting a PTY.
- Add a terminal conversation coordinator on the server, implemented alongside orchestration, that subscribes to terminal events, updates terminal-run metadata, and writes preview tails into projection state.
- Update `apps/server/src/orchestration/decider.ts`, `projector.ts`, `Layers/ProjectionPipeline.ts`, and `Layers/ProjectionSnapshotQuery.ts` so terminal runs are replayable and survive reloads/reconnects.
- Extend `apps/web/src/types.ts`, `session-logic.ts`, and `MessagesTimeline.tsx` so timeline entries can include a new `terminal-run` row type.
- Render terminal runs as full transcript chat blocks in `apps/web/src/components/chat/MessagesTimeline.tsx`, with live streaming output, exit status, and an expand/collapse control for large transcripts.
- Keep virtualization friendly: timeline rows render `previewText` immediately and lazy-load full transcript through `terminal.inspect` when expanded.
- Commands started with `!` are always `attachedToConversation = true` and therefore automatically appear in the timeline and become context for future turns.
- Existing drawer terminals are not auto-attached by default; they gain an explicit `Attach to chat` / `Detach from chat` control in `apps/web/src/components/ThreadTerminalDrawer.tsx`.
- When a drawer terminal is attached, its live PTY buffer is mirrored into a terminal-run row in the conversation and remains scoped to that thread only.

## Workstream 2: `!` Composer Execution and Agent Terminal Control

- Extend `apps/web/src/composer-logic.ts` with standalone bang-command parsing.
- Exact parsing rule: when the trimmed composer value starts with `!`, contains no attachments, and is a standalone command input, CUT3 runs it locally instead of dispatching a provider turn.
- Exact command normalization rule: strip the leading `!`, preserve the rest verbatim, reject empty commands, and reject mixed `!` plus freeform chat text in the same submission.
- `!` runs in the active thread workspace cwd, reusing the thread’s current terminal runtime env from `ChatView.tsx`.
- Implement `thread.terminal.run` dispatch from `apps/web/src/components/ChatView.tsx` instead of `thread.turn.start` for bang submissions.
- For shell compatibility, the server launches `!` commands through the platform shell:
  - Windows: `powershell.exe -NoLogo -NoProfile -Command <command>`
  - POSIX: `/bin/sh -lc <command>`
- `!` commands create a dedicated hidden terminal id per run, not the drawer’s default shell terminal id.
- Add a toolbar toggle in `apps/web/src/components/ChatView.tsx` for `Auto-approve safe terminal commands`.
- Persist the toggle in app settings as `autoApproveSafeTerminalCommands`, default `false`.
- The toggle is only interactive in `Supervised` runtime mode; in `Full access` it is visually disabled because approvals are already bypassed.
- Implement the safety classifier in shared runtime code, preferably `packages/shared/src/terminalApprovalPolicy.ts`, and evaluate it before persisted approval rules.
- Auto-approve only applies to command-execution approvals originating from CUT3 terminal runs or attached CUT3 terminals inside the current workspace.
- Commands that match the dangerous-command matcher stay manually gated even when auto-approve is enabled.
- The v1 dangerous matcher must treat these as non-auto-approvable: `rm`, `rmdir`, `unlink`, `del`, `erase`, `rd`, `Remove-Item`, `shred`, `sdelete`, `dd`, `mkfs`, `format`, `diskpart`, `fdisk`, `parted`, `mount`, `umount`, `shutdown`, `reboot`, `halt`, `poweroff`, `git reset --hard`, `git clean -fd`, `git checkout --`, `git restore --source`, `curl ... | sh`, `wget ... | sh`, `Invoke-WebRequest ... | iex`, `irm ... | iex`.
- For agent control, introduce a CUT3-native terminal tool path that targets attached terminals and terminal runs.
- Scope the CUT3-native terminal tool to the new CUT3-managed local/API backends in v1.
- Existing external CLI-backed providers keep their native tool execution path; they can consume attached terminal transcripts as context, but they do not gain direct PTY control unless their adapter can explicitly route tool calls into the CUT3 terminal tool later.
- When an attached terminal is active, future turns automatically include a capped tail of its transcript in server-side turn context assembly inside `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`.
- Exact context cap for v1: include at most the 3 most recent attached terminal runs, at most 300 lines total, and at most 24,000 characters total, newest-first, preserving command headers and exit status.

## Workstream 3: App-Wide Local-First Model Routing With API Fallbacks

- Add an explicit routing mode to orchestration rather than magic model slugs.
- Extend `packages/contracts/src/orchestration.ts` thread and turn-start contracts with `modelSelectionMode: "direct" | "app-default"`.
- In `direct` mode, CUT3 behaves exactly as it does today.
- In `app-default` mode, CUT3 ignores per-thread provider/model as execution targets and instead resolves the turn through one global routing chain stored in app settings.
- Add these settings in `apps/web/src/appSettings.ts`:
  - `modelRoutingEnabled: boolean`
  - `appModelRoutingChain: RoutingChainEntry[]`
  - `ollamaBaseUrl: string`
  - `openAiCompatibleBaseUrl: string`
  - `openAiCompatibleApiKey: string`
- Define `RoutingChainEntry` in contracts with: `id`, `enabled`, `provider`, `model`, `priority`, `requiresTools`, `displayName`.
- V1 local backends are exactly:
  - `ollama`
  - `openai-compatible`
- Implement them as CUT3-managed providers by extending `ProviderKind` and provider routing contracts in `packages/contracts/src/orchestration.ts`, `packages/contracts/src/provider.ts`, and `packages/contracts/src/server.ts`.
- Use one shared server-side manager for OpenAI-compatible chat/tool-calling requests, with thin provider adapters for `ollama` and `openai-compatible`.
- Ollama discovery and health use official endpoints:
  - model discovery via `/api/tags` or `/v1/models`
  - tool-capable execution via Ollama’s OpenAI compatibility and tool-calling support
  - docs used for this choice: https://docs.ollama.com/api/tags, https://docs.ollama.com/openai, https://docs.ollama.com/capabilities/tool-calling
- Generic OpenAI-compatible discovery uses `GET /v1/models`; execution requires tool-calling-capable chat/responses compatibility.
- Extend `apps/server/src/provider/Layers/ProviderHealth.ts` and `packages/contracts/src/server.ts` so provider health includes `ollama` and `openai-compatible`.
- Add `supportsTools?: boolean` to `ServerProviderModel` so routing can skip models that cannot drive CUT3 terminal tools.
- Add provider picker sections and settings UI for `Ollama`, `OpenAI-compatible`, and `Auto (App routing)` in:
  - `apps/web/src/session-logic.ts`
  - `apps/web/src/lib/modelPickerHelpers.ts`
  - `apps/web/src/components/chat/ProviderModelPicker.tsx`
  - `apps/web/src/components/ChatView.tsx`
- The chain editor lives in Settings and is app-wide only. There is exactly one chain, no per-project chain and no named profiles.
- Routing algorithm for `app-default` mode:
  - Refresh provider health and available models.
  - Filter to enabled chain entries.
  - Skip entries that are unavailable, unauthenticated, missing the target model, or missing tool support when the turn requires CUT3 terminal tools.
  - Attempt entries in ascending `priority`.
  - Fail over only on pre-output failures: health failure, auth failure, missing model, session start failure, turn-start failure, rate-limit/overload error before useful output, or tool-capability mismatch before execution begins.
  - Once `turn.started` and assistant output has begun, pin that model for the rest of the turn; no mid-stream failover.
  - On the next turn, always start again from the highest-priority healthy entry.
- Persist reroute visibility by continuing to use `model.rerouted` activities, but make them routing-aware and always include `fromProvider`, `fromModel`, `toProvider`, `toModel`, and `reason`.
- Keep `DEFAULT_MODEL_BY_PROVIDER` aligned and add defaults for the new providers.
- New threads should default to `modelSelectionMode = "app-default"` only when `modelRoutingEnabled` is true; otherwise they default to today’s direct behavior.

## Important Public API and Type Changes

- `packages/contracts/src/orchestration.ts`
  - extend `ProviderKind`
  - add `modelSelectionMode`
  - add terminal-run command/event schemas
  - add `OrchestrationTerminalRun`
  - extend `OrchestrationThread`
- `packages/contracts/src/provider.ts`
  - extend provider session and send-turn schemas for new providers
- `packages/contracts/src/server.ts`
  - extend `ServerProviderStatus`
  - extend `ServerProviderModel` with `supportsTools`
- `packages/contracts/src/ws.ts` and `packages/contracts/src/ipc.ts`
  - add `terminal.inspect`
- `apps/web/src/types.ts`
  - add terminal-run types and routing-mode surface types
- `apps/web/src/appSettings.ts`
  - add routing settings, local backend settings, and auto-approve toggle
- `packages/shared/src/model.ts`
  - extend defaults, normalization, and display helpers for `ollama`, `openai-compatible`, and `Auto (App routing)`

## Exact Files and Areas To Change

- Server terminal/orchestration: `apps/server/src/terminal/Services/Manager.ts`, `apps/server/src/terminal/Layers/Manager.ts`, `apps/server/src/wsServer.ts`, `apps/server/src/orchestration/decider.ts`, `apps/server/src/orchestration/projector.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- Server provider/routing: `apps/server/src/provider/Services/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderHealth.ts`, plus new local/API adapter and manager files
- Web chat/composer/timeline: `apps/web/src/composer-logic.ts`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/components/ThreadTerminalDrawer.tsx`, `apps/web/src/session-logic.ts`, `apps/web/src/terminalStateStore.ts`
- Web model picker/settings: `apps/web/src/appSettings.ts`, `apps/web/src/lib/modelPickerHelpers.ts`, `apps/web/src/components/chat/ProviderModelPicker.tsx`, `apps/web/src/routes/_chat.settings.tsx`
- Contracts/shared: `packages/contracts/src/orchestration.ts`, `packages/contracts/src/provider.ts`, `packages/contracts/src/server.ts`, `packages/contracts/src/ws.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/model.ts`, `packages/shared/src/model.ts`, new shared terminal approval helper
- Docs: `README.md`, `.docs/runtime-modes.md`, `.docs/provider-settings.md`, `.docs/quick-start.md`, `AGENTS.md`

## Test Cases and Acceptance Criteria

- `!pio run` creates a terminal-run row in the chat, streams output live, exits cleanly, and remains visible after reload.
- `!` with empty content is rejected without dispatching a provider turn.
- Attached drawer terminals mirror live PTY output into the conversation and stop contributing context after detach.
- The next agent turn automatically receives recent attached-terminal transcript tail without manual paste/attach.
- Auto-approve enabled in `Supervised` auto-allows safe commands like `npm test` and `bun run lint`, but still requires manual approval for `rm -rf`, `git clean -fd`, and `Remove-Item -Recurse`.
- `Full access` runtime mode still bypasses approvals and leaves the auto-approve toggle inert.
- `app-default` routing uses the global chain in priority order, falls back before output, emits `model.rerouted`, and returns to the preferred target on the next turn when healthy.
- Direct model mode still behaves exactly like current CUT3 and never silently reroutes through the app chain.
- Ollama discovery populates available local models from the configured base URL.
- OpenAI-compatible discovery populates models from `/v1/models` and marks tool support correctly.
- Existing Codex, Copilot, OpenCode, Kimi, and Pi direct flows remain green.
- Add or update tests in:
  - `packages/contracts/src/*.test.ts`
  - `apps/server/src/wsServer.test.ts`
  - `apps/server/src/terminal/Layers/Manager.test.ts`
  - `apps/server/src/provider/Layers/ProviderHealth.test.ts`
  - `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
  - `apps/web/src/composer-logic.test.ts`
  - `apps/web/src/session-logic.test.ts`
  - `apps/web/src/terminalStateStore.test.ts`
  - `apps/web/src/wsNativeApi.test.ts`
- Final implementation is not complete until `bun run fmt`, `bun run lint`, `bun run typecheck`, and `bun run test` pass.

## Assumptions and Defaults

- `Multi-backend now` is implemented as Ollama plus one generic OpenAI-compatible backend in v1, not a larger local-runtime matrix.
- The routing chain is app-wide only. There are no project-scoped chains and no named routing profiles in v1.
- The `Auto (App routing)` path is the Warp-like fallback experience; explicit direct model selection remains for compatibility and debugging.
- Failover never happens after meaningful assistant output begins.
- Full transcript chat means terminal runs are first-class timeline rows with expandable transcript bodies, not generic work-log summaries.
- Existing external CLI-backed providers remain supported, but CUT3-native PTY control is guaranteed first for CUT3-managed local/API backends.
- The auto-approve toggle defaults to off, persists locally on the device, and only applies to safe command execution approvals inside the current workspace.
