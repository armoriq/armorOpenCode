import { readFile } from "node:fs/promises";
import {
  isMatcherSpec,
  isPlainObject,
  matchesAnyStringField,
  matchParams,
  MAX_SCAN_DEPTH,
  type MatcherSpec,
} from "./matcher.ts";

// Same file format as armorCodex's policy.json: either `{ rules: [...] }` or
// the versioned state envelope `{ version, policy: { rules: [...] } }`.

const ACTIONS = ["allow", "deny", "require_approval"] as const;
const DATA_CLASSES = ["PCI", "PAYMENT", "PHI", "PII"] as const;
type Action = (typeof ACTIONS)[number];
type DataClass = (typeof DATA_CLASSES)[number];

export interface Rule {
  id: string;
  action: Action;
  tool: string;
  dataClass?: DataClass;
  params?: Record<string, unknown>;
  anyParam?: MatcherSpec;
}

export interface Policy {
  rules: Rule[];
}

export type PolicyLoad =
  | { kind: "none" }
  | { kind: "loaded"; policy: Policy }
  | { kind: "invalid"; error: string };

export type Decision =
  | { kind: "allow"; ruleId?: string }
  | { kind: "deny"; ruleId: string; reason: string };

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

// A misspelled operator or a broken regex would otherwise match nothing and
// quietly turn a deny rule off.
function checkMatcherTree(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => checkMatcherTree(entry, `${where}[${i}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  const keys = Object.keys(value);
  if (!keys.some((key) => key.startsWith("$"))) {
    for (const key of keys) checkMatcherTree(value[key], `${where}.${key}`);
    return;
  }
  if (!isMatcherSpec(value)) throw new Error(`${where} has an unknown operator in ${JSON.stringify(keys)}`);
  for (const [op, needle] of Object.entries(value)) {
    if (typeof needle !== "string") throw new Error(`${where}.${op} must be a string`);
    if (op === "$matches") {
      try {
        new RegExp(needle, "i");
      } catch {
        throw new Error(`${where}.$matches is not a valid regex`);
      }
    }
  }
}

function parseRule(raw: unknown, index: number): Rule {
  if (!isPlainObject(raw)) throw new Error(`rule ${index} is not an object`);
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const tool = typeof raw.tool === "string" ? raw.tool.trim() : "";
  const action = typeof raw.action === "string" ? raw.action.trim() : "";
  if (!id || !tool) throw new Error(`rule ${index} needs a non-empty id and tool`);
  if (!isOneOf(ACTIONS, action)) throw new Error(`rule ${id} has unknown action ${JSON.stringify(raw.action)}`);
  const rule: Rule = { id, action, tool };
  if (raw.dataClass !== undefined) {
    if (!isOneOf(DATA_CLASSES, raw.dataClass)) throw new Error(`rule ${id} has unknown dataClass`);
    rule.dataClass = raw.dataClass;
  }
  if (raw.params !== undefined) {
    if (!isPlainObject(raw.params)) throw new Error(`rule ${id} params must be an object`);
    checkMatcherTree(raw.params, `rule ${id} params`);
    rule.params = raw.params;
  }
  if (typeof raw.anyParam === "string") {
    rule.anyParam = { $contains: raw.anyParam };
  } else if (raw.anyParam !== undefined) {
    if (!isMatcherSpec(raw.anyParam)) throw new Error(`rule ${id} anyParam is not a matcher`);
    checkMatcherTree(raw.anyParam, `rule ${id} anyParam`);
    rule.anyParam = raw.anyParam;
  }
  return rule;
}

// Unlike armorCodex, which drops rules it cannot parse, any malformed rule
// rejects the whole file: a silently dropped deny rule is an open door.
export function parsePolicy(raw: unknown): Policy {
  if (!isPlainObject(raw)) throw new Error("policy file must contain a JSON object");
  if (isPlainObject(raw.policy) && raw.rules !== undefined) {
    throw new Error("policy file has rules both at the top level and under policy");
  }
  const container = isPlainObject(raw.policy) ? raw.policy : raw;
  if (container.rules === undefined) return { rules: [] };
  if (!Array.isArray(container.rules)) throw new Error("policy rules must be an array");
  return { rules: container.rules.map(parseRule) };
}

export async function loadPolicy(file: string): Promise<PolicyLoad> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isPlainObject(error) && error.code === "ENOENT") return { kind: "none" };
    return { kind: "invalid", error: `cannot read ${file}: ${String(error)}` };
  }
  try {
    return { kind: "loaded", policy: parsePolicy(JSON.parse(text)) };
  } catch (error) {
    return { kind: "invalid", error: `cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function toolMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === "*") return true;
  const rule = normalizeToolName(ruleTool);
  const tool = normalizeToolName(toolName);
  if (rule.length > 1 && rule.endsWith("*")) return tool.startsWith(rule.slice(0, -1));
  return rule === tool;
}

function collectStrings(value: unknown, depth: number, texts: string[], keys: string[]): void {
  if (depth > MAX_SCAN_DEPTH) return;
  if (typeof value === "string") {
    texts.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, depth + 1, texts, keys);
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      collectStrings(entry, depth + 1, texts, keys);
    }
  }
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const PAYMENT_KEYWORDS = ["card", "credit", "payment", "cvv", "iban", "swift", "bank", "routing"];

export function detectDataClasses(toolName: string, toolInput: unknown): Set<DataClass> {
  const texts: string[] = [];
  const keys: string[] = [];
  collectStrings(toolInput, 0, texts, keys);
  const haystack = [...texts, ...keys].join(" ").toLowerCase();
  const hasKeywords = PAYMENT_KEYWORDS.some((keyword) => haystack.includes(keyword));
  const hasCard = texts.some((text) =>
    (text.match(/\b(?:\d[ -]*?){13,19}\b/g) ?? []).some((match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
    }),
  );
  const classes = new Set<DataClass>();
  if (hasCard || hasKeywords) classes.add("PCI");
  if (hasKeywords || /pay|payment|transfer|charge|crypto|bank|card|stripe|billing/i.test(toolName)) {
    classes.add("PAYMENT");
  }
  return classes;
}

// First matching rule wins, as in armorCodex. require_approval denies until
// OpenCode exposes a permission hook the plugin can actually answer.
export function evaluatePolicy(policy: Policy, toolName: string, toolInput: unknown): Decision {
  const dataClasses = detectDataClasses(toolName, toolInput);
  for (const rule of policy.rules) {
    if (!toolMatches(rule.tool, toolName)) continue;
    if (rule.dataClass && !dataClasses.has(rule.dataClass)) continue;
    if (rule.params && !matchParams(rule.params, toolInput)) continue;
    if (rule.anyParam && !matchesAnyStringField(rule.anyParam, toolInput)) continue;
    switch (rule.action) {
      case "allow":
        return { kind: "allow", ruleId: rule.id };
      case "deny":
        return { kind: "deny", ruleId: rule.id, reason: `ArmorOpenCode policy deny: ${rule.id}` };
      case "require_approval":
        return { kind: "deny", ruleId: rule.id, reason: `ArmorOpenCode policy requires approval: ${rule.id}` };
      default: {
        const exhaustive: never = rule.action;
        return exhaustive;
      }
    }
  }
  return { kind: "allow" };
}
