/**
 * 网页区域 PDF 导出器 - Content Script (v3.4.0)
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

  let currentOutputFormat = 'pdf';
  // A canvas needs four bytes per pixel before image encoding. Keeping this
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

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['wos_output_format'], (res) => {
      if (res?.wos_output_format && ['pdf', 'png', 'jpeg'].includes(res.wos_output_format)) {
        currentOutputFormat = res.wos_output_format;
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

  // 获取页面标题生成文件名（智能过滤学术网站冗余后缀）
  function getCleanFileName() {
    const heading = document.querySelector('h1') || document.querySelector('h2') || document.title;
    let titleText = typeof heading === 'string' ? heading : (heading.innerText || document.title);
    titleText = titleText
      .replace(/\s*[-_–|]\s*(Web of Science|Clarivate|Nature|ScienceDirect|SpringerLink|Wiley Online Library|PubMed|IEEE Xplore|CNKI|知网|百度学术|核心合集).*$/i, '')
      .trim();

    const clean = titleText
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 70);
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

  function getPreferredPageBreaks(targetElement, canvasHeight, defaultPageHeightPx, scale, cropTop = 0) {
    const targetRect = targetElement.getBoundingClientRect();
    const candidates = Array.from(targetElement.querySelectorAll(
      'h1,h2,h3,h4,p,li,blockquote,pre,figure,table,img,section,article'
    )).map(el => {
      const rect = el.getBoundingClientRect();
      return Math.round((rect.bottom - targetRect.top - cropTop) * scale);
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
      '#wos-pdf-floating-widget,#wos-picker-banner,#wos-smart-preview,#wos-toast-message,#wos-export-target-marker,#wos-region-adjuster,#wos-region-adjuster-panel'
    ));
    const states = elements.map(el => ({ el, visibility: el.style.visibility }));
    elements.forEach(el => { el.style.visibility = 'hidden'; });
    return () => states.forEach(({ el, visibility }) => { el.style.visibility = visibility; });
  }

  function createExportTargetMarker() {
    const marker = document.createElement('div');
    marker.id = 'wos-export-target-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.innerHTML = '<span class="wos-export-target-marker__label"><i></i><b>将导出此区域</b></span>';
    (document.body || document.documentElement).appendChild(marker);

    let activeElement = null;
    let resizeObserver = null;

    const isFixedElement = (el) => {
      let cur = el;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        const pos = window.getComputedStyle(cur).position;
        if (pos === 'fixed') return true;
        cur = cur.parentElement;
      }
      return false;
    };

    const update = (element, label = '将导出此区域') => {
      if (element) {
        if (element !== activeElement) {
          activeElement = element;
          if (resizeObserver) {
            resizeObserver.disconnect();
            try {
              resizeObserver.observe(activeElement);
            } catch (e) {}
          }
        }
      }

      if (!activeElement?.isConnected) {
        marker.hidden = true;
        return;
      }

      const rect = activeElement.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        marker.hidden = true;
        return;
      }

      const isFixed = isFixedElement(activeElement);
      let targetTop, targetLeft;

      if (isFixed) {
        if (marker.style.position !== 'fixed') marker.style.position = 'fixed';
        targetTop = `${rect.top - 3}px`;
        targetLeft = `${rect.left - 3}px`;
      } else {
        if (marker.style.position !== 'absolute') marker.style.position = 'absolute';
        const bodyRect = document.body ? document.body.getBoundingClientRect() : { top: 0, left: 0 };
        targetTop = `${rect.top - bodyRect.top - 3}px`;
        targetLeft = `${rect.left - bodyRect.left - 3}px`;
      }

      const targetWidth = `${rect.width + 6}px`;
      const targetHeight = `${rect.height + 6}px`;

      if (marker.style.top !== targetTop) marker.style.top = targetTop;
      if (marker.style.left !== targetLeft) marker.style.left = targetLeft;
      if (marker.style.width !== targetWidth) marker.style.width = targetWidth;
      if (marker.style.height !== targetHeight) marker.style.height = targetHeight;
      if (marker.hidden) marker.hidden = false;

      // 靠近顶端时将引导标签翻入选框内部，防止被浏览器顶部遮挡
      marker.classList.toggle('wos-marker-flip-label', rect.top < 38);

      const labelEl = marker.querySelector('b');
      if (labelEl && label && labelEl.textContent !== label) {
        labelEl.textContent = label;
      }
    };

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (activeElement?.isConnected) update();
      });
    }

    return {
      update,
      remove: () => {
        if (resizeObserver) resizeObserver.disconnect();
        marker.remove();
      }
    };
  }

  function getRequestedFileName(fileName) {
    const clean = String(fileName || '').trim()
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 70);
    return clean ? `${clean}.pdf` : getCleanFileName();
  }

  // --- 高保真直出 PDF 引擎 ---
  async function downloadCanvasAsImage(canvas, fileName, outputFormat) {
    const isPng = outputFormat === 'png';
    const mimeType = isPng ? 'image/png' : 'image/jpeg';
    const extension = isPng ? 'png' : 'jpg';
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, isPng ? undefined : 0.96));
    if (!blob) throw new Error('无法编码图片');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName.replace(/\.pdf$/i, '')}.${extension}`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportElementToPdf(targetElement, options = {}) {
    if (isExporting) return;
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
    if (!JsPDFClass && (!options.outputFormat || options.outputFormat === 'pdf')) {
      showToast('⚠️ 未检测到 PDF 生成器，请刷新网页重试', 'warning');
      return;
    }

    const requested = Number(options.resolutionScale || currentResolutionScale || 3.0);
    const requestedScale = Number.isFinite(requested) && requested > 0 ? Math.min(4, requested) : 3;
    const scale = getSafeScale(targetElement, requestedScale);
    const mode = options.exportMode || currentExportMode || 'a4';
    const outputFormat = ['pdf', 'png', 'jpeg'].includes(options.outputFormat) ? options.outputFormat : 'pdf';
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
    isExporting = true;
    try {
      restoreExtensionUi = hideExtensionUi();

      await waitForRenderableAssets(targetElement);

      let canvas = await html2canvas(targetElement, {
        scale: scale,
        useCORS: true,
        allowTaint: false,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: document.documentElement.offsetWidth,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      });

      const cropTopPx = Math.max(0, Math.round(Number(options.cropTop || 0) * scale));
      const cropBottomPx = Math.min(canvas.height, Math.round(Number(options.cropBottom || (canvas.height / scale)) * scale));
      if (cropBottomPx - cropTopPx > 2 && (cropTopPx > 0 || cropBottomPx < canvas.height)) {
        const croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = canvas.width;
        croppedCanvas.height = cropBottomPx - cropTopPx;
        croppedCanvas.getContext('2d').drawImage(canvas, 0, cropTopPx, canvas.width, croppedCanvas.height, 0, 0, canvas.width, croppedCanvas.height);
        canvas.width = 0;
        canvas.height = 0;
        canvas = croppedCanvas;
      }

      restoreExtensionUi();
      restoreExtensionUi = () => {};

      const fileName = getRequestedFileName(options.fileName);
      if (outputFormat !== 'pdf') {
        await downloadCanvasAsImage(canvas, fileName, outputFormat);
        showToast(`✅ ${outputFormat.toUpperCase()} 图片已生成并开始下载`, 'success', 3000);
        return;
      }

      if (usePng && canvas.width * canvas.height > 24 * 1024 * 1024) {
        format = 'JPEG';
        mimeType = 'image/jpeg';
        quality = 0.96;
        showToast('ℹ️ 超长内容已使用高质量 JPEG，以避免 PDF 过大或生成失败', 'info', 3500);
      }

      const wantsAdaptive = mode === 'adaptive' || mode === 'continuous';
      const isAdaptive = wantsAdaptive && Math.max(canvas.width, canvas.height) / scale * 25.4 / 96 + 12 <= MAX_CONTINUOUS_HEIGHT_MM;
      if (wantsAdaptive && !isAdaptive) showToast('选区超出单页尺寸上限，已切换 A4 分页', 'info', 4000);

      if (isAdaptive) {
        // 根据图形实际长宽等比自适应单页 PDF (以 96 DPI CSS 像素精确换算为毫米)
        const marginMm = 6;
        const cssWidth = canvas.width / scale;
        const cssHeight = canvas.height / scale;
        const contentWidthMm = (cssWidth * 25.4) / 96;
        const contentHeightMm = (cssHeight * 25.4) / 96;
        const pageWidthMm = Math.min(MAX_CONTINUOUS_HEIGHT_MM, Math.round((contentWidthMm + marginMm * 2) * 10) / 10);
        const pageHeightMm = Math.min(MAX_CONTINUOUS_HEIGHT_MM, Math.round((contentHeightMm + marginMm * 2) * 10) / 10);
        const isLandscape = pageWidthMm > pageHeightMm;

        const pdf = new JsPDFClass({
          orientation: isLandscape ? 'l' : 'p',
          unit: 'mm',
          format: [pageWidthMm, pageHeightMm]
        });
        setPdfMetadata(pdf, fileName);

        const imgData = canvas.toDataURL(mimeType, quality);
        pdf.addImage(imgData, format, marginMm, marginMm, contentWidthMm, contentHeightMm, undefined, 'FAST');
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
        const preferredBreaks = getPreferredPageBreaks(targetElement, canvas.height, pageHeightPx, scale, Number(options.cropTop || 0));

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
        sliceCanvas.width = 0;
        sliceCanvas.height = 0;
      }

      showToast(`✅ PDF 生成成功，已开始下载！`, 'success', 3000);
    } catch (err) {
      console.error('PDF 生成异常:', err);
      showToast('❌ 生成失败: ' + (err.message || '未知错误'), 'warning', 4000);
    } finally {
      isExporting = false;
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
  let isExporting = false;
  let closeAdjuster = null;

  function startSmartPreview(options = {}) {
    if (isPicking || isExporting) return;
    if (closeAdjuster) closeAdjuster();
    const target = findSmartContentContainer();
    if (!target) {
      showToast('未识别到阅读区，请使用“选择页面区块”', 'warning', 3500);
      startElementPicker(options);
      return;
    }

    openRegionAdjuster(target, options);

  }

  function openRegionAdjuster(target, options = {}) {
    if (closeAdjuster) closeAdjuster();
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const baseTop = rect.top + window.scrollY;
    const baseBottom = rect.bottom + window.scrollY;
    const state = { top: baseTop, bottom: baseBottom, dragging: null };
    const MIN_HEIGHT = Math.min(24, rect.height);

    const adjuster = document.createElement('div');
    adjuster.id = 'wos-region-adjuster';
    adjuster.innerHTML = `
      <div class="wos-region-frame"></div>
      <button type="button" class="wos-region-handle top" data-edge="top" aria-label="拖动调整选区上边缘" title="拖动调整上边缘"><i></i></button>
      <button type="button" class="wos-region-handle bottom" data-edge="bottom" aria-label="拖动调整选区下边缘" title="拖动调整下边缘"><i></i></button>
    `;
    const panel = document.createElement('div');
    panel.id = 'wos-region-adjuster-panel';
    panel.innerHTML = `
      <span class="wos-region-tip">拖动上下边缘 · 聚焦手柄后 ↑↓ 微调</span>
      <button type="button" data-action="export">导出此区域</button>
      <button type="button" data-action="repick">重选</button>
      <button type="button" data-action="cancel" aria-label="取消选区">✕</button>
    `;
    document.body.append(adjuster, panel);

    const render = () => {
      if (!target.isConnected) { close(); return; }
      const currentRect = target.getBoundingClientRect();
      const top = currentRect.top + state.top - baseTop;
      const bottom = currentRect.top + state.bottom - baseTop;
      adjuster.style.left = `${currentRect.left}px`;
      adjuster.style.width = `${currentRect.width}px`;
      adjuster.style.top = `${top}px`;
      adjuster.style.height = `${Math.max(MIN_HEIGHT, bottom - top)}px`;
      const panelTop = bottom + 10 <= window.innerHeight - 46 ? bottom + 10 : Math.max(10, top - 46);
      panel.style.top = `${Math.max(10, Math.min(panelTop, window.innerHeight - panel.offsetHeight - 10))}px`;
      panel.style.left = `${Math.max(12, Math.min(currentRect.left, window.innerWidth - panel.offsetWidth - 12))}px`;
    };

    const finishDrag = () => {
      state.dragging = null;
      document.body.classList.remove('wos-region-resizing');
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', finishDrag, true);
      document.removeEventListener('pointercancel', finishDrag, true);
    };
    const onPointerMove = (event) => {
      if (!state.dragging) return;
      const point = event.clientY - target.getBoundingClientRect().top + baseTop;
      if (state.dragging === 'top') {
        state.top = Math.max(baseTop, Math.min(point, state.bottom - MIN_HEIGHT));
      } else {
        state.bottom = Math.min(baseBottom, Math.max(point, state.top + MIN_HEIGHT));
      }
      render();
    };
    const startDrag = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      state.dragging = event.currentTarget.dataset.edge;
      document.body.classList.add('wos-region-resizing');
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', finishDrag, true);
      document.addEventListener('pointercancel', finishDrag, true);
    };
    const close = () => {
      closeAdjuster = null;
      finishDrag();
      adjuster.remove();
      panel.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', render, true);
      window.removeEventListener('resize', render, true);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close();
      const edge = event.target.dataset?.edge;
      if (edge && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const delta = (event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? 10 : 1);
        state[edge] = edge === 'top' ? Math.max(baseTop, Math.min(state.top + delta, state.bottom - MIN_HEIGHT)) : Math.min(baseBottom, Math.max(state.bottom + delta, state.top + MIN_HEIGHT));
        render();
      }
    };

    adjuster.querySelectorAll('.wos-region-handle').forEach(handle => handle.addEventListener('pointerdown', startDrag));
    panel.addEventListener('click', (event) => {
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'export') {
        if (!target.isConnected || Math.abs(target.getBoundingClientRect().height - rect.height) > 1) {
          close();
          showToast('页面内容尺寸已变化，请重新选择区域', 'warning', 3500);
          return;
        }
        const cropTop = state.top - baseTop;
        const cropBottom = state.bottom - baseTop;
        close();
        exportElementToPdf(target, { ...options, cropTop, cropBottom });
      } else if (action === 'repick') {
        close();
        startElementPicker(options);
      } else if (action === 'cancel') {
        close();
      }
    });
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', render, true);
    window.addEventListener('resize', render, true);
    closeAdjuster = close;
    render();
  }

  function startElementPicker(options = {}) {
    if (isPicking || isExporting) return;
    if (closeAdjuster) closeAdjuster();
    isPicking = true;

    const banner = document.createElement('div');
    banner.id = 'wos-picker-banner';
    banner.innerHTML = `
      <span>🎯 点击网页区块以锁定选区</span>
      <span class="wos-banner-key">↑ 选父级 · 锁定后拖动边缘 · ESC 退出</span>
    `;
    document.body.appendChild(banner);

    const marker = createExportTargetMarker();
    const refreshMarker = () => {
      if (currentHighlightedEl) marker.update(currentHighlightedEl, '点击锁定选区');
    };

    function onMouseMove(e) {
      if (!isPicking) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target.closest('#wos-picker-banner') || target.closest('#wos-pdf-floating-widget')) return;
      if (target === currentHighlightedEl) return;
      if (currentHighlightedEl) currentHighlightedEl.classList.remove('wos-element-highlighted');
      currentHighlightedEl = target;
      currentHighlightedEl.classList.add('wos-element-highlighted');
      refreshMarker();
    }

    function onClick(e) {
      if (!isPicking) return;
      if (e.target.closest('#wos-picker-banner,#wos-pdf-floating-widget')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const selected = currentHighlightedEl || document.elementFromPoint(e.clientX, e.clientY);
      stopElementPicker();
      if (selected) openRegionAdjuster(selected, options);
    }

    function onKeyDown(e) {
      if (e.key === 'ArrowUp' && currentHighlightedEl?.parentElement && currentHighlightedEl.parentElement !== document.body) {
        e.preventDefault();
        currentHighlightedEl.classList.remove('wos-element-highlighted');
        currentHighlightedEl = currentHighlightedEl.parentElement;
        currentHighlightedEl.classList.add('wos-element-highlighted');
        refreshMarker();
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
      marker.remove();
      banner.remove();
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', refreshMarker, true);
      window.removeEventListener('scroll', refreshMarker, true);
    }

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', refreshMarker, true);
    window.addEventListener('scroll', refreshMarker, true);
  }
  // --- 悬浮操作胶囊更新 ---
  function getOutputLabel() {
    return currentOutputFormat === 'pdf' ? 'PDF' : currentOutputFormat.toUpperCase();
  }

  function updateFloatingBadge() {
    const badge = document.getElementById('wos-quick-badge');
    if (badge) {
      const modeText = currentExportMode === 'a4' ? 'A4 纸' : '自适应';
      badge.textContent = `${currentResolutionScale}x · ${modeText}`;
    }
  }
  function initFloatingWidget() {
    if (document.getElementById('wos-pdf-floating-widget')) return;

    const widget = document.createElement('div');
    widget.id = 'wos-pdf-floating-widget';
    widget.innerHTML = `
      <span class="wos-widget-logo-icon" title="展开 PDF 导出助手">📄</span>
      <button class="wos-widget-btn primary" id="wos-btn-auto-export" title="识别主体，调整范围后确认导出">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:2px">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        <span>智能导出 PDF</span>
      </button>

      <button class="wos-widget-btn secondary" id="wos-btn-pick-export" title="点击自由选择页面任意区域导出">
        <span>🎯 自由选区</span>
      </button>

      <!-- 紧凑规格徽标 (点击可快速轮换模式) -->
      <button class="wos-badge-chip" id="wos-quick-badge" title="当前页面规格（点击切换 A4 纸张/自适应大小）">
        ${currentResolutionScale}x · ${currentExportMode === 'a4' ? 'A4 纸' : '自适应'}
      </button>

      <div class="wos-widget-divider"></div>
      <button class="wos-widget-close" id="wos-btn-minimize" title="最小化">✕</button>
    `;

    document.body.appendChild(widget);

    const autoBtn = widget.querySelector('#wos-btn-auto-export');
    const pickBtn = widget.querySelector('#wos-btn-pick-export');
    const badgeBtn = widget.querySelector('#wos-quick-badge');
    const minBtn = widget.querySelector('#wos-btn-minimize');

    // 点击徽标轮换 A4 / 自适应大小
    badgeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentExportMode = currentExportMode === 'a4' ? 'adaptive' : 'a4';
      updateFloatingBadge();
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ wos_export_mode: currentExportMode });
      }
      showToast(`已切换规格: ${currentExportMode === 'a4' ? 'A4 纸张 (标准分页)' : '自适应大小 (依图定幅)'}`, 'info', 1500);
    });

    autoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startSmartPreview({
        resolutionScale: currentResolutionScale,
        exportMode: currentExportMode,
        losslessPng: currentLosslessPng,
        outputFormat: currentOutputFormat,
      });
    });

    pickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startElementPicker({
        resolutionScale: currentResolutionScale,
        exportMode: currentExportMode,
        losslessPng: currentLosslessPng,
        outputFormat: currentOutputFormat,
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
        losslessPng: currentLosslessPng,
        outputFormat: currentOutputFormat,
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
