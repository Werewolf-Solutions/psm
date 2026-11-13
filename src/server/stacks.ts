/**
 * Stacks (P18 R5): a named set of runbook units, possibly across projects,
 * started and stopped together — "Todo work" = werewolf-dapp server/dev +
 * todo-app client/dev. Starting goes through units.ts, so shared units start
 * once and dependencies come first; stopping keeps what something else running
 * still needs.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { db } from "./db.ts";
import { parseTargets, type UnitTarget } from "./units.ts";

export interface Stack {
  id: string;
  title: string;
  units: UnitTarget[];
  createdAt: number;
  updatedAt: number;
}

export class StackError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const ID = /^stk_[0-9a-f]{12}$/;
const TITLE = /^[\p{L}\p{N} ._&+()/-]{1,60}$/u;

export const isStackId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

function validate(input: unknown): { title: string; units: UnitTarget[] } {
  const { title, units } = (input ?? {}) as Record<string, unknown>;
  const name = typeof title === "string" ? title.trim() : "";
  if (!TITLE.test(name)) throw new StackError("Name the stack in 1-60 letters, digits, spaces and . _ & + ( ) / -");
  let targets: UnitTarget[];
  try {
    targets = parseTargets(units);
  } catch (error) {
    throw new StackError((error as Error).message);
  }
  const unique = new Map(targets.map((target) => [`${target.project}\0${target.unit}`, target]));
  return { title: name, units: [...unique.values()] };
}

export class StackStore {
  constructor(private readonly database: () => DatabaseSync = db) {}

  list(): Stack[] {
    return (this.database().prepare("SELECT document FROM stacks").all() as { document: string }[])
      .map((row) => JSON.parse(row.document) as Stack)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  get(id: string): Stack | null {
    if (!isStackId(id)) return null;
    const row = this.database().prepare("SELECT document FROM stacks WHERE id = ?").get(id) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as Stack) : null;
  }

  create(input: unknown, now = Date.now()): Stack {
    if (this.list().length >= 50) throw new StackError("Up to 50 stacks.");
    const stack: Stack = { id: `stk_${crypto.randomBytes(6).toString("hex")}`, ...validate(input), createdAt: now, updatedAt: now };
    this.database().prepare("INSERT INTO stacks(id, document) VALUES (?, ?)").run(stack.id, JSON.stringify(stack));
    return stack;
  }

  update(id: string, input: unknown, now = Date.now()): Stack {
    const current = this.get(id);
    if (!current) throw new StackError("Unknown stack.", 404);
    const stack: Stack = { ...current, ...validate(input), updatedAt: now };
    this.database().prepare("UPDATE stacks SET document = ? WHERE id = ?").run(JSON.stringify(stack), id);
    return stack;
  }

  remove(id: string): boolean {
    if (!isStackId(id)) return false;
    return Number(this.database().prepare("DELETE FROM stacks WHERE id = ?").run(id).changes) > 0;
  }
}
