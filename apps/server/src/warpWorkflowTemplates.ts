import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ProjectCommandTemplate,
  ProjectCommandTemplate as ProjectCommandTemplateSchema,
  type ProjectCommandTemplateIssue,
  type ProjectListCommandTemplatesResult,
} from "@draft/contracts";
import { Schema } from "effect";

const WARP_WORKFLOWS_PATH_ENV = "DRAFT_WARP_WORKFLOWS_FILE";
const AGENT_PROCESS_WORKFLOWS_PATH_ENV = "DRAFT_AGENT_PROCESS_WORKFLOWS_FILE";
const AGENT_CLI_WORKFLOWS_PATH_ENV = "DRAFT_AGENT_CLI_WORKFLOWS_FILE";
const CLI_TOOL_CANDIDATES_PATH_ENV = "DRAFT_CLI_TOOL_CANDIDATES_FILE";
const WARP_WORKFLOW_TEMPLATE_NAME_MAX_LENGTH = 120;

type WorkflowCatalogParserKind = "bracketed" | "cli-tools";

interface WorkflowCatalogSourceConfig {
  readonly sourceId: string;
  readonly envVar: string;
  readonly parserKind: WorkflowCatalogParserKind;
  readonly fallbackPaths: ReadonlyArray<string>;
}

interface ResolvedWorkflowCatalogSource {
  readonly config: WorkflowCatalogSourceConfig;
  readonly sourcePath: string;
}

const WORKFLOW_CATALOG_SOURCES: ReadonlyArray<WorkflowCatalogSourceConfig> = [
  {
    sourceId: "warp-workflows",
    envVar: WARP_WORKFLOWS_PATH_ENV,
    parserKind: "bracketed",
    fallbackPaths: [
      path.join(
        os.homedir(),
        "Desktop",
        "Code",
        "#OLD",
        "warpworkflow",
        "workflows",
        "warp_workflows_cleaned.txt",
      ),
      path.join(process.cwd(), "warp_workflows_cleaned.txt"),
      path.join(process.cwd(), "workflows", "warp_workflows_cleaned.txt"),
      path.join(process.cwd(), ".draft", "warp_workflows_cleaned.txt"),
    ],
  },
  {
    sourceId: "cli-tool-candidates",
    envVar: CLI_TOOL_CANDIDATES_PATH_ENV,
    parserKind: "cli-tools",
    fallbackPaths: [
      path.join(os.homedir(), "Downloads", "cli_tool_candidates.txt"),
      path.join(process.cwd(), "cli_tool_candidates.txt"),
      path.join(process.cwd(), "workflows", "cli_tool_candidates.txt"),
      path.join(process.cwd(), ".draft", "cli_tool_candidates.txt"),
    ],
  },
  {
    sourceId: "agent-process-workflows",
    envVar: AGENT_PROCESS_WORKFLOWS_PATH_ENV,
    parserKind: "bracketed",
    fallbackPaths: [
      path.join(os.homedir(), "Downloads", "agent_process_workflows.txt"),
      path.join(process.cwd(), "agent_process_workflows.txt"),
      path.join(process.cwd(), "workflows", "agent_process_workflows.txt"),
      path.join(process.cwd(), ".draft", "agent_process_workflows.txt"),
    ],
  },
  {
    sourceId: "agent-cli-workflows",
    envVar: AGENT_CLI_WORKFLOWS_PATH_ENV,
    parserKind: "bracketed",
    fallbackPaths: [
      path.join(os.homedir(), "Downloads", "agent_cli_workflows.txt"),
      path.join(process.cwd(), "agent_cli_workflows.txt"),
      path.join(process.cwd(), "workflows", "agent_cli_workflows.txt"),
      path.join(process.cwd(), ".draft", "agent_cli_workflows.txt"),
    ],
  },
];

const decodeProjectCommandTemplate = Schema.decodeUnknownSync(ProjectCommandTemplateSchema);

interface WarpWorkflowEntry {
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly command: string;
  readonly sourceLineNumber: number;
}

interface WarpWorkflowCatalogParseResult {
  readonly entries: ReadonlyArray<WarpWorkflowEntry>;
  readonly issues: ReadonlyArray<ProjectCommandTemplateIssue>;
}

interface CachedWorkflowTemplates {
  readonly signature: string;
  readonly result: ProjectListCommandTemplatesResult;
}

let cachedWorkflowTemplates: CachedWorkflowTemplates | null = null;

function slugifySegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "workflow";
}

