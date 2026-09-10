/**
 * 网页区域 PDF 导出器 - Popup Logic (v3.0.0)
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
    currentExportMode = mode;
    modeButtons.forEach(btn => {
      if (btn.dataset.mode === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (save && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ wos_export_mode: mode });
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

  // 确保 Content Script 就绪
  async function ensureContentScriptInjected() {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'check_status' });
      return response;
    } catch (e) {
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
        await new Promise(r => setTimeout(r, 120));
        return await chrome.tabs.sendMessage(tab.id, { action: 'check_status' });
      } catch (err) {
        console.error('无法注入扩展:', err);
        return null;
      }
    }
  }

  const status = await ensureContentScriptInjected();
  if (!status) {
    setExportAvailability(false, '此页面不允许导出');
    return;
  }

  statusLabel.textContent = status.isWos ? 'WOS 页面已连接' : '全网通用模式';

  // 点击“自动识别主体”：先在页面中预览识别范围，再由用户确认导出。
  btnSmartExport.addEventListener('click', async () => {
    try {
      await ensureContentScriptInjected();
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
      await ensureContentScriptInjected();
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
