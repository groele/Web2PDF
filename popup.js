/**
 * 网页区域 PDF 导出器 - Popup Logic (v3.4.0)
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusLabel = document.getElementById('status-label');
  const btnSmartExport = document.getElementById('btn-smart-export');
  const btnPickExport = document.getElementById('btn-pick-export');
  const dpiBadge = document.getElementById('dpi-badge');
  const optLosslessPng = document.getElementById('opt-lossless-png');

  const filenameInput = document.getElementById('export-filename');
  const scaleButtons = document.querySelectorAll('#scale-segmented .seg-item');
  const modeButtons = document.querySelectorAll('#mode-segmented .seg-item');

  const formatButtons = document.querySelectorAll('#format-segmented .seg-item');
  const pdfOnlyRows = [modeButtons[0]?.closest('.config-row'), optLosslessPng.closest('.toggle-row')];
  let currentScale = 3.0;
  let currentExportMode = 'a4';
  let currentLosslessPng = true;

  let currentOutputFormat = 'pdf';
  function setScale(val, save = false) {
    currentScale = val;
    dpiBadge.textContent = `${val}× ${val === 3 ? '推荐' : '渲染'}`;

    scaleButtons.forEach(btn => {
      const btnVal = parseFloat(btn.dataset.scale);
      if (Math.abs(btnVal - currentScale) < 0.2) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (save && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ wos_resolution_scale: currentScale });
    }
  }

  function setMode(mode, save = false) {
    currentExportMode = (mode === 'continuous' || mode === 'adaptive') ? 'adaptive' : 'a4';
    modeButtons.forEach(btn => {
      const btnMode = btn.dataset.mode;
      if (btnMode === currentExportMode || (btnMode === 'adaptive' && currentExportMode === 'adaptive')) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    const pageSizeHint = document.getElementById('page-size-hint');
    if (pageSizeHint) {
      pageSizeHint.textContent = currentExportMode === 'a4' ? 'A4 纸张' : '图形自适应';
    }

    if (save && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ wos_export_mode: currentExportMode });
    }
  }

  function setOutputFormat(format, save = false) {
    currentOutputFormat = ['pdf', 'png', 'jpeg'].includes(format) ? format : 'pdf';
    formatButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.format === currentOutputFormat));
    pdfOnlyRows.forEach(row => { if (row) row.hidden = currentOutputFormat !== 'pdf'; });
    formatButtons.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.format === currentOutputFormat)));
    if (save && chrome.storage?.local) chrome.storage.local.set({ wos_output_format: currentOutputFormat });
  }

  function setExportAvailability(available, message) {
    btnSmartExport.disabled = !available;
    btnPickExport.disabled = !available;
    btnSmartExport.setAttribute('aria-disabled', String(!available));
    btnPickExport.setAttribute('aria-disabled', String(!available));
    if (message) statusLabel.textContent = message;
  }

  // 分辨率段选切换
  scaleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      setScale(parseFloat(btn.dataset.scale), true);
    });
  });

  // 模式段选切换
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode, true);
    });
  });

  // 无损 PNG 开关
  optLosslessPng.addEventListener('change', (e) => {
    currentLosslessPng = e.target.checked;
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ wos_lossless_png: currentLosslessPng });
    }
  });
  formatButtons.forEach(btn => {
    btn.addEventListener('click', () => setOutputFormat(btn.dataset.format, true));
  });

  // Read preferences before enabling actions so the first click cannot export
  // with a stale default setting.
  if (chrome.storage && chrome.storage.local) {
    const outputPrefs = await chrome.storage.local.get(['wos_output_format']);
    if (outputPrefs.wos_output_format) setOutputFormat(outputPrefs.wos_output_format);

    const res = await chrome.storage.local.get(['wos_resolution_scale', 'wos_export_mode', 'wos_lossless_png']);
    if (res) {
      if (res.wos_resolution_scale) setScale(parseFloat(res.wos_resolution_scale));
      if (res.wos_export_mode) setMode(res.wos_export_mode);
      if (res.wos_lossless_png !== undefined) {
        currentLosslessPng = !!res.wos_lossless_png;
        optLosslessPng.checked = currentLosslessPng;
      }
      if (res.wos_output_format) setOutputFormat(res.wos_output_format);
    }
  }

  // 获取当前标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    statusLabel.textContent = '未连接网页';
    return;
  }

  // 确保 Content Script 就绪（带重试轮询与精准诊断）
  async function ensureContentScriptInjected() {
    // 1. 优先尝试直接与已有页面通信
    try {
      const directRes = await chrome.tabs.sendMessage(tab.id, { action: 'check_status' });
      if (directRes) return directRes;
    } catch (_) {
      // 尚未注入或刚刷新，继续执行动态注入
    }

    // 2. 检查是否为浏览器底层禁止注入的系统级受限页面
    const url = tab.url || '';
    const isRestricted = url.startsWith('chrome://') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url.startsWith('chrome-extension://') ||
      url.includes('chromewebstore.google.com') ||
      url.includes('chrome.google.com/webstore');

    if (isRestricted) {
      return { restricted: true, message: '浏览器系统页受保护' };
    }

    // 3. 执行动态注入并启动握手重试轮询（解决大文件解析时延竞争）
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'libs/html2canvas.min.js',
          'libs/jspdf.umd.min.js',
          'content.js'
        ]
      });

      // 循环重试握手（最多 10 次，约 1.5 秒），等待 600KB 核心脚本完全就绪
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 120 + attempt * 25));
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { action: 'check_status' });
          if (res) return res;
        } catch (_) {
          // 继续等待就绪
        }
      }
      return { failed: true, message: '请按 F5 刷新网页后重试' };
    } catch (err) {
      console.error('无法注入扩展:', err);
      return { failed: true, message: '请按 F5 刷新网页' };
    }
  }

  const status = await ensureContentScriptInjected();
  if (!status || status.restricted || status.failed) {
    setExportAvailability(false, status?.message || '此页面不允许导出');
    return;
  }

  setExportAvailability(true);
  statusLabel.textContent = status.isWos ? 'WOS 页面已连接' : '全网通用就绪';

  // 点击“自动识别主体”：先在页面中预览识别范围，再由用户确认导出。
  btnSmartExport.addEventListener('click', async () => {
    try {
      const ready = await ensureContentScriptInjected();
      if (!ready || ready.failed || ready.restricted) throw new Error(ready?.message || '页面未就绪');
      statusLabel.textContent = '正在准备识别范围…';
      await chrome.tabs.sendMessage(tab.id, {
        action: 'preview_smart',
        options: {
          resolutionScale: currentScale,
          fileName: filenameInput.value.trim(),
          outputFormat: currentOutputFormat,
          exportMode: currentExportMode,
          losslessPng: currentLosslessPng
        }
      });
      window.close();
    } catch (err) {
      alert('导出失败：' + (err.message || '未知错误'));
    }
  });

  // 点击“自选区域导出”
  btnPickExport.addEventListener('click', async () => {
    try {
      const ready = await ensureContentScriptInjected();
      if (!ready || ready.failed || ready.restricted) throw new Error(ready?.message || '页面未就绪');
      statusLabel.textContent = '正在启动区域选择…';
      await chrome.tabs.sendMessage(tab.id, {
        action: 'start_picker',
        options: {
          resolutionScale: currentScale,
          fileName: filenameInput.value.trim(),
          outputFormat: currentOutputFormat,
          exportMode: currentExportMode,
          losslessPng: currentLosslessPng
        }
      });
      window.close();
    } catch (err) {
      alert('启动选区失败：' + (err.message || '未知错误'));
    }
  });
});
