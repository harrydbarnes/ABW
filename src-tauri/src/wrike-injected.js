(() => {
  try {
    __ABW_TASK_PO__
  } catch {}
  window.__abwSpellCleanup?.();
  let enabled = __ABW_SPELL_CHECK_ENABLED__;
  const abwAutoDownload = __ABW_AUTO_DOWNLOAD__;
  const abwIsWrikeHost = () => {
    const host = String(window.location?.hostname || "").toLowerCase();
    return host === "wrike.com" || host.endsWith(".wrike.com");
  };
  let abwSpellApplyTimer = 0;
  let abwThemeDetectTimer = 0;
  const abwWrikeThemeCatalog = [
    { id: "default", rgb: [16, 29, 62], patterns: [/\bdark[\s_-]*blue\b/i] },
    { id: "midnight", rgb: [22, 33, 54], patterns: [/\bmidnight\b/i] },
    { id: "aquamarine", rgb: [0, 57, 64], patterns: [/\baquamarine\b/i] },
    { id: "blueberry-pie", rgb: [25, 48, 100], patterns: [/\bblueberry(?:[\s_-]*pie)?\b/i] },
    { id: "blue-steel", rgb: [40, 54, 82], patterns: [/\bblue[\s_-]*steel\b/i] },
    { id: "imperial-purple", rgb: [52, 37, 113], patterns: [/\bimperial[\s_-]*purple\b/i] },
    { id: "velvet-cosmos", rgb: [63, 13, 79], patterns: [/\bvelvet[\s_-]*cosmos\b/i] },
    { id: "cool-confetti", rgb: [63, 13, 79], patterns: [/\bcool[\s_-]*confetti\b/i] },
    { id: "merlot", rgb: [68, 2, 36], patterns: [/\bmerlot\b/i] },
    { id: "halloween", rgb: [68, 2, 36], patterns: [/\bhalloween\b/i] },
    { id: "pumpkin-spice", rgb: [121, 0, 0], patterns: [/\bpumpkin[\s_-]*spice\b/i] },
    { id: "woodland-grass", rgb: [3, 38, 0], patterns: [/\bwoodland[\s_-]*grass\b/i] },
    { id: "blue-skies", rgb: [215, 234, 255], patterns: [/\bblue[\s_-]*skies\b/i] },
    { id: "flamingo", rgb: [255, 223, 247], patterns: [/\bflamingo\b/i] },
    { id: "cappuccino", rgb: [237, 231, 229], patterns: [/\bcappuccino\b/i] },
    { id: "winter-white", rgb: [232, 232, 232], patterns: [/\bwinter[\s_-]*white\b/i] },
    { id: "monochrome", rgb: [232, 232, 232], patterns: [/\bmonochrome\b/i] },
    { id: "winter-holiday", rgb: [255, 254, 255], patterns: [/\bwinter[\s_-]*holiday\b/i] },
    { id: "legendary-leopard", rgb: [40, 54, 82], patterns: [/\blegendary[\s_-]*leopard\b/i] }
  ];
  const abwParseCssColor = (value) => {
    const text = String(value || "").trim();
    if (!text || text === "transparent" || text === "none") return null;
    const rgbMatch = text.match(
      /rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([0-9.]+%?))?\s*\)/i
    );
    if (rgbMatch) {
      let alpha = 1;
      if (rgbMatch[4] !== undefined) {
        alpha = rgbMatch[4].endsWith("%")
          ? parseFloat(rgbMatch[4]) / 100
          : parseFloat(rgbMatch[4]);
      }
      if (!(alpha >= 0.82)) return null;
      return {
        r: Number(rgbMatch[1]),
        g: Number(rgbMatch[2]),
        b: Number(rgbMatch[3]),
        a: alpha
      };
    }
    const hexMatch = text.match(/#([0-9a-f]{3,8})\b/i);
    if (hexMatch) {
      const raw = hexMatch[1];
      if (raw.length === 3) {
        return {
          r: parseInt(raw[0] + raw[0], 16),
          g: parseInt(raw[1] + raw[1], 16),
          b: parseInt(raw[2] + raw[2], 16),
          a: 1
        };
      }
      if (raw.length === 6 || raw.length === 8) {
        const alpha = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
        if (!(alpha >= 0.82)) return null;
        return {
          r: parseInt(raw.slice(0, 2), 16),
          g: parseInt(raw.slice(2, 4), 16),
          b: parseInt(raw.slice(4, 6), 16),
          a: alpha
        };
      }
    }
    return null;
  };
  const abwExtractCssColors = (value) => {
    const text = String(value || "");
    if (!text || text === "none" || text === "transparent") return [];
    const tokens =
      text.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}\b/gi) || [text];
    return tokens.map(abwParseCssColor).filter(Boolean);
  };
  const abwMatchWrikeThemeText = (value) => {
    const text = String(value || "");
    if (!text) return null;
    for (const entry of abwWrikeThemeCatalog) {
      if (entry.patterns.some((pattern) => pattern.test(text))) {
        return entry.id;
      }
    }
    return null;
  };
  const abwMatchWrikeThemeColor = (rgb, allowPureWhite = true) => {
    if (!rgb) return null;
    if (!allowPureWhite && rgb.r >= 253 && rgb.g >= 253 && rgb.b >= 253) {
      return null;
    }
    let bestId = null;
    let bestDistance = Infinity;
    for (const entry of abwWrikeThemeCatalog) {
      const dr = rgb.r - entry.rgb[0];
      const dg = rgb.g - entry.rgb[1];
      const db = rgb.b - entry.rgb[2];
      const distance = Math.hypot(dr, dg, db);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = entry.id;
      }
    }
    return bestDistance <= 42 ? bestId : null;
  };
  const abwElementIdentityText = (element) => {
    if (!(element instanceof Element)) return "";
    const parts = [element.className, element.id];
    if (element.attributes) {
      for (let index = 0; index < element.attributes.length; index += 1) {
        const attr = element.attributes[index];
        if (attr && /theme|skin|palette|appearance|background/i.test(attr.name)) {
          parts.push(`${attr.name}=${attr.value}`);
        }
      }
    }
    return parts.filter(Boolean).join(" ");
  };
  const abwDetectWrikeThemeFromDom = () => {
    if (!document.body) return null;
    for (const root of [document.documentElement, document.body]) {
      const directMatch = abwMatchWrikeThemeText(abwElementIdentityText(root));
      if (directMatch) return directMatch;
    }
    const samplePoints = [
      [14, 96],
      [18, 160],
      [24, 240],
      [28, 340],
      [18, 440],
      [72, 120]
    ];
    const candidates = [];
    const seen = new Set();
    const addCandidate = (element) => {
      if (!(element instanceof Element) || seen.has(element)) return;
      seen.add(element);
      candidates.push(element);
    };
    for (const [x, y] of samplePoints) {
      const stack =
        document.elementsFromPoint?.(x, y) ||
        [document.elementFromPoint?.(x, y)].filter(Boolean);
      for (const node of stack) {
        for (
          let current = node;
          current && current instanceof Element;
          current = current.parentElement
        ) {
          addCandidate(current);
        }
      }
    }
    document
      .querySelectorAll(
        'aside, nav, [role="navigation"], [class*="sidebar" i], [class*="navigation" i], [class*="left-panel" i], [class*="workspace" i], [data-theme]'
      )
      .forEach(addCandidate);
    addCandidate(document.body);
    addCandidate(document.documentElement);

    const sidebarCandidates = [];
    const layoutCandidates = [];
    for (const element of candidates) {
      if (element.closest?.('[role="dialog"], [aria-modal="true"]')) {
        continue;
      }
      const byText = abwMatchWrikeThemeText(abwElementIdentityText(element));
      if (byText) return byText;
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.width < 28 || rect.height < 110 || rect.left > 32) {
        continue;
      }
      if (rect.width <= 380) {
        sidebarCandidates.push(element);
      } else {
        layoutCandidates.push(element);
      }
    }

    const matchFromElements = (elements, allowPureWhite) => {
      for (const element of elements) {
        const style = window.getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const colors = [
          ...abwExtractCssColors(style.backgroundColor),
          ...abwExtractCssColors(style.backgroundImage)
        ];
        for (const color of colors) {
          const matched = abwMatchWrikeThemeColor(color, allowPureWhite);
          if (matched) return matched;
        }
      }
      return null;
    };

    return (
      matchFromElements(sidebarCandidates, true) ||
      matchFromElements(layoutCandidates, false)
    );
  };
  let abwCornerObservedContent = null;
  let abwCornerObservedSidebar = null;
  let abwCornerLastSidebarColor = "";
  let abwCornerResizeObserver = null;
  let abwCornerRafId = 0;
  const abwObserveCornerTargets = (contentEl, sidebarEl) => {
    if (typeof ResizeObserver !== "function") return;
    if (contentEl === abwCornerObservedContent && sidebarEl === abwCornerObservedSidebar) {
      return;
    }
    abwCornerObservedContent = contentEl;
    abwCornerObservedSidebar = sidebarEl;
    if (!abwCornerResizeObserver) {
      abwCornerResizeObserver = new ResizeObserver(() => {
        abwSyncWrikeContentCorner(true);
      });
    } else {
      abwCornerResizeObserver.disconnect();
    }
    if (contentEl instanceof Element) {
      abwCornerResizeObserver.observe(contentEl);
    }
    if (sidebarEl instanceof Element && sidebarEl !== contentEl) {
      abwCornerResizeObserver.observe(sidebarEl);
    }
  };
  const abwScheduleCornerSync = () => {
    if (abwAutoDownload || !abwIsWrikeHost() || document.hidden || abwCornerRafId) return;
    abwCornerRafId = window.requestAnimationFrame(() => {
      abwCornerRafId = 0;
      abwSyncWrikeContentCorner(true);
    });
  };
  const abwSyncWrikeContentCorner = (fast = false) => {
    if (abwAutoDownload || !abwIsWrikeHost() || document.hidden || !document.body) return;
    const cornerId = "abw-wrike-corner";
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    if (viewportHeight < 200 || viewportWidth < 300) return;

    if (fast && abwCornerObservedContent?.isConnected && abwCornerLastSidebarColor) {
      const existingCorner = document.getElementById(cornerId);
      const rect = abwCornerObservedContent.getBoundingClientRect?.();
      if (
        existingCorner &&
        existingCorner.firstElementChild &&
        rect &&
        rect.left >= 44 &&
        rect.left <= Math.min(440, viewportWidth * 0.48) &&
        rect.top >= -4 &&
        rect.top <= 96 &&
        rect.width >= Math.min(260, viewportWidth * 0.28) &&
        rect.height >= viewportHeight * 0.55
      ) {
        const nextLeft = `${Math.floor(rect.left) - 1}px`;
        const nextTop = `${Math.floor(Math.max(0, rect.top)) - 1}px`;
        if (existingCorner.style.left !== nextLeft) existingCorner.style.left = nextLeft;
        if (existingCorner.style.top !== nextTop) existingCorner.style.top = nextTop;
        return;
      }
    }

    const parseRgb = (color) => {
      const match = String(color || "").match(
        /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)/i
      );
      if (!match) return null;
      let alpha = 1;
      if (match[4] !== undefined) {
        alpha = match[4].endsWith("%") ? parseFloat(match[4]) / 100 : Number(match[4]);
      }
      if (!(alpha > 0.05)) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };

    const resolveBackgroundColor = (element) => {
      for (let node = element; node && node instanceof Element; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const bg = style.backgroundColor || "";
        if (parseRgb(bg)) {
          return bg;
        }
        const extracted = abwExtractCssColors(style.backgroundImage);
        if (extracted.length > 0) {
          const { r, g, b } = extracted[0];
          return `rgb(${r}, ${g}, ${b})`;
        }
      }
      return "";
    };

    const isLightContentColor = (color) => {
      const rgb = parseRgb(color);
      return Boolean(rgb && rgb[0] >= 220 && rgb[1] >= 220 && rgb[2] >= 220);
    };

    const isNearWhite = (color) => {
      const rgb = parseRgb(color);
      return Boolean(rgb && rgb[0] >= 235 && rgb[1] >= 235 && rgb[2] >= 235);
    };

    let cornerLeft = null;
    let cornerTop = 0;
    let matchedContentEl = null;
    let matchedSidebarEl = null;

    // 1. Primary: find the main light content container directly across multiple horizontal/vertical probes.
    const probeXs = [0.6, 0.45, 0.35]
      .map((ratio) => Math.round(viewportWidth * ratio))
      .filter((x) => x > 48 && x < viewportWidth - 20);
    const minContentWidth = Math.min(260, viewportWidth * 0.28);
    for (const contentProbeX of probeXs) {
      for (const py of [24, 48, 80, 140]) {
        const stack =
          document.elementsFromPoint?.(contentProbeX, py) ||
          [document.elementFromPoint?.(contentProbeX, py)].filter(Boolean);
        for (const node of stack) {
          if (!(node instanceof Element) || node.id === cornerId) continue;
          if (node === document.body || node === document.documentElement) continue;
          if (node.closest?.('[role="dialog"], [aria-modal="true"]')) continue;
          const rect = node.getBoundingClientRect?.();
          if (
            !rect ||
            rect.left < 44 ||
            rect.left > Math.min(440, viewportWidth * 0.48) ||
            rect.top < 0 ||
            rect.top > 96 ||
            rect.width < minContentWidth ||
            rect.height < viewportHeight * 0.55
          ) {
            continue;
          }
          const style = window.getComputedStyle(node);
          if (style.visibility === "hidden" || style.display === "none") continue;
          if (isLightContentColor(style.backgroundColor)) {
            cornerLeft = rect.left;
            cornerTop = Math.max(0, rect.top);
            matchedContentEl = node;
            break;
          }
        }
        if (cornerLeft !== null) break;
      }
      if (cornerLeft !== null) break;
    }

    // 2. Fallback: find the left sidebar column and use its right edge.
    let sidebarColor = "";
    let sidebarRight = null;
    for (const [px, py] of [[18, 24], [18, 140], [18, Math.round(viewportHeight * 0.45)], [56, 140]]) {
      const stack =
        document.elementsFromPoint?.(px, py) ||
        [document.elementFromPoint?.(px, py)].filter(Boolean);
      for (const node of stack) {
        for (
          let current = node;
          current && current instanceof Element && current !== document.body && current !== document.documentElement;
          current = current.parentElement
        ) {
          if (current.id === cornerId || current.closest?.('[role="dialog"], [aria-modal="true"]')) {
            continue;
          }
          const rect = current.getBoundingClientRect?.();
          if (
            !rect ||
            rect.left > 16 ||
            rect.top > 60 ||
            rect.width < 44 ||
            rect.width > Math.min(440, viewportWidth * 0.48) ||
            rect.height < viewportHeight * 0.55
          ) {
            continue;
          }
          const style = window.getComputedStyle(current);
          if (style.visibility === "hidden" || style.display === "none") continue;
          const bg = resolveBackgroundColor(current);
          if (!bg || isNearWhite(bg)) continue;
          sidebarColor = bg;
          matchedSidebarEl = current;
          sidebarRight = rect.right;
          if (cornerLeft === null) {
            cornerLeft = rect.right;
            cornerTop = Math.max(0, rect.top);
          }
          break;
        }
        if (sidebarColor) break;
      }
      if (sidebarColor) break;
    }

    // If we only found the sidebar edge (e.g., outer content container is transparent),
    // refine cornerTop by checking the content container just to the right of sidebarRight.
    if (matchedContentEl === null && sidebarRight !== null && sidebarRight < viewportWidth - 60) {
      const adjacentX = Math.min(viewportWidth - 20, Math.round(sidebarRight + 24));
      for (const py of [24, 48, 80]) {
        const stack =
          document.elementsFromPoint?.(adjacentX, py) ||
          [document.elementFromPoint?.(adjacentX, py)].filter(Boolean);
        for (const node of stack) {
          if (!(node instanceof Element) || node.id === cornerId) continue;
          if (node === document.body || node === document.documentElement) continue;
          if (node.closest?.('[role="dialog"], [aria-modal="true"]')) continue;
          const rect = node.getBoundingClientRect?.();
          if (
            !rect ||
            Math.abs(rect.left - sidebarRight) > 8 ||
            rect.top < 0 ||
            rect.top > 96 ||
            rect.width < minContentWidth ||
            rect.height < viewportHeight * 0.55
          ) {
            continue;
          }
          const style = window.getComputedStyle(node);
          if (style.visibility === "hidden" || style.display === "none") continue;
          cornerLeft = rect.left;
          cornerTop = Math.max(0, rect.top);
          matchedContentEl = node;
          break;
        }
        if (matchedContentEl) break;
      }
    }

    if (!sidebarColor) {
      for (const [px, py] of [[4, 4], [16, 16]]) {
        const topLeftNode = document.elementFromPoint?.(px, py);
        if (topLeftNode instanceof Element) {
          const bg = resolveBackgroundColor(topLeftNode);
          if (bg && !isNearWhite(bg)) {
            sidebarColor = bg;
            break;
          }
        }
      }
    }

    if (!sidebarColor && window.__abwLastDetectedWrikeTheme) {
      const themeEntry = abwWrikeThemeCatalog.find(
        (entry) => entry.id === window.__abwLastDetectedWrikeTheme
      );
      if (themeEntry) {
        sidebarColor = `rgb(${themeEntry.rgb[0]}, ${themeEntry.rgb[1]}, ${themeEntry.rgb[2]})`;
      }
    }

    abwObserveCornerTargets(matchedContentEl, matchedSidebarEl);

    const existing = document.getElementById(cornerId);
    if (cornerLeft === null || !sidebarColor || cornerLeft <= 0 || cornerLeft >= viewportWidth - 60) {
      existing?.remove();
      return;
    }

    const corner = existing || document.createElement("div");
    if (!existing) {
      corner.id = cornerId;
      corner.setAttribute("aria-hidden", "true");
      Object.assign(corner.style, {
        position: "fixed",
        width: "13px",
        height: "13px",
        pointerEvents: "none",
        zIndex: "2147483646",
        lineHeight: "0"
      });
    }
    if (!corner.firstElementChild) {
      const svgNs = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNs, "svg");
      svg.setAttribute("width", "13");
      svg.setAttribute("height", "13");
      svg.setAttribute("viewBox", "-1 -1 13 13");
      svg.setAttribute("fill", "none");
      const path = document.createElementNS(svgNs, "path");
      path.setAttribute("d", "M-1 -1H12V0A12 12 0 0 0 0 12H-1Z");
      path.setAttribute("fill", "currentColor");
      svg.append(path);
      corner.append(svg);
    }
    if (!corner.isConnected) {
      document.body.append(corner);
    }
    abwCornerLastSidebarColor = sidebarColor;
    const nextLeft = `${Math.floor(cornerLeft) - 1}px`;
    const nextTop = `${Math.floor(cornerTop) - 1}px`;
    if (corner.style.left !== nextLeft) corner.style.left = nextLeft;
    if (corner.style.top !== nextTop) corner.style.top = nextTop;
    if (corner.style.color !== sidebarColor) corner.style.color = sidebarColor;
  };
  const abwSchemeQueue = [];
  let abwSchemeDrainTimer = 0;
  let abwSchemeLoadHooked = false;
  const abwEmitScheme = (url) => {
    if (!url || !abwIsWrikeHost()) return;
    abwSchemeQueue.push(url);
    if (document.readyState && document.readyState !== "complete") {
      if (!abwSchemeLoadHooked) {
        abwSchemeLoadHooked = true;
        window.addEventListener(
          "load",
          () => {
            abwSchemeLoadHooked = false;
            if (!abwSchemeDrainTimer && abwSchemeQueue.length) {
              abwSchemeDrainTimer = window.setTimeout(drainSchemeQueue, 120);
            }
          },
          { once: true }
        );
      }
      return;
    }
    if (abwSchemeDrainTimer) return;
    abwSchemeDrainTimer = window.setTimeout(drainSchemeQueue, 25);
  };
  const drainSchemeQueue = () => {
    if (document.readyState && document.readyState !== "complete") {
      abwSchemeDrainTimer = 0;
      return;
    }
    const next = abwSchemeQueue.shift();
    if (!next) {
      abwSchemeDrainTimer = 0;
      return;
    }
    window.location.href = next;
    abwSchemeDrainTimer = window.setTimeout(drainSchemeQueue, 75);
  };
  const abwDetectWrikeInboxUnread = () => {
    if (abwAutoDownload || !document.body) return false;
    if (/\binbox\s*\(\s*\d+\+?\s*\)/i.test(document.title || "")) {
      return true;
    }
    const scanRoot = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const raw = (node.textContent || "").trim();
        if (!/^inbox$/i.test(raw)) continue;
        const parent = node.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect?.();
        if (!rect || rect.width === 0 || rect.height === 0 || rect.left > 420) continue;

        let row = parent;
        for (let depth = 0; depth < 6 && row.parentElement; depth += 1) {
          const next = row.parentElement;
          const nextRect = next.getBoundingClientRect?.();
          if (!nextRect || nextRect.height > 76 || nextRect.width > 440 || nextRect.left > 420) {
            break;
          }
          row = next;
          const rowText = (row.textContent || "").replace(/\s+/g, " ").trim();
          const match = rowText.match(/(?:inbox\s*|\b)(\d+)\+?(?:\s|$)/i);
          if (match && Number.parseInt(match[1], 10) > 0) {
            return true;
          }
        }
      }
      return false;
    };
    const sidebarRoots = document.querySelectorAll('nav, aside, [class*="sidebar" i], [class*="navigation" i]');
    if (sidebarRoots.length) {
      for (const root of sidebarRoots) {
        const rect = root.getBoundingClientRect?.();
        if (rect && rect.width > 0 && rect.left < 420 && scanRoot(root)) {
          return true;
        }
      }
      return false;
    }
    return scanRoot(document.body);
  };
  const abwDetectActiveTaskTitle = () => {
    if (abwAutoDownload || !document.body) return "";
    const selectors = [
      '[data-testid="task-title"]',
      '[data-testid*="task-title" i]',
      '[data-testid*="item-title" i]',
      'wrike-task-title',
      '[data-application="task-view"] textarea',
      '[data-application="task-view"] [contenteditable="true"]',
      '.task-view-header textarea',
      '.task-view-header [contenteditable="true"]',
      'textarea.title-field',
      '[class*="title-field" i] textarea',
      '[class*="title-field" i] [contenteditable="true"]',
      '[class*="task-title" i] textarea',
      '[class*="task-title" i] [contenteditable="true"]',
      '[class*="item-title" i] textarea',
      '[class*="item-title" i] [contenteditable="true"]',
      '[contenteditable="true"][aria-label*="title" i]',
      '[role="dialog"] textarea',
      '[role="dialog"] [contenteditable="true"]',
      '[role="dialog"] h1',
      '[role="dialog"] h2'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      const raw = (typeof el.value === "string" ? el.value : el.textContent || "").replace(/\s+/g, " ").trim();
      if (raw && raw.length >= 2 && raw.length <= 240 && !/^inbox\b/i.test(raw)) {
        return raw;
      }
    }
    return "";
  };
  let abwLastFullReportAt = 0;
  const abwReportWrikeTheme = (force = false) => {
    if (abwAutoDownload || !abwIsWrikeHost() || (!force && document.hidden)) return null;
    abwSyncWrikeContentCorner();
    if (document.readyState && document.readyState !== "complete") {
      window.addEventListener(
        "load",
        () => abwReportWrikeTheme(true),
        { once: true }
      );
      return null;
    }
    const now = Date.now();
    if (!force && now - abwLastFullReportAt < 350) {
      return window.__abwLastDetectedWrikeTheme || null;
    }
    abwLastFullReportAt = now;
    const activeTaskTitle = abwDetectActiveTaskTitle();
    if (window.__abwLastActiveTaskTitle !== activeTaskTitle) {
      const wasUnset = typeof window.__abwLastActiveTaskTitle === "undefined";
      window.__abwLastActiveTaskTitle = activeTaskTitle;
      if (!wasUnset || activeTaskTitle) {
        abwEmitScheme(`abw-task://active?title=${encodeURIComponent(activeTaskTitle)}`);
      }
    }
    const hasUnread = abwDetectWrikeInboxUnread();
    if (window.__abwLastInboxUnread !== hasUnread) {
      const wasUnset = typeof window.__abwLastInboxUnread === "undefined";
      window.__abwLastInboxUnread = hasUnread;
      if (!wasUnset || hasUnread) {
        abwEmitScheme(`abw-inbox://unread?hasUnread=${hasUnread ? "true" : "false"}`);
      }
    }
    const detected = abwDetectWrikeThemeFromDom();
    if (!detected) return null;
    if (!force && window.__abwLastDetectedWrikeTheme === detected) {
      return detected;
    }
    window.__abwLastDetectedWrikeTheme = detected;
    abwEmitScheme(`abw-theme://detected?theme=${encodeURIComponent(detected)}`);
    return detected;
  };
  const abwScheduleThemeDetect = (delay = 250) => {
    if (abwAutoDownload || !abwIsWrikeHost() || document.hidden || abwThemeDetectTimer) return;
    abwThemeDetectTimer = window.setTimeout(() => {
      abwThemeDetectTimer = 0;
      abwReportWrikeTheme(false);
    }, delay);
  };
  window.__abwDetectWrikeTheme = (force = false) => abwReportWrikeTheme(Boolean(force));
  const abwEditableSelector = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]';
  const abwPendingSpellNodes = new Set();
  const applySpellCheckToNode = (root) => {
    if (!root) return;
    if (root instanceof Element && root.matches?.(abwEditableSelector)) {
      if (root.spellcheck !== enabled) root.spellcheck = enabled;
    }
    root.querySelectorAll?.(abwEditableSelector).forEach((element) => {
      if (element.spellcheck !== enabled) element.spellcheck = enabled;
    });
  };
  const apply = () => {
    applySpellCheckToNode(document);
    abwScheduleThemeDetect(450);
  };
  window.__abwSetSpellCheck = (nextEnabled) => {
    enabled = Boolean(nextEnabled);
    abwPendingSpellNodes.clear();
    apply();
  };
  const scheduleApply = (mutations) => {
    if (Array.isArray(mutations)) {
      for (const mutation of mutations) {
        if (!mutation.addedNodes) continue;
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            abwPendingSpellNodes.add(node);
          }
        }
      }
    }
    if (!abwPendingSpellNodes.size || abwSpellApplyTimer) return;
    abwSpellApplyTimer = window.setTimeout(() => {
      abwSpellApplyTimer = 0;
      const pending = Array.from(abwPendingSpellNodes);
      abwPendingSpellNodes.clear();
      for (const node of pending) {
        if (node.isConnected) {
          applySpellCheckToNode(node);
        }
      }
      abwScheduleThemeDetect(450);
    }, 150);
  };
  const findEditable = (element) => {
    const active = document.activeElement;
    for (let current = element; current; current = current.parentElement) {
      if (
        current instanceof HTMLTextAreaElement ||
        current instanceof HTMLInputElement ||
        current.isContentEditable ||
        current.getAttribute('role') === 'textbox'
      ) {
        return current;
      }
    }
    if (
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement ||
      active?.isContentEditable ||
      active?.getAttribute?.('role') === 'textbox'
    ) {
      return active;
    }
    return null;
  };
  const selectionIsActive = () => {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
  };
  const selectedWord = () => {
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString() : "";
    return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/u) || [])[0] || "";
  };
  const wordFromText = (text, offset) => {
    if (!text) return "";
    let start = Math.max(0, Math.min(offset, text.length));
    let end = start;
    while (start > 0 && /[\p{L}\p{N}'-]/u.test(text[start - 1])) start -= 1;
    while (end < text.length && /[\p{L}\p{N}'-]/u.test(text[end])) end += 1;
    return text.slice(start, end);
  };
  const nearestTextWord = (root, event) => {
    if (!root) return "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let best = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent || "";
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      range.detach?.();
      const rect = rects.find((candidate) =>
        event.clientX >= candidate.left - 6 &&
        event.clientX <= candidate.right + 6 &&
        event.clientY >= candidate.top - 6 &&
        event.clientY <= candidate.bottom + 6
      );
      if (!rect) continue;
      const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
      best = wordFromText(text, Math.round(Math.max(0, Math.min(1, ratio)) * text.length));
      if (best) break;
    }
    return best;
  };
  const wordFromPoint = (event, editable) => {
    const selected = selectedWord();
    if (selected) return selected;
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      return wordFromText(editable.value || "", editable.selectionStart || 0);
    }
    const range =
      document.caretRangeFromPoint?.(event.clientX, event.clientY) ||
      (() => {
        const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
        if (!position) return null;
        const next = document.createRange();
        next.setStart(position.offsetNode, position.offset);
        return next;
      })();
    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) {
      return nearestTextWord(editable || event.target, event);
    }
    const text = range.startContainer.textContent || "";
    return wordFromText(text, range.startOffset) || nearestTextWord(editable || event.target, event);
  };
  const closeDictionaryMenu = () => {
    document.getElementById("abw-dictionary-menu")?.remove();
    document.getElementById("abw-link-menu")?.remove();
  };
  const abwResolveLinkUrl = (target) => {
    if (!(target instanceof Element)) return null;
    const currentAcc = (() => {
      try {
        return new URLSearchParams(window.location.search).get("acc") || "";
      } catch {
        return "";
      }
    })();
    const toTaskUrl = (rawId) => {
      if (!rawId || rawId === currentAcc) return null;
      return `${window.location.origin}/open.htm?id=${rawId}`;
    };
    const extractIdFromValue = (val) => {
      if (typeof val === "number" && Number.isInteger(val)) {
        const s = String(val);
        return s.length >= 7 && s.length <= 12 && s !== currentAcc ? s : null;
      }
      if (typeof val === "string") {
        const match = val.match(/(?:^|\D)(\d{7,12})(?:\D|$)/);
        if (match && match[1] !== currentAcc) return match[1];
      }
      return null;
    };
    const extractIdFromObject = (obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 2) return null;
      const directKeys = ["taskId", "itemId", "entityId", "workItemId", "recordId", "rowId", "id"];
      for (const k of directKeys) {
        if (k in obj) {
          const found = extractIdFromValue(obj[k]);
          if (found) return found;
        }
      }
      const nestedKeys = ["task", "item", "entity", "record", "row", "data", "node", "model"];
      for (const k of nestedKeys) {
        if (obj[k] && typeof obj[k] === "object") {
          const found = extractIdFromObject(obj[k], depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    const resolveRawUrl = (raw) => {
      if (!raw || raw.startsWith("javascript:") || raw === "#") return null;
      try {
        const resolved = new URL(raw, window.location.href);
        if (resolved.protocol === "https:" || resolved.protocol === "http:") {
          return resolved.href;
        }
      } catch {}
      return null;
    };
    const link = target.closest("a[href], [data-href], [data-url]");
    if (link) {
      const resolved = resolveRawUrl(
        link.getAttribute("href") ||
        link.getAttribute("data-href") ||
        link.getAttribute("data-url") ||
        ""
      );
      if (resolved) return resolved;
    }
    for (let current = target, depth = 0; current && current instanceof Element && depth < 14; current = current.parentElement, depth += 1) {
      if (current === document.body || current === document.documentElement) break;
      const nestedLink = current.querySelector?.("a[href]");
      if (nestedLink) {
        const rect = current.getBoundingClientRect?.();
        if (rect && rect.height <= 160) {
          const resolved = resolveRawUrl(nestedLink.getAttribute("href") || "");
          if (resolved) return resolved;
        }
      }
      if (current.attributes) {
        for (let i = 0; i < current.attributes.length; i += 1) {
          const attr = current.attributes[i];
          if (!attr) continue;
          const val = (attr.value || "").trim();
          if (!val) continue;
          const urlMatch = val.match(/https?:\/\/[^\s"'<>]+wrike\.com\/(?:open|workspace)\.htm[^\s"'<>]*/i);
          if (urlMatch) return urlMatch[0];
          if (/(?:id|task|item|entity|row|key)/i.test(attr.name)) {
            const id = extractIdFromValue(val);
            if (id) return toTaskUrl(id);
          }
        }
      }
      try {
        const ownKeys = Object.keys(current);
        for (let i = 0; i < ownKeys.length; i += 1) {
          const key = ownKeys[i];
          if (key.startsWith("__reactProps$") || key.startsWith("__reactFiber$")) {
            const props = current[key];
            const found = extractIdFromObject(props) || extractIdFromObject(props?.memoizedProps);
            if (found) return toTaskUrl(found);
          } else if (key === "__ngContext__" && Array.isArray(current[key])) {
            const ctx = current[key];
            for (let j = 0; j < Math.min(ctx.length, 32); j += 1) {
              const entry = ctx[j];
              if (entry && typeof entry === "object" && !(entry instanceof Node)) {
                const found = extractIdFromObject(entry, 1);
                if (found) return toTaskUrl(found);
              }
            }
          } else if (/^(?:taskId|itemId|entityId|recordId|rowId)$/i.test(key)) {
            const found = extractIdFromValue(current[key]);
            if (found) return toTaskUrl(found);
          }
        }
      } catch {}
    }
    return null;
  };
  const abwIsDarkSurface = () => {
    try {
      const bg = window.getComputedStyle(document.body || document.documentElement).backgroundColor;
      const parsed = abwParseCssColor(bg);
      if (parsed) {
        const luma = 0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b;
        return luma < 128;
      }
    } catch {}
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches || false;
  };
  const abwMenuPalette = () =>
    abwIsDarkSurface()
      ? {
          bg: "#1e2430",
          border: "#343e52",
          text: "#e6ecf7",
          hover: "#2a3344",
          sep: "#313b4f",
          shadow: "0 12px 32px rgba(0, 0, 0, .45)",
        }
      : {
          bg: "#fff",
          border: "#d6dce8",
          text: "#17233a",
          hover: "#f1f5fb",
          sep: "#e5ebf4",
          shadow: "0 12px 32px rgba(17, 29, 59, .18)",
        };
  const abwBuildMenuContainer = (id, event, widthGuess = 210, heightGuess = 210) => {
    const palette = abwMenuPalette();
    const menu = document.createElement("div");
    menu.id = id;
    menu.setAttribute("role", "menu");
    Object.assign(menu.style, {
      position: "fixed",
      left: `${Math.min(window.innerWidth - widthGuess, Math.max(8, event.clientX))}px`,
      top: `${Math.min(window.innerHeight - heightGuess, Math.max(8, event.clientY))}px`,
      zIndex: "2147483647",
      minWidth: "196px",
      padding: "6px",
      border: `1px solid ${palette.border}`,
      borderRadius: "8px",
      background: palette.bg,
      color: palette.text,
      boxShadow: palette.shadow,
      font: "13px Segoe UI, sans-serif",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
    });
    const addMenuItem = (label, onClick, disabled = false) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.disabled = disabled;
      Object.assign(btn.style, {
        textAlign: "left",
        padding: "7px 10px",
        border: "0",
        borderRadius: "6px",
        background: "transparent",
        color: palette.text,
        opacity: disabled ? "0.45" : "1",
        font: "13px Segoe UI, sans-serif",
        cursor: disabled ? "default" : "pointer",
      });
      if (!disabled) {
        btn.addEventListener("mouseenter", () => { btn.style.background = palette.hover; });
        btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; });
        btn.addEventListener("mousedown", (e) => e.preventDefault());
        btn.addEventListener("click", () => {
          closeDictionaryMenu();
          onClick();
        });
      }
      menu.append(btn);
    };
    const addSeparator = () => {
      const sep = document.createElement("div");
      Object.assign(sep.style, { height: "1px", background: palette.sep, margin: "4px 6px" });
      menu.append(sep);
    };
    return { menu, addMenuItem, addSeparator };
  };
  const showLinkContextMenu = (url, event) => {
    closeDictionaryMenu();
    const shareTarget = url || window.location.href;
    const { menu, addMenuItem, addSeparator } = abwBuildMenuContainer("abw-link-menu", event, 210, 210);
    if (url) {
      addMenuItem("Open in new tab", () => {
        abwEmitScheme(`abw-new-tab://open?url=${encodeURIComponent(url)}`);
      });
      addMenuItem("Copy link", () => {
        navigator.clipboard?.writeText(url).catch(() => undefined);
      });
      addSeparator();
    } else {
      addMenuItem("Back", () => window.history.back());
      addMenuItem("Refresh", () => window.location.reload());
      addSeparator();
      addMenuItem("Open current page in new tab", () => {
        abwEmitScheme(`abw-new-tab://open?url=${encodeURIComponent(window.location.href)}`);
      });
      addMenuItem("Copy link", () => {
        navigator.clipboard?.writeText(window.location.href).catch(() => undefined);
      });
      addSeparator();
    }
    addMenuItem("Share", () => {
      abwEmitScheme(`abw-share://open?url=${encodeURIComponent(shareTarget)}`);
    });
    document.body.append(menu);
    window.setTimeout(() => {
      document.addEventListener("click", closeDictionaryMenu, { once: true, capture: true });
      window.addEventListener("blur", closeDictionaryMenu, { once: true });
    }, 0);
  };
  const showDictionaryMenu = (word, event, editable) => {
    closeDictionaryMenu();
    const { menu, addMenuItem, addSeparator } = abwBuildMenuContainer("abw-dictionary-menu", event, 224, 190);
    const hasSelection = selectionIsActive();
    if (word) {
      addMenuItem(`Add "${word}" to dictionary`, () => {
        abwEmitScheme(`abw-dictionary://add?word=${encodeURIComponent(word)}`);
      });
      addSeparator();
    }
    addMenuItem("Cut", () => {
      editable?.focus?.();
      document.execCommand?.("cut");
    }, !hasSelection);
    addMenuItem("Copy", () => {
      const sel = window.getSelection()?.toString() || "";
      if (sel && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(sel).catch(() => document.execCommand?.("copy"));
      } else {
        document.execCommand?.("copy");
      }
    }, !hasSelection);
    addMenuItem("Paste", () => {
      editable?.focus?.();
      if (navigator.clipboard?.readText) {
        navigator.clipboard.readText().then((text) => {
          if (!text) return;
          if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
            const startPos = editable.selectionStart ?? editable.value.length;
            const endPos = editable.selectionEnd ?? editable.value.length;
            editable.setRangeText(text, startPos, endPos, "end");
            editable.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            document.execCommand?.("insertText", false, text);
          }
        }).catch(() => document.execCommand?.("paste"));
      } else {
        document.execCommand?.("paste");
      }
    });
    document.body.append(menu);
    window.setTimeout(() => {
      document.addEventListener("click", closeDictionaryMenu, { once: true, capture: true });
      window.addEventListener("blur", closeDictionaryMenu, { once: true });
    }, 0);
  };
  const keepWrikeEditorToolsVisible = (event) => {
    const editable = findEditable(event.target);
    if (!editable) {
      closeDictionaryMenu();
      return;
    }
    const word = wordFromPoint(event, editable);
    if (word || selectionIsActive()) {
      event.preventDefault();
      showDictionaryMenu(word, event, editable);
    }
  };
  const handleLinkContextMenu = (event) => {
    if (
      window.__abwCustomContextMenuEnabled === false ||
      event.defaultPrevented ||
      findEditable(event.target)
    ) {
      return;
    }
    const linkUrl = abwResolveLinkUrl(event.target);
    event.preventDefault();
    showLinkContextMenu(linkUrl, event);
  };
  const abwSupportedFileName = /[^\r\n]{1,180}[.](pdf|docx|doc|xlsx|xlsm|xlsb|xls|ods|csv|tsv|rtf|txt|png|jpeg|jpg|gif|webp|bmp|svg)(?![a-z0-9])/i;
  const abwImageFileName = /[.](png|jpg|jpeg|gif|webp|bmp|svg)$/i;
  const abwShouldUseNativeImageViewer = (fileName) =>
    window.__abwUseNativeWrikeImageViewer !== false && abwImageFileName.test(String(fileName || "").trim());
  const abwDownloadWord = /download/i;
  const abwIsVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const abwControlLabel = (element) =>
    [
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("title"),
      element?.getAttribute?.("data-tooltip"),
      element?.getAttribute?.("data-testid"),
      element?.textContent
    ].filter(Boolean).join(" ").trim();
  const abwLooksLikeDownloadUrl = (value) => {
    let text = String(value || "");
    try { text = decodeURIComponent(text); } catch {}
    return /download|attachment|filename|disposition/i.test(text) || abwSupportedFileName.test(text);
  };
  const abwFindSupportedFileName = (element) => {
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      if (current.matches?.('wrike-attachments-common-list, [data-application="common-attachments-list"]')) {
        break;
      }
      const text = (current.textContent || "").trim();
      if (text.length > 240) continue;
      const match = text.match(abwSupportedFileName);
      if (match) return match[0].trim();
    }
    return "";
  };
  const abwNormalizeFileName = (value) =>
    String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const abwProofingViewerSelector =
    'wrike-proofing-app, proofing-viewer, [data-application="proofing-dialog-content"]';
  const abwDismissPreviewOverlay = (root) => {
    if (!(root instanceof Element)) return;
    const closeBtn = root.querySelector('button[data-application="proofing-header-close"]');
    if (closeBtn && abwIsVisible(closeBtn)) {
      closeBtn.click();
    }
  };
  let abwPreviewDownloadTimer = 0;
  let abwPreviewDownloadRequest = 0;
  let abwExpectingDownloadUntil = 0;
  let abwPreviewLoadingTimer = 0;
  const abwHidePreviewLoading = () => {
    window.clearTimeout(abwPreviewLoadingTimer);
    abwPreviewLoadingTimer = 0;
    const existing = document.getElementById("abw-preview-loading-overlay");
    if (existing) existing.remove();
  };
  window.__abwHidePreviewLoading = abwHidePreviewLoading;
  const abwShowPreviewLoading = (fileName = "") => {
    if (!document.body || abwAutoDownload) return;
    if (!document.getElementById("abw-preview-loading-style")) {
      const style = document.createElement("style");
      style.id = "abw-preview-loading-style";
      style.textContent = `
        @keyframes abw-preview-spin { to { transform: rotate(360deg); } }
        #abw-preview-loading-overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(15, 23, 42, 0.36);
          backdrop-filter: blur(2px);
          animation: abw-preview-fade 140ms ease forwards;
        }
        @keyframes abw-preview-fade { from { opacity: 0; } to { opacity: 1; } }
        .abw-preview-loading-toast {
          display: flex;
          align-items: center;
          gap: 12px;
          max-width: min(420px, calc(100vw - 48px));
          padding: 13px 18px;
          border-radius: 10px;
          background: #ffffff;
          color: #13223c;
          border: 1px solid #d8e1ef;
          box-shadow: 0 14px 36px rgba(15, 23, 42, 0.22);
          font: 600 13.5px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .abw-preview-loading-spinner {
          width: 18px;
          height: 18px;
          flex: none;
          box-sizing: border-box;
          border: 2.5px solid #d9e2f1;
          border-top-color: #315de8;
          border-radius: 50%;
          animation: abw-preview-spin 700ms linear infinite;
        }
        .abw-preview-loading-meta {
          min-width: 0;
        }
        .abw-preview-loading-name {
          font-size: 12px;
          font-weight: 500;
          color: #596981;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      `;
      (document.head || document.documentElement).append(style);
    }
    abwHidePreviewLoading();
    const overlay = document.createElement("div");
    overlay.id = "abw-preview-loading-overlay";
    const toast = document.createElement("div");
    toast.className = "abw-preview-loading-toast";
    const spinner = document.createElement("span");
    spinner.className = "abw-preview-loading-spinner";
    const meta = document.createElement("div");
    meta.className = "abw-preview-loading-meta";
    const title = document.createElement("div");
    title.textContent = "File Preview Loading…";
    meta.append(title);
    if (fileName) {
      const sub = document.createElement("div");
      sub.className = "abw-preview-loading-name";
      sub.textContent = fileName;
      meta.append(sub);
    }
    toast.append(spinner, meta);
    overlay.append(toast);
    document.body.append(overlay);
    abwPreviewLoadingTimer = window.setTimeout(abwHidePreviewLoading, 6000);
  };
  if (!window.__abwPreviewLoadingListeners) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) abwHidePreviewLoading();
    });
    window.addEventListener("pagehide", abwHidePreviewLoading);
    window.__abwPreviewLoadingListeners = true;
  }
  const abwCancelQueuedPreviewDownload = () => {
    window.clearInterval(abwPreviewDownloadTimer);
    abwPreviewDownloadRequest += 1;
    abwHidePreviewLoading();
  };
  const abwQueuePreviewDownload = (fileName = "") => {
    window.clearInterval(abwPreviewDownloadTimer);
    abwShowPreviewLoading(fileName);
    const request = ++abwPreviewDownloadRequest;
    const expectedFileName = abwNormalizeFileName(fileName);
    const previousDialogs = new Map(
      Array.from(document.querySelectorAll(abwProofingViewerSelector))
        .filter(abwIsVisible)
        .map((root) => [root, abwNormalizeFileName(root.textContent)])
    );
    let attempts = 0;
    abwPreviewDownloadTimer = window.setInterval(() => {
      if (request !== abwPreviewDownloadRequest) {
        window.clearInterval(abwPreviewDownloadTimer);
        return;
      }
      attempts += 1;
      const roots = Array.from(document.querySelectorAll(abwProofingViewerSelector))
        .filter(abwIsVisible)
        .reverse();
      if (abwAutoDownload) roots.push(document);
      for (const root of roots) {
        const rootText = abwNormalizeFileName(root.textContent);
        const matchesExpectedFile = expectedFileName && rootText.includes(expectedFileName);
        const isNewOrChangedDialog =
          !previousDialogs.has(root) || previousDialogs.get(root) !== rootText;
        if (expectedFileName && !matchesExpectedFile && !isNewOrChangedDialog) {
          continue;
        }
        const download = Array.from(root.querySelectorAll('button, a, [role="button"], [role="link"]'))
          .find((control) => {
            if (!abwIsVisible(control)) {
              return false;
            }
            return (
              abwDownloadWord.test(abwControlLabel(control)) ||
              control.hasAttribute("download") ||
              abwLooksLikeDownloadUrl(control.getAttribute("href"))
            );
          });
        if (download) {
          window.clearInterval(abwPreviewDownloadTimer);
          abwExpectingDownloadUntil = Date.now() + 5000;
          if (root !== document && typeof abwEmitScheme === "function") {
            abwEmitScheme("abw-preview-intent://mark");
          }
          download.click();
          if (root !== document) {
            window.setTimeout(() => abwDismissPreviewOverlay(root), 150);
          }
          return;
        }
      }
      if (attempts >= 120) {
        window.clearInterval(abwPreviewDownloadTimer);
        abwHidePreviewLoading();
      }
    }, 50);
  };
  const abwFindAttachmentDownloadControl = (attachmentItem) => {
    if (!(attachmentItem instanceof Element)) return null;
    const isUsable = (el) =>
      el instanceof Element &&
      !el.disabled &&
      el.getAttribute("aria-disabled") !== "true" &&
      abwIsVisible(el);
    const direct =
      attachmentItem.querySelector(
        'button[data-application="attachment-list-item-download"], a[data-application="attachment-list-item-download"]'
      ) ||
      attachmentItem
        .querySelector('[data-application="attachment-list-item-download"]')
        ?.querySelector('button, a, [role="button"], [role="link"]');
    if (isUsable(direct)) return direct;
    const inlineFallback = Array.from(
      attachmentItem.querySelectorAll('button, a, [role="button"], [role="link"]')
    ).find(
      (control) =>
        isUsable(control) &&
        (abwDownloadWord.test(abwControlLabel(control)) ||
          control.hasAttribute("download") ||
          abwLooksLikeDownloadUrl(control.getAttribute("href")))
    );
    if (inlineFallback) return inlineFallback;
    const listRoot = attachmentItem.closest(
      'wrike-attachments-common-list, [data-application="common-attachments-list"]'
    );
    if (listRoot) {
      const checkedSelector =
        'input[type="checkbox"]:checked, wrike-checkbox-v2[aria-checked="true"], [role="checkbox"][aria-checked="true"]';
      const itemChecked = Boolean(attachmentItem.querySelector(checkedSelector));
      const allChecked = listRoot.querySelectorAll(checkedSelector);
      if (itemChecked && allChecked.length === 1) {
        const bulkDownload = Array.from(
          listRoot.querySelectorAll('button, a, [role="button"], [role="link"]')
        ).find(
          (control) =>
            !control.closest('wrike-attachments-list-item, wrike-attachments-list-item-wrapper') &&
            isUsable(control) &&
            (abwDownloadWord.test(abwControlLabel(control)) ||
              control.hasAttribute("download") ||
              abwLooksLikeDownloadUrl(control.getAttribute("href")))
        );
        if (bulkDownload) return bulkDownload;
      }
    }
    return null;
  };
  const abwKeepDownloadsInWebview = (event) => {
    abwScheduleThemeDetect(220);
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-application="file-list-expander"], wrike-checkbox-v2, input[type="checkbox"]')) {
      abwCancelQueuedPreviewDownload();
      return;
    }
    const attachmentItem = target.closest('wrike-attachments-list-item, wrike-attachments-list-item-wrapper');
    if (attachmentItem && !target.closest('[data-application="attachment-list-item-download"]')) {
      const rawName = (attachmentItem.querySelector('wrike-attachments-filename')?.textContent || "").trim();
      const matchedName = rawName.match(abwSupportedFileName)?.[0]?.trim() || abwFindSupportedFileName(attachmentItem);
      if (matchedName) {
        if (abwShouldUseNativeImageViewer(matchedName)) {
          abwCancelQueuedPreviewDownload();
          return;
        }
        const inlineDownload = abwFindAttachmentDownloadControl(attachmentItem);
        if (inlineDownload) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          abwCancelQueuedPreviewDownload();
          abwShowPreviewLoading(matchedName);
          abwExpectingDownloadUntil = Date.now() + 5000;
          if (typeof abwEmitScheme === "function") {
            abwEmitScheme("abw-preview-intent://mark");
          }
          inlineDownload.click();
        } else {
          abwQueuePreviewDownload(matchedName);
        }
      } else {
        abwCancelQueuedPreviewDownload();
      }
      return;
    }
    const control = target.closest('a, button, [role="button"], [role="link"]');
    if (!control) return;
    const label = abwControlLabel(control);
    const link = control.closest('a') || control.querySelector('a');
    if (abwDownloadWord.test(label) || abwLooksLikeDownloadUrl(link?.href)) {
      abwExpectingDownloadUntil = Date.now() + 5000;
      if (link) {
        link.removeAttribute("target");
        link.setAttribute("download", "");
      }
      return;
    }
    if (target.closest(abwProofingViewerSelector)) {
      abwCancelQueuedPreviewDownload();
      return;
    }
    const fileName = abwFindSupportedFileName(target) || abwFindSupportedFileName(control);
    if (fileName && !abwShouldUseNativeImageViewer(fileName)) {
      abwQueuePreviewDownload(fileName);
    } else {
      abwCancelQueuedPreviewDownload();
    }
  };
  const abwPatchWindowOpen = () => {
    if (window.__abwNativeOpen) return;
    window.__abwNativeOpen = window.open.bind(window);
    window.open = (url, target, features) => {
      if (Date.now() < abwExpectingDownloadUntil || abwLooksLikeDownloadUrl(url)) {
        abwExpectingDownloadUntil = 0;
        const link = document.createElement("a");
        link.href = String(url);
        link.download = "";
        link.style.display = "none";
        document.body.append(link);
        link.click();
        link.remove();
        return null;
      }
      return window.__abwNativeOpen(url, target, features);
    };
  };
  const abwSendShortcut = (action, index = null) => {
    const query = index !== null ? `&index=${index}` : "";
    const url = `abw-shortcut://trigger?action=${encodeURIComponent(action)}${query}`;
    if (typeof abwEmitScheme === "function") {
      abwEmitScheme(url);
    } else {
      window.location.href = url;
    }
  };
  const abwHandleKeyboardShortcuts = (event) => {
    if (event.isComposing || event.metaKey || event.altKey || !event.ctrlKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "t" && !event.shiftKey) {
      event.preventDefault();
      abwSendShortcut("new-tab");
    } else if (key === "w" && !event.shiftKey) {
      event.preventDefault();
      abwSendShortcut("close-tab");
    } else if (event.key === "Tab") {
      event.preventDefault();
      abwSendShortcut(event.shiftKey ? "prev-tab" : "next-tab");
    } else if (event.key === "\\" && !event.shiftKey) {
      event.preventDefault();
      abwSendShortcut("toggle-split");
    } else if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      abwSendShortcut("select-tab", Number(event.key));
    }
  };
  const start = () => {
    apply();
    let observer = null;
    if (document.body) {
      observer = new MutationObserver(scheduleApply);
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
    const themeObserver = new MutationObserver(() => abwScheduleThemeDetect(200));
    const themeObserverOptions = {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"]
    };
    if (document.documentElement) {
      themeObserver.observe(document.documentElement, themeObserverOptions);
    }
    themeObserver.observe(document.body, themeObserverOptions);
    window.__abwSpellCleanup = () => {
      window.clearTimeout(abwSpellApplyTimer);
      abwSpellApplyTimer = 0;
      abwPendingSpellNodes.clear();
      window.clearTimeout(abwThemeDetectTimer);
      window.clearTimeout(abwSchemeDrainTimer);
      abwSchemeDrainTimer = 0;
      if (abwCornerRafId) {
        window.cancelAnimationFrame(abwCornerRafId);
        abwCornerRafId = 0;
      }
      observer?.disconnect();
      themeObserver.disconnect();
      abwCornerResizeObserver?.disconnect();
    };
    if (!window.__abwContextMenuGuard) {
      document.addEventListener('contextmenu', keepWrikeEditorToolsVisible, true);
      document.addEventListener('contextmenu', handleLinkContextMenu, false);
      document.addEventListener('mousedown', (event) => {
        if (event.button === 1 && abwResolveLinkUrl(event.target)) {
          event.preventDefault();
        }
      }, true);
      document.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        const linkUrl = abwResolveLinkUrl(event.target);
        if (!linkUrl) return;
        event.preventDefault();
        event.stopPropagation();
        abwEmitScheme(`abw-new-tab://open?url=${encodeURIComponent(linkUrl)}`);
      }, true);
      document.addEventListener('click', (event) => {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        const linkUrl = abwResolveLinkUrl(event.target);
        if (!linkUrl) return;
        event.preventDefault();
        event.stopPropagation();
        abwEmitScheme(`abw-new-tab://open?url=${encodeURIComponent(linkUrl)}`);
      }, true);
      window.__abwContextMenuGuard = true;
    }
    if (!window.__abwDownloadBridge) {
      document.addEventListener("click", abwKeepDownloadsInWebview, true);
      abwPatchWindowOpen();
      window.__abwDownloadBridge = true;
    }
    if (!window.__abwShortcutBridge) {
      document.addEventListener("keydown", abwHandleKeyboardShortcuts, true);
      window.__abwShortcutBridge = true;
    }
    const handleResizeCornerSync = () => {
      abwScheduleCornerSync();
      abwScheduleThemeDetect(120);
    };
    let abwCornerDragActive = false;
    const handlePointerDownCornerSync = (event) => {
      abwCornerDragActive = event.button === 0 && event.clientX <= 460;
    };
    const handlePointerMoveCornerSync = (event) => {
      if (abwCornerDragActive && (event.buttons & 1)) {
        abwScheduleCornerSync();
      }
    };
    const handlePointerUpCornerSync = () => {
      abwCornerDragActive = false;
    };
    const handleTransitionEndCornerSync = () => {
      abwScheduleCornerSync();
    };
    window.addEventListener("load", () => abwScheduleThemeDetect(120), { once: true });
    window.addEventListener("resize", handleResizeCornerSync);
    document.addEventListener("pointerdown", handlePointerDownCornerSync, { passive: true, capture: true });
    document.addEventListener("pointermove", handlePointerMoveCornerSync, { passive: true, capture: true });
    document.addEventListener("pointerup", handlePointerUpCornerSync, { passive: true, capture: true });
    document.addEventListener("pointercancel", handlePointerUpCornerSync, { passive: true, capture: true });
    document.addEventListener("transitionend", handleTransitionEndCornerSync, true);
    const inboxPollTimer = window.setInterval(() => {
      if (!document.hidden) abwScheduleThemeDetect(80);
    }, 8000);
    const handleWindowBlur = () => {
      closeDictionaryMenu();
      const active = document.activeElement;
      if (active && findEditable(active)) {
        return;
      }
      if (active instanceof Element && active.closest('[role="dialog"], dialog')) {
        return;
      }
      const hasOpenMenu = Boolean(
        document.querySelector('[role="menu"], [role="listbox"], [class*="context-menu" i], [class*="dropdown-menu" i]')
      );
      if (!hasOpenMenu) {
        return;
      }
      const target = active || document.body || document;
      try {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      } catch {}
    };
    window.addEventListener("blur", handleWindowBlur);
    const isLikelyOpenInterstitialPage = () =>
      /open(?:\.htm|-in-app)/i.test(window.location.pathname) ||
      /opening a link in wrike/i.test(document.title || "");
    const isWrikeOpenInterstitial = () =>
      isLikelyOpenInterstitialPage() ||
      /opening a link in wrike app/i.test(document.body?.innerText || "");
    let openHtmHandled = false;
    const clickBrowserLink = () => {
      if (openHtmHandled || !isWrikeOpenInterstitial()) return false;
      const candidates = Array.from(document.querySelectorAll('a[href], button, [role="link"]'));
      const browserLink = candidates.find((el) => {
        const href = (el.getAttribute?.("href") || "").toLowerCase();
        const text = (el.textContent || "").trim().toLowerCase();
        if (text.includes("download wrike app") || text.includes("apps & integrations")) return false;
        return (
          text.includes("open this link in your browser") ||
          text.includes("in your browser") ||
          href.includes("workspace.htm") ||
          href.includes("forceweb") ||
          href.includes("openinbrowser")
        );
      });
      if (browserLink) {
        openHtmHandled = true;
        const rawHref = (browserLink.getAttribute?.("href") || "").trim();
        if (rawHref && !rawHref.startsWith("javascript:") && rawHref !== "#") {
          try {
            const resolved = new URL(rawHref, window.location.href);
            if (resolved.protocol === "https:" || resolved.protocol === "http:") {
              window.location.replace(resolved.href);
              return true;
            }
          } catch {}
        }
        browserLink.click();
        return true;
      }
      return false;
    };
    let openHtmObserver = null;
    let openHtmTimer = 0;
    let openHtmStopTimer = 0;
    if (isLikelyOpenInterstitialPage() && !clickBrowserLink()) {
      openHtmObserver = new MutationObserver(() => {
        if (clickBrowserLink()) {
          openHtmObserver?.disconnect();
          openHtmObserver = null;
          window.clearInterval(openHtmTimer);
          openHtmTimer = 0;
        }
      });
      openHtmObserver.observe(document.documentElement, { childList: true, subtree: true });
      openHtmTimer = window.setInterval(() => {
        if (clickBrowserLink()) {
          window.clearInterval(openHtmTimer);
          openHtmTimer = 0;
          openHtmObserver?.disconnect();
          openHtmObserver = null;
        }
      }, 100);
      openHtmStopTimer = window.setTimeout(() => {
        window.clearInterval(openHtmTimer);
        openHtmTimer = 0;
        openHtmObserver?.disconnect();
        openHtmObserver = null;
      }, 6000);
    }
    const earlyCornerTimer = window.setTimeout(abwScheduleCornerSync, 900);
    const prevCleanup = window.__abwSpellCleanup;
    window.__abwSpellCleanup = () => {
      window.clearInterval(inboxPollTimer);
      window.clearTimeout(earlyCornerTimer);
      window.clearInterval(openHtmTimer);
      window.clearTimeout(openHtmStopTimer);
      openHtmObserver?.disconnect();
      openHtmObserver = null;
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("resize", handleResizeCornerSync);
      document.removeEventListener("pointerdown", handlePointerDownCornerSync, true);
      document.removeEventListener("pointermove", handlePointerMoveCornerSync, true);
      document.removeEventListener("pointerup", handlePointerUpCornerSync, true);
      document.removeEventListener("pointercancel", handlePointerUpCornerSync, true);
      document.removeEventListener("transitionend", handleTransitionEndCornerSync, true);
      prevCleanup?.();
    };
    abwScheduleCornerSync();
    abwScheduleThemeDetect(350);
    if (abwAutoDownload) {
      window.setTimeout(() => {
        const pageIdentity = `${document.title} ${window.location.href}`;
        if (abwLooksLikeDownloadUrl(pageIdentity) || abwSupportedFileName.test(pageIdentity)) {
          const match = pageIdentity.match(abwSupportedFileName);
          abwQueuePreviewDownload(match?.[0] || "");
        }
      }, 400);
    }
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
