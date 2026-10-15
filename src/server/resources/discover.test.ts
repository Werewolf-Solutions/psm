import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assemble,
  databaseKey,
  databaseVariables,
  engineOfImage,
  engineOfProcess,
  envReferences,
  parseDatabaseUri,
  parseDockerPorts,
  parseDockerPs,
  type DiscoveryInput,
} from "./discover.ts";

const SECRET_URIS = [
  "mongodb://admin:hunter2-secret@localhost:27017/werewolf?authSource=admin&tls=false",
  "mongodb+srv://svc:hunter2-secret@cluster0.abcd.mongodb.net/prod?retryWrites=true",
  "postgresql://app:hunter2-secret@db.internal:6543/ledger?sslmode=require",
  "redis://:hunter2-secret@127.0.0.1:6380/2",
  "mysql://root:hunter2-secret@[::1]:3307/shop",
  "mongodb://u:hunter2-secret@a.example:27017,b.example:27017/rs?replicaSet=rs0",
];

test("a parsed connection string keeps no credential, anywhere in it", () => {
  for (const uri of SECRET_URIS) {
    const target = parseDatabaseUri(uri);
    assert.ok(target, uri);
    const json = JSON.stringify(target);
    assert.ok(!json.includes("hunter2"), `${uri} leaked its password`);
    assert.ok(!json.includes("admin:") && !json.includes("svc") && !json.includes("root"), `${uri} leaked its user`);
    assert.ok(!json.includes("authSource") && !json.includes("sslmode") && !json.includes("retryWrites"), `${uri} kept its query`);
  }
});

test("connection strings reduce to engine, host, port and database", () => {
  assert.deepEqual(parseDatabaseUri(SECRET_URIS[0]), { engine: "mongodb", host: "localhost", port: 27017, database: "werewolf", local: true, moreHosts: 0 });
  assert.deepEqual(parseDatabaseUri(SECRET_URIS[1]), { engine: "mongodb", host: "cluster0.abcd.mongodb.net", port: null, database: "prod", local: false, moreHosts: 0 });
  assert.equal(parseDatabaseUri(SECRET_URIS[2])?.engine, "postgres");
  assert.equal(parseDatabaseUri(SECRET_URIS[2])?.port, 6543);
  assert.deepEqual(parseDatabaseUri(SECRET_URIS[3]), { engine: "redis", host: "localhost", port: 6380, database: "2", local: true, moreHosts: 0 });
  assert.equal(parseDatabaseUri(SECRET_URIS[4])?.host, "localhost");
  assert.equal(parseDatabaseUri(SECRET_URIS[5])?.moreHosts, 1);
  assert.equal(parseDatabaseUri("postgres://localhost/app")?.port, 5432, "the default port fills in");
  assert.equal(parseDatabaseUri("https://example.com"), null);
  assert.equal(parseDatabaseUri("not a uri"), null);
});

test("every loopback spelling is the same database", () => {
  const keys = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].map((host) => databaseKey(parseDatabaseUri(`mongodb://${host}:27017/x`)!));
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], "db:mongodb:localhost:27017");
});

test(".env lines give the variable name and target, never the value", () => {
  const found = databaseVariables([
    "# comment",
    "PORT=3000",
    `export MONGODB_URI="${SECRET_URIS[0]}"`,
    `REDIS_URL='${SECRET_URIS[3]}'`,
    "JWT_SECRET=hunter2-secret",
  ].join("\n"));
  assert.deepEqual(found.map((entry) => entry.variable), ["MONGODB_URI", "REDIS_URL"]);
  assert.ok(!JSON.stringify(found).includes("hunter2"));
});

