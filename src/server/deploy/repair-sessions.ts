import { PREPARATION_OPERATIONS } from "../agent-permissions.ts";
/**
 * The repair half of "Make ready to deploy".
 *
 * The coordinator in `make-ready.ts` knows *when* something has to be fixed; it
 * does not know how to fix anything. This is the piece that turns an outstanding
 * readiness item into work: a workroom scoped to the one project being deployed,
 * and one AI turn per attempt describing exactly which checks are failing.
 *
 * The room is deliberately an ordinary workroom. It is the same sandbox, the
 * same transcript, the same question flow the operator already knows — so when
 * preparation stalls, "open the preparation session" lands them somewhere they
 * can read what happened and answer in their own words, rather than in a private
 * channel that only this feature can see.
 *
 * Preparation permissions come from PREPARATION_OPERATIONS. The coordinator
 * checks them before spending an attempt, and the managed tool broker checks
 * each operation. Credentials and outward actions are not tools in this room;
 * deployment execution keeps its separate exact-plan approval boundary.
 */
import type { PreparationJob, PreparationRepairer, ReadinessResult } from "./make-ready.ts";

export interface PreparationAi {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface PreparationTurn {
  jobId: string;
  environmentId: string;
  purpose: "repair" | "diagnose-external";
  attempt: number;
  maximumAttempts: number;
}

export interface RepairSessionHost {
  /** Opens a workroom scoped to one project and returns its id. */
  open(input: { projectId: string; environmentId: string; title: string; objective: string; ai: PreparationAi }): string;
  /** Which AI that room currently runs. */
  ai(roomId: string): PreparationAi | null;
  /** Points an existing room at a different AI. Switching engines starts a fresh thread. */
  useAi(roomId: string, ai: PreparationAi): void;
  /** Sends one turn. `question` means the room is already waiting on the operator. */
  send(roomId: string, message: string, preparation: PreparationTurn): { ok: boolean; error?: string; question?: boolean; limited?: boolean };
  state(roomId: string): { busy: boolean; question: boolean };
  stop(roomId: string): void;
}

const MAX_ITEMS = 12;

/** What is still failing, in the operator's own checklist wording. */
function outstanding(checked: ReadinessResult): string[] {
  return checked.readiness.items
    .filter((item) => item.status !== "ready")
    .slice(0, MAX_ITEMS)
    .map((item, index) => `${index + 1}. ${item.title} — ${item.detail}${item.action ? ` (${item.action})` : ""}`);
}

/**
 * The turn psm sends into the preparation room.
 *
 * It names the failing checks instead of asking for "the deploy to be fixed":
 * these are the same lines the operator is reading in the Readiness list, so the
 * two sides of the screen agree about what is left.
 */
export function repairBrief(job: PreparationJob, checked: ReadinessResult, purpose: "repair" | "diagnose-external" = "repair"): string {
  const lines = [
    `psm is preparing this project for deployment to "${job.environmentId}" and these readiness checks are not passing.`,
    "",
    ...(outstanding(checked).length ? outstanding(checked) : ["1. The checks did not name a cause. Investigate the deployment manifest and the release source."]),
  ];
  if (job.failure) lines.push("", `What failed last time: ${job.failure}`);
  if (purpose === "diagnose-external") {
    lines.push(
      "",
      "Diagnose these external deployment checks using the available read-only project and connection information. Do not edit files, change a connection or host, request secrets, run a build, or deploy.",
      "Explain the likely cause, identify what can be verified now, and give the operator exact ordered actions with the owning project or connection and commands or UI paths where supported by evidence. Mark assumptions clearly.",
      "If the operator must provide missing facts or perform a privileged step, ask a focused question or give the exact step in this room. After your turn psm rechecks readiness and continues automatically if the blockers are gone.",
    );
    return lines.join("\n");
  }
  lines.push("", `This is attempt ${job.repairs} of 3 (a maximum, not a requirement). Read what this room already tried before repeating it.`);
  lines.push(
    "",
    "How to work here:",
    ...PREPARATION_OPERATIONS.map((operation) => `- ${operation.instruction}`),
    "- PSM's managed git_commit assigns the next root X.Y.Z version for code changes and synchronizes root lockfiles. Preserve an already chosen newer version. If an external commit needs only a release-version increment, stage package.json and use git_commit to record that increment; never relabel an existing artifact.",
    "- Do not read, write or invent deployment credentials or secrets, and do not run a deployment, a release build or an infrastructure change yourself. psm runs those, and the operator approves the exact plan first.",
    "- If a step needs a credential, a business decision or an approval, ask the operator a question instead of guessing. Preparation waits for the answer and resumes when you have it.",
    "- Stop the turn once the listed checks would pass, or once only the operator can act. psm rechecks readiness on its own and continues from there.",
    "- A failed workflow alone does not establish a compiler error. Base a diagnosis on the failed step's output; distinguish missing diagnostics or runner limitations from a defect in the application.",
    "- Preserve the existing build, test and typecheck gates. Do not propose removing a check just to make preparation pass, or commit diagnostic-only notes to trigger another build. If evidence is missing, name the missing evidence once and stop.",
  );
  return lines.join("\n");
}

/** Runs preparation repairs as one workroom conversation per deployment. */
export class WorkroomPreparationRepairer implements PreparationRepairer {
  constructor(private readonly host: RepairSessionHost) {}

  async start(job: PreparationJob, checked: ReadinessResult, purpose: "repair" | "diagnose-external" = "repair"): Promise<string> {
    const ai = { engine: job.engine, model: job.model, effort: job.effort };
    const roomId = job.workroomId ?? this.host.open({
      projectId: job.projectId,
      environmentId: job.environmentId,
      title: `Ready ${job.environmentId} to deploy`,
      objective: `Clear the deployment readiness checks for the "${job.environmentId}" environment so psm can build and deploy it.`,
      ai,
    });
    // The operator's choice wins over whatever the room was opened with. This is
    // the whole reason a preparation stopped by a usage limit can be resumed:
    // pick the other provider, press the button, and the same room continues on
    // it rather than staying stuck against a window that has not reset.
    if (job.engine) {
      const current = this.host.ai(roomId);
      const sameChoice = current?.engine === job.engine
        && (current.model || null) === (job.model || null)
        && (current.effort || null) === (job.effort || null);
      if (!sameChoice) this.host.useAi(roomId, ai);
    }
    // An unanswered question is not a room to talk over: the operator is already
    // the blocker, and a second turn would bury what they were asked.
    if (this.host.state(roomId).question) return roomId;
    const sent = this.host.send(roomId, repairBrief(job, checked, purpose), {
      jobId: job.id, environmentId: job.environmentId, purpose,
      attempt: job.repairs, maximumAttempts: 3,
    });
    if (!sent.ok && !sent.question) {
      // Name the provider that refused. "You've hit your usage limit" with no
      // subject is unactionable when the fix is to choose the other one.
      const engine = this.host.ai(roomId)?.engine;
      const reason = sent.error || "the preparation session could not take this work";
      throw new Error(sent.limited && engine
        ? `${engine}: ${reason} Choose a different AI for preparation, then resume.`
        : reason);
    }
    return roomId;
  }

  status(roomId: string): { busy: boolean; question: boolean } {
    return this.host.state(roomId);
  }

  stop(roomId: string): void {
    this.host.stop(roomId);
  }
}
