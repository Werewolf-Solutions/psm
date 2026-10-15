/** Canned same-origin responses a package declares for its offline browser check. */
export const PREVIEW_FIXTURE_FILE = "psm-preview.json";
export const PREVIEW_FIXTURE_SCHEMA = "psm.werewolf.solutions/preview-fixtures/v1";
/** v2 adds real backend services, started beside the app on an internal network. */
export const PREVIEW_SCHEMA = "psm.werewolf.solutions/preview/v2";
export interface PreviewFixture { method: string; path: string; status: number; contentType: string; body: string }
export type PreviewStore = "mongo" | "redis";
export interface PreviewService {
  /** Registered project name; it must be in the task's scope. */
  project: string;
  /** Package directory inside that project, e.g. server. */
  directory: string;
  script: string;
  port: number;
  /** Hostname the app reaches it by on the internal network. */
  alias: string;
  /** Readiness path; any HTTP answer below 500 counts. */
  ready: string;
  env: Record<string, string>;
  /** Variables PSM fills with a fresh random value on every run. */
  secrets: string[];
  stores: PreviewStore[];
  /** Node scripts, relative to the directory, run once before the script starts. */
  seed: string[];
}
/** A real 4xx a service is expected to answer, such as a signed-out session refresh. */
export interface PreviewExpectation { method: string; path: string; status: number }
/** A signed-in check: the browser holds this cookie, valued by a generated secret a service's seed also received. */
export interface PreviewSession { cookie: string; path: string; secret: string }
export interface PreviewConfig { responses: PreviewFixture[]; services: PreviewService[]; expected: PreviewExpectation[]; env: Record<string, string>; host: "127.0.0.1" | "localhost"; session: PreviewSession | null }

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const STORES: PreviewStore[] = ["mongo", "redis"];
const MAX_FIXTURES = 40;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SERVICES = 3;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Set by PSM itself; a declaration cannot point them somewhere else. */
const RESERVED_ENV = new Set(["PORT", "HOST", "HOME", "PATH", "NODE_OPTIONS", "MONGODB_URI", "REDIS_URL", "npm_config_cache"]);
const HOSTNAME = /^[a-z][a-z0-9-]{0,62}$/;
const RELATIVE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-][A-Za-z0-9._/-]{0,200}$/;

type Fail = (message: string) => never;
const failer = (): Fail => message => { throw new Error(`${PREVIEW_FIXTURE_FILE} is invalid: ${message}. Verification has not run.`); };
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A fixture answers one exact method and pathname. It cannot stand in for the
 * page or its assets, so the check still loads and runs the real app.
 */
export function parsePreviewFixtures(text: string): PreviewFixture[] { return parsePreviewConfig(text).responses; }

export function parsePreviewConfig(text: string): PreviewConfig {
  const fail = failer();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { fail("it is not JSON"); }
  if (!isObject(parsed)) fail("expected an object");
  if (parsed.schema === PREVIEW_FIXTURE_SCHEMA) {
    if (Object.keys(parsed).some(key => key !== "schema" && key !== "responses")) fail("only schema and responses are allowed");
    return { responses: responses(parsed.responses, fail), services: [], expected: [], env: {}, host: "127.0.0.1", session: null };
  }
  if (parsed.schema !== PREVIEW_SCHEMA) fail(`schema must be ${PREVIEW_FIXTURE_SCHEMA} or ${PREVIEW_SCHEMA}`);
  if (Object.keys(parsed).some(key => !["schema", "responses", "services", "expected", "env", "host", "session"].includes(key))) fail("only schema, responses, services, expected, env, host and session are allowed");
  if ("host" in parsed && !["127.0.0.1", "localhost"].includes(parsed.host)) fail("host must be 127.0.0.1 or localhost");
  if ("services" in parsed && (!Array.isArray(parsed.services) || parsed.services.length > MAX_SERVICES)) fail(`services must be a list of at most ${MAX_SERVICES}`);
  const services = (parsed.services ?? []).map((entry: unknown, index: number) => service(entry, `services[${index}]`, fail));
  const aliases = new Set<string>();
  for (const { alias } of services) { if (aliases.has(alias) || STORES.includes(alias as PreviewStore)) fail(`service alias ${alias} is used twice`); aliases.add(alias); }
  if ("expected" in parsed && !services.length) fail("expected needs a service; a fixture already answers its own call");
  return { responses: responses(parsed.responses ?? [], fail), services, expected: expected(parsed.expected ?? [], fail), env: env(parsed.env ?? {}, "env", fail), host: parsed.host ?? "127.0.0.1", session: "session" in parsed ? session(parsed.session, services, fail) : null };
}

function session(entry: unknown, services: PreviewService[], fail: Fail): PreviewSession {
  if (!isObject(entry) || Object.keys(entry).some(key => !["cookie", "path", "secret"].includes(key))) fail("session takes cookie, path and secret");
  const e = entry as Record<string, any>;
  if (typeof e.cookie !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.cookie)) fail("session.cookie must be a cookie name");
  const cookiePath = e.path ?? "/";
  if (typeof cookiePath !== "string" || !/^\/[A-Za-z0-9._~%/-]{0,200}$/.test(cookiePath)) fail("session.path must be a cookie path");
  // Only a value PSM generated for this run can sign the browser in; a declared literal would be a real credential in the repository.
  if (typeof e.secret !== "string" || !services.some(service => service.secrets.includes(e.secret))) fail("session.secret must name a secret one of the services declares");
  return { cookie: e.cookie, path: cookiePath, secret: e.secret };
}

