import { getProjects, writeMarkdown } from "./index.ts";
import { STATUS_META } from "./render.ts";

const cmd = process.argv[2] || "list";

if (cmd === "scan" || cmd === "list") {
  const projects = getProjects();
  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  for (const p of active) {
    const m = STATUS_META[p.status];
    const ver = [p.gitBranch, p.gitVersion].filter(Boolean).join(" ");
    console.log(
      `${m.emoji} ${p.name.padEnd(26)} ${(p.lastActivity || "—").padEnd(11)} ${ver}`,
    );
  }
  console.log(
    `\n${active.length} active/tracked · ${archived.length} archived · ${projects.length} total`,
  );
} else if (cmd === "build") {
  const file = writeMarkdown();
  console.log("wrote", file);
} else {
  console.error(`unknown command: ${cmd}\nusage: psm [list|scan|build]`);
  process.exit(1);
}
