import type { CustomCommand, Project } from "../types.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function customCommandId(kind: unknown): string | null {
  if (typeof kind !== "string" || !kind.startsWith("custom:")) return null;
  const id = kind.slice("custom:".length);
  return ID.test(id) ? id : null;
}

export function validateCustomCommands(value: unknown, projects: Project[]): CustomCommand[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Choose up to 20 custom commands.");
  const known = new Set(projects.map((project) => project.name));
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid custom command.");
    const { id, name, directory, command } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !ID.test(id) || ids.has(id)) throw new Error("Invalid or duplicate custom command ID.");
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("Custom command needs a name (up to 80 characters).");
    if (typeof directory !== "string" || !known.has(directory)) throw new Error("Choose a linked project directory.");
    if (typeof command !== "string" || !command.trim() || command.length > 2000) throw new Error("Custom command needs a command (up to 2000 characters).");
    ids.add(id);
    return { id, name: name.trim(), directory, command: command.trim() };
  });
}
