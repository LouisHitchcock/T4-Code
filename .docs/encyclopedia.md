# Encyclopedia

This is a living glossary for CUT3. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Composer and settings](#composer-and-settings)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot`, a title, and one or more threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live in [GitCore.ts][3].

#### Repo-local skill

A repo-owned instruction artifact discovered from `.cut3/skills/<name>/SKILL.md` and attachable per turn from the composer. Each skill must declare `name` and `description`, and `name` must match the lowercase hyphenated directory name. See [projectWorkspaceMetadata.ts][32] and [ComposerSkillPicker.tsx][33].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when follow-up work like checkpointing settles. See [the contracts][1], [ProviderRuntimeIngestion.ts][5], and [CheckpointReactor.ts][6].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

#### Thread fork

A new thread created from an existing thread's current state, a selected message, or a completed checkpoint. The fork replays durable thread events into a fresh thread record with new message, activity, and proposed-plan ids so projection storage stays consistent. See [the contracts][1] and [decider.ts][8].

#### Thread export

A client-side snapshot of a thread that CUT3 can download as markdown or JSON, or save into the workspace. Exports include messages, proposed plans, derived tasks, curated work-log entries, checkpoint diff summaries, and attachment metadata. See [README.md][25].

#### Shared thread

A read-only snapshot of a thread exposed through a share id. Shared threads can be revoked and opened in a dedicated shared route instead of the normal editable thread view. See [threadShareStore.ts][29] and [shared.$shareId.tsx][27].

#### Thread import

A new local thread created from a shared snapshot. The shared-thread route lets the user pick a local project and import the snapshot into that project. See [shared.$shareId.tsx][27].

#### Thread compaction

A thread action that writes a continuation boundary so future turns can keep working with a smaller context footprint without abandoning the thread. See [threadArtifacts.ts][28] and [README.md][25].

#### Continuation summary

The persisted compacted summary CUT3 carries forward after thread compaction or share import. It preserves active goals, plan state, and other thread context for the next turn. See [threadArtifacts.ts][28] and [README.md][25].

#### Thread undo/redo

A linear restore flow backed by saved restore states. Undo moves the thread to an earlier snapshot and redo can reapply the trimmed future state while it remains available. See [threadRedoStore.ts][30] and [README.md][25].

#### Task panel

A compact read-only summary of provider-emitted task lifecycle events. It is derived from thread activities, stays separate from the curated work log, and only appears when a provider actually emits task events. See [session-logic.ts][26].

### Composer and settings

#### Permission policy

A persistent approval rule stored in Settings and matched against pending provider approvals. Rules can be app-wide or project-scoped and can `allow`, `ask`, or `deny` based on request kind, raw request type, and detail text. See [PermissionPoliciesSection.tsx][31] and [runtime-modes.md][18].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A lightweight typed runtime signal emitted when an async milestone completes. See [RuntimeReceiptBus.ts][13].
Examples include `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, and `turn.processing.quiesced`, which are emitted by flows such as [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable. In [the receipt schema][13], it means the follow-up work has settled, including work in [CheckpointReactor.ts][6].

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [provider-architecture.md][16].

#### Provider

The backend agent runtime that actually performs work. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17].

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. In [the contracts][1], the main values are `approval-required` and `full-access`. See [runtime-modes.md][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the main values are `default` and `plan`. See [runtime-modes.md][18].

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` delivers a completed result. See [ProviderService.ts][14].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [architecture.md][24]
- [provider-architecture.md][16]
- [runtime-modes.md][18]
- [workspace-layout.md][2]

[1]: ../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../apps/server/src/git/Layers/GitCore.ts
[4]: ../apps/server/src/orchestration/projector.ts
[5]: ../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../apps/server/src/orchestration/decider.ts
[9]: ../apps/server/src/orchestration/commandInvariants.ts
[10]: ../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./provider-architecture.md
[17]: ../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ./runtime-modes.md
[19]: ../apps/server/src/checkpointing/Services/CheckpointStore.ts
[20]: ../apps/server/src/checkpointing/Services/CheckpointDiffQuery.ts
[21]: ../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../apps/server/src/checkpointing/Utils.ts
[23]: ../apps/server/src/checkpointing/Diffs.ts
[24]: ./architecture.md
[25]: ../README.md
[26]: ../apps/web/src/session-logic.ts
[27]: ../apps/web/src/routes/shared.$shareId.tsx
[28]: ../apps/server/src/threadArtifacts.ts
[29]: ../apps/server/src/threadShareStore.ts
[30]: ../apps/server/src/threadRedoStore.ts
[31]: ../apps/web/src/components/settings/PermissionPoliciesSection.tsx
[32]: ../apps/server/src/projectWorkspaceMetadata.ts
[33]: ../apps/web/src/components/chat/ComposerSkillPicker.tsx
