import assert from "node:assert/strict";
import test from "node:test";

import { primaryCheckouts } from "./primary-checkout.ts";

const linked = (projectPath: string) => projectPath.includes("worktree");

test("a linked worktree sharing an id never stands in for the main checkout", () => {
  const projects = [
    { id: "prj_a", path: "/p/app-worktree", name: "app-p14" },
    { id: "prj_a", path: "/p/app", name: "app" },
    { id: "prj_b", path: "/p/other", name: "other" },
    { id: null, path: "/p/no-id", name: "no-id" },
  ];
  assert.deepEqual(primaryCheckouts(projects, linked).map((project) => project.name), ["app", "other", "no-id"]);
});

test("a lone worktree keeps its id; two main checkouts with one id are both left out", () => {
  assert.deepEqual(primaryCheckouts([{ id: "prj_a", path: "/p/app-worktree" }], linked).length, 1);
  assert.deepEqual(primaryCheckouts([{ id: "prj_a", path: "/p/one" }, { id: "prj_a", path: "/p/two" }, { id: "prj_a", path: "/p/x-worktree" }], linked), []);
});
