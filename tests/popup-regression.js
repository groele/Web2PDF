// Run with browser_run_code (filename), against the repository served on port 8765.
// This tests the real popup UI with mocked Chrome APIs, not an installed extension.
async (browserPage) => {
  const page = await browserPage.context().newPage();
  const results = [];
  const check = (name, pass, details) => results.push({name,pass:Boolean(pass),details});
  try {
    await page.setViewportSize({width:400,height:600});
    await page.addInitScript(() => {
      window.sent = [];
      window.chrome = {
        runtime:{getManifest:()=>({version:'3.6.0'})},
        storage:{local:{
          get:async()=>JSON.parse(sessionStorage.getItem('prefs') || '{}'),
          set:async values=>sessionStorage.setItem('prefs',JSON.stringify(values))
        }},
        tabs:{
          query:async()=>[{id:1,title:'Research article',url:'https://example.org/article'}],
          sendMessage:async(id,msg)=>{
            window.sent.push(msg);
            if (msg.action === 'check_status') return {version:window.stale ? '3.5.0' : '3.6.0'};
            if (window.launchError) throw new Error('Test connection failed');
            return {success:true};
          }
        },
        scripting:{insertCSS:async()=>{},executeScript:async()=>{}}
      };
      window.close = () => { window.closedByPopup = true; };
    });
    await page.goto('http://127.0.0.1:8765/popup.html');
    await page.waitForFunction(() => !document.querySelector('#btn-smart-export').disabled);
    check('fresh preferences use balanced preset', await page.locator('[data-preset="balanced"]').getAttribute('aria-pressed') === 'true');
    const footer = await page.locator('.action-dock').boundingBox();
    check('primary actions remain in viewport', footer.y >= 0 && footer.y + footer.height <= 600, footer);
    await page.locator('[data-preset="fast"]').click();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('prefs')).wos_resolution_scale === 1.5);
    check('fast preset persists scale and PDF encoding together', await page.evaluate(() => JSON.parse(sessionStorage.getItem('prefs')).wos_lossless_png === false));
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#btn-smart-export').disabled);
    check('fast preset survives reopening', await page.locator('[data-preset="fast"]').getAttribute('aria-pressed') === 'true');
    await page.locator('[data-format="png"]').click();
    check('image format hides PDF layout', await page.locator('.pdf-layout').isHidden());
    await page.locator('summary').click();
    check('image format hides PDF encoding option', await page.locator('.toggle-row').isHidden());
    await page.locator('[data-margin="top"]').fill('70');
    await page.locator('[data-margin="top"]').press('Tab');
    check('margins clamp to supported range', await page.locator('[data-margin="top"]').inputValue() === '50');
    await page.locator('#reset-margins').click();
    check('reset restores default margin semantics', await page.locator('[data-margin="top"]').inputValue() === '');
    await page.locator('[data-scale="4"]').click();
    check('custom scale clears preset selection', await page.locator('[data-preset][aria-pressed="true"]').count() === 0);
    await page.locator('[data-format="pdf"]').click();
    await page.locator('[data-preset="balanced"]').click();
    await page.locator('#export-filename').fill('My article');
    await page.evaluate(() => { window.launchError = true; });
    await page.locator('#btn-smart-export').click();
    await page.waitForFunction(() => document.querySelector('#page-status').dataset.state === 'error');
    check('launch failure offers retry without disabling actions permanently', await page.locator('#retry-connect').isVisible() && await page.locator('#btn-smart-export').isEnabled());
    await page.evaluate(() => { window.launchError = false; });
    await page.locator('#retry-connect').click();
    await page.waitForFunction(() => document.querySelector('#page-status').dataset.state === 'ready');
    check('connection retry restores ready state', await page.locator('#retry-connect').isHidden());
    await page.locator('#btn-smart-export').click();
    const sent = await page.evaluate(() => window.sent.filter(msg => msg.action === 'preview_smart').pop());
    check('launch uses displayed format, scale and filename', sent.options.resolutionScale === 2 && sent.options.losslessPng === true && sent.options.fileName === 'My article' && sent.options.outputFormat === 'pdf', sent);
    await page.evaluate(() => { window.stale = true; });
    await page.locator('#btn-smart-export').click();
    check('stale page script requires refresh', (await page.locator('#status-label').innerText()).includes('旧版'));
    await page.setViewportSize({width:400,height:420});
    const compactFooter = await page.locator('.action-dock').boundingBox();
    check('short popup keeps actions reachable', compactFooter.y >= 0 && compactFooter.y + compactFooter.height <= 420, compactFooter);
    return {passed:results.filter(r=>r.pass).length,total:results.length,results};
  } finally { await page.close(); }
}
