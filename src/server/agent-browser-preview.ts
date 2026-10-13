/** Runs inside the disposable browser container, never against the host dev server. */
export function browserPreviewProbe(script: string, port: number, paths: string[], args: string[], build = false): string {
  return String.raw`
const cp = require('child_process');
if (${build}) { const built = cp.spawnSync('npm', ['run', 'build'], { stdio: 'inherit' }); if (built.error || built.status !== 0) process.exit(1); }
const origin = 'http://127.0.0.1:${port}';
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
  const report = { verified: false, listening: false, results: [], serverLog: '' };
  try {
    let chromium;
    try { ({ chromium } = require('/opt/psm-browser/node_modules/playwright')); }
    catch { throw new Error('Browser verification unavailable. Build scripts/task-browser.Dockerfile as psm-task-browser:1.64.0, or set PSM_BROWSER_IMAGE to an image with /opt/psm-browser/node_modules/playwright and Chromium.'); }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !report.listening) {
      try { await fetch(origin + '/', { signal: AbortSignal.timeout(1000) }); report.listening = true; }
      catch { await new Promise(r => setTimeout(r, 250)); }
      if (server.exitCode !== null) break;
    }
    if (!report.listening) throw new Error('The preview server did not start on port ${port}.');
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    for (const route of ${JSON.stringify(paths)}) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', request => {
        const url = new URL(request.request().url());
        return url.origin === origin ? request.continue() : request.abort();
      });
      const page = await context.newPage();
      const errors = [];
      const addError = message => { if (errors.length < 20) errors.push(String(message).slice(0, 1000)); };
      page.on('pageerror', e => addError(e.message));
      page.on('console', m => { if (m.type() === 'error') addError(m.text()); });
      page.on('response', r => { if (r.url().startsWith(origin + '/') && r.status() >= 400 && !r.url().endsWith('/favicon.ico')) addError('HTTP ' + r.status() + ': ' + r.url()); });
      page.on('requestfailed', r => { if (r.url().startsWith(origin + '/') && !r.url().endsWith('/favicon.ico')) addError('Request failed: ' + r.url()); });
      let result = { path: route, status: null, type: null, body: '', errors };
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
