# Draft

<p align="center">
  <img src="./T4.png" alt="Draft" width="144" />
</p>

Draft is a coding-agent workspace for teams that want one consistent surface across multiple provider runtimes without flattening them into the lowest common denominator. It currently supports Codex, GitHub Copilot, OpenCode, Kimi Code, and the Pi agent harness.

This project started as a fork of the T3/CUT3 lineage, but the goal here is different. Draft is not trying to be a thin chat wrapper around one preferred agent. It is trying to be the place where provider-native runtimes, repo-owned instructions, approvals, local commands, model controls, and thread history all meet in one predictable workflow.

## Design objectives

- Make provider switching cheap without making providers feel fake or generic.
- Keep repository context first-class through `AGENTS.md`, repo-local commands, and repo-local skills.
- Treat agent work as an inspectable workflow, not a black box. Execution state, approvals, command runs, file changes, and thread history should stay visible.
- Optimize for active development loops: pick a project, start a thread, run commands, steer a turn, fork from a checkpoint, and keep moving.
- Support both web and desktop without splitting the product into two different mental models.

## How Draft differs from T3

- T3 was more opinionated around a narrower agent workflow and older branding. Draft is explicitly multi-provider and built around orchestration across provider-native adapters.
- Draft puts more weight on repo-owned behavior. Workspace instructions, command templates, and attachable skills are part of the core UX rather than an afterthought.
- Draft exposes more execution controls in the main flow: runtime mode, interaction mode, approvals, queued follow-ups, local `!` commands, thread exports, undo/redo, and branch-style forking from checkpoints.
- Draft is designed to make agent sessions easier to inspect and recover. The UI keeps more of the operational state visible instead of hiding it behind a simple transcript.

## What it does

- Run coding sessions against Codex, GitHub Copilot, OpenCode, Kimi Code, and Pi from one interface.
- Attach repo instructions and reusable repo-local command/skill surfaces to every turn.
- Mix normal chat turns with plan-first turns and supervised or full-access execution modes.
- Run local terminal commands inline, review approvals, inspect tool activity, and follow file-change summaries inside the thread.
- Keep projects, threads, shares, forks, exports, and model preferences in one place across web and desktop.

## Screenshot

![Draft screenshot](./T4.png)

## Supported providers

- Codex
- GitHub Copilot
- OpenCode
- Kimi Code
- Pi

Gemini is intentionally shown as coming soon in the provider picker. Claude Code and Cursor are also visible there as unavailable placeholders. None of those three are wired up for sessions yet.

## How to use

