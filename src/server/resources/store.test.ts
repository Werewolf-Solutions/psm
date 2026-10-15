import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db.ts";
import type { Resource } from "./discover.ts";
import { suggest } from "./levels.ts";
import { ResourceStore, ResourceStoreError } from "./store.ts";

const store = () => {
  const handle = openDatabase(":memory:");
  return new ResourceStore(() => handle);
};

test("anything new is unset, and unset is enforced as none", () => {
  const resources = store();
  assert.equal(resources.get("db:mongodb:localhost:27017"), null);
  assert.equal(resources.effective("db:mongodb:localhost:27017"), "none");
});

test("a level is set with a revision, and a stale tab cannot overwrite it", () => {
  const resources = store();
  const first = resources.setLevel("db:mongodb:localhost:27017", "full", 0, "local:me");
  assert.equal(first.revision, 1);
  assert.equal(resources.effective(first.key), "full");
  assert.throws(() => resources.setLevel(first.key, "none", 0, "local:other-tab"), (error: unknown) => error instanceof ResourceStoreError && error.status === 409);
  assert.equal(resources.setLevel(first.key, "read", 1, "local:me").level, "read");
});

test("only real resource keys and levels are accepted", () => {
  const resources = store();
  assert.throws(() => resources.setLevel("server:123", "full", 0, "me"), ResourceStoreError);
  assert.throws(() => resources.setLevel("db:x", "admin" as never, 0, "me"), ResourceStoreError);
});

test("folders are added unset and can be forgotten", () => {
  const resources = store();
  const folder = resources.addFolder("folder:/home/me/Videos", "/home/me/Videos", "me");
  assert.equal(folder.level, null);
  assert.deepEqual(resources.folders(), ["/home/me/Videos"]);
  resources.forget(folder.key, folder.revision);
  assert.deepEqual(resources.folders(), []);
});

const db = (over: Partial<Resource>): Resource => ({ key: "db:mongodb:localhost:27017", kind: "database", name: "MongoDB :27017", where: "", running: true, local: true, usedBy: [], ...over });

test("suggestions: dev Full, remote Read, personal None, otherwise nothing", () => {
  assert.equal(suggest(db({ usedBy: [{ project: "werewolf-dapp", directory: "server", file: ".env", variable: "MONGODB_URI", database: "w" }] }))?.level, "full");
  assert.equal(suggest(db({ local: false }))?.level, "read");
  assert.equal(suggest(db({})), null, "a local database no project uses gets no suggestion");
  const folder = (p: string): Resource => ({ key: `folder:${p}`, kind: "folder", name: "x", where: p, running: true, local: true, path: p });
  assert.equal(suggest(folder("/home/me/Videos/2026"), "/home/me")?.level, "none");
  assert.equal(suggest(folder("/home/me/projects"), "/home/me"), null);
});
