import { User } from "@linear/sdk";
import Fuse from "fuse.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - sherlockjs doesn't have type declarations
import Sherlock from "sherlockjs";

import type { LabelResult } from "../api/getLabels";
import type { ProjectResult } from "../api/getProjects";
import type { TeamResult } from "../api/getTeams";

// Types for parsed results
export interface MatchResult<T> {
  matched: boolean;
  value?: T;
  id?: string;
  rawToken: string;
}

export interface ParsedQuickIssue {
  title: string;
  description: string;
  team: MatchResult<string> | null;
  project: MatchResult<string> | null;
  labels: MatchResult<string>[];
  assignee: MatchResult<string> | null;
  priority: MatchResult<number> | null;
  dueDate: MatchResult<Date> | null;
  estimate: MatchResult<number | string> | null;
  hasErrors: boolean;
}

// Priority mapping
const PRIORITY_MAP: Record<string, number> = {
  "0": 0,
  none: 0,
  "1": 1,
  urgent: 1,
  "2": 2,
  high: 2,
  "3": 3,
  medium: 3,
  "4": 4,
  low: 4,
};

const PRIORITY_LABELS: Record<number, string> = {
  0: "No Priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

// Token patterns
const PATTERNS = {
  team: /\/(\S+)/g, // /eng
  project: /#(\S+)/g, // #mobile-app
  label: /\*(\S+)/g, // *bug
  deadline: /<([^<>]+)/g, // <friday
  assignee: /@(\S+)/g, // @alex
  priority: /!(\S+)/g, // !1 or !urgent
  estimate: /=(\S+)/g, // =3 or =large
};

function extractTokens(input: string, pattern: RegExp): { tokens: string[]; remaining: string } {
  const tokens: string[] = [];
  let remaining = input;

  const matches = input.matchAll(pattern);
  for (const match of matches) {
    tokens.push(match[1]);
    remaining = remaining.replace(match[0], " ");
  }

  return { tokens, remaining: remaining.replace(/\s+/g, " ").trim() };
}

function fuzzyMatch<T extends { id: string; name?: string; displayName?: string; key?: string }>(
  token: string,
  items: T[],
  keys: string[] = ["name"],
): { item: T; score: number } | null {
  if (!items || items.length === 0) return null;

  const normalizedToken = token.toLowerCase();

  // Exact match first (case-insensitive)
  const exactMatch = items.find((item) => {
    for (const key of keys) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string" && value.toLowerCase() === normalizedToken) {
        return true;
      }
    }
    return false;
  });
  if (exactMatch) return { item: exactMatch, score: 1 };

  // Prefix match
  const prefixMatches = items.filter((item) => {
    for (const key of keys) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string" && value.toLowerCase().startsWith(normalizedToken)) {
        return true;
      }
    }
    return false;
  });
  if (prefixMatches.length === 1) return { item: prefixMatches[0], score: 0.9 };

  // Fuzzy match
  const fuse = new Fuse(items, {
    keys,
    threshold: 0.4,
    ignoreLocation: true,
  });
  const fuseResults = fuse.search(token);
  if (fuseResults.length > 0) {
    return { item: fuseResults[0].item, score: 1 - (fuseResults[0].score ?? 0) };
  }

  return null;
}

function parsePriority(token: string): number | null {
  const normalized = token.toLowerCase();
  return PRIORITY_MAP[normalized] ?? null;
}

function parseDeadline(deadlineStr: string): Date | null {
  const parsed = Sherlock.parse(deadlineStr);
  if (parsed.startDate) {
    // If the parsed date is in the past, assume next occurrence
    const now = new Date();
    if (parsed.startDate < now) {
      // Add a year if it's a past date
      const nextYear = new Date(parsed.startDate);
      nextYear.setFullYear(nextYear.getFullYear() + 1);
      return nextYear;
    }
    return parsed.startDate;
  }
  return null;
}

export interface LinearData {
  teams: TeamResult[];
  projects: ProjectResult[];
  labels: LabelResult[];
  users: User[];
}