> [!WARNING]
> Install at least one supported provider runtime before starting Draft. Codex, GitHub Copilot, OpenCode, and Kimi Code still depend on their native CLIs plus whatever auth or API keys they require. Pi is embedded directly in Draft, but it still needs Pi auth/config under `~/.pi/agent` (or the equivalent Pi environment variables) before Pi-backed sessions can start:
>
> - [Codex CLI](https://github.com/openai/codex)
> - [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent)
> - [OpenCode CLI](https://opencode.ai/docs)
> - [Kimi Code CLI](https://www.kimi.com/code/docs/en/)
> - [Pi agent harness](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

```bash
bun run start
```

If you bind Draft to a non-loopback host, set `T4CODE_AUTH_TOKEN`. Legacy `CUT3_AUTH_TOKEN` is still accepted in the runtime, but `T4CODE_AUTH_TOKEN` is the current env var.

Once the app is running, choose Codex, GitHub Copilot, OpenCode, Kimi Code, or Pi from the provider picker before starting a session. If this is your first run and Draft does not know any projects yet, the empty chat view walks you through adding a project folder and immediately opens the first draft thread for it.

## Workspace instructions and slash commands

Draft recognizes three repo-owned workspace surfaces:

- `AGENTS.md` at the workspace root. When it exists, Draft wraps every new provider turn with those workspace instructions on the server side.
- `.t4code/commands/*.md` for repo-local slash-command templates.
- `.t4code/skills/<name>/SKILL.md` for repo-local skills that can be attached per turn from the composer.

Legacy `.cut3/commands` and `.cut3/skills` directories are still recognized for compatibility.

From the composer:

- Run built-in slash commands such as `/new` (`/clear`), `/compact` (`/summarize`), `/share`, `/unshare`, `/undo`, `/redo`, `/export`, `/details`, `/init`, `/plan`, `/default`, `/model`, and `/mcp` (when the active provider supports MCP).
- Run standalone local terminal commands with `!`, for example `!bun run lint`. Draft launches these in a hidden thread-scoped terminal using the current thread workspace cwd/env, then appends durable started/completed command rows to the conversation.
- Type `/` to see those built-in commands plus any templates discovered from `.t4code/commands/*.md`.
- Open the Skills picker to attach repo-local skills discovered from `.t4code/skills/<name>/SKILL.md`. Skill files must include `name` and `description` frontmatter, and `name` must match the lowercase hyphenated directory name.
- Attach up to **8 images per message** with the paperclip button, drag-and-drop, or paste. Draft accepts image files only, enforces a **10 MB per image** limit, shows inline previews in the composer and thread timeline, and includes attachment names in bootstrap/export summaries.
- When a turn is already running, use the composer follow-up controls to **Queue** the next message or **Steer** the run so Draft interrupts the current turn and sends your new follow-up next. Press `Enter` to use the current Queue/Steer mode, or `Cmd/Ctrl+Enter` to use the opposite mode for that one follow-up.
- Watch the activity strip above the timeline for live status. It keeps idle vs working state visible and shows compact command/file context for the latest active tool, approval, or local `!` command.
- Template frontmatter can set `description`, optional `provider`, optional `model`, optional `interactionMode`, optional `runtimeMode`, and optional `sendImmediately`.

Template bodies support `$ARGUMENTS` plus positional placeholders `$1` through `$9`.

## Build your own desktop release

If you do not want to wait for a GitHub release, you can build a desktop artifact locally for your own platform.

```bash
# Install dependencies first
bun install

# macOS Apple Silicon DMG
bun run dist:desktop:dmg:arm64

# macOS Intel DMG
bun run dist:desktop:dmg:x64

# Linux x64 AppImage
bun run dist:desktop:linux

# Windows x64 installer
bun run dist:desktop:win
```

Artifacts are written to `./release`.

On Windows, you can also double-click [build-windows-installer.bat](build-windows-installer.bat) from the repo root. It runs the same `bun run dist:desktop:win` packaging flow and writes the installer into `./release`.

Use the matching host OS when possible:

- Build macOS artifacts on macOS.
- Build Linux artifacts on Linux.
- Build Windows artifacts on Windows.

For the full local packaging and release notes, see [docs/release.md](docs/release.md) and [.docs/scripts.md](.docs/scripts.md).

## Provider settings and model controls

Open Settings in the app to configure provider-specific behavior on the current device.

- **Appearance**: choose the base light/dark/system mode, switch to integrated presets like Lilac, and configure a custom chat background image with adjustable fade and blur.
- **Language**: switch the settings experience and shared app shell between English and Persian. Persian also flips document direction and locale-aware time/date formatting in the web UI.
- **Provider overrides**: set custom binary paths for Codex, Copilot, OpenCode, or Kimi, plus an optional Codex home path, a shared OpenRouter API key, and a Kimi API key. Pi is embedded through Draft's Node dependency instead of a separate binary override; Draft reads Pi auth/models config from `~/.pi/agent`, keeps Pi packages, AGENTS files, system prompts, extensions, skills, prompt templates, and themes disabled so workspace instructions still come only from Draft, and now surfaces authenticated Pi provider/model ids directly in the picker and `/model` suggestions instead of only showing a static `pi/default` placeholder. OpenCode account authentication still happens outside Draft through `opencode auth login` and `opencode auth logout`, while MCP server auth/debug remains server-specific through commands like `opencode mcp auth <server>` and `opencode mcp debug <server>`. The OpenCode settings panel inspects the resolved OpenCode config paths plus `opencode auth list`, `opencode mcp list`, and `opencode mcp auth list` so Draft can show current credentials, provider-specific MCP status (including disabled and auth-gated entries), and copyable recovery commands. Kimi CLI authentication can use either `kimi login` or the in-shell `/login` flow when you are not using an API key, and new OpenCode sessions now inherit that shared OpenRouter key as `OPENROUTER_API_KEY` when the OpenCode provider config expects it.
- **OpenRouter free models**: review the current OpenRouter entries that are explicitly free-locked and compatible with Draft's native tool-calling path (`tools` plus `tool_choice`), keep the built-in `openrouter/free` router handy, and pin any listed model into the picker. Draft now keeps a last-known-good OpenRouter free-model catalog locally so the picker and settings can stay usable even when the next live catalog refresh fails.
- **Custom model slugs**: save extra model ids for GitHub Copilot, OpenCode, Kimi, Pi provider/model ids such as `github-copilot/claude-sonnet-4.5`, custom Codex models, or current OpenRouter `:free` slugs so they appear in the model picker and `/model` suggestions.
- **Picker controls**: the chat composer now uses a searchable grouped model picker with direct `Usage`, `Provider readiness`, and `Manage models` actions.
- **Favorites, recents, and visibility**: pin favorite models so they stay at the top of the picker, let Draft surface recent model choices ahead of the long tail, and hide or restore discovered/saved models without deleting them. Hidden models are removed from both the picker and `/model` suggestions until you show them again.
- **Thread defaults**: choose whether new draft threads start in `Local` or `New worktree`, and set thread sharing to `Manual`, `Auto` (create a share link after a new server-backed thread settles), or `Disabled` for new links.
- **Codex service tier**: choose `Automatic`, `Fast`, or `Flex` as the default service tier for new Codex turns.
- **Per-turn controls**: the composer exposes provider-aware reasoning controls where Draft has a provider-specific contract today. Codex and GitHub Copilot expose provider-specific reasoning levels, Codex also supports a per-turn `Fast Mode` toggle, and Pi now surfaces its live model reasoning capability plus Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) for reasoning-capable Pi models while still preserving Pi defaults until you choose an override.
- **Usage dashboard**: click the composer context ring or the picker `Usage` action to open a unified usage dashboard for the current selection, including documented/live context limits, token breakdowns from the latest matching runtime snapshot, latest reported spend when the provider exposes it, and GitHub Copilot quota details.
- **Response visibility**: choose whether assistant messages stream token-by-token and whether tool/work-log entries stay visible in the main timeline.
- **Permission policies**: save persistent app-wide or project-scoped approval rules with `allow`, `ask`, or `deny` actions, request-kind filters, request-type/detail matching, and Build/Plan/Review presets.

The chat model picker now shows OpenRouter as its own top-level section, with the built-in `openrouter/free` router plus the current OpenRouter `:free` models that Draft can safely use for native tool-calling turns. The picker is searchable, grouped by provider, and can open in-chat provider setup and model-management surfaces without sending you into Settings first.

For the full details, see [.docs/provider-settings.md](.docs/provider-settings.md).

## Runtime and interaction modes

The chat toolbar exposes two additional execution controls:

- **Runtime mode**: choose `Full access` for direct execution or `Supervised` for in-app command/file approvals.
- **Interaction mode**: switch between normal `Chat` turns and `Plan` turns for plan-first collaboration.

Runtime mode sets the default sandbox and approval posture for new sessions. Persistent permission policies from Settings can still auto-allow, ask, or deny specific requests on top of that default when a provider raises an approval. Pi is the main exception to Draft's usual external-runtime sandbox story: `Supervised` still gates Pi tools through the same approval UX, but Pi itself is embedded through Draft's Node SDK rather than a separate OS sandbox.

When a plan is active, Draft can keep it open in a sidebar and export it by copying, downloading markdown, or saving it into the workspace. For Pi, Draft drives that mode by sending explicit plan-first instructions and switching Pi onto a read-only tool set for the turn.

Threads also expose collaboration and history controls directly in the chat surface. Use the thread actions menu or the composer slash commands (`/share`, `/unshare`, `/compact`, `/undo`, `/redo`, `/export`, `/details`) to manage the current thread. Shared snapshots open in a dedicated read-only route that can import the snapshot into another local project. Use `Undo` and `Redo` in the thread header to move through recent restore snapshots, use `Fork thread here` on individual messages to branch from that point, and use the diff panel to fork from a completed checkpoint. The sidebar now supports project/thread search, pinning, active/all/archived filters, project recent/manual sort, and thread archiving, while each project shows the 10 most recent matching threads before `Show more` expands the rest. When a provider emits task lifecycle events, Draft shows a compact task panel above the timeline.

For the full details, see [.docs/runtime-modes.md](.docs/runtime-modes.md).

## Additional docs

- [Codex prerequisites](.docs/codex-prerequisites.md)
- [Desktop architecture and verification](apps/desktop/README.md)
- [GLM and MiniMax support plan](.docs/glm-minimax-support-plan.md)
- [Quick start](.docs/quick-start.md)
- [Runtime modes](.docs/runtime-modes.md)

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.
If you are using coding agents while contributing, also read [AGENTS.md](./AGENTS.md) for the current documentation hygiene and delegation rules.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
