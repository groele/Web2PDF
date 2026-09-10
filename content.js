/**
 * 网页区域 PDF 导出器 - Content Script (v2.4.0 通用高保真版)
 */

(function () {
  if (window.__WOS_PDF_EXPORTER_INITIALIZED__) return;
  window.__WOS_PDF_EXPORTER_INITIALIZED__ = true;

  // 默认排版模式：'a4' (标准 A4 分页) 或 'continuous' (单页长图)
  let currentExportMode = 'a4';
  // 默认清晰度：3.0（推荐渲染倍率；实际 DPI 取决于网页尺寸）
  let currentResolutionScale = 3.0;
  // 默认开启 PNG 无损位图输出
  let currentLosslessPng = true;

  // A canvas needs four bytes per pixel before image encoding.  Keeping this
  // bounded prevents a long article from exhausting the tab's memory.
  const MAX_RENDER_PIXELS = 48 * 1024 * 1024;
  const MAX_CANVAS_EDGE = 32767;
  const MAX_CONTINUOUS_HEIGHT_MM = 5000;

  // 从 storage 读取用户偏好
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['wos_export_mode', 'wos_resolution_scale', 'wos_lossless_png'], (res) => {
      if (res) {
        if (res.wos_export_mode) currentExportMode = res.wos_export_mode;
        if (res.wos_resolution_scale) currentResolutionScale = parseFloat(res.wos_resolution_scale);
        if (res.wos_lossless_png !== undefined) currentLosslessPng = !!res.wos_lossless_png;
        updateFloatingBadge();
      }
    });
  }

  function getJsPdfInstance() {
    if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
    if (typeof jsPDF !== 'undefined') return jsPDF;
    return null;
  }

  // --- 全网通用的智能主要内容定位引擎 ---
  function findSmartContentContainer() {
    // 1. 优先定位学术网站 (Web of Science / PubMed / CNKI 等) 的核心文章白底卡片
    const heading = document.querySelector('h1') || document.querySelector('h2');
    if (heading) {
      let curr = heading;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        const text = curr.innerText || '';
        const hasCore = text.includes('摘要') || text.includes('Abstract') || text.includes('作者') || text.includes('Authors') || text.includes('DOI');
        const hasRight = text.includes('引文网络') || text.includes('Citation Network') || text.includes('被引频次');
        const hasLeft = text.includes('我的 Web of Science') || text.includes('个人信息通知');

        // 定位到包含核心文献信息、同时避开侧栏的最内层完整卡片
        if (hasCore && !hasRight && !hasLeft) {
          return curr;
        }

        curr = curr.parentElement;
      }
    }

    // 2. 通用学术/文章页面标签检测
    const genericSelectors = [
      'app-record-full .full-record-container',
      'app-full-record .main-record',
      'article',
      'main',
      '.article-container',
      '.paper-content',
      '.full-record',
      '#main-content'
    ];

    const semanticCandidates = Array.from(document.querySelectorAll(genericSelectors.join(',')));
    const scoredCandidate = semanticCandidates
      .filter(el => el instanceof HTMLElement && el.innerText.trim().length > 100)
      .map(el => ({ el, score: getContentScore(el) }))
      .sort((a, b) => b.score - a.score)[0];
    if (scoredCandidate) return scoredCandidate.el;

    // 3. 兜底方案：页面最大的内容区块
    const allArticles = Array.from(document.querySelectorAll('div, section, article'));
    let bestEl = null;
    let maxLen = 0;

    for (const el of allArticles) {
      const len = (el.innerText || '').trim().length;
      if (len > maxLen && len < 50000) {
        const text = el.innerText;
        if (!text.includes('我的 Web of Science') && !text.includes('引文网络')) {
          maxLen = len;
          bestEl = el;
        }
      }
    }

    return bestEl;
  }

  function getContentScore(el) {
    const text = (el.innerText || '').trim();
    const textScore = Math.min(text.length, 18000);
    const linkText = Array.from(el.querySelectorAll('a'))
      .reduce((total, link) => total + (link.innerText || '').trim().length, 0);
    const linkPenalty = Math.min(linkText / Math.max(text.length, 1), 1) * 8000;
    const tagBonus = el.matches('article,main') ? 2500 : 0;
    const classBonus = /article|content|paper|record|document|post/i.test(`${el.id} ${el.className}`) ? 1400 : 0;
    const chromePenalty = el.matches('nav,aside,footer,header') ? 10000 : 0;
    return textScore + tagBonus + classBonus - linkPenalty - chromePenalty;
  }

  // 获取页面标题生成文件名
  function getCleanFileName() {
    const heading = document.querySelector('h1') || document.querySelector('h2') || document.title;
    const titleText = typeof heading === 'string' ? heading : (heading.innerText || document.title);
    const clean = titleText.trim()
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 60);
    return clean ? `${clean}.pdf` : 'Academic_Document.pdf';
  }

  function getSafeScale(targetElement, requestedScale) {
    const rect = targetElement.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.ceil(targetElement.scrollWidth || rect.width));
    const cssHeight = Math.max(1, Math.ceil(targetElement.scrollHeight || rect.height));
    const maxScale = Math.min(
      Math.sqrt(MAX_RENDER_PIXELS / (cssWidth * cssHeight)),
      MAX_CANVAS_EDGE / cssWidth,
      MAX_CANVAS_EDGE / cssHeight
    );
    return Math.min(requestedScale, maxScale);
  }

  async function waitForRenderableAssets(targetElement) {
    const imageTasks = Array.from(targetElement.querySelectorAll('img'))
      .filter(img => !img.complete)
      .map(img => new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }));
    const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    await Promise.race([
      Promise.allSettled([fontsReady, ...imageTasks]),
      new Promise(resolve => setTimeout(resolve, 2500))
    ]);
  }

  function getPreferredPageBreaks(targetElement, canvasHeight, defaultPageHeightPx, scale) {
    const targetRect = targetElement.getBoundingClientRect();
    const candidates = Array.from(targetElement.querySelectorAll(
      'h1,h2,h3,h4,p,li,blockquote,pre,figure,table,img,section,article'
    )).map(el => {
      const rect = el.getBoundingClientRect();
      return Math.round((rect.bottom - targetRect.top) * scale);
    }).filter(bottom => bottom > 0 && bottom < canvasHeight).sort((a, b) => a - b);

    const breaks = [];
    let top = 0;
    while (top + defaultPageHeightPx < canvasHeight) {
      const ideal = top + defaultPageHeightPx;
      const minimum = top + Math.floor(defaultPageHeightPx * 0.62);
      let next = 0;
      for (const bottom of candidates) {
        if (bottom >= minimum && bottom <= ideal) next = bottom;
        if (bottom > ideal) break;
      }
      // Avoid a very short page if no useful block boundary was found.
      if (!next || next <= top + 64) next = ideal;
      breaks.push(next);
      top = next;
    }
    return breaks;
  }

  function setPdfMetadata(pdf, fileName) {
    pdf.setProperties({
      title: fileName.replace(/\.pdf$/i, ''),
      subject: 'Exported webpage region',
      creator: 'Web Region PDF Exporter'
    });
  }

  function hideExtensionUi() {
    const elements = Array.from(document.querySelectorAll(
      '#wos-pdf-floating-widget,#wos-picker-banner,#wos-smart-preview,#wos-toast-message'
    ));
    const states = elements.map(el => ({ el, visibility: el.style.visibility }));
    elements.forEach(el => { el.style.visibility = 'hidden'; });
    return () => states.forEach(({ el, visibility }) => { el.style.visibility = visibility; });
  }

  // --- 高保真直出 PDF 引擎 ---
  async function exportElementToPdf(targetElement, options = {}) {
    if (!targetElement) {
      showToast('🎯 请在网页上点击想要导出的区域', 'info', 3000);
      startElementPicker(options);
      return;
    }

    if (typeof html2canvas === 'undefined') {
      showToast('⚠️ 正在加载组件，请稍候 1 秒后重试', 'warning');
      return;
    }

    const JsPDFClass = getJsPdfInstance();
    if (!JsPDFClass) {
      showToast('⚠️ 未检测到 PDF 生成器，请刷新网页重试', 'warning');
      return;
    }

    const requestedScale = Number(options.resolutionScale || currentResolutionScale || 3.0);
    const scale = getSafeScale(targetElement, requestedScale);
    const mode = options.exportMode || currentExportMode || 'a4';
    const usePng = options.losslessPng !== undefined ? options.losslessPng : currentLosslessPng;
    let format = usePng ? 'PNG' : 'JPEG';
    let mimeType = usePng ? 'image/png' : 'image/jpeg';
    let quality = usePng ? undefined : 0.96;

    if (scale < 0.75) {
      showToast('⚠️ 选区过长，无法在保证清晰度的情况下安全导出；请改为分段选择', 'warning', 5000);
      return;
    }

    const primaryBtn = document.getElementById('wos-btn-auto-export');
    let originalBtnText = '';
    if (primaryBtn) {
      originalBtnText = primaryBtn.innerHTML;
      primaryBtn.classList.add('loading');
      primaryBtn.innerHTML = `<span>⏳ 正在生成 PDF...</span>`;
    }

    if (scale < requestedScale - 0.05) {
      showToast(`⏳ 内容较长，已自动调整为 ${scale.toFixed(1)}x 渲染以保障稳定性`, 'info', 3500);
    } else {
      showToast(`⏳ 正在以 ${scale}x 高保真渲染 PDF，请稍候...`, 'info', 3500);
    }

    let restoreExtensionUi = () => {};
    try {
      restoreExtensionUi = hideExtensionUi();

      await waitForRenderableAssets(targetElement);

      const canvas = await html2canvas(targetElement, {
        scale: scale,
        useCORS: true,
        // A tainted canvas cannot be converted to an image for jsPDF. Images
        // without CORS permission are therefore omitted instead of breaking
        // the entire export at canvas.toDataURL().
        allowTaint: false,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: document.documentElement.offsetWidth,
        scrollX: 0,
        scrollY: -window.scrollY
      });

      restoreExtensionUi();
      restoreExtensionUi = () => {};

      const fileName = getCleanFileName();

      // PNG is lossless but can make a long document several hundred MB. Keep
      // it for normal captures and switch very large captures to high-quality
      // JPEG rather than failing the whole export.
      if (usePng && canvas.width * canvas.height > 24 * 1024 * 1024) {
        format = 'JPEG';
        mimeType = 'image/jpeg';
        quality = 0.96;
        showToast('ℹ️ 超长内容已使用高质量 JPEG，以避免 PDF 过大或生成失败', 'info', 3500);
      }

      const pdfWidthMm = 210;
      const continuousHeightMm = (canvas.height * (pdfWidthMm - 16)) / canvas.width + 16;
      const useContinuousPage = mode === 'continuous' && continuousHeightMm <= MAX_CONTINUOUS_HEIGHT_MM;

      if (mode === 'continuous' && !useContinuousPage) {
        showToast('ℹ️ 页面过长，已安全切换为 A4 分页，避免生成无法打开的 PDF', 'info', 4000);
      }

      if (useContinuousPage) {
        // 单页长图 PDF
        const marginMm = 8;
        const printWidthMm = pdfWidthMm - (marginMm * 2);
        const printHeightMm = (canvas.height * printWidthMm) / canvas.width;
        const totalHeightMm = printHeightMm + (marginMm * 2);

        const pdf = new JsPDFClass({
          orientation: 'p',
          unit: 'mm',
          format: [pdfWidthMm, totalHeightMm]
        });
        setPdfMetadata(pdf, fileName);

        const imgData = canvas.toDataURL(mimeType, quality);
        pdf.addImage(imgData, format, marginMm, marginMm, printWidthMm, printHeightMm, undefined, 'FAST');
        pdf.save(fileName);
      } else {
        // 标准 A4 多页分页
        const pdf = new JsPDFClass('p', 'mm', 'a4');
        setPdfMetadata(pdf, fileName);
        const pageWidthMm = 210;
        const pageHeightMm = 297;
        const marginX = 10;
        const marginY = 12;
        const printWidthMm = pageWidthMm - (marginX * 2);
        const printHeightMm = pageHeightMm - (marginY * 2);

        const pageHeightPx = Math.floor((printHeightMm * canvas.width) / printWidthMm);
        const preferredBreaks = getPreferredPageBreaks(targetElement, canvas.height, pageHeightPx, scale);

        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = canvas.width;
        const sliceCtx = sliceCanvas.getContext('2d');
        sliceCtx.imageSmoothingEnabled = true;
        sliceCtx.imageSmoothingQuality = 'high';

        let renderedHeightPx = 0;
        let pageCount = 0;

        while (renderedHeightPx < canvas.height) {
          const remainingPx = canvas.height - renderedHeightPx;
          const preferredEnd = preferredBreaks.find(end => end > renderedHeightPx);
          const currentSlicePx = Math.min(
            remainingPx,
            preferredEnd ? preferredEnd - renderedHeightPx : pageHeightPx
          );

          sliceCanvas.height = currentSlicePx;
          sliceCtx.fillStyle = '#ffffff';
          sliceCtx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
          sliceCtx.imageSmoothingEnabled = true;
          sliceCtx.imageSmoothingQuality = 'high';
          sliceCtx.drawImage(
            canvas,
            0, renderedHeightPx, canvas.width, currentSlicePx,
            0, 0, canvas.width, currentSlicePx
          );

          const currentSliceHeightMm = (currentSlicePx * printWidthMm) / canvas.width;
          if (pageCount > 0) {
            pdf.addPage();
          }

          const sliceData = sliceCanvas.toDataURL(mimeType, quality);
          pdf.addImage(sliceData, format, marginX, marginY, printWidthMm, currentSliceHeightMm, undefined, 'FAST');

          renderedHeightPx += currentSlicePx;
          pageCount++;
        }

        const totalPages = pdf.getNumberOfPages();
        for (let page = 1; page <= totalPages; page++) {
          pdf.setPage(page);
          pdf.setFontSize(8);
          pdf.setTextColor(100);
          pdf.text(`${page} / ${totalPages}`, pageWidthMm - marginX, pageHeightMm - 5, { align: 'right' });
        }

        pdf.save(fileName);
      }

      showToast(`✅ PDF 生成成功，已开始下载！`, 'success', 3000);
    } catch (err) {
      console.error('PDF 生成异常:', err);
      showToast('❌ 生成失败: ' + (err.message || '未知错误'), 'warning', 4000);
    } finally {
      restoreExtensionUi();
      if (primaryBtn && originalBtnText) {
        primaryBtn.classList.remove('loading');
        primaryBtn.innerHTML = originalBtnText;
      }
    }
  }

  // --- 自由框选模式 ---
  let isPicking = false;
  let currentHighlightedEl = null;
  let isPreviewingSmartTarget = false;

  function startSmartPreview(options = {}) {
    if (isPicking || isPreviewingSmartTarget) return;
    const target = findSmartContentContainer();
    if (!target) {
      showToast('未识别到阅读区，请使用“选择页面区块”', 'warning', 3500);
      startElementPicker(options);
      return;
    }

    isPreviewingSmartTarget = true;
    target.classList.add('wos-smart-candidate');
    const preview = document.createElement('div');
    preview.id = 'wos-smart-preview';
    preview.innerHTML = `
      <span>已识别推荐导出区域</span>
      <button type="button" data-action="export">导出此区域</button>
      <button type="button" data-action="pick">自己选择</button>
      <button type="button" data-action="cancel" aria-label="取消自动识别">✕</button>
    `;
    document.body.appendChild(preview);

    const stopPreview = () => {
      isPreviewingSmartTarget = false;
      target.classList.remove('wos-smart-candidate');
      preview.remove();
      document.removeEventListener('keydown', onKeyDown, true);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') stopPreview();
    };

    preview.addEventListener('click', event => {
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'export') {
        stopPreview();
        exportElementToPdf(target, options);
      } else if (action === 'pick') {
        stopPreview();
        startElementPicker(options);
      } else if (action === 'cancel') {
        stopPreview();
      }
    });
    document.addEventListener('keydown', onKeyDown, true);
  }

  function startElementPicker(options = {}) {
    if (isPicking) return;
    isPicking = true;

    const banner = document.createElement('div');
    banner.id = 'wos-picker-banner';
    banner.innerHTML = `
      <span>🎯 移动鼠标选择网页区块，点击后直接导出</span>
      <span class="wos-banner-key">↑ 选父级 · ESC 退出</span>
    `;
    document.body.appendChild(banner);

    function onMouseMove(e) {
      if (!isPicking) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target.closest('#wos-picker-banner') || target.closest('#wos-pdf-floating-widget')) {
        return;
      }

      if (target === currentHighlightedEl) return;

      if (currentHighlightedEl) {
        currentHighlightedEl.classList.remove('wos-element-highlighted');
      }

      currentHighlightedEl = target;
      currentHighlightedEl.classList.add('wos-element-highlighted');
    }

    function onClick(e) {
      if (!isPicking) return;
      e.preventDefault();
      e.stopPropagation();

      const selected = currentHighlightedEl;
      stopElementPicker();

      if (selected) {
        exportElementToPdf(selected, options);
      }
    }

    function onKeyDown(e) {
      if (e.key === 'ArrowUp' && currentHighlightedEl?.parentElement && currentHighlightedEl.parentElement !== document.body) {
        e.preventDefault();
        currentHighlightedEl.classList.remove('wos-element-highlighted');
        currentHighlightedEl = currentHighlightedEl.parentElement;
        currentHighlightedEl.classList.add('wos-element-highlighted');
        return;
      }
      if (e.key === 'Escape' || e.keyCode === 27) {
        stopElementPicker();
        showToast('已取消选区', 'info', 1500);
      }
    }

    function stopElementPicker() {
      isPicking = false;
      if (currentHighlightedEl) {
        currentHighlightedEl.classList.remove('wos-element-highlighted');
        currentHighlightedEl = null;
      }
      const b = document.getElementById('wos-picker-banner');
      if (b) b.remove();

      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    }

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  // --- 悬浮操作胶囊更新 ---
  function updateFloatingBadge() {
    const badge = document.getElementById('wos-quick-badge');
    if (badge) {
      const modeText = currentExportMode === 'a4' ? 'A4' : '长图';
      badge.textContent = `${currentResolutionScale}x · ${modeText}`;
    }
  }

  function initFloatingWidget() {
    if (document.getElementById('wos-pdf-floating-widget')) return;

    const widget = document.createElement('div');
    widget.id = 'wos-pdf-floating-widget';
    widget.innerHTML = `
      <span class="wos-widget-logo-icon" title="展开 PDF 导出助手">📄</span>
      <button class="wos-widget-btn primary" id="wos-btn-auto-export" title="智能识别并直接导出主要内容为 PDF">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:2px">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        <span>智能导出 PDF</span>
      </button>

      <button class="wos-widget-btn secondary" id="wos-btn-pick-export" title="点击自由选择页面任意区域导出">
        <span>🎯 自由选区</span>
      </button>

      <!-- 紧凑规格徽标 (点击可快速轮换模式) -->
      <button class="wos-badge-chip" id="wos-quick-badge" title="当前排版规格（点击切换 A4/长图）">
        ${currentResolutionScale}x · ${currentExportMode === 'a4' ? 'A4' : '长图'}
      </button>

      <div class="wos-widget-divider"></div>
      <button class="wos-widget-close" id="wos-btn-minimize" title="最小化">✕</button>
    `;

    document.body.appendChild(widget);

    const autoBtn = widget.querySelector('#wos-btn-auto-export');
    const pickBtn = widget.querySelector('#wos-btn-pick-export');
    const badgeBtn = widget.querySelector('#wos-quick-badge');
    const minBtn = widget.querySelector('#wos-btn-minimize');

    // 点击徽标轮换 A4 / 长图
    badgeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentExportMode = currentExportMode === 'a4' ? 'continuous' : 'a4';
      updateFloatingBadge();
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ wos_export_mode: currentExportMode });
      }
      showToast(`已切换为: ${currentExportMode === 'a4' ? 'A4 标准分页' : '单页无缝长图'}`, 'info', 1200);
    });

    autoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startSmartPreview({
        resolutionScale: currentResolutionScale,
        exportMode: currentExportMode,
        losslessPng: currentLosslessPng
      });
    });

    pickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startElementPicker({
        resolutionScale: currentResolutionScale,
        exportMode: currentExportMode,
        losslessPng: currentLosslessPng
      });
    });

    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      widget.classList.add('minimized');
    });

    widget.addEventListener('click', () => {
      if (widget.classList.contains('minimized')) {
        widget.classList.remove('minimized');
      }
    });
  }

  // --- 轻量 Toast 提示 ---
  function showToast(message, type = 'info', duration = 2500) {
    let toast = document.getElementById('wos-toast-message');
    if (toast) toast.remove();

    toast = document.createElement('div');
    toast.id = 'wos-toast-message';
    toast.className = type;
    toast.innerText = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, duration);
  }

  // --- 与扩展通信 ---
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'preview_smart' || request.action === 'export_smart' || request.action === 'export_middle') {
      startSmartPreview(request.options);
      sendResponse({ success: true });
    } else if (request.action === 'start_picker') {
      startElementPicker(request.options);
      sendResponse({ success: true });
    } else if (request.action === 'check_status') {
      const isWos = location.hostname.includes('webofscience') || location.hostname.includes('clarivate');
      sendResponse({
        isWos,
        currentMode: currentExportMode,
        currentScale: currentResolutionScale,
        losslessPng: currentLosslessPng
      });
    }
    return true;
  });

  // 初始化浮窗
  const isWosDomain = location.hostname.includes('webofscience') || location.hostname.includes('clarivate');
  if (isWosDomain || location.href.includes('wos') || location.href.includes('alps')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initFloatingWidget);
    } else {
      initFloatingWidget();
    }
  }
})();
