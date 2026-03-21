import { Schema } from "effect";
import { PositiveInt, ProjectSkillName, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderInteractionMode, ProviderKind, RuntimeMode } from "./orchestration";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_COMMAND_TEMPLATE_NAME_MAX_LENGTH = 128;
const PROJECT_SKILL_DESCRIPTION_MAX_LENGTH = 1_024;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

const ProjectWorkspaceInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});

export const ProjectAgentsFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  includeContents: Schema.optional(Schema.Boolean),
});
export type ProjectAgentsFileInput = typeof ProjectAgentsFileInput.Type;

export const ProjectAgentsFileResult = Schema.Struct({
  status: Schema.Literals(["available", "missing"]),
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
  absolutePath: TrimmedNonEmptyString,
  contents: Schema.optional(Schema.String),
});
export type ProjectAgentsFileResult = typeof ProjectAgentsFileResult.Type;

export const ProjectDraftAgentsFileInput = ProjectWorkspaceInput;
export type ProjectDraftAgentsFileInput = typeof ProjectDraftAgentsFileInput.Type;

export const ProjectDraftAgentsFileResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
  absolutePath: TrimmedNonEmptyString,
  contents: Schema.String,
  mode: Schema.Literals(["create", "update"]),
});
export type ProjectDraftAgentsFileResult = typeof ProjectDraftAgentsFileResult.Type;

export const ProjectCommandTemplate = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_COMMAND_TEMPLATE_NAME_MAX_LENGTH)),
  relativePath: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  template: Schema.String,
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  interactionMode: Schema.optional(ProviderInteractionMode),
  runtimeMode: Schema.optional(RuntimeMode),
  sendImmediately: Schema.optional(Schema.Boolean),
});
export type ProjectCommandTemplate = typeof ProjectCommandTemplate.Type;

export const ProjectCommandTemplateIssue = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type ProjectCommandTemplateIssue = typeof ProjectCommandTemplateIssue.Type;

export const ProjectListCommandTemplatesInput = ProjectWorkspaceInput;
export type ProjectListCommandTemplatesInput = typeof ProjectListCommandTemplatesInput.Type;

export const ProjectListCommandTemplatesResult = Schema.Struct({
  commands: Schema.Array(ProjectCommandTemplate),
  issues: Schema.Array(ProjectCommandTemplateIssue),
});
export type ProjectListCommandTemplatesResult = typeof ProjectListCommandTemplatesResult.Type;

export const ProjectSkill = Schema.Struct({
  name: ProjectSkillName,
  relativePath: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_SKILL_DESCRIPTION_MAX_LENGTH),
  ),
});
export type ProjectSkill = typeof ProjectSkill.Type;

export const ProjectSkillIssue = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type ProjectSkillIssue = typeof ProjectSkillIssue.Type;

export const ProjectListSkillsInput = ProjectWorkspaceInput;
export type ProjectListSkillsInput = typeof ProjectListSkillsInput.Type;

export const ProjectListSkillsResult = Schema.Struct({
  skills: Schema.Array(ProjectSkill),
  issues: Schema.Array(ProjectSkillIssue),
});
export type ProjectListSkillsResult = typeof ProjectListSkillsResult.Type;