export function parseQuickIssue(input: string, data: LinearData): ParsedQuickIssue {
  let remaining = input;
  let description = "";

  // Extract description after // (must be at end or followed by space then more tokens)
  const descriptionMatch = remaining.match(/\/\/\s*(.*)$/);
  if (descriptionMatch) {
    description = descriptionMatch[1].trim();
    remaining = remaining.slice(0, descriptionMatch.index).trim();
  }

  const result: ParsedQuickIssue = {
    title: "",
    description,
    team: null,
    project: null,
    labels: [],
    assignee: null,
    priority: null,
    dueDate: null,
    estimate: null,
    hasErrors: false,
  };

  // Extract team tokens
  const teamExtract = extractTokens(remaining, PATTERNS.team);
  remaining = teamExtract.remaining;
  if (teamExtract.tokens.length > 0) {
    const token = teamExtract.tokens[0]; // Only use first team
    const match = fuzzyMatch(token, data.teams ?? [], ["name", "key"]);
    if (match) {
      result.team = { matched: true, value: match.item.name, id: match.item.id, rawToken: token };
    } else {
      result.team = { matched: false, rawToken: token };
      result.hasErrors = true;
    }
  }

  // Extract project tokens
  const projectExtract = extractTokens(remaining, PATTERNS.project);
  remaining = projectExtract.remaining;
  if (projectExtract.tokens.length > 0) {
    const token = projectExtract.tokens[0]; // Only use first project
    const match = fuzzyMatch(token, data.projects ?? [], ["name"]);
    if (match) {
      result.project = { matched: true, value: match.item.name, id: match.item.id, rawToken: token };
    } else {
      result.project = { matched: false, rawToken: token };
      result.hasErrors = true;
    }
  }

  // Extract label tokens
  const labelExtract = extractTokens(remaining, PATTERNS.label);
  remaining = labelExtract.remaining;
  for (const token of labelExtract.tokens) {
    const match = fuzzyMatch(token, data.labels ?? [], ["name"]);
    if (match) {
      result.labels.push({ matched: true, value: match.item.name, id: match.item.id, rawToken: token });
    } else {
      result.labels.push({ matched: false, rawToken: token });
      result.hasErrors = true;
    }
  }

  // Extract assignee tokens
  const assigneeExtract = extractTokens(remaining, PATTERNS.assignee);
  remaining = assigneeExtract.remaining;
  if (assigneeExtract.tokens.length > 0) {
    const token = assigneeExtract.tokens[0]; // Only use first assignee
    const match = fuzzyMatch(token, data.users ?? [], ["name", "displayName"]);
    if (match) {
      result.assignee = {
        matched: true,
        value: match.item.displayName ?? match.item.name,
        id: match.item.id,
        rawToken: token,
      };
    } else {
      result.assignee = { matched: false, rawToken: token };
      result.hasErrors = true;
    }
  }

  // Extract priority tokens
  const priorityExtract = extractTokens(remaining, PATTERNS.priority);
  remaining = priorityExtract.remaining;
  if (priorityExtract.tokens.length > 0) {
    const token = priorityExtract.tokens[0];
    const priority = parsePriority(token);
    if (priority !== null) {
      result.priority = { matched: true, value: priority, rawToken: token };
    } else {
      result.priority = { matched: false, rawToken: token };
      result.hasErrors = true;
    }
  }

  // Extract deadline tokens
  const deadlineExtract = extractTokens(remaining, PATTERNS.deadline);
  remaining = deadlineExtract.remaining;
  if (deadlineExtract.tokens.length > 0) {
    const token = deadlineExtract.tokens[0];
    const dueDate = parseDeadline(token);
    if (dueDate) {
      result.dueDate = { matched: true, value: dueDate, rawToken: token };
    } else {
      result.dueDate = { matched: false, rawToken: token };
      result.hasErrors = true;
    }
  }

  // Extract estimate tokens (numeric or t-shirt sizes like "large", "small")
  const estimateExtract = extractTokens(remaining, PATTERNS.estimate);
  remaining = estimateExtract.remaining;
  if (estimateExtract.tokens.length > 0) {
    const token = estimateExtract.tokens[0];
    const numEstimate = parseFloat(token);
    const value = isNaN(numEstimate) ? token : numEstimate;
    result.estimate = { matched: true, value, rawToken: token };
  }

  // If no explicit deadline was set, try to detect dates naturally from the text
  // Sherlock will parse "tomorrow", "next friday", "Jan 15", etc.
  if (!result.dueDate) {
    const parsed = Sherlock.parse(remaining);
    if (parsed.startDate) {
      // Use the date Sherlock found
      let dueDate = parsed.startDate;
      // If the parsed date is in the past, assume next occurrence
      const now = new Date();
      if (dueDate < now) {
        dueDate = new Date(dueDate);
        dueDate.setFullYear(dueDate.getFullYear() + 1);
      }
      // Figure out what date text was detected (for display in rawToken)
      const detectedDateText =
        parsed.eventTitle && remaining !== parsed.eventTitle ? remaining.replace(parsed.eventTitle, "").trim() : "";
      result.dueDate = {
        matched: true,
        value: dueDate,
        rawToken: detectedDateText || "auto",
      };
      // Use the cleaned title from Sherlock (date words removed)
      remaining = parsed.eventTitle || remaining;
    }
  }

  // Whatever is left is the title
  result.title = remaining.trim();

  return result;
}

export function getPriorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority] ?? "Unknown";
}
