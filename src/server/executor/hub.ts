/**
 * Which queue psm works from.
 *
 *   local     (default) psm's own database (local-hub.ts). No account needed.
 *   werewolf  PSM_HUB=werewolf: the hub in the Werewolf platform, so Todo and
 *             other machines can feed the same queue. Needs "Sign in with Werewolf".
 *
 * The executor loop and the cockpit both take their `Hub` from here, so they
 * always agree on where the work is.
 */
import { getProjects } from "../../index.ts";
import { werewolfApiUrl } from "../runtime.ts";
import { sessionContext } from "../session.ts";
import { executorId, hubClient, type Hub } from "./client.ts";
import { localHub } from "./local-hub.ts";
import { primaryCheckouts } from "../mcp/primary-checkout.ts";

export type HubMode = "local" | "werewolf";

export const hubMode = (): HubMode => (process.env.PSM_HUB === "werewolf" ? "werewolf" : "local");

/** What to call the queue in the cockpit and over MCP. */
export const LOCAL_HUB_TARGET = "this psm (local queue)";

let hub: { mode: HubMode; hub: Hub } | null = null;

export function activeHub(): Hub {
  const mode = hubMode();
  if (hub?.mode === mode) return hub.hub;
  hub = {
    mode,
    hub: mode === "local"
      ? localHub({ executorId: executorId(), projects: () => primaryCheckouts(getProjects()) })
      // TODO(P14 B4): the Werewolf hub needs a credential that survives a restart;
      // today it is the in-memory session from "Continue with Werewolf".
      : hubClient({ apiUrl: () => werewolfApiUrl(), token: async () => (await sessionContext()).accessToken, executorId: executorId() }),
  };
  return hub.hub;
}