function isCategoryHeader(line: string): string | null {
  const match = /^===\s*(.+?)\s*===\s*$/.exec(line.trim());
  if (!match) {
    return null;
  }
  const category = match[1]?.trim();
  if (!category || /^=+$/.test(category)) {
    return null;
  }
  return category;
}

function toIssue(sourceLabel: string, lineNumber: number, message: string): ProjectCommandTemplateIssue {
  return {
    relativePath: `${sourceLabel}:${lineNumber}`,
    message,
  };
}

function trimBlankEdges(lines: ReadonlyArray<string>): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim().length === 0) {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function buildUniqueTemplateName(input: {
  readonly category: string;
  readonly title: string;
  readonly used: Set<string>;
}): string {
  const rawBaseName = `${slugifySegment(input.category)}-${slugifySegment(input.title)}`;
  const baseName = rawBaseName.slice(0, WARP_WORKFLOW_TEMPLATE_NAME_MAX_LENGTH);
  if (!input.used.has(baseName)) {
    input.used.add(baseName);
    return baseName;
  }

  let suffix = 2;
  while (suffix < 10_000) {
    const suffixText = `-${suffix}`;
    const maxBaseLength = Math.max(
      1,
      WARP_WORKFLOW_TEMPLATE_NAME_MAX_LENGTH - suffixText.length,
    );
    const candidate = `${baseName.slice(0, maxBaseLength)}${suffixText}`;
    if (!input.used.has(candidate)) {
      input.used.add(candidate);
      return candidate;
    }
    suffix += 1;
  }

  const fallback = `${baseName.slice(0, Math.max(1, WARP_WORKFLOW_TEMPLATE_NAME_MAX_LENGTH - 5))}-x`;
  input.used.add(fallback);
  return fallback;
}

export function parseWarpWorkflowCatalog(
  raw: string,
  sourceLabel = "warp_workflows_cleaned.txt",
): WarpWorkflowCatalogParseResult {
  const lines = raw.split(/\r?\n/g);
  const entries: WarpWorkflowEntry[] = [];
  const issues: ProjectCommandTemplateIssue[] = [];

  let activeCategory = "General";
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    const trimmed = line.trim();

    const category = isCategoryHeader(trimmed);
    if (category) {
      activeCategory = category;
      lineIndex += 1;
      continue;
    }

    const titleMatch = /^\[(.+)\]$/.exec(trimmed);
    if (!titleMatch) {
      lineIndex += 1;
      continue;
    }

    const title = titleMatch[1]?.trim();
    const sourceLineNumber = lineIndex + 1;
    if (!title) {
      issues.push(toIssue(sourceLabel, sourceLineNumber, "Workflow title was empty."));
      lineIndex += 1;
      continue;
    }

    lineIndex += 1;
    const bodyLines: string[] = [];
    while (lineIndex < lines.length) {
      const nextLine = lines[lineIndex] ?? "";
      const nextTrimmed = nextLine.trim();
      if (/^\[(.+)\]$/.test(nextTrimmed)) {
        break;
      }
      if (isCategoryHeader(nextTrimmed)) {
        break;
      }
      bodyLines.push(nextLine);
      lineIndex += 1;
    }

    const nonEmptyBodyIndex = bodyLines.findIndex((value) => value.trim().length > 0);
    if (nonEmptyBodyIndex < 0) {
      issues.push(
        toIssue(sourceLabel, sourceLineNumber, `Workflow '${title}' did not contain a description.`),
      );
      continue;
    }

    const description = bodyLines[nonEmptyBodyIndex]?.trim() ?? "";
    const commandLines = trimBlankEdges(bodyLines.slice(nonEmptyBodyIndex + 1));
    if (description.length === 0) {
      issues.push(
        toIssue(sourceLabel, sourceLineNumber, `Workflow '${title}' did not contain a description.`),
      );
      continue;
    }
    if (commandLines.length === 0) {
      issues.push(
        toIssue(sourceLabel, sourceLineNumber, `Workflow '${title}' did not contain a command body.`),
      );
      continue;
    }

    const command = commandLines.join("\n").trim();
    if (command.length === 0) {
      issues.push(
        toIssue(sourceLabel, sourceLineNumber, `Workflow '${title}' command body was empty.`),
      );
      continue;
    }

    entries.push({
      category: activeCategory,
      title,
      description,
      command,
      sourceLineNumber,
    });
  }

  return {
    entries,
    issues,
  };
}

