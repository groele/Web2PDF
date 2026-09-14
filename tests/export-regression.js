// Run with the connected Playwright browser_run_code tool (filename), not Node directly.
// Uses real bundled renderers and a mocked extension message boundary.
async (page) => {
  const base = 'http://127.0.0.1:8765';
  const results = [];
  let state;
  const check = (name, condition, details) => { results.push({ name, pass: Boolean(condition), details }); };
  async function setup(html, width = 1100) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(base + '/tests/scroll-sidebar.html');
    await page.setContent(html);
    await page.evaluate(() => {
      window.chrome = { runtime: { onMessage: { addListener(fn) { window.message = fn; } } } };
      window.downloads = [];
      window.downloadTasks = [];
      HTMLAnchorElement.prototype.click = function() {
        window.downloads.push(this.download);
        window.downloadTasks.push(fetch(this.href).then(r => r.blob()).then(async blob => {
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
          window.encoded = { type: blob.type, width: canvas.width, height: canvas.height,
            corner: [...ctx.getImageData(0, 0, 1, 1).data], center: [...ctx.getImageData(100, 100, 1, 1).data] };
        }));
      };
    });
    await page.addStyleTag({ url: base + '/content.css' });
    await page.addScriptTag({ url: base + '/libs/html2canvas.min.js' });
    await page.addScriptTag({ url: base + '/libs/jspdf.umd.min.js' });
    await page.evaluate(() => {
      const render = window.html2canvas;
      window.html2canvas = async (...args) => {
        if (window.failCapture) throw new Error('Test renderer failure');
        if (window.delayCapture) await new Promise(resolve => { window.releaseCapture = resolve; });
        if (window.failClone) {
          const onclone = args[1].onclone;
          args[1].onclone = (...params) => { onclone(...params); throw new Error('Test clone failure'); };
        }
        const canvas = await render(...args);
        const ctx = canvas.getContext('2d');
        window.capture = { width: canvas.width, height: canvas.height,
          bottom: [...ctx.getImageData(20, canvas.height - 20, 1, 1).data] };
        window.previewPng = canvas.toDataURL('image/png');
        return canvas;
      };
      const RealPDF = window.jspdf.jsPDF;
      window.jspdf.jsPDF = function(...args) {
        const pdf = new RealPDF(...args);
        let textCalls = 0;
        const text = pdf.text;
        pdf.text = function(...params) { textCalls++; return text.apply(this, params); };
        pdf.save = () => { window.pdf = { pages: pdf.getNumberOfPages(), textCalls, header: pdf.output().slice(0, 8) }; };
        return pdf;
      };
    });
    await page.addScriptTag({ url: base + '/content.js' });
  }
  const sidebar = `<style>
    body{margin:0;background:purple} .drawer{position:fixed;right:0;top:0;width:400px;height:100vh;display:flex;flex-direction:column;background:white}
    header{height:60px;flex-shrink:0} main{overflow:auto;flex:1} section{height:500px} footer{height:100px;background:rgb(0,200,0)}
    header::before{content:'Journal';color:oklch(60% .1 180)}
    </style><div class="drawer"><header>Title</header><main><script type="application/json">{}</script><span data-html2canvas-ignore="true"></span><section>First</section><section>Second</section><footer>END</footer></main></div>`;
  const options = { outputFormat: 'png', resolutionScale: 2, fileName: 'capture.png', margins: { top: 0, bottom: 0, left: 0, right: 0 } };
  async function pick(selector, opts = options) {
    await page.evaluate(opts => window.message({ action: 'start_picker', options: opts }, null, () => {}), opts);
    await page.locator(selector).click();
  }
  async function exportNow() {
    await page.locator('[data-action="export"]').click();
    await page.waitForFunction(() => !document.querySelector('#wos-region-adjuster-panel')?.hasAttribute('aria-busy'));
    await page.evaluate(() => Promise.all(window.downloadTasks));
  }
  await setup(sidebar);
  await page.evaluate(() => document.querySelector('main').scrollTop = 200);
  await pick('header');
  check('custom div drawer detected through title', await page.locator('.wos-region-scroll-mode').count() === 1);
  await page.locator('#wos-region-adjuster').evaluate(el => el.dataset.instance = 'original');
  await page.evaluate(opts => window.message({ action: 'start_picker', options: opts }, null, reply => window.duplicateReply = reply), options);
  state = await page.evaluate(() => ({ reply: window.duplicateReply, instance: document.querySelector('#wos-region-adjuster')?.dataset.instance }));
  check('duplicate launch reuses current selection', state.reply?.reused === true && state.instance === 'original', state);
  await exportNow();
  state = await page.evaluate(() => ({ capture: window.capture, downloads: window.downloads, scroll: document.querySelector('main').scrollTop,
    height: document.querySelector('.drawer').offsetHeight, frames: document.querySelectorAll('.html2canvas-container').length,
    attrs: [...document.querySelectorAll('*')].flatMap(el => [...el.attributes].filter(a => a.name.startsWith('data-wos-capture-'))).length }));
  check('full drawer including tail; ignored nodes and pseudo colors', state.capture?.width === 800 && state.capture?.height === 2320 && state.capture?.bottom[1] === 200, state);
  check('live scroll, layout and temporary nodes restored', state.scroll === 200 && state.height === 800 && state.frames === 0 && state.attrs === 0, state);
  check('no duplicated filename extension', state.downloads[0] === 'capture.png', state.downloads);

  await setup(sidebar);
  await pick('header', { ...options, outputFormat: 'pdf', margins: { top: 12, bottom: 12, left: 10, right: 10 } });
  await exportNow();
  state = await page.evaluate(() => window.pdf);
  check('real multipage PDF without added page numbers', state?.pages >= 2 && state?.textCalls === 0 && state?.header === '%PDF-1.3', state);

  await setup('<style>body{margin:0}article{width:600px;height:900px}h1{margin:0} .table{overflow:auto;height:100px} .table div{height:600px}</style><article><h1>Article</h1><div class="table"><div>Rows</div></div></article>');
  await pick('article');
  check('ordinary article is not promoted to nested table', await page.locator('.wos-region-scroll-mode').count() === 0);
  await page.evaluate(() => window.failCapture = true);
  await exportNow();
  check('failure retains editable selection', await page.locator('#wos-region-adjuster-panel').count() === 1 && await page.locator('[data-action="export"]').isEnabled());
  await page.evaluate(() => window.failCapture = false);
  await exportNow();
  check('retry succeeds', await page.locator('#wos-region-adjuster-panel').count() === 0);

  await setup(sidebar, 360);
  await pick('header');
  const bounds = await page.locator('#wos-region-adjuster-panel').boundingBox();
  check('narrow viewport toolbar stays visible', bounds.x >= 0 && bounds.x + bounds.width <= 361 && bounds.y >= 0 && bounds.y + bounds.height <= 800, bounds);
  await page.selectOption('.wos-region-scroll-mode', 'page');
  check('mode switch restores manual metadata', !(await page.locator('.wos-region-hud-meta').innerText()).includes('完整'));
  await page.keyboard.press('Escape');
  check('cancel removes all selection UI', await page.locator('#wos-region-adjuster,#wos-mask-overlay,#wos-guidance-banner').count() === 0);

  await setup(sidebar);
  await pick('header');
  await page.evaluate(() => window.failClone = true);
  await exportNow();
  state = await page.evaluate(() => ({ frames: document.querySelectorAll('.html2canvas-container').length,
    attrs: [...document.querySelectorAll('*')].flatMap(el => [...el.attributes].filter(a => a.name.startsWith('data-wos-capture-'))).length }));
  check('clone failure cleans iframe and temporary attributes', state.frames === 0 && state.attrs === 0, state);
  await page.evaluate(() => { window.failClone = false; window.delayCapture = true; document.querySelector('main').scrollTop = 200; });
  await page.locator('[data-action="export"]').click();
  await page.waitForFunction(() => typeof window.releaseCapture === 'function');
  await page.evaluate(opts => window.message({ action: 'start_picker', options: opts }, null, reply => window.pendingReply = reply), options);
  check('launch rejected while export is pending', (await page.evaluate(() => window.pendingReply))?.success === false, await page.evaluate(() => window.pendingReply));
  // The progress overlay intentionally intercepts pointer events during capture.
  await page.locator('main').hover({ force: true });
  await page.mouse.wheel(0, 500);
  await page.keyboard.press('PageDown');
  await page.evaluate(() => document.querySelector('main').scrollTop = 350);
  await page.waitForTimeout(100);
  const lockedScroll = await page.locator('main').evaluate(el => el.scrollTop);
  check('wheel, keyboard and programmatic scroll stay locked during capture', lockedScroll === 200, lockedScroll);
  await page.evaluate(() => window.releaseCapture());
  await page.waitForFunction(() => !document.querySelector('#wos-region-adjuster-panel'));
  await page.locator('main').evaluate(el => el.scrollTop = 350);
  await page.waitForTimeout(100);
  check('scroll unlocked after capture', await page.locator('main').evaluate(el => el.scrollTop) === 350);

  await setup('<style>body{margin:0;min-height:2000px}article{margin:100px;width:100px;height:100px;background:rgb(0,200,0)}</style><article>Box</article>');
  await pick('article');
  await page.locator('[data-size="width"]').fill('10');
  await page.locator('[data-size="height"]').fill('10');
  await page.locator('[data-size="height"]').press('Enter');
  const before = await page.locator('#wos-region-adjuster').boundingBox();
  check('small region display agrees with inputs', before.width === 10 && before.height === 10, before);
  await page.locator('[data-edge="bottom"]').focus();
  await page.keyboard.press('ArrowUp');
  const after = await page.locator('#wos-region-adjuster').boundingBox();
  check('focused bottom handle shrinks without moving top', after.height === 9 && after.y === before.y, after);
  await page.locator('[data-edge="bottom"]').evaluate(el => el.blur());
  await page.keyboard.press('ArrowLeft');
  const moved = await page.locator('#wos-region-adjuster').boundingBox();
  check('keyboard translation preserves width and height', moved.x === before.x - 1 && moved.width === after.width && moved.height === after.height, moved);
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(100);
  const offscreen = await page.locator('#wos-region-adjuster-panel').boundingBox();
  check('offscreen selection still has reachable export controls', offscreen.y >= 0 && offscreen.y + offscreen.height <= 800, offscreen);
  await exportNow();
  state = await page.evaluate(() => window.capture);
  check('small region actual output matches selected pixels', state.width === 20 && state.height === 18, state);

  await setup(sidebar.replace('<section>First</section>', '<section><div style="height:20px;overflow:hidden"><div style="height:300px">Clipped logo</div></div>First</section>'));
  await pick('header');
  await exportNow();
  state = await page.evaluate(() => window.capture);
  check('intentional non-scrolling clipping remains intact', state.width === 800 && state.height === 2320, state);
  state = await page.evaluate(() => new Promise(resolve => window.message({ action: 'check_status' }, null, resolve)));
  check('content version handshake is current', state.version === '4.0.0', state);
  for (const format of ['png', 'jpeg']) {
    await setup('<style>body{margin:0}article{margin:100px;width:100px;height:100px;background:rgb(0,200,0)}</style><article></article>');
    await pick('article', { ...options, outputFormat: format, margins: { top: 1, bottom: 3, left: 2, right: 4 } });
    await exportNow();
    state = await page.evaluate(() => window.encoded);
    check(format + ' encoded file dimensions and independent margins', state.width === 245 && state.height === 231 && state.corner.slice(0, 3).every(n => n > 250) && state.center[1] >= 195 && state.center[0] < 5, state);
  }

  // Cooperative cancellation must never release scroll or start a download early.
  await setup(sidebar);
  await page.locator('main').evaluate(el => el.scrollTop = 200);
  await pick('header');
  await page.evaluate(() => { window.delayCapture = true; });
  await page.locator('[data-action="export"]').click();
  await page.waitForFunction(() => typeof window.releaseCapture === 'function');
  check('export shows live stage and elapsed timer', await page.locator('#wos-export-progress').count() === 1 && (await page.locator('#wos-export-progress').innerText()).includes('2 / 4'));
  await page.locator('#wos-export-progress button').click();
  check('cancel waits for active renderer', await page.locator('#wos-region-adjuster-panel').getAttribute('aria-busy') === 'true');
  await page.evaluate(() => window.releaseCapture());
  await page.waitForFunction(() => !document.querySelector('#wos-export-progress'));
  state = await page.evaluate(() => ({
    downloads:window.downloads.length,
    busy:document.querySelector('#wos-region-adjuster-panel')?.hasAttribute('aria-busy'),
    frames:document.querySelectorAll('.html2canvas-container').length,
    attrs:[...document.querySelectorAll('*')].flatMap(el => el.getAttributeNames()).filter(name => /^data-wos-(capture|scroll)-/.test(name)).length
  }));
  check('cancel keeps selection without download or leaked clone', state.downloads === 0 && state.busy === false && state.frames === 0 && state.attrs === 0, state);
  await page.evaluate(() => { window.delayCapture = false; });
  await exportNow();
  check('cancelled selection can be exported again', await page.evaluate(() => window.downloads.length) === 1);

  await setup('<style>body{margin:0}article{margin:100px;width:100px;height:100px;background:rgb(0,200,0)}</style><article>Fast</article>');
  await pick('article', {...options,resolutionScale:1.5});
  await exportNow();
  state = await page.evaluate(() => window.encoded);
  check('fast scale produces real lossless PNG at 1.5x', state.width === 150 && state.height === 150 && state.type === 'image/png', state);

  await setup(sidebar);
  await pick('header', {...options,outputFormat:'pdf'});
  await page.evaluate(() => {
    window.realToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback) { callback(null); };
  });
  await exportNow();
  check('encoding failure keeps retryable selection and cleans progress', await page.locator('#wos-region-adjuster-panel').count() === 1 && await page.locator('#wos-export-progress').count() === 0);
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = window.realToBlob; });
  await exportNow();
  check('real PDF encoding succeeds after retry', await page.evaluate(() => window.pdf?.pages > 0 && window.pdf?.header.startsWith('%PDF')));

  return { passed: results.filter(r => r.pass).length, total: results.length, results };
}
