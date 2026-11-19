/**
 * Which other tickets a job needs merged before it can start.
 *
 * Triage names them by intake id (`int_…`) in its verdict's `dependsOn` and
 * `queue.after`. Unlike file overlap (overlap.ts), this is not about two jobs
 * racing on the same files: the job builds on code the other ticket creates,
 * so it waits, in either overlap mode, until that ticket's job is accepted.
 *
 * A dependency stops counting when its ticket is withdrawn or its newest job
 * was rejected or cancelled: the owner dropped it, and a job must never wait on
 * something nobody will do. Two tickets that name each other, directly or
 * through others, would wait for ever; the older one goes first.
 */

export const INTAKE_REF = /\bint_[0-9a-f]{24}\b/g;

export interface NeedIntake {
  intakeId: string;
  projectId: string;
  status: string;
  /** Ordering for cycles; `seq` breaks ties within a millisecond. */
  createdAt: number;
  seq?: number;
  text: string;
  verdict: { dependsOn?: unknown; queue?: { after?: unknown } | null } | null;
}

export interface Need {
  intakeId: string;
  /** A short name for the ticket, e.g. "grid lab 2: Live grid preview". */
  title: string;
  /** Its newest job, or null when nobody clicked Go on it yet. */
  jobId: string | null;
  status: "not-started" | "queued" | "claimed" | "review" | "stalled" | "failed";
}

const DROPPED = new Set(["rejected", "cancelled"]);

/** The intake ids a verdict names, in order, without repeats. */
export function referencedIntakes(verdict: NeedIntake["verdict"]): string[] {
  const texts = [verdict?.dependsOn, verdict?.queue?.after].flatMap((list) => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []));
  return [...new Set(texts.flatMap((text) => text.match(INTAKE_REF) ?? []))];
}

/**
 * A ticket's name for people: its first line that is not psm's or the hub's
 * "[… requested by …]" header, without the leading "[tag]" kept as a prefix.
 */
export function intakeTitle(text: string, max = 80): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const line = lines.find((entry) => !/^\[[^\]]*\brequested by\b[^\]]*\]$/i.test(entry)) ?? lines[0] ?? "";
  const tagged = /^\[([^\]]{1,40})\]\s*(.*)$/.exec(line);
  const sentence = (tagged ? tagged[2] : line).split(/(?<=[.!?])\s/)[0];
  const title = tagged ? `${tagged[1]}: ${sentence}` : sentence;
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/**
 * What a ticket's job waits for: the tickets triage said it needs that are not
 * merged yet. `newestJob` is each ticket's newest job, if any.
 */
export function needsFor(intakeId: string, intakes: Map<string, NeedIntake>, newestJob: Map<string, { jobId: string; status: string }>): Need[] {
  const self = intakes.get(intakeId);
  if (!self) return [];
  const edges = (id: string): string[] => {
    const intake = intakes.get(id);
    if (!intake) return [];
    return referencedIntakes(intake.verdict).filter((ref) => ref !== id && intakes.get(ref)?.projectId === intake.projectId);
  };
  const pending = (id: string) => {
    const intake = intakes.get(id);
    const job = newestJob.get(id);
    return Boolean(intake && intake.status !== "withdrawn" && job?.status !== "accepted" && !(job && DROPPED.has(job.status)));
  };
  const reaches = (from: string, target: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...edges(id));
    }
    return false;
  };
  const older = (a: NeedIntake, b: NeedIntake) => a.createdAt < b.createdAt || (a.createdAt === b.createdAt && (a.seq ?? 0) < (b.seq ?? 0));
  const needs: Need[] = [];
  for (const ref of edges(intakeId)) {
    if (!pending(ref)) continue;
    const dependency = intakes.get(ref)!;
    // A cycle: only the older ticket waits for nothing, so one of them can start.
    if (reaches(ref, intakeId) && !older(dependency, self)) continue;
    const job = newestJob.get(ref) ?? null;
    needs.push({
      intakeId: ref,
      title: intakeTitle(dependency.text),
      jobId: job?.jobId ?? null,
      status: (job?.status ?? "not-started") as Need["status"],
    });
  }
  return needs;
}

/** One line for people: what to merge (or start) before this job can run. */
export function describeNeeds(needs: Need[]): string {
  const what = (need: Need) => {
    const ticket = `"${need.title}"`;
    switch (need.status) {
      case "review": return `${ticket} (${need.jobId}, ready for review: Accept it)`;
      case "claimed": return `${ticket} (${need.jobId}, implementing now)`;
      case "queued": return `${ticket} (${need.jobId}, queued)`;
      case "stalled": case "failed": return `${ticket} (${need.jobId}, ${need.status}: resume or cancel it)`;
      default: return `${ticket} (not started: click Go on it)`;
    }
  };
  return `Waiting for ${needs.length === 1 ? "another ticket" : `${needs.length} other tickets`} to be merged first: ${needs.map(what).join("; ")}.`;
}
