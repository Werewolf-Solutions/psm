import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {HostCollector} from "./metrics.ts";
import { monitorsFromConfig, probe, WatchStore } from "./watch.ts";

const stateDirectory = process.env.WEREWOLF_WATCH_STATE ?? "/var/lib/psm-watch";
if (process.argv[2] === "read") {
  const command = process.env.SSH_ORIGINAL_COMMAND ?? process.argv[3] ?? "";
  const match = /^watch ([a-z][a-z0-9-]{0,79})$/.exec(command);
  if (!match) throw Error("Only watch <monitor-id> is available");
  const file = path.join(stateDirectory, "snapshots", `${match[1]}.json`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw Error("Invalid snapshot");
  process.stdout.write(fs.readFileSync(file));
} else {
  const configFile = process.env.WEREWOLF_WATCH_CONFIG ?? "/etc/psm-watch/monitors.json";
  const monitors = monitorsFromConfig(JSON.parse(fs.readFileSync(configFile, "utf8")));
  fs.mkdirSync(path.join(stateDirectory, "snapshots"), {recursive: true, mode: 0o750});
  const store = new WatchStore(new DatabaseSync(path.join(stateDirectory, "watch.db")));
  const collector = new HostCollector();
  let hostDue = 0;
  const due = new Map<string, number>();
  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  process.on("SIGINT", () => { stopped = true; });
  while (!stopped) {
    if (Date.now() >= hostDue) {
      try { store.recordHost(collector.collect()); } catch { console.error("Host metrics unavailable"); }
      hostDue = Date.now() + 60000;
    }
    const ready = monitors.filter((monitor) => (due.get(monitor.id) ?? 0) <= Date.now());
    for (let offset = 0; offset < ready.length && !stopped; offset += 4) {
      await Promise.all(ready.slice(offset, offset + 4).map(async (monitor) => {
      const sample = await probe(monitor);
      const observation = store.record(monitor, sample);
      const snapshot = {schema: "werewolf.watch/v1", monitorId: monitor.id, observer: os.hostname(),
        failureDomain: process.env.WEREWOLF_WATCH_FAILURE_DOMAIN ?? "unspecified", ...observation, history:store.history(monitor.id)};
      const destination = path.join(stateDirectory, "snapshots", `${monitor.id}.json`);
      const temporary = `${destination}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(snapshot) + "\n", {mode: 0o640});
      fs.renameSync(temporary, destination);
      due.set(monitor.id, Date.now() + monitor.intervalSeconds * 1000);
      const incident = (observation.incidents as {opened:number;resolved:number|null}[])[0];
      if (incident?.opened === sample.observedAt || incident?.resolved === sample.observedAt) console.log(JSON.stringify({monitor: monitor.id, state: observation.effectiveState, incident}));
      }));
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  store.database.close();
}
