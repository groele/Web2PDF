/**
 * 网页区域 PDF 导出器 - Content Script (v4.0.0)
 */

(function () {
  const CONTENT_VERSION = '4.0.0';
  if (window.__WOS_PDF_EXPORTER_INITIALIZED__) return;
  window.__WOS_PDF_EXPORTER_INITIALIZED__ = true;
  window.__WOS_PDF_EXPORTER_VERSION__ = CONTENT_VERSION;

  // 默认排版模式：'a4' (标准 A4 分页) 或 'continuous' (单页长图)
  let currentExportMode = 'a4';
  // 默认平衡预设：2×；保留用户已保存的倍率。
  let currentResolutionScale = 2.0;
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
    const textCache = new Map();
    const readText = element => {
      if (!textCache.has(element)) textCache.set(element, element.innerText || '');
      return textCache.get(element);
    };
    const headings = Array.from(document.querySelectorAll('h1, h2'));
    for (const heading of headings) {
      let curr = heading;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        const text = readText(curr);
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
      const len = readText(el).trim().length;
      if (len > maxLen && len < 50000) {
        const text = readText(el);
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
    const cleanups = [];
    const imageTasks = Array.from(targetElement.querySelectorAll('img'))
      .filter(img => !img.complete)
      .map(img => new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        cleanups.push(() => { img.removeEventListener('load', resolve); img.removeEventListener('error', resolve); });
      }));
    const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([fontsReady, ...imageTasks]),
        new Promise(resolve => { timer = setTimeout(resolve, 2500); })
      ]);
    } finally {
      clearTimeout(timer);
      cleanups.forEach(cleanup => cleanup());
    }
  }

  function getPreferredPageBreaks(targetElement, canvasHeight, defaultPageHeightPx, scale, cropTop = 0, clonedBoundaries = null) {
    const targetRect = targetElement.getBoundingClientRect();
    const candidates = clonedBoundaries ? clonedBoundaries.map(y => Math.round(y * scale)).sort((a, b) => a - b) : Array.from(targetElement.querySelectorAll(
      'h1,h2,h3,h4,p,li,blockquote,pre,figure,table,img,section,article'
    )).map(el => {
      const rect = el.getBoundingClientRect();
      return Math.round((rect.bottom - targetRect.top - cropTop) * scale);
    }).filter(bottom => bottom > 0 && bottom < canvasHeight).sort((a, b) => a - b);

    const breaks = [];
    let top = 0;
    let candidateIndex = 0;
    while (top + defaultPageHeightPx < canvasHeight) {
      const ideal = top + defaultPageHeightPx;
      const minimum = top + Math.floor(defaultPageHeightPx * 0.62);
      let next = 0;
      while (candidateIndex < candidates.length && candidates[candidateIndex] <= ideal) {
        const bottom = candidates[candidateIndex++];
        if (bottom >= minimum) next = bottom;
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
      '#wos-mask-overlay,#wos-guidance-banner,#wos-pdf-floating-widget,#wos-picker-banner,#wos-smart-preview,#wos-toast-message,#wos-export-target-marker,#wos-region-adjuster,#wos-region-adjuster-panel'
    ));
    const states = elements.map(el => ({ el, visibility: el.style.visibility }));
    elements.forEach(el => { el.style.visibility = 'hidden'; });
    return () => states.forEach(({ el, visibility }) => { el.style.visibility = visibility; });
  }

  // --- 聚光灯暗色遮罩系统 (4-Panel Spotlight Mask) ---
  function createMaskOverlay() {
    let overlay = document.getElementById('wos-mask-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'wos-mask-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('data-html2canvas-ignore', 'true');
      overlay.innerHTML = `
        <div class="wos-mask-panel top"></div>
        <div class="wos-mask-panel bottom"></div>
        <div class="wos-mask-panel left"></div>
        <div class="wos-mask-panel right"></div>
      `;
      document.documentElement.appendChild(overlay);
    }
    const topPanel = overlay.querySelector('.top');
    const bottomPanel = overlay.querySelector('.bottom');
    const leftPanel = overlay.querySelector('.left');
    const rightPanel = overlay.querySelector('.right');

    const update = (rect) => {
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        topPanel.style.height = '100vh';
        bottomPanel.style.top = '100vh';
        leftPanel.style.width = '0';
        rightPanel.style.left = '100vw';
        return;
      }
      const t = Math.max(0, rect.top);
      const b = Math.max(0, rect.top + rect.height);
      const l = Math.max(0, rect.left);
      const r = Math.max(0, rect.left + rect.width);
      const h = Math.max(0, rect.height);

      topPanel.style.height = `${t}px`;
      bottomPanel.style.top = `${b}px`;
      leftPanel.style.top = `${t}px`;
      leftPanel.style.height = `${h}px`;
      leftPanel.style.width = `${l}px`;
      rightPanel.style.top = `${t}px`;
      rightPanel.style.height = `${h}px`;
      rightPanel.style.left = `${r}px`;
    };

    const remove = () => {
      overlay.remove();
    };

    return { update, remove, element: overlay };
  }

  // --- 顶部流程引导横幅 (Top Guidance Banner) ---
  function createGuidanceBanner(icon, text, shortcuts = []) {
    let banner = document.getElementById('wos-guidance-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'wos-guidance-banner';
      banner.setAttribute('data-html2canvas-ignore', 'true');
      document.documentElement.appendChild(banner);
    }
    const renderContent = (curIcon, curText, curShortcuts) => {
      const badgesHtml = curShortcuts.map(k => `<span class="wos-guidance-key">${k}</span>`).join('');
      banner.innerHTML = `
        <span class="wos-guidance-icon">${curIcon}</span>
        <span class="wos-guidance-text">${curText}</span>
        ${curShortcuts.length ? `<div class="wos-guidance-badges">${badgesHtml}</div>` : ''}
      `;
    };
    renderContent(icon, text, shortcuts);
    return {
      update(newIcon, newText, newShortcuts = []) {
        renderContent(newIcon, newText, newShortcuts);
      },
      remove() {
        banner?.remove();
      }
    };
  }

  function createExportTargetMarker() {
    const marker = document.createElement('div');
    marker.id = 'wos-export-target-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.setAttribute('data-html2canvas-ignore', 'true');
    marker.hidden = true;
    marker.innerHTML = '<span class="wos-export-target-marker__label"><i></i><b>将导出此区域</b></span>';
    document.documentElement.appendChild(marker);

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

    const update = (element, label) => {
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

      // getBoundingClientRect is always viewport-relative, including sticky elements.
      marker.style.position = 'fixed';
      const targetTop = `${rect.top - 3}px`;
      const targetLeft = `${rect.left - 3}px`;

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
      .replace(/\.(pdf|png|jpe?g)$/i, '')
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 70);
    return clean ? `${clean}.pdf` : getCleanFileName();
  }

  function findScrollCaptureTarget(selected) {
    const isScrollable = element => {
      const style = getComputedStyle(element);
      return /(auto|scroll|overlay)/.test(style.overflowY) && element.clientHeight > 0
        && element.scrollHeight > element.clientHeight + 2;
    };
    let scroller = null;
    for (let node = selected; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (isScrollable(node)) { scroller = node; break; }
    }
    if (!scroller) {
      let panel = null;
      for (let node = selected; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (node.matches('aside,dialog,[role="dialog"]') || getComputedStyle(node).position === 'fixed') { panel = node; break; }
      }
      // A normal article containing a small scrolling table is still an article.
      if (!panel) return null;
      const searchRoot = panel || selected;
      scroller = [...searchRoot.querySelectorAll('*')].find(node => isScrollable(node)
        && node.getBoundingClientRect().width >= searchRoot.getBoundingClientRect().width * 0.6);
    }
    if (!scroller) return null;
    // Include a drawer's title and footer if they wrap its independently scrolling body.
    let root = scroller;
    for (let node = scroller; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width > window.innerWidth * 0.9) break;
      if (getComputedStyle(node).position === 'fixed' || node.matches('[role="dialog"],dialog,aside')) root = node;
    }
    return root;
  }

  function createScrollCapturePlan(root) {
    const expandNodes = new Set([root]);
    for (const element of root.querySelectorAll('*')) {
      if (element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 2
        && /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY)) {
        for (let node = element; node && root.contains(node); node = node.parentElement) expandNodes.add(node);
      }
    }
    const attribute = 'data-wos-capture-' + Math.random().toString(36).slice(2);
    const nodes = [root, ...root.querySelectorAll('*')].filter(element => expandNodes.has(element));
    const geometry = nodes.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { index, element, width: rect.width, height: rect.height, expand: true,
        scrollbar: Math.max(0, element.offsetWidth - element.clientWidth - parseFloat(style.borderLeftWidth || 0) - parseFloat(style.borderRightWidth || 0)),
        paddingRight: parseFloat(style.paddingRight) || 0 };
    });
    return { width: root.getBoundingClientRect().width, geometry, attribute,
      mark() { geometry.forEach(entry => entry.element.setAttribute(attribute, String(entry.index))); },
      restore() { geometry.forEach(entry => entry.element.removeAttribute(attribute)); }
    };
  }

  function expandScrollCapture(clonedDocument, root, plan) {
    const nodes = plan.geometry.map(entry => entry.index === 0 ? root : root.querySelector(`[${plan.attribute}="${entry.index}"]`));
    if (nodes.some(node => !node)) throw new Error('滚动区域结构已变化，请重新选择后导出');
    const set = (element, property, value) => element.style.setProperty(property, value, 'important');
    set(root, 'bottom', 'auto');
    // Preserve computed content width when removing a scrollbar.
    for (const entry of plan.geometry) {
      const element = nodes[entry.index];
      if (entry.expand || entry.index === 0) {
        set(element, 'box-sizing', 'border-box');
        set(element, 'width', entry.width + 'px');
        set(element, 'min-width', entry.width + 'px');
        set(element, 'max-width', entry.width + 'px');
        if (entry.scrollbar) {
          set(element, 'scrollbar-gutter', 'auto');
          set(element, 'padding-right', (entry.paddingRight + entry.scrollbar) + 'px');
        }
        set(element, 'overflow', 'visible');
        set(element, 'max-height', 'none');
        set(element, 'height', 'auto');
        set(element, 'flex-shrink', '0');
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
    }
    for (const element of [root, ...root.querySelectorAll('*')]) {
      if (clonedDocument.defaultView.getComputedStyle(element).position === 'sticky') {
        set(element, 'position', 'relative');
        set(element, 'top', 'auto');
        set(element, 'bottom', 'auto');
      }
    }
    // Work from inner scroll areas outwards; offsetHeight includes padding/borders.
    for (const entry of [...plan.geometry].reverse()) {
      if (!entry.expand && entry.index !== 0) continue;
      const element = nodes[entry.index];
      const height = Math.max(element.scrollHeight + element.offsetHeight - element.clientHeight, element.getBoundingClientRect().height);
      set(element, 'height', Math.ceil(height) + 'px');
    }
    // Its position inside the page should not constrain the isolated capture.
    set(root, 'bottom', 'auto');
    set(root, 'max-height', 'none');
  }

  function prepareCaptureClone(clonedDocument, captureRoot = null) {
    const view = clonedDocument.defaultView;
    // Sticky toolbars can move from normal flow to the top after scrolling.
    // Detect compact action groups, not a particular edge or scroll position.
    // Visibility preserves the original layout and crop coordinates.
    const isWos = /(^|\.)(webofscience\.com|clarivate\.(com|cn))$/i.test(location.hostname);
    const hiddenRoots = [];
    for (const element of (captureRoot ? [captureRoot, ...captureRoot.querySelectorAll('*')] : clonedDocument.querySelectorAll('*'))) {
      if (element === captureRoot) continue;
      const style = view.getComputedStyle(element);
      if (!isWos && style.position !== 'fixed' && style.position !== 'sticky') continue;
      const box = element.getBoundingClientRect();
      if (box.height <= 0 || box.height > Math.min(180, view.innerHeight * 0.3)) continue;
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length >= 1200) continue;
      const toolbarLike = element.matches('nav,header,[role="toolbar"]')
        || /toolbar|action[-_ ]?bar/i.test(`${element.id} ${element.className}`);
      const floatingCandidate = !captureRoot && box.width >= 240
        && (style.position === 'fixed' || (style.position === 'sticky' && toolbarLike));
      let controlCount = 0;
      if (floatingCandidate) {
        const walker = clonedDocument.createTreeWalker(element, 1);
        while (walker.nextNode()) {
          if (walker.currentNode.matches('button,[role="button"],a[href],input[type="button"],input[type="submit"]') && ++controlCount === 2) break;
        }
      }
      const isFloatingActions = floatingCandidate && controlCount >= 2;
      // WOS may position an outer wrapper while the action group itself is static.
      // Require multiple distinctive labels so article metadata is not mistaken for UI.
      const wosFullText = /出版商处的全文|全文链接|Full text links|Full text at publisher/i.test(text);
      const wosActions = /添加到标记|标记结果列表|Add to marked|Marked List/i.test(text);
      const isWosActionGroup = isWos && wosFullText && wosActions && /导出|Export/i.test(text);
      const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.id, typeof element.className === 'string' ? element.className : ''].join(' ');
      const isHelpWidget = style.position === 'fixed' && box.width <= 240 && box.height <= 180
        && /help|support|chat|帮助|客服/i.test(label);
      if (element === captureRoot || (!isFloatingActions && !isWosActionGroup && !isHelpWidget)) continue;
      hiddenRoots.push(element);
    }
    for (const element of hiddenRoots) {
      element.setAttribute('data-html2canvas-ignore', 'true');
      element.style.setProperty('visibility', 'hidden', 'important');
      // Descendants may explicitly set visibility:visible.
      for (const child of element.querySelectorAll('*')) child.style.setProperty('visibility', 'hidden', 'important');
    }
    // html2canvas 1.4 needs a compatibility pass for modern CSS colours, but
    // asking for three computed styles on every cloned node is expensive on
    // long papers. Inspect authored rules first and retain the conservative
    // full pass whenever a stylesheet cannot be inspected.
    if (captureCloneMayUseModernColors(clonedDocument, captureRoot)) {
      normalizeCaptureColors(clonedDocument, captureRoot);
    }
  }

  function captureCloneMayUseModernColors(clonedDocument, captureRoot = null) {
    const modern = /\b(?:oklch|oklab|lch|lab|color-mix|color|light-dark)\(/i;
    const hasSyntax = value => typeof value === 'string' && modern.test(value);
    const scanRules = rules => {
      for (const rule of Array.from(rules || [])) {
        if (hasSyntax(rule.cssText)) return true;
        // Grouping rules such as @media can be represented without their
        // nested declarations in cssText on some Chromium versions.
        if (rule.cssRules && scanRules(rule.cssRules)) return true;
      }
      return false;
    };

    for (const sheet of Array.from(clonedDocument.styleSheets || [])) {
      try {
        if (scanRules(sheet.cssRules)) return true;
      } catch (_) {
        // Cross-origin stylesheets cannot be read. Keep correctness over the
        // optimization because they may still supply modern computed colours.
        return true;
      }
    }

    const scope = captureRoot
      ? [captureRoot, ...captureRoot.querySelectorAll('[style]')]
      : Array.from(clonedDocument.querySelectorAll('[style]'));
    return scope.some(element => hasSyntax(element.getAttribute('style') || ''));
  }

  // html2canvas 1.4 cannot parse modern CSS colors. Normalize only its cloned DOM.
  function normalizeCaptureColors(clonedDocument, captureRoot = null) {
    const view = clonedDocument.defaultView;
    const canvas = clonedDocument.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const cache = new Map();
    const modern = /\b(?:oklch|oklab|lch|lab|color-mix|color|light-dark)\(/i;
    const properties = [
      'color', 'background-color', 'background-image',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'outline-color', 'text-decoration-color', 'text-emphasis-color', 'column-rule-color',
      'box-shadow', 'text-shadow', 'fill', 'stroke', 'stop-color', 'flood-color',
      'lighting-color', '-webkit-text-fill-color', '-webkit-text-stroke-color'
    ];
    function rgb(token) {
      if (cache.has(token)) return cache.get(token);
      if (!ctx || !view.CSS.supports('color', token)) throw new Error('无法转换页面颜色：' + token);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = token;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      const converted = 'rgba(' + [r, g, b, a / 255].join(',') + ')';
      cache.set(token, converted);
      return converted;
    }
    function normalize(value) {
      let match;
      while ((match = modern.exec(value))) {
        let end = match.index + match[0].length;
        let depth = 1;
        while (end < value.length && depth) {
          if (value[end] === '(') depth++;
          if (value[end] === ')') depth--;
          end++;
        }
        if (depth) break;
        value = value.slice(0, match.index) + rgb(value.slice(match.index, end)) + value.slice(end);
      }
      return value;
    }
    const updates = [];
    const pseudoRules = [];
    let index = 0;
    for (const element of (captureRoot ? [captureRoot, ...captureRoot.querySelectorAll('*')] : clonedDocument.querySelectorAll('*'))) {
      // Read computed values before writing to avoid inherited-color changes.
      for (const pseudo of [null, '::before', '::after']) {
        const computed = view.getComputedStyle(element, pseudo);
        if (pseudo && ['none', 'normal'].includes(computed.content)) continue;
        const declarations = [];
        for (const property of properties) {
          const value = computed.getPropertyValue(property);
          if (modern.test(value)) declarations.push([property, normalize(value)]);
        }
        if (!declarations.length) continue;
        if (pseudo) {
          const id = String(index++);
          element.setAttribute('data-wos-capture-color', id);
          // One unique selector per pseudo, without relying on page IDs or classes.
          pseudoRules.push({ element, pseudo, declarations });
        } else updates.push({ element, declarations });
      }
    }
    for (const { element, declarations } of updates) {
      for (const [property, value] of declarations) element.style.setProperty(property, value, 'important');
    }
    const sheet = clonedDocument.createElement('style');
    sheet.textContent = pseudoRules.map(({ element, pseudo, declarations }) =>
      '[data-wos-capture-color="' + element.getAttribute('data-wos-capture-color') + '"]' + pseudo +
      '{' + declarations.map(([key, value]) => key + ':' + value + '!important').join(';') + '}'
    ).join('\n');
    (clonedDocument.head || clonedDocument.documentElement).appendChild(sheet);
  }

  // --- 高保真直出 PDF 引擎 ---
  async function downloadCanvasAsImage(canvas, fileName, outputFormat, job) {
    const isPng = outputFormat === 'png';
    const mimeType = isPng ? 'image/png' : 'image/jpeg';
    const extension = isPng ? 'png' : 'jpg';
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, isPng ? undefined : 0.96));
    if (!blob) throw new Error('无法编码图片');
    job?.check();
    job?.stage('4 / 4 · 开始下载', 100);
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

  function freezeCaptureScroll() {
    const viewport = { x: window.scrollX, y: window.scrollY, width: document.documentElement.clientWidth, height: window.innerHeight };
    const positions = new Map();
    const attribute = 'data-wos-scroll-' + Math.random().toString(36).slice(2);
    for (const element of document.querySelectorAll('*')) {
      if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
        const id = String(positions.size);
        positions.set(element, { left: element.scrollLeft, top: element.scrollTop, id });
      }
    }
    for (const [element, position] of positions) element.setAttribute(attribute, position.id);
    const prevent = event => {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    };
    const keydown = event => {
      if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End',' '].includes(event.key)) return;
      // Keep the progress dialog's keyboard-accessible cancel action working.
      if (event.key === ' ' && event.target?.closest?.('#wos-export-progress button')) return;
      prevent(event);
    };
    const keepPosition = event => {
      const element = event.target;
      if (element === document || element === document.documentElement || element === document.body) {
        if (window.scrollX !== viewport.x || window.scrollY !== viewport.y) {
          window.scrollTo({ left: viewport.x, top: viewport.y, behavior: 'instant' });
        }
      } else {
        const position = positions.get(element);
        if (position && (element.scrollLeft !== position.left || element.scrollTop !== position.top)) {
          element.scrollTo({ ...position, behavior: 'instant' });
        }
      }
    };
    window.addEventListener('wheel', prevent, { capture: true, passive: false });
    window.addEventListener('touchmove', prevent, { capture: true, passive: false });
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('scroll', keepPosition, true);
    // Scroll events may be delayed in background tabs or by page scripts.
    const restorePositions = () => {
      if (window.scrollX !== viewport.x || window.scrollY !== viewport.y) window.scrollTo({ left: viewport.x, top: viewport.y, behavior: 'instant' });
      for (const [element, position] of positions) {
        if (element.isConnected && (element.scrollLeft !== position.left || element.scrollTop !== position.top)) element.scrollTo({ left: position.left, top: position.top, behavior: 'instant' });
      }
    };
    const watchdog = setInterval(restorePositions, 50);
    return {
      viewport,
      restoreClone(doc) {
        for (const position of positions.values()) {
          const element = doc.querySelector(`[${attribute}="${position.id}"]`);
          if (element) { element.scrollLeft = position.left; element.scrollTop = position.top; element.removeAttribute(attribute); }
        }
      },
      restore() {
        clearInterval(watchdog);
        restorePositions();
        for (const element of positions.keys()) element.removeAttribute(attribute);
        window.removeEventListener('wheel', prevent, true);
        window.removeEventListener('touchmove', prevent, true);
        window.removeEventListener('keydown', keydown, true);
        window.removeEventListener('scroll', keepPosition, true);
      }
    };
  }

  // Yield between expensive stages. html2canvas itself cannot be interrupted safely.
  const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
  async function encodeCanvas(canvas, mimeType, quality) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));
    if (!blob) throw new Error('无法编码图片，请缩小选区或降低倍率');
    return new Uint8Array(await blob.arrayBuffer());
  }

  function createExportJob() {
    const controller = new AbortController();
    const started = performance.now();
    const panel = document.createElement('section');
    panel.id = 'wos-export-progress';
    panel.setAttribute('data-html2canvas-ignore', 'true');
    panel.setAttribute('aria-label', '导出进度');
    panel.innerHTML = '<div class="wos-progress-heading"><strong>正在导出</strong><span class="wos-progress-time" aria-hidden="true">0.0 s</span></div><div class="wos-progress-track" aria-hidden="true"><i></i></div><p role="status" aria-live="polite"></p><button type="button">取消导出</button>';
    document.documentElement.appendChild(panel);
    const status = panel.querySelector('p');
    const button = panel.querySelector('button');
    const cancel = () => {
      controller.abort();
      button.disabled = true;
      status.textContent = '取消已请求，等待当前处理阶段结束…';
    };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
    };
    button.addEventListener('click', cancel);
    document.addEventListener('keydown', onKey, true);
    const timer = setInterval(() => { panel.querySelector('.wos-progress-time').textContent = ((performance.now() - started) / 1000).toFixed(1) + ' s'; }, 200);
    return {
      get cancelled() { return controller.signal.aborted; },
      check() { if (controller.signal.aborted) throw new DOMException('已取消导出', 'AbortError'); },
      stage(text, progress) {
        this.check();
        status.textContent = text;
        panel.querySelector('.wos-progress-track i').style.width = progress + '%';
      },
      elapsed() { return ((performance.now() - started) / 1000).toFixed(1); },
      close() { clearInterval(timer); document.removeEventListener('keydown', onKey, true); panel.remove(); }
    };
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

    const requested = Number(options.resolutionScale || currentResolutionScale || 2.0);
    const requestedScale = Number.isFinite(requested) && requested > 0 ? Math.min(4, requested) : 2;
    const capture = options.captureRect;
    let scrollPlan = null;
    let clonedBoundaries = null;
    let scale = getSafeScale(capture ? {
      getBoundingClientRect: () => capture, scrollWidth: capture.width, scrollHeight: capture.height
    } : targetElement, requestedScale);
    const mode = options.exportMode || currentExportMode || 'a4';
    const outputFormat = ['pdf', 'png', 'jpeg'].includes(options.outputFormat) ? options.outputFormat : 'pdf';
    const defaults = outputFormat !== 'pdf' ? { top: 0, bottom: 0, left: 0, right: 0 }
      : mode === 'a4' ? { top: 12, bottom: 12, left: 10, right: 10 }
      : { top: 6, bottom: 6, left: 6, right: 6 };
    let margins = defaults;
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
      primaryBtn.innerHTML = `<span>⏳ 正在生成 ${outputFormat.toUpperCase()}...</span>`;
    }

    const formatUpper = outputFormat.toUpperCase();
    if (scale < requestedScale - 0.05) {
      showToast(`⏳ 内容较长，已自动调整为 ${scale.toFixed(1)}x 渲染以保障稳定性`, 'info', 3500);
    } else {
      showToast(`⏳ 正在以 ${scale}x 高保真渲染 ${formatUpper}，请稍候...`, 'info', 3500);
    }

    let restoreExtensionUi = () => {};
    let scrollLock;
    let canvas;
    let cloneFrame;
    let sliceCanvas;
    const job = createExportJob();
    isExporting = true;
    try {
      // Freeze synchronously when export starts, before the first async yield.
      scrollLock = freezeCaptureScroll();
      job.stage('1 / 4 · 准备页面与图片', 10);
      await yieldToBrowser();
      job.check();
      const saved = options.margins === undefined && typeof chrome !== 'undefined' && chrome.storage?.local
        ? (await chrome.storage.local.get(['wos_margins'])).wos_margins : options.margins;
      margins = Object.fromEntries(Object.entries(defaults).map(([edge, fallback]) => {
        const value = saved?.[edge];
        const n = Number(value);
        return [edge, value === null || value === undefined || value === '' || !Number.isFinite(n) ? fallback : Math.max(0, Math.min(50, n))];
      }));
      restoreExtensionUi = hideExtensionUi();
      document.getElementById('wos-toast-message')?.remove();

      await waitForRenderableAssets(targetElement);
      job.check();
      if (!targetElement.isConnected) throw new Error('选中的内容已被页面移除，请重新选择');
      if (options.fullScroll) {
        scrollPlan = createScrollCapturePlan(targetElement);
        scrollPlan.mark();
      }

      job.stage('2 / 4 · 渲染选区，复杂页面可能需要更久', 30);
      await yieldToBrowser();
      job.check();
      const renderOptions = {
        scale: scale,
        useCORS: true,
        allowTaint: false,
        logging: false,
        backgroundColor: '#ffffff',
        onclone: (doc, root) => {
          cloneFrame = doc.defaultView.frameElement;
          job.check();
          scrollLock.restoreClone(doc);
          if (scrollPlan) {
            expandScrollCapture(doc, root, scrollPlan);
            prepareCaptureClone(doc, root);
            const bounds = root.getBoundingClientRect();
            clonedBoundaries = [...root.querySelectorAll('h1,h2,h3,p,li,tr,figure,section')].map(el => el.getBoundingClientRect().bottom - bounds.top).filter(y => y > 0 && y < bounds.height);
            scale = getSafeScale({ getBoundingClientRect: () => bounds, scrollWidth: bounds.width, scrollHeight: bounds.height }, requestedScale);
            if (scale < 0.75) throw new Error('滚动内容过长，请缩小范围后导出');
            renderOptions.scale = scale;
            renderOptions.width = Math.ceil(bounds.width);
            renderOptions.height = Math.ceil(bounds.height);
          } else prepareCaptureClone(doc);
        },
        windowWidth: scrollLock.viewport.width,
        windowHeight: scrollLock.viewport.height,
        scrollX: scrollLock.viewport.x,
        scrollY: scrollLock.viewport.y,
        ...(capture ? { x: capture.x, y: capture.y, width: capture.width, height: capture.height } : {})
      };
      canvas = await html2canvas(capture ? document.documentElement : targetElement, renderOptions);
      job.check();
      job.stage('3 / 4 · 编码文件', 65);
      await yieldToBrowser();
      job.check();
      if (!canvas.width || !canvas.height) throw new Error('导出范围为空，请重新选择');

      const cropTopPx = Math.max(0, Math.round(Number(options.cropTop || 0) * scale));
      const cropBottomPx = Math.min(canvas.height, Math.round(Number(options.cropBottom || (canvas.height / scale)) * scale));
      const cropWidthPx = Math.min(canvas.width, Math.max(1, Math.round(Number(options.cropWidth ?? (canvas.width / scale)) * scale)));
      if (cropBottomPx > cropTopPx && (cropTopPx > 0 || cropBottomPx < canvas.height || cropWidthPx < canvas.width)) {
        const croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = cropWidthPx;
        croppedCanvas.height = cropBottomPx - cropTopPx;
        croppedCanvas.getContext('2d').drawImage(canvas, 0, cropTopPx, cropWidthPx, croppedCanvas.height, 0, 0, cropWidthPx, croppedCanvas.height);
        canvas.width = 0;
        canvas.height = 0;
        canvas = croppedCanvas;
      }

      restoreExtensionUi();
      restoreExtensionUi = () => {};

      const fileName = getRequestedFileName(options.fileName);
      if (outputFormat !== 'pdf') {
        const padding = Object.fromEntries(Object.entries(margins).map(([edge, mm]) => [edge, Math.round(mm * 96 / 25.4 * scale)]));
        if (Object.values(padding).some(value => value > 0)) {
          const width = canvas.width + padding.left + padding.right;
          const height = canvas.height + padding.top + padding.bottom;
          if (width > MAX_CANVAS_EDGE || height > MAX_CANVAS_EDGE || width * height > MAX_RENDER_PIXELS) {
            throw new Error('添加留白后图片过大，请降低倍率或缩小选区');
          }
          const padded = document.createElement('canvas');
          padded.width = width;
          padded.height = height;
          const ctx = padded.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(canvas, padding.left, padding.top);
          canvas.width = 0;
          canvas.height = 0;
          canvas = padded;
        }
        await downloadCanvasAsImage(canvas, fileName, outputFormat, job);
        showToast(`✅ ${outputFormat.toUpperCase()} ${canvas.width} × ${canvas.height} px · ${scale.toFixed(2)}× · ${job.elapsed()} s · 已开始下载`, 'success', 5000);
        return true;
      }

      const wantsAdaptive = mode === 'adaptive' || mode === 'continuous';
      const isAdaptive = wantsAdaptive
        && canvas.width / scale * 25.4 / 96 + margins.left + margins.right <= MAX_CONTINUOUS_HEIGHT_MM
        && canvas.height / scale * 25.4 / 96 + margins.top + margins.bottom <= MAX_CONTINUOUS_HEIGHT_MM;
      if (wantsAdaptive && !isAdaptive) showToast('选区超出单页尺寸上限，已切换 A4 分页', 'info', 4000);

      if (isAdaptive) {
        // 根据图形实际长宽等比自适应单页 PDF (以 96 DPI CSS 像素精确换算为毫米)
        const cssWidth = canvas.width / scale;
        const cssHeight = canvas.height / scale;
        const contentWidthMm = (cssWidth * 25.4) / 96;
        const contentHeightMm = (cssHeight * 25.4) / 96;
        const pageWidthMm = contentWidthMm + margins.left + margins.right;
        const pageHeightMm = contentHeightMm + margins.top + margins.bottom;
        const isLandscape = pageWidthMm > pageHeightMm;

        const pdf = new JsPDFClass({
          orientation: isLandscape ? 'l' : 'p',
          unit: 'mm',
          format: [pageWidthMm, pageHeightMm]
        });
        setPdfMetadata(pdf, fileName);

        const imgData = await encodeCanvas(canvas, mimeType, quality);
        job.check();
        pdf.addImage(imgData, format, margins.left, margins.top, contentWidthMm, contentHeightMm, undefined, 'FAST');
        job.stage('4 / 4 · 开始下载', 100);
        await yieldToBrowser();
        job.check();
        pdf.save(fileName);
      } else {
        // 标准 A4 多页分页
        const pdf = new JsPDFClass('p', 'mm', 'a4');
        setPdfMetadata(pdf, fileName);
        const pageWidthMm = 210;
        const pageHeightMm = 297;
        const printWidthMm = pageWidthMm - margins.left - margins.right;
        const printHeightMm = pageHeightMm - margins.top - margins.bottom;

        const pageHeightPx = Math.floor((printHeightMm * canvas.width) / printWidthMm);
        const preferredBreaks = getPreferredPageBreaks(capture ? document.documentElement : targetElement, canvas.height, pageHeightPx, scale, capture ? capture.y : Number(options.cropTop || 0), clonedBoundaries);

        sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = canvas.width;
        const sliceCtx = sliceCanvas.getContext('2d');
        sliceCtx.imageSmoothingEnabled = true;
        sliceCtx.imageSmoothingQuality = 'high';

        let renderedHeightPx = 0;
        let pageCount = 0;
        let breakIndex = 0;

        while (renderedHeightPx < canvas.height) {
          const remainingPx = canvas.height - renderedHeightPx;
          const preferredEnd = preferredBreaks[breakIndex];
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

          job.stage('3 / 4 · 正在编码第 ' + (pageCount + 1) + ' 页', 65 + 30 * renderedHeightPx / canvas.height);
          await yieldToBrowser();
          job.check();
          const sliceData = await encodeCanvas(sliceCanvas, mimeType, quality);
          job.check();
          pdf.addImage(sliceData, format, margins.left, margins.top, printWidthMm, currentSliceHeightMm, undefined, 'FAST');

          renderedHeightPx += currentSlicePx;
          pageCount++;
          breakIndex++;
        }

        job.stage('4 / 4 · 开始下载', 100);
        await yieldToBrowser();
        job.check();
        pdf.save(fileName);
        sliceCanvas.width = 0;
        sliceCanvas.height = 0;
      }

      showToast(`✅ ${formatUpper} 生成成功 · ${job.elapsed()} s · 已开始下载`, 'success', 3000);
      return true;
    } catch (err) {
      if (job.cancelled || err.name === 'AbortError') {
        showToast('已取消导出，选区已保留', 'info', 3000);
        return false;
      }
      console.error('PDF 生成异常:', err);
      showToast('❌ 生成失败: ' + (err.message || '未知错误'), 'warning', 4000);
      return false;
    } finally {
      isExporting = false;
      job.close();
      if (sliceCanvas) { sliceCanvas.width = 0; sliceCanvas.height = 0; }
      scrollLock?.restore();
      scrollPlan?.restore();
      cloneFrame?.remove();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
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
    if (isExporting) { showToast('正在生成文件，请等待当前导出完成', 'info', 2500); return false; }
    if (isPicking || closeAdjuster) { showToast('已有截图选区，请在当前选区中确认导出或取消', 'info', 3000); return false; }
    const target = findSmartContentContainer();
    if (!target) {
      showToast('未识别到主体阅读区，请在页面上手动选择', 'warning', 3500);
      startElementPicker(options);
      return true;
    }

    // 视觉引导：平滑滚动主体进入视口
    const rect = target.getBoundingClientRect();
    const isInView = rect.top >= 50 && rect.bottom <= window.innerHeight - 50;
    if (!isInView) {
      try {
        target.scrollIntoView({ behavior: 'instant', block: 'start' });
      } catch (_) {}
    }

    openRegionAdjuster(target, options, 'smart');
    return true;
  }

  function openRegionAdjuster(target, options = {}, source = 'manual') {
    const scrollTarget = findScrollCaptureTarget(target);
    let fullScroll = Boolean(scrollTarget);
    if (closeAdjuster) closeAdjuster();
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const baseTop = rect.top + window.scrollY;
    const baseBottom = rect.bottom + window.scrollY;
    const baseLeft = Math.max(0, rect.left + window.scrollX);
    const baseRight = baseLeft + rect.width;
    const initialCoords = { left: baseLeft, top: baseTop, right: baseRight, bottom: baseBottom };

    const pageHeight = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight);
    const pageWidth = () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth);
    const state = { left: baseLeft, top: baseTop, right: baseRight, bottom: baseBottom, dragging: null };
    const MIN_SIZE = 1;
    let exportPending = false;
    let estimatedHeight = 0;
    if (scrollTarget) {
      let extra = 0;
      for (const element of scrollTarget.querySelectorAll('*')) {
        if (/(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY)) extra = Math.max(extra, element.scrollHeight - element.clientHeight);
      }
      estimatedHeight = Math.max(scrollTarget.scrollHeight, scrollTarget.getBoundingClientRect().height + extra);
    }

    // 遮罩与顶部引导条
    const maskOverlay = createMaskOverlay();
    const bannerPrompt = source === 'smart'
      ? '已自动识别正文主体 · 拖动手柄调整选区 · Enter 确认导出'
      : '已锁定选区 · 拖动手柄调整边界 · 拖动框体平移 · Enter 确认导出';
    const guidanceBanner = createGuidanceBanner(source === 'smart' ? '✨' : '📐', bannerPrompt, ['Enter 导出', '方向键 微调', 'Esc 取消']);

    // 选区调整框
    const adjuster = document.createElement('div');
    adjuster.id = 'wos-region-adjuster';
    adjuster.setAttribute('data-html2canvas-ignore', 'true');
    adjuster.innerHTML = `
      <div class="wos-region-move-surface" data-edge="move" title="按住拖动平移整个选区"></div>
      <div class="wos-region-frame"></div>
      <div class="wos-region-hud">
        <span class="wos-region-hud-dot"></span>
        <span class="wos-region-hud-dim">0 × 0 px</span>
        <span class="wos-region-hud-meta">${(options.outputFormat || currentOutputFormat).toUpperCase()} · ${options.resolutionScale || currentResolutionScale}×</span>
      </div>
      <button type="button" class="wos-region-handle top" data-edge="top" aria-label="拖动调整上边缘" title="拖动调整上边缘"><i></i></button>
      <button type="button" class="wos-region-handle bottom" data-edge="bottom" aria-label="拖动调整下边缘" title="拖动调整下边缘"><i></i></button>
      <button type="button" class="wos-region-handle left" data-edge="left" aria-label="拖动调整左边缘" title="拖动调整左边缘"><i></i></button>
      <button type="button" class="wos-region-handle right" data-edge="right" aria-label="拖动调整右边缘" title="拖动调整右边缘"><i></i></button>
      <button type="button" class="wos-region-handle top-left" data-edge="top-left" aria-label="拖动调整左上角" title="拖动调整左上角"></button>
      <button type="button" class="wos-region-handle top-right" data-edge="top-right" aria-label="拖动调整右上角" title="拖动调整右上角"></button>
      <button type="button" class="wos-region-handle bottom-left" data-edge="bottom-left" aria-label="拖动调整左下角" title="拖动调整左下角"></button>
      <button type="button" class="wos-region-handle bottom-right" data-edge="bottom-right" aria-label="拖动调整右下角" title="拖动调整右下角"></button>
    `;

    // 智能吸附操作面板
    const panel = document.createElement('div');
    panel.id = 'wos-region-adjuster-panel';
    panel.setAttribute('data-html2canvas-ignore', 'true');
    panel.innerHTML = `
      <div class="wos-region-size-inputs">
        <span>宽</span><input type="number" data-size="width" aria-label="选区宽度" min="1" step="1">
        <span>× 高</span><input type="number" data-size="height" aria-label="选区高度" min="1" step="1">
        <span>px</span>
      </div>
      <button type="button" data-action="reset-size" title="恢复为最初识别/选取的尺寸">↺ 原始尺寸</button>
      <div class="wos-region-divider"></div>
      <button type="button" data-action="export" title="导出此选区 (Enter)">导出文件 ↗</button>
      <button type="button" data-action="repick" title="重新在页面上选择区块">重选</button>
      <button type="button" data-action="cancel" aria-label="取消选区" title="取消并退出 (Esc)">✕</button>
    `;
    document.documentElement.append(adjuster, panel);

    if (scrollTarget) {
      const mode = document.createElement('select');
      mode.className = 'wos-region-scroll-mode';
      mode.setAttribute('aria-label', '截图范围模式');
      mode.innerHTML = '<option value="scroll">完整滚动区域（自动展开全部内容）</option><option value="page">页面矩形（手动调整大小）</option>';
      panel.querySelector('.wos-region-size-inputs').before(mode);
      mode.addEventListener('change', () => { finishDrag(); fullScroll = mode.value === 'scroll'; render(); });
    }

    const hud = adjuster.querySelector('.wos-region-hud');
    const hudDim = hud.querySelector('.wos-region-hud-dim');
    const hudMeta = hud.querySelector('.wos-region-hud-meta');
    const widthInput = panel.querySelector('[data-size="width"]');
    const heightInput = panel.querySelector('[data-size="height"]');

    const render = () => {
      if (exportPending) return;
      guidanceBanner.update(fullScroll ? '📜' : '📐', fullScroll
        ? '将导出整个滚动容器（包括标题）· 高度为估算，文件尺寸以实际展开为准'
        : '拖动边缘调整 · 拖动框体或方向键平移 · 聚焦手柄后方向键微调', ['Enter 导出', 'Esc 取消']);
      panel.querySelector('[data-action="reset-size"]').disabled = fullScroll;
      const currentWidth = state.right - state.left;
      const currentHeight = state.bottom - state.top;
      widthInput.disabled = heightInput.disabled = fullScroll;
      adjuster.querySelectorAll('.wos-region-handle, .wos-region-move-surface').forEach(el => {
        el.hidden = fullScroll;
        el.style.display = fullScroll ? 'none' : '';
      });

      let viewRect;
      if (fullScroll) {
        const bounds = scrollTarget.getBoundingClientRect();
        viewRect = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
        Object.assign(adjuster.style, {
          left: `${bounds.left}px`,
          top: `${bounds.top}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`
        });
        widthInput.value = String(Math.round(bounds.width));
        heightInput.value = String(Math.round(estimatedHeight));
        hudDim.textContent = `${Math.round(bounds.width)} × 约 ${Math.round(estimatedHeight)} px`;
        hudMeta.textContent = '完整滚动区域';
        hud.classList.toggle('flipped', bounds.top < 42);
        maskOverlay.update(bounds);
      } else {
        const top = state.top - window.scrollY;
        const left = state.left - window.scrollX;
        const width = Math.max(MIN_SIZE, currentWidth);
        const height = Math.max(MIN_SIZE, currentHeight);
        viewRect = { left, top, width, height };

        adjuster.style.left = `${left}px`;
        adjuster.style.top = `${top}px`;
        adjuster.style.width = `${width}px`;
        adjuster.style.height = `${height}px`;

        widthInput.max = String(pageWidth() - state.left);
        heightInput.max = String(pageHeight() - state.top);
        if (document.activeElement !== widthInput) widthInput.value = String(Math.round(width));
        if (document.activeElement !== heightInput) heightInput.value = String(Math.round(height));

        hudDim.textContent = `${Math.round(width)} × ${Math.round(height)} px`;
        hudMeta.textContent = `${(options.outputFormat || currentOutputFormat).toUpperCase()} · ${options.resolutionScale || currentResolutionScale}×`;
        hud.classList.toggle('flipped', top < 42);

        maskOverlay.update(viewRect);
      }

      // 智能吸附操作面板定位 (跟随选区)
      const panelWidth = panel.offsetWidth || 360;
      const panelHeight = panel.offsetHeight || 44;

      let panelTop = viewRect.top + viewRect.height + 12;
      if (panelTop + panelHeight > window.innerHeight - 12) {
        panelTop = viewRect.top - panelHeight - 12;
      }
      if (panelTop < 12) {
        panelTop = window.innerHeight - panelHeight - 16;
      }
      let panelLeft = viewRect.left + (viewRect.width - panelWidth) / 2;
      panelLeft = Math.max(12, Math.min(window.innerWidth - panelWidth - 12, panelLeft));

      panel.style.top = `${Math.max(12, Math.min(window.innerHeight - panelHeight - 12, panelTop))}px`;
      panel.style.left = `${panelLeft}px`;
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
    };

    let scrollFrame = 0;
    let pointerX = 0;
    let pointerY = 0;
    let grabOffsetX = 0;
    let grabOffsetY = 0;

    const moveEdge = () => {
      if (!state.dragging) return;
      const pointX = pointerX + window.scrollX - grabOffsetX;
      const pointY = pointerY + window.scrollY - grabOffsetY;
      const pWidth = pageWidth();
      const pHeight = pageHeight();

      if (state.dragging === 'move') {
        const w = state.right - state.left;
        const h = state.bottom - state.top;
        state.left = Math.max(0, Math.min(pointX, pWidth - w));
        state.right = state.left + w;
        state.top = Math.max(0, Math.min(pointY, pHeight - h));
        state.bottom = state.top + h;
      } else {
        if (state.dragging.includes('top')) {
          state.top = Math.max(0, Math.min(pointY, state.bottom - MIN_SIZE));
        }
        if (state.dragging.includes('bottom')) {
          state.bottom = Math.min(pHeight, Math.max(pointY, state.top + MIN_SIZE));
        }
        if (state.dragging.includes('left')) {
          state.left = Math.max(0, Math.min(pointX, state.right - MIN_SIZE));
        }
        if (state.dragging.includes('right')) {
          state.right = Math.min(pWidth, Math.max(pointX, state.left + MIN_SIZE));
        }
      }
      render();
    };

    const autoScroll = () => {
      if (!state.dragging) return;
      const deltaY = pointerY < 48 ? -16 : pointerY > window.innerHeight - 48 ? 16 : 0;
      const deltaX = pointerX < 48 ? -16 : pointerX > window.innerWidth - 48 ? 16 : 0;
      if (deltaY || deltaX) {
        window.scrollBy(deltaX, deltaY);
        moveEdge();
      }
      scrollFrame = requestAnimationFrame(autoScroll);
    };

    const onSelectionScroll = () => {
      if (state.dragging) moveEdge();
      else render();
    };

    const finishDrag = () => {
      cancelAnimationFrame(scrollFrame);
      state.dragging = null;
      document.body.classList.remove(
        'wos-region-resizing',
        'wos-moving-region',
        'wos-resizing-top', 'wos-resizing-bottom', 'wos-resizing-left', 'wos-resizing-right',
        'wos-resizing-top-left', 'wos-resizing-top-right', 'wos-resizing-bottom-left', 'wos-resizing-bottom-right'
      );
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', finishDrag, true);
      document.removeEventListener('pointercancel', finishDrag, true);
    };

    const onPointerMove = (event) => {
      if (!state.dragging) return;
      event.preventDefault();
      pointerX = event.clientX;
      pointerY = event.clientY;
      moveEdge();
    };

    const startDrag = (event) => {
      if (event.button !== 0 || fullScroll || exportPending) return;
      event.preventDefault();
      event.stopPropagation();
      const edge = event.currentTarget.dataset.edge;
      state.dragging = edge;
      pointerX = event.clientX;
      pointerY = event.clientY;

      if (edge === 'move') {
        grabOffsetX = pointerX + window.scrollX - state.left;
        grabOffsetY = pointerY + window.scrollY - state.top;
      } else {
        if (edge.includes('top')) grabOffsetY = pointerY + window.scrollY - state.top;
        else if (edge.includes('bottom')) grabOffsetY = pointerY + window.scrollY - state.bottom;
        else grabOffsetY = 0;

        if (edge.includes('left')) grabOffsetX = pointerX + window.scrollX - state.left;
        else if (edge.includes('right')) grabOffsetX = pointerX + window.scrollX - state.right;
        else grabOffsetX = 0;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      scrollFrame = requestAnimationFrame(autoScroll);
      document.body.classList.add('wos-region-resizing');
      if (edge === 'move') document.body.classList.add('wos-moving-region');
      else document.body.classList.add(`wos-resizing-${edge}`);

      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', finishDrag, true);
      document.addEventListener('pointercancel', finishDrag, true);
    };

    const close = () => {
      closeAdjuster = null;
      finishDrag();
      adjuster.remove();
      panel.remove();
      maskOverlay.remove();
      guidanceBanner.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onSelectionScroll, true);
      window.removeEventListener('resize', render, true);
      window.removeEventListener('blur', finishDrag);
    };

    const triggerExport = async () => {
      if (exportPending) return;
      if (!(fullScroll ? scrollTarget : target).isConnected) {
        showToast('原区域已被页面移除，请重选', 'warning');
        return;
      }
      if (!fullScroll) applySize();
      const captureRect = {
        x: Math.max(0, state.left),
        y: Math.max(0, state.top),
        width: Math.min(state.right - state.left, pageWidth() - state.left),
        height: Math.min(state.bottom - state.top, pageHeight() - state.top)
      };
      if (captureRect.width < 1 || captureRect.height < 1) {
        showToast('页面范围已变化，请重新选择', 'warning');
        return;
      }
      finishDrag();
      exportPending = true;
      panel.setAttribute('aria-busy', 'true');
      panel.querySelectorAll('button,input,select').forEach(el => { el.disabled = true; });
      let success = false;
      try {
        success = await exportElementToPdf(fullScroll ? scrollTarget : document.documentElement, {
          ...options, fullScroll, captureRect: fullScroll ? undefined : captureRect, cropTop: 0, cropBottom: undefined, cropWidth: undefined
        });
      } finally {
        exportPending = false;
        if (success) close();
        else {
          panel.removeAttribute('aria-busy');
          panel.querySelectorAll('button,input,select').forEach(el => { el.disabled = false; });
          render();
        }
      }
    };

    const onKeyDown = (event) => {
      if (exportPending) return;
      if (event.key === 'Escape') {
        close();
        showToast('已取消选区', 'info', 1500);
        return;
      }
      if (event.key === 'Enter' && !['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        triggerExport();
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        if (fullScroll || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        const edge = document.activeElement?.dataset?.edge;
        if (edge && edge !== 'move') {
          if (edge.includes('left')) state.left = Math.max(0, Math.min(state.right - MIN_SIZE, state.left + dx));
          if (edge.includes('right')) state.right = Math.min(pageWidth(), Math.max(state.left + MIN_SIZE, state.right + dx));
          if (edge.includes('top')) state.top = Math.max(0, Math.min(state.bottom - MIN_SIZE, state.top + dy));
          if (edge.includes('bottom')) state.bottom = Math.min(pageHeight(), Math.max(state.top + MIN_SIZE, state.bottom + dy));
        } else {
          const x = Math.max(-state.left, Math.min(dx, pageWidth() - state.right));
          const y = Math.max(-state.top, Math.min(dy, pageHeight() - state.bottom));
          state.left += x; state.right += x; state.top += y; state.bottom += y;
        }
        render();
      }
    };

    adjuster.querySelectorAll('.wos-region-handle, .wos-region-move-surface').forEach(el => el.addEventListener('pointerdown', startDrag));

    const applySize = () => {
      const w = Number(widthInput.value);
      const h = Number(heightInput.value);
      if (Number.isFinite(w) && w >= MIN_SIZE) {
        state.right = Math.min(pageWidth(), state.left + w);
      }
      if (Number.isFinite(h) && h >= MIN_SIZE) {
        state.bottom = Math.min(pageHeight(), state.top + h);
      }
      widthInput.value = String(Math.round(state.right - state.left));
      heightInput.value = String(Math.round(state.bottom - state.top));
      render();
    };
    [widthInput, heightInput].forEach(input => {
      input.addEventListener('change', applySize);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); applySize(); input.blur(); }
      });
    });

    panel.addEventListener('click', (event) => {
      if (exportPending) return;
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'export') {
        triggerExport();
      } else if (action === 'reset-size') {
        state.left = initialCoords.left;
        state.top = initialCoords.top;
        state.right = initialCoords.right;
        state.bottom = initialCoords.bottom;
        render();
      } else if (action === 'repick') {
        close();
        startElementPicker(options);
      } else if (action === 'cancel') {
        close();
        showToast('已取消选区', 'info', 1500);
      }
    });

    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onSelectionScroll, true);
    window.addEventListener('resize', render, true);
    window.addEventListener('blur', finishDrag);
    closeAdjuster = close;
    render();
  }

  function startElementPicker(options = {}) {
    if (isExporting) { showToast('正在生成文件，请等待当前导出完成', 'info', 2500); return false; }
    if (isPicking || closeAdjuster) { showToast('已有截图选区，请在当前选区中确认导出或取消', 'info', 3000); return false; }
    isPicking = true;

    const guidanceBanner = createGuidanceBanner('🎯', '移动鼠标高亮选择区块 · 点击锁定 · [↑] 扩大至父级', ['点击 锁定', '↑ 选父级', 'Esc 退出']);
    const maskOverlay = createMaskOverlay();
    const marker = createExportTargetMarker();

    const refreshMarker = () => {
      if (currentHighlightedEl?.isConnected) {
        const tagName = (currentHighlightedEl.tagName || 'DIV').toLowerCase();
        const className = currentHighlightedEl.className && typeof currentHighlightedEl.className === 'string'
          ? '.' + currentHighlightedEl.className.trim().split(/\s+/)[0].slice(0, 16) : '';
        const rect = currentHighlightedEl.getBoundingClientRect();
        const label = `<${tagName}${className}> ${Math.round(rect.width)} × ${Math.round(rect.height)} px · 点击锁定`;
        marker.update(currentHighlightedEl, label);
        maskOverlay.update(rect);
      }
    };

    function onMouseMove(e) {
      if (!isPicking) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target.closest('#wos-guidance-banner,#wos-pdf-floating-widget,#wos-mask-overlay,#wos-export-target-marker')) return;
      if (target === currentHighlightedEl) return;
      if (currentHighlightedEl) currentHighlightedEl.classList.remove('wos-element-highlighted');
      currentHighlightedEl = target;
      currentHighlightedEl.classList.add('wos-element-highlighted');
      refreshMarker();
    }

    function onClick(e) {
      if (!isPicking) return;
      if (e.target.closest('#wos-guidance-banner,#wos-pdf-floating-widget,#wos-mask-overlay')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const selected = currentHighlightedEl || document.elementFromPoint(e.clientX, e.clientY);
      stopElementPicker();
      if (selected) openRegionAdjuster(selected, options, 'picker');
    }

    function onKeyDown(e) {
      if (e.key === 'ArrowUp' && currentHighlightedEl?.parentElement && currentHighlightedEl.parentElement !== document.body && currentHighlightedEl.parentElement !== document.documentElement) {
        e.preventDefault();
        currentHighlightedEl.classList.remove('wos-element-highlighted');
        currentHighlightedEl = currentHighlightedEl.parentElement;
        currentHighlightedEl.classList.add('wos-element-highlighted');
        refreshMarker();
        const parentTag = currentHighlightedEl.tagName.toLowerCase();
        guidanceBanner.update('🎯', `已扩大至父级元素: <${parentTag}> · 点击确认锁定`, ['点击 锁定', '↑ 选父级', 'Esc 退出']);
      }
      if (e.key === 'Escape' || e.keyCode === 27) {
        stopElementPicker();
        showToast('已退出选择', 'info', 1500);
      }
    }

    function stopElementPicker() {
      isPicking = false;
      if (currentHighlightedEl) {
        currentHighlightedEl.classList.remove('wos-element-highlighted');
        currentHighlightedEl = null;
      }
      marker.remove();
      maskOverlay.remove();
      guidanceBanner.remove();
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
    return true;
  }
  // --- 悬浮操作胶囊更新 ---
  function getOutputLabel() {
    return currentOutputFormat === 'pdf' ? 'PDF' : currentOutputFormat.toUpperCase();
  }

  function updateFloatingBadge() {
    const label = document.querySelector('#wos-btn-auto-export > span');
    if (label && !isExporting) label.textContent = `智能导出 ${getOutputLabel()}`;
    const badge = document.getElementById('wos-quick-badge');
    if (badge) {
      const modeText = currentExportMode === 'a4' ? 'A4 纸' : '自适应';
      badge.textContent = `${currentResolutionScale}x · ${currentOutputFormat === 'pdf' ? modeText : getOutputLabel()}`;
      badge.disabled = currentOutputFormat !== 'pdf';
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
        <span>智能导出 ${getOutputLabel()}</span>
      </button>

      <button class="wos-widget-btn secondary" id="wos-btn-pick-export" title="点击自由选择页面任意区域导出">
        <span>手动选区</span>
      </button>

      <!-- 紧凑规格徽标 (点击可快速轮换模式) -->
      <button class="wos-badge-chip" id="wos-quick-badge" title="当前页面规格（点击切换 A4 纸张/自适应大小）">
        ${currentResolutionScale}x · ${currentExportMode === 'a4' ? 'A4 纸' : '自适应'}
      </button>

      <div class="wos-widget-divider"></div>
      <button class="wos-widget-close" id="wos-btn-minimize" title="最小化">✕</button>
    `;

    document.body.appendChild(widget);
    widget.setAttribute('data-html2canvas-ignore', 'true');
    updateFloatingBadge();

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
    toast.setAttribute('data-html2canvas-ignore', 'true');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.className = type;
    toast.innerText = message;
    document.body.appendChild(toast);
    if (duration <= 0) return;
    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, duration);
  }

  // --- 与扩展通信 ---
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (['pdf', 'png', 'jpeg'].includes(changes.wos_output_format?.newValue)) currentOutputFormat = changes.wos_output_format.newValue;
      if (['a4', 'adaptive', 'continuous'].includes(changes.wos_export_mode?.newValue)) currentExportMode = changes.wos_export_mode.newValue;
      if ([1.5, 2, 3, 4].includes(Number(changes.wos_resolution_scale?.newValue))) currentResolutionScale = Number(changes.wos_resolution_scale.newValue);
      if (typeof changes.wos_lossless_png?.newValue === 'boolean') currentLosslessPng = changes.wos_lossless_png.newValue;
      updateFloatingBadge();
    });
  }
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const launchActions = ['preview_smart','export_smart','export_middle','start_picker'];
    if (launchActions.includes(request.action) && isExporting) {
      sendResponse({ success: false, message: '文件正在生成，请等待当前导出完成' });
      return false;
    }
    if (launchActions.includes(request.action) && (isPicking || closeAdjuster)) {
      showToast('已有截图选区，已为你保留当前窗口', 'info', 2500);
      sendResponse({ success: true, reused: true, message: '已保留当前选区' });
      return false;
    }
    if (request.action === 'preview_smart' || request.action === 'export_smart' || request.action === 'export_middle') {
      sendResponse({ success: startSmartPreview(request.options) !== false });
    } else if (request.action === 'start_picker') {
      sendResponse({ success: startElementPicker(request.options) !== false });
    } else if (request.action === 'check_status') {
      const isWos = location.hostname.includes('webofscience') || location.hostname.includes('clarivate');
      sendResponse({
        isWos,
        currentMode: currentExportMode,
        currentScale: currentResolutionScale,
        losslessPng: currentLosslessPng,
        outputFormat: currentOutputFormat,
        version: CONTENT_VERSION,
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
