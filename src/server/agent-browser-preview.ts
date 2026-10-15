import type { PreviewExpectation, PreviewFixture } from "./agent-preview-fixtures.ts";

/** Runs inside the disposable browser container, never against the host dev server. */
export interface ProbeOptions {
  /** The hostname the browser loads the app by; apps that check Origin may require localhost. */
  host?: "127.0.0.1" | "localhost";
  /** Backend services on the task network; no page loads until each answers. */
  services?: Array<{ name: string; url: string }>;
  /** Real 4xx answers the repository declared as normal; each one used is reported. */
  expected?: PreviewExpectation[];
  /** A signed-in check: this cookie is set before the first route and the jar carries from route to route. */
  session?: { cookie: string; path: string; value: string };
}
export function browserPreviewProbe(script: string, port: number, paths: string[], args: string[], build = false, fixtures: PreviewFixture[] = [], options: ProbeOptions = {}): string {
  return String.raw`
const cp = require('child_process');
if (${build}) { const built = cp.spawnSync('npm', ['run', 'build'], { stdio: 'inherit' }); if (built.error || built.status !== 0) process.exit(1); }
const local = 'http://127.0.0.1:${port}';
const origin = 'http://${options.host ?? "127.0.0.1"}:${port}';
const fixtures = ${JSON.stringify(fixtures)};
const services = ${JSON.stringify(options.services ?? [])};
const expected = ${JSON.stringify(options.expected ?? [])};
const session = ${JSON.stringify(options.session ?? null)};
const server = cp.spawn('npm', ['run', ${JSON.stringify(script)}, ...${JSON.stringify(args)}], {
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: '${port}', HOST: '127.0.0.1', BROWSER: 'none' }
});
let log = '';
server.stdout.on('data', d => log = (log + d).slice(-4000));
server.stderr.on('data', d => log = (log + d).slice(-4000));
server.on('error', e => log = (log + String(e)).slice(-4000));
const stop = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
let browser;
(async () => {
  const report = { verified: false, listening: false, services: [], results: [], serverLog: '' };
  try {
    for (const service of services) {
      const started = Date.now();
      let answered = null;
      while (Date.now() - started < 120000 && answered === null) {
        try { const r = await fetch(service.url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) answered = r.status; else await new Promise(r => setTimeout(r, 500)); }
        catch { await new Promise(r => setTimeout(r, 500)); }
      }
      report.services.push({ name: service.name, ready: answered !== null, status: answered, seconds: Math.round((Date.now() - started) / 1000) });
      if (answered === null) throw new Error('Service ' + service.name + ' did not answer ' + service.url + ' within 120 seconds.');
    }
    let chromium;
    try { ({ chromium } = require('/opt/psm-browser/node_modules/playwright')); }
    catch { throw new Error('Browser verification unavailable. Build scripts/task-browser.Dockerfile as psm-task-browser:1.64.0, or set PSM_BROWSER_IMAGE to an image with /opt/psm-browser/node_modules/playwright and Chromium.'); }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !report.listening) {
      try { await fetch(local + '/', { signal: AbortSignal.timeout(1000) }); report.listening = true; }
      catch { await new Promise(r => setTimeout(r, 250)); }
      if (server.exitCode !== null) break;
    }
    if (!report.listening) throw new Error('The preview server did not start on port ${port}.');
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    // A session token rotates on use, so each route starts from the jar the previous one left, as a person's browser would.
    let jar = session ? [{ name: session.cookie, value: session.value, domain: new URL(origin).hostname, path: session.path, httpOnly: true, secure: false, sameSite: 'Lax', expires: -1 }] : [];
    report.signedIn = !!session;
    for (const route of ${JSON.stringify(paths)}) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      if (jar.length) await context.addCookies(jar);
      // A declared fixture answers the app's own API call; its status is the repository's choice, not a failure.
      const answered = new Set();
      const used = [];
      await context.route('**/*', request => {
        const url = new URL(request.request().url());
        if (url.origin !== origin) return request.abort();
        const fixture = !['fetch', 'xhr'].includes(request.request().resourceType()) ? null : fixtures.find(f => f.method === request.request().method() && f.path === url.pathname);
        if (!fixture) return request.continue();
        answered.add(request.request().url());
        const label = fixture.method + ' ' + fixture.path + ' -> ' + fixture.status;
        if (!used.includes(label)) used.push(label);
        return request.fulfill({ status: fixture.status, contentType: fixture.contentType, body: fixture.body });
      });
      const page = await context.newPage();
      const errors = [];
      const addError = message => { if (errors.length < 20) errors.push(String(message).slice(0, 1000)); };
      page.on('pageerror', e => addError(e.message));
      page.on('console', m => { if (m.type() === 'error' && !(answered.has(m.location().url) && m.text().startsWith('Failed to load resource'))) addError(m.text()); });
      page.on('response', r => {
        const url = new URL(r.url());
        const match = ['fetch', 'xhr'].includes(r.request().resourceType()) && expected.find(e => e.method === r.request().method() && e.path === url.pathname && e.status === r.status());
        if (match) { answered.add(r.url()); const label = 'expected ' + match.method + ' ' + match.path + ' -> ' + match.status; if (!used.includes(label)) used.push(label); return; }
        if (r.url().startsWith(origin + '/') && r.status() >= 400 && !answered.has(r.url()) && !r.url().endsWith('/favicon.ico')) addError('HTTP ' + r.status() + ': ' + r.url());
      });
      page.on('requestfailed', r => { if (r.url().startsWith(origin + '/') && !r.url().endsWith('/favicon.ico')) addError('Request failed: ' + r.url()); });
      let result = { path: route, status: null, type: null, body: '', fixtures: used, errors };
      try {
        const response = await page.goto(origin + route, { waitUntil: 'networkidle', timeout: 10000 });
        result.status = response?.status() ?? null;
        result.type = response?.headers()['content-type'] ?? null;
        await page.waitForTimeout(500);
        const rendered = await page.evaluate(() => {
          const overlay = document.querySelector('vite-error-overlay');
          const root = document.querySelector('#root, #app, #__next') || document.body;
          const text = root?.innerText?.trim() || '';
          const media = [...(root?.querySelectorAll('img, svg, canvas, video') || [])].some(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
          return { overlay: overlay?.shadowRoot?.textContent || overlay?.textContent || (overlay ? 'Vite error overlay' : ''), empty: !text && !media, body: document.body?.innerText?.slice(0, 2000) || '' };
        });
        result.body = rendered.body;
        if (rendered.overlay) addError(rendered.overlay);
        if (rendered.empty) addError('The app rendered no visible content.');
        if (!response || response.status() >= 400) addError('Page navigation failed.');
      } catch (e) { addError(String(e)); }
      report.results.push(result);
      jar = (await context.storageState()).cookies;
      await context.close();
    }
    report.verified = report.results.length > 0 && report.results.every(r => !r.errors.length);
  } catch (e) { report.error = String(e); }
  finally {
    if (browser) await browser.close().catch(() => {});
    stop();
    report.serverLog = log.slice(-2000);
    console.log(JSON.stringify(report, null, 1));
    process.exit(report.verified ? 0 : 1);
  }
})();`;
}
