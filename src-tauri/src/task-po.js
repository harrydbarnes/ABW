(() => {
  if (window !== window.top || !/(^|\.)wrike\.com$/.test(location.hostname) || window.__abwPoObserver) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Check PO';
  button.style.cssText = 'position:fixed;z-index:1000;padding:4px 12px;border:1px solid #aab4c5;border-radius:6px;background:Canvas;color:CanvasText;font:500 13px system-ui;cursor:pointer';
  let panel;
  const labels = {client:'Client Code', product:'Product Code', po:'PO Number', total:'Total PO value', plan:'Media plan budget (Total cost to client)', start:'Campaign Start Date', end:'Campaign End Date', media:'Media code', channel:'Channel-GRM-GGB-MC'};
  const actionSelector = 'button,[role="button"],[title],[aria-label],[data-test-id],[data-testid]';
  const name = el => ['aria-label','title','data-test-id','data-testid'].map(a => el.getAttribute(a) || '').join(' ');
  function sync() {
    let anchor = null;
    panel = null;
    if (/(?:[?&#](?:id|taskId|itemId|panel)=\d+|\/(?:tasks?|items?)\/\d+)/i.test(location.href) || document.querySelector('[data-test-id*="task-view"],[data-testid*="task-view"],task-view,work-item-view')) {
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
    }
    if (!anchor) {button.remove(); return;}
    const r = anchor.getBoundingClientRect();
    button.style.top = (r.bottom + 8) + 'px';
    button.style.right = Math.max(8, innerWidth-r.right) + 'px';
    if (!button.isConnected) document.body.append(button);
  }
  button.onclick = () => {
    if (!panel) return;
    const lines = panel.innerText.split(/\n/).map(s => s.trim()).filter(Boolean);
    const values = new URLSearchParams();
    for (const [key,label] of Object.entries(labels)) {
      const i = lines.findIndex(s => s.replace(/[\s*:]+$/,'').toLowerCase() === label.toLowerCase());
      if (i >= 0 && lines[i+1]) values.set(key,lines[i+1].slice(0,100));
    }
    location.href = 'abw-po://check?' + values;
  };
  let scheduled = false;
  function schedule() {
    if (!scheduled) {scheduled=true; requestAnimationFrame(() => {scheduled=false; sync();});}
  }
  function start() {
    window.__abwPoObserver.observe(document.documentElement,{childList:true,subtree:true});
    addEventListener('resize',schedule); addEventListener('scroll',schedule,true); addEventListener('hashchange',schedule);
    schedule();
  }
  window.__abwPoObserver=new MutationObserver(schedule);
  if (document.documentElement) start(); else addEventListener('DOMContentLoaded',start,{once:true});
})();