test("project .env files are found two levels down, examples skipped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-res-"));
  try {
    fs.mkdirSync(path.join(root, "server"));
    fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, "server", ".env"), `MONGODB_URI=${SECRET_URIS[0]}\n`);
    fs.writeFileSync(path.join(root, "server", ".env.example"), "MONGODB_URI=mongodb://localhost:27017/example\n");
    fs.writeFileSync(path.join(root, "node_modules", "x", ".env"), "MONGODB_URI=mongodb://localhost:1/nope\n");
    const refs = envReferences([{ name: "dapp", path: root }]);
    assert.equal(refs.length, 1);
    assert.deepEqual({ ...refs[0], target: undefined }, { project: "dapp", directory: "server", file: ".env", variable: "MONGODB_URI", target: undefined });
    assert.ok(!JSON.stringify(refs).includes("hunter2"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("docker ps lines and port mappings parse", () => {
  assert.deepEqual(parseDockerPorts("0.0.0.0:27018->27017/tcp, :::27018->27017/tcp, 9000/tcp"), [{ hostPort: 27018, containerPort: 27017 }]);
  const rows = parseDockerPs(`{"Names":"mongo-dev","Image":"mongo:7","State":"running","Status":"Up 2 hours","Ports":"0.0.0.0:27018->27017/tcp"}\nnot json\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "mongo-dev");
});

test("engines are recognised from images and executables", () => {
  assert.equal(engineOfImage("mongo:7"), "mongodb");
  assert.equal(engineOfImage("docker.io/library/postgres:16-alpine"), "postgres");
  assert.equal(engineOfImage("bitnami/redis"), "redis");
  assert.equal(engineOfImage("node:22"), null);
  assert.equal(engineOfProcess("/usr/bin/mongod --config /etc/mongod.conf"), "mongodb");
  assert.equal(engineOfProcess("node ./bin/www"), null);
});

const empty = (): DiscoveryInput => ({
  sockets: [],
  table: new Map(),
  docker: { available: true, reason: null, containers: [] },
  env: [],
  servers: [],
  folders: [],
});

test("a system database with no visible pid is still found, and linked to its project", () => {
  const input = empty();
  input.sockets = [
    { address: "127.0.0.1", port: 27017, pid: null },
    { address: "127.0.0.1", port: 631, pid: null },
    { address: "127.0.0.1", port: 6379, pid: null },
    { address: "::1", port: 6379, pid: null },
  ];
  input.env = [{ project: "werewolf-dapp", directory: "server", file: ".env", variable: "MONGODB_URI", target: parseDatabaseUri(SECRET_URIS[0])! }];
  const { resources } = assemble(input);
  const dbs = resources.filter((row) => row.kind === "database");
  assert.deepEqual(dbs.map((row) => row.key).sort(), ["db:mongodb:localhost:27017", "db:redis:localhost:6379"]);
  const mongo = dbs.find((row) => row.engine === "mongodb")!;
  assert.equal(mongo.running, true);
  assert.equal(mongo.where, "system service");
  assert.deepEqual(mongo.usedBy, [{ project: "werewolf-dapp", directory: "server", file: ".env", variable: "MONGODB_URI", database: "werewolf" }]);
});

test("a known non-database process on a database port is not a database", () => {
  const input = empty();
  input.sockets = [{ address: "127.0.0.1", port: 6379, pid: 42 }];
  input.table.set(42, { pid: 42, ppid: 1, etimes: 1, rss: 1, args: "node fake-redis.js" });
  assert.equal(assemble(input).resources.length, 0);
});

test("a database container names itself on its published port", () => {
  const input = empty();
  input.docker.containers = [{ name: "mongo-dev", image: "mongo:7", state: "running", status: "Up", ports: [{ hostPort: 27018, containerPort: 27017 }] }];
  input.sockets = [{ address: "0.0.0.0", port: 27018, pid: null }];
  const { resources } = assemble(input);
  const db = resources.find((row) => row.kind === "database")!;
  assert.equal(db.key, "db:mongodb:localhost:27018");
  assert.equal(db.container, "mongo-dev");
  assert.ok(resources.some((row) => row.key === "container:mongo-dev"));
});

test("a remote or stopped database referenced by a project is still listed", () => {
  const input = empty();
  input.env = [
    { project: "a", directory: "", file: ".env", variable: "DATABASE_URL", target: parseDatabaseUri(SECRET_URIS[2])! },
    { project: "b", directory: "", file: ".env", variable: "MONGODB_URI", target: parseDatabaseUri("mongodb://localhost:27099/x")! },
  ];
  const rows = assemble(input).resources;
  const remote = rows.find((row) => row.host === "db.internal")!;
  assert.equal(remote.local, false);
  assert.equal(remote.where, "remote");
  const stopped = rows.find((row) => row.port === 27099)!;
  assert.equal(stopped.running, false);
  assert.equal(stopped.where, "this machine, not running");
});
