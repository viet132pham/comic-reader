// Runs in every frame but stays dormant unless its direct parent is the reader page.
(() => {
  const OWN = 'chrome-extension://' + chrome.runtime.id;
  if (location.ancestorOrigins?.[0] !== OWN) return;

  const send = msg => parent.postMessage({ src: 'comic-frame', ...msg }, OWN);

  // Tell hook.js (page world) it is inside the reader, and pass on what it reports.
  document.documentElement?.setAttribute('data-comic-reader', '');
  let popupTried = 0;
  document.addEventListener('comic-reader-open', e => {
    popupTried = Date.now();
    send({ type: 'popup', url: absolute(e.detail) });
  });

  // Popunder scripts (Adcash and friends) swallow a link click: they cancel it, window.open()
  // the link in a new tab and send this one to an ad. The sandbox kills the new tab, so the
  // click would go nowhere. If a same-site link click tried a popup (or was target=_blank) and
  // nothing navigated within a second, follow the link ourselves.
  addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    if (!a || picking) return;
    const blank = /^_blank$/i.test(a.target);
    if (blank) send({ type: 'popup', url: a.href });
    let to;
    try { to = new URL(a.href); } catch { return; }
    if (to.hostname !== location.hostname || !/^https?:$/.test(to.protocol)) return;
    if (to.href.split('#')[0] === location.href.split('#')[0]) return; // in-page anchor
    const at = Date.now(), from = location.href;
    setTimeout(() => {
      if (location.href !== from) return; // the site navigated (or routed) on its own
      if (blank || popupTried >= at) location.href = to.href;
    }, 1000);
  }, true);
  function absolute(u) { try { return new URL(u, location.href).href; } catch { return ''; } }
  let cfg = { auto: false, speed: 12, dead: 0.25, css: '' };
  let v = 0, acc = 0, raf = 0, stuck = 0, scroller = null, style = null;
  let picking = false, box = null, pickStyle = null, target = null;

  addEventListener('message', e => {
    // Origin, not e.source: in the PiP window the reader's code still runs in its tab, so
    // messages come from that tab's window, not from our parent. Only our pages have OWN.
    if (e.origin !== OWN || e.data?.src !== 'comic-reader') return;
    if (e.data.type === 'config') apply(e.data);
    if (e.data.type === 'pick') e.data.on ? startPick() : stopPick();
    if (e.data.type === 'rest') setV(0);
  });

  function apply(c) {
    cfg = c;
    if (!c.auto) setV(0);
    style ??= document.createElement('style');
    style.textContent = c.css;
    if (style.isConnected) return;
    const attach = () => document.documentElement.append(style);
    document.documentElement ? attach() : document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  // ---- auto-scroll ----

  function setV(nv) {
    if (nv === v) return;
    v = nv;
    send({ type: 'speed', v });
    if (v && !raf) raf = requestAnimationFrame(tick);
  }

  function tick() {
    raf = 0;
    if (!v || !cfg.auto) return;
    if (!scroller?.isConnected) scroller = pickScroller();
    acc += v * cfg.speed; // scrollTop rounds, so carry the fraction to keep slow speeds moving
    const step = Math.trunc(acc);
    acc -= step;
    if (step) {
      const before = scroller.scrollTop;
      scroller.scrollBy({ top: step, behavior: 'instant' });
      // At the end, or the page now scrolls another element: re-pick about once a second.
      if (scroller.scrollTop === before && ++stuck % 60 === 0) scroller = pickScroller();
    }
    raf = requestAnimationFrame(tick);
  }

  // The page itself, unless the site scrolls an inner box instead.
  // ponytail: one full DOM scan per pick; cache harder if huge pages lag.
  function pickScroller() {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 1) return root;
    let best = root, area = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
      const a = el.clientWidth * el.clientHeight;
      if (a > area) { area = a; best = el; }
    }
    return best;
  }

  addEventListener('mousemove', e => {
    if (picking) return track(e);
    if (cfg.auto) setV(Math.round(scrollSpeed(e.clientY / innerHeight, cfg.dead, 1) * 100) / 100);
  }, { passive: true });

  // ---- element picker ----

  function startPick() {
    if (picking) return;
    picking = true;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
      'outline:2px solid #f2c14e;background:rgba(242,193,78,.25)';
    // Nested ad iframes swallow mouse events; let them fall through so we can see them.
    pickStyle = document.createElement('style');
    pickStyle.textContent = 'iframe{pointer-events:none!important}';
    document.documentElement.append(box, pickStyle);
  }

  function stopPick() {
    picking = false;
    box?.remove();
    pickStyle?.remove();
    target = null;
  }

  function track(e) {
    const { clientX: x, clientY: y } = e;
    target = [...document.querySelectorAll('iframe')].find(f => {
      const r = f.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) || e.target;
    const r = target.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }

  // Shortest selector that matches only this element; skips ids/classes that look
  // generated (long digit runs) since those change on every page load.
  function selectorFor(el) {
    if (el.id && !/\d{3,}/.test(el.id)) return '#' + CSS.escape(el.id);
    const cls = [...el.classList].filter(c => !/\d{3,}/.test(c)).slice(0, 3);
    const base = el.localName + cls.map(c => '.' + CSS.escape(c)).join('');
    const p = el.parentElement;
    if (!p || document.querySelectorAll(base).length === 1) return base;
    return `${selectorFor(p)} > ${base}:nth-child(${[...p.children].indexOf(el) + 1})`;
  }

  // Capture-phase and registered at document_start, so these run before the site's
  // own handlers (popunder ads usually hook mousedown/click).
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    addEventListener(type, e => {
      if (!picking) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (type !== 'click') return;
      const el = target;
      stopPick();
      if (el && el !== document.documentElement && el !== document.body) {
        send({ type: 'picked', selector: selectorFor(el) });
      } else send({ type: 'pick-cancel' });
    }, true);
  }

  addEventListener('keydown', e => {
    if (picking && e.key === 'Escape') { stopPick(); send({ type: 'pick-cancel' }); }
  }, true);

  // ---- hello ----

  const meta = () => send({ type: 'meta', url: location.href, title: document.title });
  send({ type: 'hello', host: location.hostname });
  meta();
  document.addEventListener('DOMContentLoaded', meta);
  window.navigation?.addEventListener('navigatesuccess', meta); // SPA chapter changes
})();
