document.addEventListener('DOMContentLoaded', async () => {
  const $ = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const status = $('#status-label');
  const actions = [$('#btn-smart-export'), $('#btn-pick-export')];
  const margins = all('[data-margin]');
  const state = { format: 'pdf', scale: 2, mode: 'a4', lossless: true };
  let tab, ready = false, busy = false, saveQueue = Promise.resolve();

  function message(text, kind = 'ready') {
    status.textContent = text;
    $('#page-status').dataset.state = kind;
    $('#retry-connect').hidden = kind !== 'error' || busy;
  }
  function availability() {
    actions.forEach(button => {
      button.disabled = !ready || busy;
      button.setAttribute('aria-disabled', String(button.disabled));
    });
  }
  function marginValues() {
    return Object.fromEntries(margins.map(input => {
      const n = Number(input.value);
      return [input.dataset.margin, input.value === '' || !Number.isFinite(n) ? null : Math.round(Math.max(0, Math.min(50, n)) * 10) / 10];
    }));
  }
  function displayMargins(values = {}) {
    margins.forEach(input => {
      const value = values[input.dataset.margin];
      input.value = value == null || !Number.isFinite(Number(value)) ? '' : Math.max(0, Math.min(50, Number(value)));
    });
  }
  function refresh() {
    [['format',state.format],['scale',String(state.scale)],['mode',state.mode]].forEach(([name,value]) => {
      all('[data-' + name + ']').forEach(button => {
        const selected = button.dataset[name] === value;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    });
    $('.pdf-layout').hidden = state.format !== 'pdf';
    $('.toggle-row').hidden = state.format !== 'pdf';
    $('#opt-lossless-png').checked = state.lossless;
    const preset = state.scale === 1.5 && !state.lossless ? 'fast' : state.scale === 2 && state.lossless ? 'balanced' : state.scale === 3 && state.lossless ? 'detail' : '';
    all('[data-preset]').forEach(button => {
      const selected = button.dataset.preset === preset;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    $('#dpi-badge').textContent = state.scale + '× ' + ({fast:'快速',balanced:'平衡',detail:'精细'}[preset] || '自定义');
    $('#quality-hint').textContent = state.scale === 1.5 ? '较低渲染倍率；PDF 使用 JPEG 内嵌，PNG 始终无损。' : state.scale === 2 ? '2× 的像素量为 3× 的 44%；实际耗时取决于页面复杂度。' : '更高倍率会增加渲染与编码耗时，适合需要放大查看的内容。';
    $('#export-summary').textContent = state.format.toUpperCase() + ' · ' + (state.format === 'pdf' ? (state.mode === 'a4' ? 'A4' : '自适应') + ' · ' : '') + state.scale + '×';
    $('#page-size-hint').textContent = state.format === 'pdf' ? (state.mode === 'a4' ? 'A4 纸张' : '自适应') : '完整图片';
    const defaults = state.format !== 'pdf' ? [0,0,0,0] : state.mode === 'a4' ? [12,12,10,10] : [6,6,6,6];
    const values = marginValues();
    margins.forEach((input,index) => { input.placeholder = String(defaults[index]); });
    $('#margin-hint').textContent = state.format !== 'pdf' ? '留空默认 0 · 白边随倍率缩放' : '留空用框内默认值 · 0–50 mm';
    const preview = $('.paper-preview');
    ['top','bottom','left','right'].forEach((edge,index) => {
      preview.style['padding' + edge[0].toUpperCase() + edge.slice(1)] = Math.min(22, 3 + (values[edge] ?? defaults[index]) * .7) + 'px';
    });
  }
  function persist() {
    const values = { wos_output_format:state.format, wos_resolution_scale:state.scale, wos_export_mode:state.mode, wos_lossless_png:state.lossless, wos_margins:marginValues() };
    saveQueue = saveQueue.catch(() => {}).then(() => chrome.storage.local.set(values));
    saveQueue.catch(() => message('设置保存失败；仍可使用当前设置导出', 'error'));
    return saveQueue;
  }
  async function connect() {
    const popupVersion = chrome.runtime?.getManifest?.().version;
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, {action:'check_status'});
      if (reply?.version === popupVersion) return;
      if (reply) throw new Error(`页面仍在运行旧版 ${reply.version || '脚本'}，请刷新当前网页后重试`);
    } catch (error) {
      if (/页面仍在运行旧版/.test(error?.message || '')) throw error;
    }
    const rawUrl = tab?.url || tab?.pendingUrl || '';
    if (!rawUrl) {
      throw new Error('此页面受浏览器保护，请切换到普通网页');
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch (_) {
      throw new Error('此页面受浏览器保护，请切换到普通网页');
    }
    if (!['http:','https:','file:'].includes(url.protocol) || ['chromewebstore.google.com','microsoftedge.microsoft.com'].includes(url.hostname)) {
      throw new Error('此页面受浏览器保护，请切换到普通网页');
    }
    try {
      await chrome.scripting.insertCSS({target:{tabId:tab.id},files:['content.css']});
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:['libs/html2canvas.min.js','libs/jspdf.umd.min.js','content.js']});
    } catch (err) {
      if (err?.message && (err.message.includes('chrome://') || err.message.includes('Cannot access') || err.message.includes('extensions gallery'))) {
        throw new Error('此页面受浏览器保护，请切换到普通网页');
      }
      throw err;
    }
    const reply = await chrome.tabs.sendMessage(tab.id, {action:'check_status'});
    if (!reply || reply.version !== popupVersion) throw new Error('页面脚本版本不一致，请刷新当前网页后重试');
  }
  async function start(action) {
    if (busy || !ready) return;
    busy = true; availability(); message('正在准备选区…','loading');
    displayMargins(marginValues()); refresh();
    try {
      await persist().catch(() => {});
      await connect();
      const response = await chrome.tabs.sendMessage(tab.id, { action, options: {
        outputFormat:state.format, resolutionScale:state.scale, exportMode:state.mode,
        losslessPng:state.lossless, fileName:$('#export-filename').value.trim(), margins:marginValues()
      }});
      if (!response?.success) throw new Error(response?.message || '选区未能启动，请刷新网页后重试');
      window.close();
    } catch (error) {
      message(error.message || '无法连接页面，请刷新网页后重试','error');
    } finally { busy = false; availability(); $('#retry-connect').hidden = $('#page-status').dataset.state !== 'error'; }
  }

  try {
    const version = chrome.runtime?.getManifest?.().version;
    if (version) $('.version-badge').textContent = 'v' + version;
    try {
      const prefs = await chrome.storage.local.get(['wos_output_format','wos_resolution_scale','wos_export_mode','wos_lossless_png','wos_margins']);
      if (['pdf','png','jpeg'].includes(prefs.wos_output_format)) state.format = prefs.wos_output_format;
      if ([1.5,2,3,4].includes(Number(prefs.wos_resolution_scale))) state.scale = Number(prefs.wos_resolution_scale);
      if (['adaptive','continuous'].includes(prefs.wos_export_mode)) state.mode = 'adaptive';
      if (typeof prefs.wos_lossless_png === 'boolean') state.lossless = prefs.wos_lossless_png;
      displayMargins(prefs.wos_margins);
    } catch (_) { message('无法读取已保存设置，已使用默认值','error'); }
    refresh();
    all('[data-preset]').forEach(button => button.addEventListener('click', () => {
      const preset = {fast:{scale:1.5,lossless:false},balanced:{scale:2,lossless:true},detail:{scale:3,lossless:true}}[button.dataset.preset];
      Object.assign(state, preset); refresh(); persist();
    }));
    $('#retry-connect').addEventListener('click', async () => {
      if (busy) return;
      busy = true; ready = false; availability(); message('正在重新连接…', 'loading');
      try {
        [tab] = await chrome.tabs.query({active:true,currentWindow:true});
        if (!tab?.id) throw new Error('未找到当前页面');
        $('#page-title').textContent = tab.title || '当前网页';
        await connect(); ready = true; message('页面已就绪 · 设置自动保存');
      } catch (error) { message(error.message || '连接失败', 'error'); }
      finally { busy = false; availability(); $('#retry-connect').hidden = ready; }
    });
    all('[data-format]').forEach(button => button.addEventListener('click',()=>{ state.format=button.dataset.format; refresh(); persist(); }));
    all('[data-scale]').forEach(button => button.addEventListener('click',()=>{ state.scale=Number(button.dataset.scale); refresh(); persist(); }));
    all('[data-mode]').forEach(button => button.addEventListener('click',()=>{ state.mode=button.dataset.mode; refresh(); persist(); }));
    margins.forEach(input => input.addEventListener('change',()=>{ displayMargins(marginValues()); refresh(); persist(); }));
    $('#reset-margins').addEventListener('click',()=>{ displayMargins(); refresh(); persist(); });
    $('#opt-lossless-png').addEventListener('change',event=>{state.lossless=event.target.checked; refresh(); persist();});
    actions[0].addEventListener('click',()=>start('preview_smart'));
    actions[1].addEventListener('click',()=>start('start_picker'));
    [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw new Error('未找到当前页面');
    $('#page-title').textContent = tab.title || '当前网页';
    $('#page-title').title = tab.title || '';
    await connect();
    ready = true; availability(); message('当前页面已连接 · 设置自动保存');
  } catch (error) { message(error.message || '页面连接失败','error'); availability(); }
});
