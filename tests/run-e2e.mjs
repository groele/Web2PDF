import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. Start local HTTP server
const mimeMap = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(baseDir, '.' + decodeURIComponent(urlPath));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found: ' + filePath);
  }
});

await new Promise(r => server.listen(8767, '127.0.0.1', r));
console.log('Local HTTP server running at http://127.0.0.1:8767');

// 2. Launch Edge directly with target URL
const browserCandidates = [
  process.env.WEB2PDF_BROWSER_PATH,
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
].filter(Boolean);
const edgePath = browserCandidates.find(candidate => fs.existsSync(candidate));
if (!edgePath) throw new Error('No supported browser found. Set WEB2PDF_BROWSER_PATH to Edge or Chrome.');
const userDataDir = path.join(baseDir, 'test-output', 'edge-e2e-data-3');
fs.mkdirSync(userDataDir, { recursive: true });

const proc = spawn(edgePath, [
  '--headless=new',
  '--remote-debugging-port=9234',
  '--disable-gpu',
  '--window-size=1280,900',
  '--user-data-dir=' + userDataDir,
  'http://127.0.0.1:8767/tests/test-guidance.html'
]);

await new Promise(r => setTimeout(r, 2500));

try {
  const versionRes = await fetch('http://127.0.0.1:9234/json/list');
  const pages = await versionRes.json();
  const page = pages.find(p => p.type === 'page' && p.url.includes('test-guidance')) || pages[0];
  console.log('Target page URL:', page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.onopen = resolve);

  let id = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = id++;
    const handler = (e) => {
      const data = JSON.parse(e.data);
      if (data.id === msgId) {
        ws.removeEventListener('message', handler);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };

  let ready = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    ready = await evaluate("({ state: document.readyState, title: document.title, heading: document.querySelector('article.main-record h1')?.textContent || '' })");
    if (ready.state === 'complete' && ready.heading) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(ready?.state, 'complete');
  assert.ok(ready?.heading, 'Fixture article did not load');

  console.log('Loaded Page Title:', ready.title + ' | ' + ready.heading);

  // Trigger Smart Preview
  console.log('Triggering smart preview...');
  await evaluate("window.chrome.runtime.onMessage.listeners.forEach(l => l({ action: 'preview_smart', options: { outputFormat: 'pdf', resolutionScale: 3, exportMode: 'a4' } }, {}, () => {}));");

  await new Promise(r => setTimeout(r, 1000));

  // Check state
  const smartState = await evaluate(`
      ({
        hasMask: !!document.getElementById('wos-mask-overlay'),
        maskTop: document.querySelector('.wos-mask-panel.top')?.style.height,
        maskBottom: document.querySelector('.wos-mask-panel.bottom')?.style.top,
        hasBanner: !!document.getElementById('wos-guidance-banner'),
        bannerText: document.querySelector('.wos-guidance-text')?.textContent,
        hasAdjuster: !!document.getElementById('wos-region-adjuster'),
        hudDim: document.querySelector('.wos-region-hud-dim')?.textContent,
        handleCount: document.querySelectorAll('.wos-region-handle').length,
        handles: Array.from(document.querySelectorAll('.wos-region-handle')).map(h => h.className),
        hasMoveSurface: !!document.querySelector('.wos-region-move-surface'),
        hasPanel: !!document.getElementById('wos-region-adjuster-panel')
      })
    `);
  console.log('SMART_PREVIEW_STATE:', JSON.stringify(smartState, null, 2));
  assert.equal(smartState.hasMask, true);
  assert.equal(smartState.hasBanner, true);
  assert.equal(smartState.hasAdjuster, true);
  assert.equal(smartState.handleCount, 8);
  assert.equal(smartState.hasMoveSurface, true);
  assert.equal(smartState.hasPanel, true);

  // Capture screenshot of smart selection
  const snap1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(baseDir, 'test-output', 'smart-guidance-verified.png'), Buffer.from(snap1.data, 'base64'));
  console.log('Saved: smart-guidance-verified.png');

  // Cancel smart selection
  await evaluate("document.querySelector('#wos-region-adjuster-panel button[data-action=\"cancel\"]').click();");
  await new Promise(r => setTimeout(r, 300));

  // Trigger picker mode
  console.log('Triggering picker mode...');
  await evaluate("window.chrome.runtime.onMessage.listeners.forEach(l => l({ action: 'start_picker', options: { outputFormat: 'pdf', resolutionScale: 3, exportMode: 'a4' } }, {}, () => {}));");
  await new Promise(r => setTimeout(r, 400));

  // Dispatch mouse move over article
  const box = await evaluate(`
      const target = document.querySelector('article.main-record');
      const b = target.getBoundingClientRect();
      ({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) })
    `);

  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y
  });
  await new Promise(r => setTimeout(r, 500));

  const pickerState = await evaluate(`
      ({
        hasMarker: !document.getElementById('wos-export-target-marker')?.hidden,
        highlightedCount: document.querySelectorAll('.wos-element-highlighted').length,
        markerLabel: document.querySelector('.wos-export-target-marker__label')?.textContent,
        hasMask: !!document.getElementById('wos-mask-overlay'),
        bannerText: document.querySelector('.wos-guidance-text')?.textContent
      })
    `);
  console.log('PICKER_STATE:', JSON.stringify(pickerState, null, 2));
  assert.equal(pickerState.hasMarker, true);
  assert.equal(pickerState.hasMask, true);
  assert.match(pickerState.markerLabel || '', /点击锁定/);

  // Capture screenshot of picker
  const snap2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(baseDir, 'test-output', 'picker-guidance-verified.png'), Buffer.from(snap2.data, 'base64'));
  console.log('Saved: picker-guidance-verified.png');

  ws.close();
} catch (e) {
  console.error('ERROR:', e);
  process.exitCode = 1;
} finally {
  proc.kill();
  server.close();
}
