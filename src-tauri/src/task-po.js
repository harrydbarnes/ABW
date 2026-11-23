(() => {
  if (window !== window.top || !/(^|\.)wrike\.com$/.test(location.hostname) || window.__abwPoObserver) return;
  const style = document.createElement('style');
  style.textContent = '.abw-check-po-btn{position:fixed;z-index:1000;padding:4px 12px;border:1px solid #aab4c5;border-radius:6px;background:Canvas;color:CanvasText;font:500 13px system-ui;cursor:pointer;transition:transform 140ms ease,background-color 140ms ease,border-color 140ms ease,box-shadow 140ms ease,color 140ms ease}.abw-check-po-btn:hover{transform:translateY(-1px);background:#f3f6fc;border-color:#7d95c4;box-shadow:0 3px 10px rgba(16,29,53,.12)}.abw-check-po-btn:active{transform:translateY(0);box-shadow:none}';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'abw-check-po-btn';
  button.textContent = 'Check PO';
  let panel;
  let lastBooking = '';
  let pendingId;
  let nextCheck = 0;
  let expandedMoreFor = '';
  let lastPanelEl = null;
  let lastPanelFingerprint = '';
  let lastValues = null;
  const requiredKeys = ['client', 'product', 'po', 'start', 'end', 'total', 'plan'];
  const handoff = 'https://go.mediaocean.com/robots.txt#abw-check-po?';
  function setStatus(status) {
    const states = {
      checking: ['Checking PO…', 'CanvasText'],
      checked: ['✓ PO Checked', '#176640'],
      review: ['Review PO', '#854b16'],
      signin: ['Sign in to Prisma', '#854b16'],
      unavailable: ['Check PO', 'CanvasText'],
    };
    const [label, color] = states[status] || states.unavailable;
    if (button.textContent !== label) button.textContent = label;
    button.style.color = color;
  }
  window.__abwReceivePoStatus = (id, status) => {
    if (id !== pendingId) return;
    pendingId = undefined;
    nextCheck = Date.now() + (status === 'checked' || status === 'review' ? 300000 : 60000);
    setStatus(status);
  };
  const labels = {client:'Client Code', product:'Product Code', po:'PO Number', total:'Total PO value', plan:'Media plan budget (Total cost to client)', start:'Campaign Start Date', end:'Campaign End Date', media:'Media code', channel:'Channel-GRM-GBR-MCM-Digital Ops'};
  const actionSelector = 'button,[role="button"],[title],[aria-label],[data-test-id],[data-testid]';
  const name = el => ['aria-label','title','data-test-id','data-testid'].map(a => el.getAttribute(a) || '').concat((el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '')).join(' ');
  function sync() {
    if (document.hidden) return;
    let anchor = null;
    panel = null;
    for (const close of [...document.querySelectorAll(actionSelector)].reverse()) {
      if (!/close/i.test(name(close)) || !close.getBoundingClientRect().width) continue;
      for (let header=close.parentElement; header && header !== document.body && header.getBoundingClientRect().height < 160; header=header.parentElement) {
        if (![...header.querySelectorAll(actionSelector)].some(el => /permalink|copy.{0,12}link|share/i.test(name(el)))) continue;
        panel=header;
        while (panel.parentElement && panel.getBoundingClientRect().height < 300) panel=panel.parentElement;
        anchor=close;
        break;
      }
      if (anchor) break;
    }
    if (!anchor) {button.remove(); lastBooking = ''; pendingId = undefined; expandedMoreFor = ''; lastPanelEl = null; lastPanelFingerprint = ''; lastValues = null; return;}
    const r = anchor.getBoundingClientRect();
    button.style.zIndex = '2147483647';
    button.style.top = (r.bottom + 8) + 'px';
    button.style.right = Math.max(8, innerWidth-r.right) + 'px';
    const host = anchor.closest('dialog:modal') || document.body;
    if (button.parentElement !== host) host.append(button);
    queueCheck();
  }
  function bookingValues() {
    const fingerprint = panel ? `${panel.childElementCount}:${panel.textContent || ''}` : '';
    if (panel === lastPanelEl && fingerprint === lastPanelFingerprint && lastValues) {
      return new URLSearchParams(lastValues);
    }
    const lines = panel.innerText.split(/\n/).map(line => line.trim()).filter(Boolean);
    const values = new URLSearchParams();
    for (const [key, label] of Object.entries(labels)) {
      const i = lines.findIndex(line => line.replace(/[\s*:]+$/, '').toLowerCase() === label.toLowerCase());
      if (i >= 0 && lines[i + 1]) values.set(key, lines[i + 1].slice(0, 100));
    }
    lastPanelEl = panel;
    lastPanelFingerprint = fingerprint;
    lastValues = new URLSearchParams(values);
    return values;
  }
  function hasRequiredValues(values) {
    return requiredKeys.every(key => values.get(key));
  }
  function expandMoreIfNeeded(values) {
    if (!panel || hasRequiredValues(values)) return false;
    const taskKey = location.href + ' ' + (panel.innerText.split(/\n/)[0] || '').trim();
    if (expandedMoreFor === taskKey) return false;
    const moreBtn = [...panel.querySelectorAll('button,[role="button"]')].find(el => {
      const text = (el.textContent || '').trim();
      return /^more$/i.test(text) && el.getAttribute('aria-expanded') !== 'true' && el.getBoundingClientRect().width > 0;
    });
    if (!moreBtn) return false;
    expandedMoreFor = taskKey;
    moreBtn.click();
    setTimeout(schedule, 250);
    return true;
  }
  function queueCheck() {
    const values = bookingValues();
    const booking = location.href + ' ' + values.toString();
    if (booking !== lastBooking) {
      lastBooking = booking;
      pendingId = undefined;
      nextCheck = Date.now() + 750;
      setStatus('unavailable');
      setTimeout(schedule, 750);
    }
    if (pendingId || Date.now() < nextCheck) return;
    if (!hasRequiredValues(values)) {
      expandMoreIfNeeded(values);
      return;
    }
    pendingId = crypto.randomUUID();
    values.set('automatic', pendingId);
    setStatus('checking');
    location.assign(handoff + values);
  }
  button.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    if (!panel) return;
    const values = bookingValues();
    if (!hasRequiredValues(values) && expandMoreIfNeeded(values)) {
      setTimeout(() => {
        if (panel) location.assign(handoff + bookingValues());
      }, 250);
      return;
    }
    location.assign(handoff + values);
  };
  let scheduleTimer = 0;
  let rafId = 0;
  function schedule() {
    if (scheduleTimer || rafId) return;
    scheduleTimer = setTimeout(() => {
      scheduleTimer = 0;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        sync();
      });
    }, 120);
  }
  function start() {
    if (!style.isConnected) (document.head || document.documentElement)?.append(style);
    window.__abwPoObserver.observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('resize', schedule, { passive: true });
    addEventListener('hashchange', schedule);
    schedule();
    setInterval(() => { if (!document.hidden && panel) schedule(); }, 15000);
  }
  window.__abwPoObserver = new MutationObserver(schedule);
  if (document.documentElement) start(); else addEventListener('DOMContentLoaded', start, { once: true });
})();
