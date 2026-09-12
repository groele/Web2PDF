import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(baseDir, 'test-output', 'extension-e2e-' + runId);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web2pdf-extension-e2e-'));
fs.mkdirSync(outputDir, { recursive: true });

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitFor(check, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(label + (lastError ? ': ' + lastError.message : ''));
}

function findBrowser() {
  const candidates = [
    process.env.WEB2PDF_BROWSER_PATH,
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

function createCdpClient(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (!data.id) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result);
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return {
    open,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); }
  };
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

function eventAt(client, type, point) {
  return client.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function click(client, selector) {
  const point = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  assert.ok(point, 'Missing ' + selector);
  await eventAt(client, 'mousePressed', point);
  await eventAt(client, 'mouseReleased', point);
}

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png'
};
const server = http.createServer((request, response) => {
  const relative = decodeURIComponent((request.url || '/').split('?')[0]);
  const filePath = path.resolve(baseDir, '.' + relative);
  if (!filePath.startsWith(baseDir + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
});

let browser;
let browserClient;
let pageClient;
let exitCode = 0;
let stderr = '';
try {
  const fixturePort = await listen(server);
  const debuggerPort = await freePort();
  const browserPath = findBrowser();
  assert.ok(browserPath, 'Chrome or Edge is required for extension E2E testing');
  const fixtureUrl = 'http://test.webofscience.com:' + fixturePort + '/tests/test-guidance.html';

  browser = spawn(browserPath, [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + debuggerPort,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions-except=' + baseDir,
    '--load-extension=' + baseDir,
    '--host-resolver-rules=MAP test.webofscience.com 127.0.0.1',
    '--user-data-dir=' + profileDir,
    '--window-size=1280,900',
    fixtureUrl
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const version = await waitFor(async () => {
    const response = await fetch('http://127.0.0.1:' + debuggerPort + '/json/version');
    return response.ok ? response.json() : null;
  }, 'Chrome DevTools endpoint did not become available');
  browserClient = createCdpClient(version.webSocketDebuggerUrl);
  await browserClient.open;
  await browserClient.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outputDir });

  const pageInfo = await waitFor(async () => {
    const pages = await (await fetch('http://127.0.0.1:' + debuggerPort + '/json/list')).json();
    return pages.find(page => page.type === 'page' && page.url.includes('test-guidance.html'));
  }, 'Fixture page did not load');
  pageClient = createCdpClient(pageInfo.webSocketDebuggerUrl);
  await pageClient.open;
  await pageClient.send('Page.enable');
  await pageClient.send('Runtime.enable');
  // Chrome can start the target page before an unpacked extension has finished
  // registering its content scripts. Navigate again only after CDP is ready so
  // this checks the actual document_idle injection lifecycle.
  await pageClient.send('Page.navigate', { url: fixtureUrl });
  await waitFor(async () => evaluate(pageClient, "document.readyState === 'complete'"), 'Fixture did not finish its extension-aware navigation');

  await waitFor(async () => evaluate(pageClient, "Boolean(document.querySelector('#wos-pdf-floating-widget'))"), 'Installed extension did not inject its toolbar');
  const initial = await evaluate(pageClient, `({
    title: document.title,
    widget: Boolean(document.querySelector('#wos-pdf-floating-widget')),
    smartButton: document.querySelector('#wos-btn-auto-export')?.textContent.trim(),
    version: document.querySelector('#wos-pdf-floating-widget')?.textContent.includes('2x') || null
  })`);
  assert.equal(initial.widget, true);
  assert.match(initial.smartButton || '', /智能导出 PDF/);

  await click(pageClient, '#wos-btn-auto-export');
  await waitFor(async () => evaluate(pageClient, "Boolean(document.querySelector('#wos-region-adjuster-panel'))"), 'Smart selection panel did not open');
  const smart = await evaluate(pageClient, `({
    mask: Boolean(document.querySelector('#wos-mask-overlay')),
    adjuster: Boolean(document.querySelector('#wos-region-adjuster')),
    handles: document.querySelectorAll('.wos-region-handle').length,
    panel: document.querySelector('#wos-region-adjuster-panel')?.textContent.trim()
  })`);
  assert.equal(smart.mask, true);
  assert.equal(smart.adjuster, true);
  assert.equal(smart.handles, 8);
  assert.match(smart.panel || '', /导出文件/);

  const smartShot = await pageClient.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outputDir, 'smart-selection.png'), Buffer.from(smartShot.data, 'base64'));

  await click(pageClient, '#wos-region-adjuster-panel [data-action="export"]');
  const downloadedPdf = await waitFor(() => {
    const pdf = fs.readdirSync(outputDir).find(name => name.toLowerCase().endsWith('.pdf'));
    return pdf && fs.statSync(path.join(outputDir, pdf)).size > 512 ? pdf : null;
  }, 'Installed extension did not create a PDF download', 30000);
  const downloadSize = fs.statSync(path.join(outputDir, downloadedPdf)).size;
  assert.ok(downloadSize > 512);

  await waitFor(async () => evaluate(pageClient, "!document.querySelector('#wos-region-adjuster-panel')"), 'Selection did not close after export');
  await click(pageClient, '#wos-btn-pick-export');
  await waitFor(async () => evaluate(pageClient, "Boolean(document.querySelector('#wos-export-target-marker'))"), 'Manual picker did not open');
  const articlePoint = await evaluate(pageClient, `(() => {
    const box = document.querySelector('article.main-record').getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  await pageClient.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: articlePoint.x, y: articlePoint.y });
  await eventAt(pageClient, 'mousePressed', articlePoint);
  await eventAt(pageClient, 'mouseReleased', articlePoint);
  await waitFor(async () => evaluate(pageClient, "Boolean(document.querySelector('#wos-region-adjuster-panel'))"), 'Manual picker did not create an adjustable selection');
  await click(pageClient, '#wos-region-adjuster-panel [data-action="cancel"]');
  await waitFor(async () => evaluate(pageClient, "!document.querySelector('#wos-region-adjuster-panel')"), 'Manual selection did not close');

  const result = {
    browser: path.basename(browserPath),
    fixtureUrl,
    outputDir,
    download: { name: downloadedPdf, bytes: downloadSize },
    initial,
    smart
  };
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  exitCode = 1;
  console.error(error.stack || error.message);
  if (stderr) console.error('Browser stderr:\n' + stderr);
} finally {
  pageClient?.close();
  browserClient?.close();
  if (browser && !browser.killed) {
    browser.kill();
    await new Promise(resolve => browser.once('exit', resolve));
  }
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(profileDir, { recursive: true, force: true });
}
process.exitCode = exitCode;