function isCliToolHeading(lines: ReadonlyArray<string>, lineIndex: number): boolean {
  const line = lines[lineIndex]?.trim() ?? "";
  if (
    line.length === 0 ||
    line.startsWith("=") ||
    line.startsWith("[") ||
    line.startsWith("-") ||
    line.includes(":")
  ) {
    return false;
  }
  const nextLine = lines[lineIndex + 1]?.trim() ?? "";
  return /^Priority:/i.test(nextLine);
}

export function parseCliToolCandidatesCatalog(
  raw: string,
  sourceLabel = "cli_tool_candidates.txt",
): WarpWorkflowCatalogParseResult {
  const lines = raw.split(/\r?\n/g);
  const entries: WarpWorkflowEntry[] = [];
  const issues: ProjectCommandTemplateIssue[] = [];

  let activeCategory = "CLI Tools";
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    const trimmed = line.trim();

    const category = isCategoryHeader(trimmed);
    if (category) {
      activeCategory = category;
      lineIndex += 1;
      continue;
    }

    if (!isCliToolHeading(lines, lineIndex)) {
      lineIndex += 1;
      continue;
    }

    const title = trimmed;
    const sourceLineNumber = lineIndex + 1;
    lineIndex += 1;

    const bodyLines: string[] = [];
    while (lineIndex < lines.length) {
      const nextLine = lines[lineIndex] ?? "";
      const nextTrimmed = nextLine.trim();
      if (isCategoryHeader(nextTrimmed) || isCliToolHeading(lines, lineIndex)) {
        break;
      }
      bodyLines.push(nextLine);
      lineIndex += 1;
    }

    let priority: string | null = null;
    let use: string | null = null;
    let integration: string | null = null;
    const exampleLines: string[] = [];
    let inExampleSection = false;
    for (const bodyLine of bodyLines) {
      const bodyTrimmed = bodyLine.trim();
      if (bodyTrimmed.length === 0) {
        if (inExampleSection && exampleLines.length > 0) {
          exampleLines.push("");
        }
        continue;
      }
      if (/^Priority:/i.test(bodyTrimmed)) {
        priority = bodyTrimmed.slice(bodyTrimmed.indexOf(":") + 1).trim();
        inExampleSection = false;
        continue;
      }
      if (/^Use:/i.test(bodyTrimmed)) {
        use = bodyTrimmed.slice(bodyTrimmed.indexOf(":") + 1).trim();
        inExampleSection = false;
        continue;
      }
      if (/^Agent integration:/i.test(bodyTrimmed)) {
        integration = bodyTrimmed.slice(bodyTrimmed.indexOf(":") + 1).trim();
        inExampleSection = false;
        continue;
      }
      if (/^Example:/i.test(bodyTrimmed)) {
        inExampleSection = true;
        continue;
      }
      if (inExampleSection) {
        exampleLines.push(bodyLine.trimEnd());
      }
    }

    const descriptionParts: string[] = [];
    descriptionParts.push(`[${activeCategory}]`);
    descriptionParts.push(use && use.length > 0 ? use : `CLI tool workflow for ${title}.`);
    if (priority && priority.length > 0) {
      descriptionParts.push(`Priority: ${priority}.`);
    }
    if (integration && integration.length > 0) {
      descriptionParts.push(`Integration: ${integration}.`);
    }
    const description = descriptionParts.join(" ").replace(/\s+/g, " ").trim();
    if (description.length === 0) {
      issues.push(toIssue(sourceLabel, sourceLineNumber, `Tool '${title}' did not contain a description.`));
      continue;
    }

    const normalizedExampleLines = trimBlankEdges(exampleLines);
    let command = normalizedExampleLines.join("\n").trim();
    if (command.length === 0) {
      const fallbackLines = [
        `Tool: ${title}`,
        ...(use && use.length > 0 ? [`Use: ${use}`] : []),
        ...(priority && priority.length > 0 ? [`Priority: ${priority}`] : []),
        ...(integration && integration.length > 0 ? [`Agent integration: ${integration}`] : []),
      ];
      command = fallbackLines.join("\n").trim();
    }
    if (command.length === 0) {
      issues.push(
        toIssue(sourceLabel, sourceLineNumber, `Tool '${title}' did not contain command guidance.`),
      );
      continue;
    }

    entries.push({
      category: activeCategory,
      title,
      description,
      command,
      sourceLineNumber,
    });
  }

  return {
    entries,
    issues,
  };
}

