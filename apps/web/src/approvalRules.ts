import type { ProjectId } from "@t3tools/contracts";

import type { PendingApproval } from "./session-logic";

export const APPROVAL_RULE_REQUEST_KIND_OPTIONS = [
  { value: "command", label: "Commands" },
  { value: "file-read", label: "File reads" },
  { value: "file-change", label: "File writes" },
  { value: "other", label: "Other approvals" },
] as const;
export type ApprovalRuleRequestKind = (typeof APPROVAL_RULE_REQUEST_KIND_OPTIONS)[number]["value"];

export const APPROVAL_RULE_ACTION_OPTIONS = [
  { value: "ask", label: "Ask every time" },
  { value: "allow", label: "Auto-approve" },
  { value: "deny", label: "Auto-deny" },
] as const;
export type ApprovalRuleAction = (typeof APPROVAL_RULE_ACTION_OPTIONS)[number]["value"];

export const APPROVAL_RULE_SCOPE_OPTIONS = [
  { value: "app", label: "App-wide" },
  { value: "project", label: "Project-only" },
] as const;
export type ApprovalRuleScope = (typeof APPROVAL_RULE_SCOPE_OPTIONS)[number]["value"];

export interface ApprovalRule {
  id: string;
  label: string;
  enabled: boolean;
  scope: ApprovalRuleScope;
  projectId: string | null;
  requestKinds: ReadonlyArray<ApprovalRuleRequestKind>;
  requestTypeTerms: string;
  matchText: string;
  action: ApprovalRuleAction;
}

export interface ApprovalRulePreset {
  id: "build" | "plan" | "review";
  label: string;
  description: string;
  rules: ApprovalRule[];
}

const DEFAULT_REQUEST_KINDS: ApprovalRuleRequestKind[] = ["command", "file-read", "file-change"];
const MAX_APPROVAL_RULE_COUNT = 64;
const MAX_APPROVAL_RULE_LABEL_LENGTH = 120;
const MAX_APPROVAL_RULE_TEXT_LENGTH = 512;

const BUILD_COMMAND_TERMS = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pytest",
  "cargo",
  "go test",
  "go build",
  "make",
  "just",
  "gradle",
  "mvn",
  "jest",
  "vitest",
  "turbo",
].join("\n");

function trimmed(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLength);
}

function normalizeApprovalRuleRequestKinds(values: Iterable<unknown>): ApprovalRuleRequestKind[] {
  const requestKinds: ApprovalRuleRequestKind[] = [];
  const seen = new Set<ApprovalRuleRequestKind>();
  for (const candidate of values) {
    if (
      candidate !== "command" &&
      candidate !== "file-read" &&
      candidate !== "file-change" &&
      candidate !== "other"
    ) {
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    requestKinds.push(candidate);
  }
  return requestKinds.length > 0 ? requestKinds : [...DEFAULT_REQUEST_KINDS];
}

function normalizeApprovalRuleAction(value: unknown): ApprovalRuleAction {
  return value === "allow" || value === "deny" || value === "ask" ? value : "ask";
}

function normalizeApprovalRuleScope(value: unknown): ApprovalRuleScope {
  return value === "project" ? "project" : "app";
}

function normalizeApprovalRule(candidate: unknown, fallbackIndex: number): ApprovalRule | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const label =
    trimmed(record.label, MAX_APPROVAL_RULE_LABEL_LENGTH) || `Rule ${fallbackIndex + 1}`;
  const id = trimmed(record.id, 128) || createApprovalRuleId();
  return {
    id,
    label,
    enabled: record.enabled !== false,
    scope: normalizeApprovalRuleScope(record.scope),
    projectId:
      typeof record.projectId === "string" && record.projectId.trim().length > 0
        ? (record.projectId.trim() as ProjectId)
        : null,
    requestKinds: normalizeApprovalRuleRequestKinds(
      Array.isArray(record.requestKinds) ? record.requestKinds : DEFAULT_REQUEST_KINDS,
    ),
    requestTypeTerms: trimmed(record.requestTypeTerms, MAX_APPROVAL_RULE_TEXT_LENGTH),
    matchText: trimmed(record.matchText, MAX_APPROVAL_RULE_TEXT_LENGTH),
    action: normalizeApprovalRuleAction(record.action),
  };
}

export function normalizeApprovalRules(rules: Iterable<unknown>): ApprovalRule[] {
  const normalized: ApprovalRule[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of Array.from(rules).entries()) {
    const rule = normalizeApprovalRule(candidate, index);
    if (!rule || seen.has(rule.id)) {
      continue;
    }
    seen.add(rule.id);
    normalized.push(rule);
    if (normalized.length >= MAX_APPROVAL_RULE_COUNT) {
      break;
    }
  }
  return normalized;
}

