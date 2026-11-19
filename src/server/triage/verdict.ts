/**
 * The triage Verdict — docs/roadmaps/p14-hub-contract.md, section D.
 *
 * The hub validates it too, but this side is the one that decides whether a run
 * succeeded: a malformed answer is a failed run, never a fake verdict. So the
 * validator is strict and explains itself, because the explanation is what gets
 * posted back as the job's `error`.
 */

import { normalizeScope, type Scope } from "../executor/overlap.ts";

export type VerdictKind = "fits" | "doesnt_fit" | "needs_decision";
export type VerdictSize = "S" | "M" | "L" | "XL";

export interface Verdict {
  verdict: VerdictKind;
  size: VerdictSize;
  dependsOn: string[];
  conflictsWith: string[];
  queue: { after: string[]; note: string };
  questions: string[];
  rationale: string;
}

export type VerdictResult = { ok: true; verdict: Verdict } | { ok: false; error: string };

const KINDS: VerdictKind[] = ["fits", "doesnt_fit", "needs_decision"];
const SIZES: VerdictSize[] = ["S", "M", "L", "XL"];
const TOP_KEYS = ["verdict", "size", "dependsOn", "conflictsWith", "queue", "questions", "rationale"];
const QUEUE_KEYS = ["after", "note"];

export const LIST_MAX = 10;
export const ITEM_MAX = 200;
export const RATIONALE_MAX = 2000;
/** The contract gives no limit for `queue.note`; the rationale's is the generous reading. */
export const NOTE_MAX = 2000;

/* ---------- dates ---------- */

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|" +
  "Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/**
 * Each pattern names what it caught, so the failure reason says *why* a verdict
 * was refused. Month names are matched capitalised only: "may 3 tests fail" is a
 * sentence, "May 3" is a date.
 */
const DATE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "ISO date", re: /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2})?/ },
  { label: "year-month", re: /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])\b/ },
  // Slashes take a two-digit year; dots need four, so a version like 0.2.10 is not a date.
  { label: "numeric date", re: /\b\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b/ },
  { label: "numeric date", re: /\b\d{1,2}\.\d{1,2}\.\d{4}\b/ },
  { label: "month and day", re: new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`) },
  { label: "day and month", re: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`) },
  { label: "month and year", re: new RegExp(`\\b${MONTH}\\.?\\s+(?:19|20)\\d{2}\\b`) },
  { label: "quarter", re: /\bQ[1-4]\s*(?:19|20)\d{2}\b/ },
  { label: "weekday", re: /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/i },
  { label: "relative date", re: /\b(?:tomorrow|yesterday|tonight|overmorrow)\b/i },
  {
    label: "relative date",
    re: /\b(?:next|this|last|coming|following)\s+(?:week|month|year|quarter|weekend)\b/i,
  },
  {
    label: "relative date",
    re: /\b(?:in|within)\s+(?:a|an|one|two|three|four|five|six|a\s+few|few|several|\d+)\s+(?:days?|weeks?|months?|years?)\b/i,
  },
  { label: "relative date", re: /\b\d+\s+(?:days?|weeks?|months?|years?)\s+(?:from\s+now|ago)\b/i },
  { label: "relative date", re: /\bend\s+of\s+(?:the\s+)?(?:day|week|month|year|quarter)\b/i },
  { label: "relative date", re: /\b(?:EOD|EOW|EOM|EOY)\b/ },
];

/** The first calendar date found in `text`, or null. Exported for the tests. */
export function findCalendarDate(text: string): { label: string; match: string } | null {
  for (const { label, re } of DATE_PATTERNS) {
    const match = text.match(re);
    if (match) return { label, match: match[0] };
  }
  return null;
}

/* ---------- validation ---------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, field: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be a list of strings`);
    return [];
  }
  if (value.length > LIST_MAX) errors.push(`${field} has ${value.length} entries; at most ${LIST_MAX}`);
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push(`${field}[${index}] must be a string`);
      return;
    }
    const trimmed = item.trim();
    if (!trimmed) errors.push(`${field}[${index}] is empty`);
    else if (trimmed.length > ITEM_MAX) {
      errors.push(`${field}[${index}] is ${trimmed.length} characters; at most ${ITEM_MAX}`);
    }
    out.push(trimmed);
  });
  return out;
}

function unknownKeys(value: Record<string, unknown>, allowed: string[], where: string, errors: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`unexpected field ${where}${key}`);
  }
}

/**
 * Validate an already-parsed value. Returns a normalised copy (strings trimmed,
 * `questions` always present) or every problem found, joined into one reason.
 */