export function buildWarpWorkflowTemplatesFromCatalog(input: {
  readonly catalog: WarpWorkflowCatalogParseResult;
  readonly sourceLabel?: string;
  readonly sourceId?: string;
  readonly usedTemplateNames?: Set<string>;
}): ProjectListCommandTemplatesResult {
  const usedNames = input.usedTemplateNames ?? new Set<string>();
  const commands: ProjectCommandTemplate[] = [];
  const issues: ProjectCommandTemplateIssue[] = [...input.catalog.issues];
  const sourceLabel = input.sourceLabel ?? "warp_workflows_cleaned.txt";
  const sourceId = input.sourceId ?? "warp-workflows";
  const sourceIdSlug = slugifySegment(sourceId);

  for (const entry of input.catalog.entries) {
    const name = buildUniqueTemplateName({
      category: entry.category,
      title: entry.title,
      used: usedNames,
    });
    const categorySlug = slugifySegment(entry.category);
    const relativePath = `${sourceIdSlug}/${categorySlug}/${name}.md`;
    const description = `[${entry.category}] ${entry.description}`;

    try {
      const command = decodeProjectCommandTemplate({
        name,
        relativePath,
        description,
        template: entry.command,
        sendImmediately: false,
      });
      commands.push(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(
        toIssue(
          sourceLabel,
          entry.sourceLineNumber,
          `Failed to decode workflow '${entry.title}' as a command template: ${message}`,
        ),
      );
    }
  }

  return { commands, issues };
}

function resolveWorkflowCatalogPath(config: WorkflowCatalogSourceConfig): string | null {
  const configuredPath = process.env[config.envVar]?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return configuredPath;
  }
  for (const candidate of config.fallbackPaths) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveWorkflowCatalogSources(): ReadonlyArray<ResolvedWorkflowCatalogSource> {
  const sources: ResolvedWorkflowCatalogSource[] = [];
  for (const config of WORKFLOW_CATALOG_SOURCES) {
    const sourcePath = resolveWorkflowCatalogPath(config);
    if (!sourcePath) {
      continue;
    }
    sources.push({ config, sourcePath });
  }
  return sources;
}

export function resetWarpWorkflowTemplateCacheForTests(): void {
  cachedWorkflowTemplates = null;
}

export function listWarpWorkflowCommandTemplates(): ProjectListCommandTemplatesResult {
  const resolvedSources = resolveWorkflowCatalogSources();
  if (resolvedSources.length === 0) {
    return { commands: [], issues: [] };
  }

  const issues: ProjectCommandTemplateIssue[] = [];
  const sourceStates: Array<{
    readonly config: WorkflowCatalogSourceConfig;
    readonly sourcePath: string;
    readonly sourceLabel: string;
    readonly mtimeMs: number;
  }> = [];

  for (const source of resolvedSources) {
    try {
      const stat = fs.statSync(source.sourcePath);
      if (!stat.isFile()) {
        issues.push({
          relativePath: source.sourcePath,
          message: `Workflow source '${source.config.sourceId}' is not a file.`,
        });
        continue;
      }
      sourceStates.push({
        config: source.config,
        sourcePath: source.sourcePath,
        sourceLabel: path.basename(source.sourcePath),
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      issues.push({
        relativePath: source.sourcePath,
        message: `Failed to read workflow source metadata: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  if (sourceStates.length === 0) {
    return { commands: [], issues };
  }

  const signature = sourceStates
    .map((state) => `${state.config.sourceId}:${state.sourcePath}:${state.mtimeMs}`)
    .join("|");
  if (issues.length === 0 && cachedWorkflowTemplates && cachedWorkflowTemplates.signature === signature) {
    return cachedWorkflowTemplates.result;
  }

  const commands: ProjectCommandTemplate[] = [];
  const usedTemplateNames = new Set<string>();
  for (const state of sourceStates) {
    let raw = "";
    try {
      raw = fs.readFileSync(state.sourcePath, "utf8");
    } catch (error) {
      issues.push({
        relativePath: state.sourcePath,
        message: `Failed to read workflow source: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }

    const catalog =
      state.config.parserKind === "cli-tools"
        ? parseCliToolCandidatesCatalog(raw, state.sourceLabel)
        : parseWarpWorkflowCatalog(raw, state.sourceLabel);
    const built = buildWarpWorkflowTemplatesFromCatalog({
      catalog,
      sourceLabel: state.sourceLabel,
      sourceId: state.config.sourceId,
      usedTemplateNames,
    });
    commands.push(...built.commands);
    issues.push(...built.issues);
  }

  const result = { commands, issues };
  if (issues.length === 0) {
    cachedWorkflowTemplates = { signature, result };
  }
  return result;
}