export function createApprovalRuleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createBlankApprovalRule(projectId: ProjectId | null = null): ApprovalRule {
  return {
    id: createApprovalRuleId(),
    label: "New rule",
    enabled: true,
    scope: projectId ? "project" : "app",
    projectId,
    requestKinds: [...DEFAULT_REQUEST_KINDS],
    requestTypeTerms: "",
    matchText: "",
    action: "ask",
  };
}

function createPresetRule(input: Omit<ApprovalRule, "id"> & { id: string }): ApprovalRule {
  return {
    ...input,
  };
}

export const APPROVAL_RULE_PRESETS: ReadonlyArray<ApprovalRulePreset> = [
  {
    id: "build",
    label: "Build",
    description: "Auto-approve file reads and common build/test commands.",
    rules: [
      createPresetRule({
        id: "build-read",
        label: "Allow file reads",
        enabled: true,
        scope: "app",
        projectId: null,
        requestKinds: ["file-read"],
        requestTypeTerms: "",
        matchText: "",
        action: "allow",
      }),
      createPresetRule({
        id: "build-command",
        label: "Allow common build/test commands",
        enabled: true,
        scope: "app",
        projectId: null,
        requestKinds: ["command"],
        requestTypeTerms: "",
        matchText: BUILD_COMMAND_TERMS,
        action: "allow",
      }),
    ],
  },
  {
    id: "plan",
    label: "Plan",
    description: "Auto-approve read-only exploration while keeping commands and writes gated.",
    rules: [
      createPresetRule({
        id: "plan-read",
        label: "Allow file reads",
        enabled: true,
        scope: "app",
        projectId: null,
        requestKinds: ["file-read"],
        requestTypeTerms: "",
        matchText: "",
        action: "allow",
      }),
    ],
  },
  {
    id: "review",
    label: "Review",
    description: "Allow reads, but automatically reject write requests while you are reviewing.",
    rules: [
      createPresetRule({
        id: "review-read",
        label: "Allow file reads",
        enabled: true,
        scope: "app",
        projectId: null,
        requestKinds: ["file-read"],
        requestTypeTerms: "",
        matchText: "",
        action: "allow",
      }),
      createPresetRule({
        id: "review-deny-writes",
        label: "Deny file writes",
        enabled: true,
        scope: "app",
        projectId: null,
        requestKinds: ["file-change"],
        requestTypeTerms: "",
        matchText: "",
        action: "deny",
      }),
    ],
  },
];

function parseMatchTerms(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index);
}

function requestKindMatches(rule: ApprovalRule, approval: PendingApproval): boolean {
  return rule.requestKinds.includes(approval.requestKind as ApprovalRuleRequestKind);
}

function scopeMatches(rule: ApprovalRule, activeProjectId: string | null): boolean {
  if (rule.scope === "app") {
    return true;
  }
  return rule.projectId !== null && rule.projectId === activeProjectId;
}

function textTermsMatch(terms: string[], values: string[]): boolean {
  if (terms.length === 0) {
    return true;
  }
  return terms.some((term) => values.some((value) => value.includes(term)));
}

export function findMatchingApprovalRule(input: {
  rules: ReadonlyArray<ApprovalRule>;
  approval: PendingApproval;
  activeProjectId: string | null;
}): ApprovalRule | null {
  const haystacks = [input.approval.requestType ?? "", input.approval.detail ?? ""].map((value) =>
    value.toLowerCase(),
  );

  for (const rule of input.rules) {
    if (!rule.enabled) {
      continue;
    }
    if (!scopeMatches(rule, input.activeProjectId)) {
      continue;
    }
    if (!requestKindMatches(rule, input.approval)) {
      continue;
    }
    if (!textTermsMatch(parseMatchTerms(rule.requestTypeTerms), [haystacks[0] ?? ""])) {
      continue;
    }
    if (!textTermsMatch(parseMatchTerms(rule.matchText), haystacks)) {
      continue;
    }
    return rule;
  }

  return null;
}

export function cloneApprovalPresetRules(
  presetId: ApprovalRulePreset["id"],
  projectId: ProjectId | null,
): ApprovalRule[] {
  const preset = APPROVAL_RULE_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) {
    return [];
  }
  return preset.rules.map((rule) =>
    Object.assign({}, rule, {
      id: createApprovalRuleId(),
      scope: projectId ? "project" : rule.scope,
      projectId: projectId ?? rule.projectId,
    }),
  );
}
