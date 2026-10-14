/** Canned same-origin responses a package declares for its offline browser check. */
export const PREVIEW_FIXTURE_FILE = "psm-preview.json";
export const PREVIEW_FIXTURE_SCHEMA = "psm.werewolf.solutions/preview-fixtures/v1";
export interface PreviewFixture { method: string; path: string; status: number; contentType: string; body: string }

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_FIXTURES = 40;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * A fixture answers one exact method and pathname. It cannot stand in for the
 * page or its assets, so the check still loads and runs the real app.
 */
export function parsePreviewFixtures(text: string): PreviewFixture[] {
  const fail = (message: string): never => { throw new Error(`${PREVIEW_FIXTURE_FILE} is invalid: ${message}. Verification has not run.`); };
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { fail("it is not JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("expected an object");
  if (parsed.schema !== PREVIEW_FIXTURE_SCHEMA) fail(`schema must be ${PREVIEW_FIXTURE_SCHEMA}`);
  if (Object.keys(parsed).some(key => key !== "schema" && key !== "responses")) fail("only schema and responses are allowed");
  if (!Array.isArray(parsed.responses) || parsed.responses.length > MAX_FIXTURES) fail(`responses must be a list of at most ${MAX_FIXTURES}`);
  const seen = new Set<string>();
  let total = 0;
  return parsed.responses.map((entry: any, index: number) => {
    const at = `responses[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${at} must be an object`);
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