export function validateVerdict(value: unknown): VerdictResult {
  if (!isPlainObject(value)) return { ok: false, error: "verdict must be a JSON object" };
  const errors: string[] = [];
  unknownKeys(value, TOP_KEYS, "", errors);

  const kind = value.verdict;
  if (!KINDS.includes(kind as VerdictKind)) errors.push(`verdict must be one of ${KINDS.join(", ")}`);
  const size = value.size;
  if (!SIZES.includes(size as VerdictSize)) errors.push(`size must be one of ${SIZES.join(", ")}`);

  const dependsOn = stringList(value.dependsOn, "dependsOn", errors);
  const conflictsWith = stringList(value.conflictsWith, "conflictsWith", errors);

  let after: string[] = [];
  let note = "";
  if (!isPlainObject(value.queue)) {
    errors.push("queue must be an object with after and note");
  } else {
    unknownKeys(value.queue, QUEUE_KEYS, "queue.", errors);
    after = stringList(value.queue.after, "queue.after", errors);
    if (typeof value.queue.note !== "string") errors.push("queue.note must be a string");
    else {
      note = value.queue.note.trim();
      if (note.length > NOTE_MAX) errors.push(`queue.note is ${note.length} characters; at most ${NOTE_MAX}`);
    }
  }

  // Required and non-empty only for needs_decision; anywhere else a question
  // would be a decision nobody is asked to make.
  let questions: string[] = [];
  if (kind === "needs_decision") {
    questions = stringList(value.questions, "questions", errors);
    if (Array.isArray(value.questions) && !value.questions.length) {
      errors.push("questions must not be empty when the verdict is needs_decision");
    }
  } else if (value.questions !== undefined) {
    questions = stringList(value.questions, "questions", errors);
    if (questions.length) errors.push("questions are only allowed when the verdict is needs_decision");
  }

  let rationale = "";
  if (typeof value.rationale !== "string" || !value.rationale.trim()) {
    errors.push("rationale must be a non-empty string");
  } else {
    rationale = value.rationale.trim();
    if (rationale.length > RATIONALE_MAX) {
      errors.push(`rationale is ${rationale.length} characters; at most ${RATIONALE_MAX}`);
    }
  }

  // No calendar dates anywhere: position is relative to named items, not time.
  const texts: Array<[string, string]> = [
    ...dependsOn.map((t, i): [string, string] => [`dependsOn[${i}]`, t]),
    ...conflictsWith.map((t, i): [string, string] => [`conflictsWith[${i}]`, t]),
    ...after.map((t, i): [string, string] => [`queue.after[${i}]`, t]),
    ["queue.note", note],
    ...questions.map((t, i): [string, string] => [`questions[${i}]`, t]),
    ["rationale", rationale],
  ];
  for (const [field, text] of texts) {
    const date = findCalendarDate(text);
    if (date) errors.push(`${field} contains a calendar date (${date.label}: "${date.match}")`);
  }

  if (errors.length) return { ok: false, error: `invalid verdict: ${errors.join("; ")}` };
  return {
    ok: true,
    verdict: {
      verdict: kind as VerdictKind,
      size: size as VerdictSize,
      dependsOn,
      conflictsWith,
      queue: { after, note },
      questions,
      rationale,
    },
  };
}

/* ---------- parsing the model's answer ---------- */

const FENCE_RE = /```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/gi;

/**
 * Turn the model's raw answer into a verdict. Accepted shapes, and nothing else:
 *   - the whole answer is one JSON object;
 *   - the answer holds exactly one fenced block (```json or ```), which is.
 * Two fences, prose with bare JSON in it, or JSON that is not an object are all
 * invalid — guessing which object was meant is how a fake verdict gets in.
 */
export function parseVerdictAnswer(answer: string): VerdictResult {
  const parsed = parseAnswerObject(answer);
  return parsed.ok ? validateVerdict(parsed.value) : parsed;
}

/**
 * The triage answer: the verdict, plus `touches`, the files and folders the
 * work is expected to change. `touches` is psm's own (executor/overlap.ts) and
 * never part of the verdict the hub sees. A missing or unusable list is an
 * unknown scope, never a reason to refuse the verdict.
 */
export function parseTriageAnswer(answer: string): { ok: true; verdict: Verdict; scope: Scope } | { ok: false; error: string } {
  const parsed = parseAnswerObject(answer);
  if (!parsed.ok) return parsed;
  let scope: Scope = null;
  let value = parsed.value;
  if (isPlainObject(value) && "touches" in value) {
    const { touches, ...rest } = value as Record<string, unknown>;
    scope = normalizeScope(touches);
    value = rest;
  }
  const checked = validateVerdict(value);
  return checked.ok ? { ok: true, verdict: checked.verdict, scope } : checked;
}

function parseAnswerObject(answer: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = String(answer ?? "").trim();
  if (!text) return { ok: false, error: "the engine returned an empty answer" };

  let body: string;
  if (text.startsWith("{")) {
    body = text;
  } else {
    const fences = [...text.matchAll(FENCE_RE)];
    if (fences.length !== 1) {
      return {
        ok: false,
        error: fences.length
          ? `the answer holds ${fences.length} fenced blocks; expected exactly one verdict`
          : "the answer is not a JSON verdict",
      };
    }
    body = fences[0][1].trim();
  }

  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (err) {
    return { ok: false, error: `the answer is not valid JSON: ${(err as Error).message}` };
  }
}