function expected(list: unknown, fail: Fail): PreviewExpectation[] {
  if (!Array.isArray(list) || list.length > 20) fail("expected must be a list of at most 20");
  return (list as any[]).map((entry, index) => {
    const at = `expected[${index}]`;
    if (!isObject(entry) || Object.keys(entry).some(key => !["method", "path", "status"].includes(key))) fail(`${at} takes method, path and status`);
    const method = entry.method ?? "GET";
    if (!METHODS.includes(method)) fail(`${at}.method must be one of ${METHODS.join(", ")}`);
    if (typeof entry.path !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,300}$/.test(entry.path)) fail(`${at}.path must be an exact pathname without a query`);
    if (!Number.isInteger(entry.status) || entry.status < 400 || entry.status > 499) fail(`${at}.status must be 400-499; a 5xx is never expected`);
    return { method, path: entry.path, status: entry.status };
  });
}

function responses(list: unknown, fail: Fail): PreviewFixture[] {
  if (!Array.isArray(list) || list.length > MAX_FIXTURES) fail(`responses must be a list of at most ${MAX_FIXTURES}`);
  const seen = new Set<string>();
  let total = 0;
  return (list as any[]).map((entry: any, index: number) => {
    const at = `responses[${index}]`;
    if (!isObject(entry)) fail(`${at} must be an object`);
    if (Object.keys(entry).some(key => !["method", "path", "status", "json", "text", "contentType"].includes(key))) fail(`${at} has an unknown field`);
    const method = entry.method ?? "GET";
    if (!METHODS.includes(method)) fail(`${at}.method must be one of ${METHODS.join(", ")}`);
    if (typeof entry.path !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,300}$/.test(entry.path)) fail(`${at}.path must be an exact pathname without a query`);
    if (!Number.isInteger(entry.status) || entry.status < 200 || entry.status > 599 || (entry.status >= 300 && entry.status < 400)) fail(`${at}.status must be 200-299 or 400-599`);
    if ("json" in entry && "text" in entry) fail(`${at} takes json or text, not both`);
    if ("text" in entry && typeof entry.text !== "string") fail(`${at}.text must be a string`);
    if ("contentType" in entry && (typeof entry.contentType !== "string" || !/^[a-z]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/.test(entry.contentType))) fail(`${at}.contentType is not a plain media type`);
    const body = "json" in entry ? JSON.stringify(entry.json) : entry.text ?? "";
    total += Buffer.byteLength(body);
    if (total > MAX_BODY_BYTES) fail(`response bodies exceed ${MAX_BODY_BYTES} bytes in total`);
    const key = `${method} ${entry.path}`;
    if (seen.has(key)) fail(`${key} is declared twice`);
    seen.add(key);
    return { method, path: entry.path, status: entry.status, contentType: entry.contentType ?? ("json" in entry ? "application/json" : "text/plain"), body };
  });
}

function env(value: unknown, at: string, fail: Fail): Record<string, string> {
  if (!isObject(value) || Object.keys(value).length > 30) fail(`${at} must be an object of at most 30 variables`);
  for (const [name, text] of Object.entries(value as object)) {
    if (!ENV_NAME.test(name)) fail(`${at}.${name} is not an environment variable name`);
    if (RESERVED_ENV.has(name)) fail(`${at}.${name} is set by PSM`);
    if (typeof text !== "string" || text.length > 500) fail(`${at}.${name} must be a string of at most 500 characters`);
  }
  return { ...(value as Record<string, string>) };
}

function service(entry: unknown, at: string, fail: Fail): PreviewService {
  if (!isObject(entry)) fail(`${at} must be an object`);
  const e = entry as Record<string, any>;
  if (Object.keys(e).some(key => !["project", "directory", "script", "port", "alias", "ready", "env", "secrets", "stores", "seed"].includes(key))) fail(`${at} has an unknown field`);
  if (typeof e.project !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(e.project)) fail(`${at}.project must be a registered project name`);
  const directory = e.directory ?? ".";
  if (directory !== "." && (typeof directory !== "string" || !RELATIVE.test(directory))) fail(`${at}.directory must be a relative package directory`);
  if (typeof e.script !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,99}$/.test(e.script)) fail(`${at}.script must be a package.json script name`);
  if (!Number.isInteger(e.port) || e.port < 1024 || e.port > 65535) fail(`${at}.port must be 1024-65535`);
  const alias = e.alias ?? e.project.toLowerCase();
  if (typeof alias !== "string" || !HOSTNAME.test(alias)) fail(`${at}.alias must be a lowercase hostname`);
  const ready = e.ready ?? "/";
  if (typeof ready !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,300}$/.test(ready)) fail(`${at}.ready must be a pathname`);
  const secrets = e.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.length > 10 || secrets.some((name: unknown) => typeof name !== "string" || !ENV_NAME.test(name) || RESERVED_ENV.has(name))) fail(`${at}.secrets must list at most 10 variable names`);
  const stores = e.stores ?? [];
  if (!Array.isArray(stores) || stores.some((name: unknown) => !STORES.includes(name as PreviewStore)) || new Set(stores).size !== stores.length) fail(`${at}.stores may only list ${STORES.join(" and ")}`);
  const seed = e.seed ?? [];
  if (!Array.isArray(seed) || seed.length > 5 || seed.some((file: unknown) => typeof file !== "string" || !RELATIVE.test(file) || !/\.(?:c|m)?js$/.test(file))) fail(`${at}.seed must list at most 5 relative .js files`);
  return { project: e.project, directory, script: e.script, port: e.port, alias, ready, env: env(e.env ?? {}, `${at}.env`, fail), secrets: [...secrets], stores: [...stores], seed: [...seed] };
}
