import assert from "node:assert/strict";
import test from "node:test";

import type { HubProject } from "./client.ts";
import { createProjectPublisher, projectsForHub } from "./publish.ts";

test("only id, name and archived leave the machine, for projects with a prj_ id", () => {
  const list = projectsForHub([
    { id: "prj_b59f38f33cea866492d8", name: "psm", archived: false, path: "/home/me/psm", notes: "secret" } as never,
    { id: null, name: "no-id" },
    { id: "not-a-prj", name: "bad" },
    { id: "prj_b59f38f33cea866492d8", name: "psm duplicate" },
    { id: "prj_aaaa", name: "old", archived: true },
  ]);
  assert.deepEqual(list, [
    { projectId: "prj_aaaa", name: "old", archived: true },
    { projectId: "prj_b59f38f33cea866492d8", name: "psm", archived: false },
  ]);
});

function fixture(signedIn = true) {
  const calls: HubProject[][] = [];
  let projects = [{ id: "prj_aaaa", name: "todo-app" }];
  let clock = 0;
  let session = signedIn;
  let failNext = false;
  const publisher = createProjectPublisher({
    hub: {
      publishProjects: async (list) => {
        if (failNext) { failNext = false; throw new Error("Hub returned 403"); }
        calls.push(list);
        return { count: list.length, archived: 0 };
      },
    },
    projects: () => projects,
    signedIn: async () => session,
    now: () => clock,
  });
  return {
    publisher,
    calls,
    setProjects: (next: typeof projects) => { projects = next; },
    advance: (ms: number) => { clock += ms; },
    signIn: (value: boolean) => { session = value; },
    failOnce: () => { failNext = true; },
  };
}

test("signed out, nothing is sent", async () => {
  const { publisher, calls } = fixture(false);
  assert.equal((await publisher.sync()).state, "signed-out");
  assert.equal(calls.length, 0);
});

test("publishes once, again only when the list changes or goes stale", async () => {
  const { publisher, calls, setProjects, advance } = fixture();
  assert.equal((await publisher.sync()).count, 1);
  await publisher.sync();
  assert.equal(calls.length, 1, "unchanged list is not re-sent");
  setProjects([{ id: "prj_aaaa", name: "todo-app" }, { id: "prj_bbbb", name: "psm" }]);
  await publisher.sync();
  assert.equal(calls.length, 2);
  advance(31 * 60 * 1000);
  await publisher.sync();
  assert.equal(calls.length, 3, "stale list is refreshed");
  await publisher.sync(true);
  assert.equal(calls.length, 4, "force always sends");
});

test("a failure is reported and retried on the next tick; a new sign-in publishes again", async () => {
  const { publisher, calls, failOnce, signIn } = fixture();
  failOnce();
  const failed = await publisher.sync();
  assert.equal(failed.state, "error");
  assert.match(failed.lastError!, /403/);
  assert.equal((await publisher.sync()).state, "published");
  signIn(false);
  await publisher.sync();
  signIn(true);
  await publisher.sync();
  assert.equal(calls.length, 2, "signing in again (maybe as someone else) re-sends");
});
