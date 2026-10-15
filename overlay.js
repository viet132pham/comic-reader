// Injected into the current tab when the toolbar icon is clicked: toggles a floating reader panel.
(async () => {
  const ID = 'comic-reader-overlay';
  const existing = document.getElementById(ID);
  if (existing) return close(existing);

  const MARGIN = 16, HEAD = 28;
  const saved = (await chrome.storage.local.get('overlay')).overlay;
  const w = Math.min(saved?.w ?? 380, innerWidth - MARGIN * 2);
  const h = Math.min(saved?.h ?? 620, innerHeight - MARGIN * 2);

  // One-time token: reader.html refuses to run framed without it, so other sites can't embed
  // the reader to strip frame protection in their own tab.
  const token = crypto.randomUUID();
  await chrome.storage.local.set({ overlayToken: token });

  const life = new AbortController(); // ends this panel's page-level listeners on close
  const host = document.createElement('div');
  host.id = ID;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .panel {
      position: fixed; z-index: 2147483647;
      display: flex; flex-direction: column;
      min-width: 280px; min-height: 240px; max-width: 100vw; max-height: 100vh;
      resize: both; overflow: hidden;
      border-radius: 10px;
      background: var(--bg);
      box-shadow: 0 16px 48px rgba(0, 0, 0, .35), 0 0 0 1px var(--edge);
      --bg: #f7f7f8; --head: #e4e6ea; --ink: #1d2026; --edge: rgba(0, 0, 0, .12); --accent: #e3a81c;
    }
    @media (prefers-color-scheme: dark) {
      .panel { --bg: #1d2026; --head: #282c33; --ink: #e6e3dc; --edge: rgba(255, 255, 255, .1); --accent: #f2c14e; }
    }
    .head {
      flex: none; height: ${HEAD}px;
      display: flex; align-items: center; gap: 8px; padding: 0 4px 0 10px;
      background: var(--head); color: var(--ink);
      font: 12px/1 system-ui, sans-serif;
      cursor: grab; user-select: none; touch-action: none;
    }
    .head span { flex: 1; }
    .panel.busy .head { cursor: grabbing; }
    button {
      all: unset; width: 22px; height: 22px; border-radius: 4px;
      display: grid; place-items: center; font-size: 16px; cursor: pointer;
    }
    button:hover { background: var(--edge); }
    button:focus-visible { outline: 2px solid var(--accent); }
    iframe { flex: 1; min-height: 0; width: 100%; border: 0; display: block; }
    /* while dragging or resizing, the iframe must not swallow the pointer */
    .panel.busy iframe { pointer-events: none; }
  </style>
  <div class="panel" role="dialog" aria-label="Đọc truyện">
    <div class="head"><span>Đọc truyện</span><button type="button" aria-label="Đóng">×</button></div>
    <iframe title="Đọc truyện"></iframe>
  </div>`;

  const panel = root.querySelector('.panel');
  const head = root.querySelector('.head');
  const frame = root.querySelector('iframe');
  frame.src = chrome.runtime.getURL('reader.html') + '#' + token;

  function place(x, y) {
    x = Math.max(0, Math.min(x, innerWidth - panel.offsetWidth));
    y = Math.max(0, Math.min(y, innerHeight - HEAD));
    Object.assign(panel.style, { left: x + 'px', top: y + 'px' });
  }
  const save = () => chrome.storage.local.set({ overlay: {
    x: panel.offsetLeft, y: panel.offsetTop, w: panel.offsetWidth, h: panel.offsetHeight } });

  Object.assign(panel.style, { width: w + 'px', height: h + 'px' });
  document.documentElement.append(host);
  // Default: bottom-right corner, like a video picture-in-picture.
  place(saved?.x ?? innerWidth - w - MARGIN, saved?.y ?? innerHeight - h - MARGIN);

  head.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const dx = e.clientX - panel.offsetLeft, dy = e.clientY - panel.offsetTop;
    const move = ev => place(ev.clientX - dx, ev.clientY - dy);
    head.setPointerCapture(e.pointerId);
    panel.classList.add('busy');
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', () => {
      head.removeEventListener('pointermove', move);
      panel.classList.remove('busy');
      save();
    }, { once: true });
  });

  // The native resize grip is the only part of .panel itself that can be pressed.
  panel.addEventListener('pointerdown', e => {
    if (e.composedPath()[0] !== panel) return;
    panel.classList.add('busy');
    addEventListener('pointerup', () => { panel.classList.remove('busy'); save(); }, { once: true });
  });

  addEventListener('resize', () => place(panel.offsetLeft, panel.offsetTop), { signal: life.signal });
  root.querySelector('button').addEventListener('click', () => close(host));
  host.life = life;

  // The comic frame can't tell when the cursor leaves the panel for this page; say so.
  const readerOrigin = new URL(frame.src).origin;
  document.addEventListener('pointerover', e => {
    if (e.target !== host) frame.contentWindow?.postMessage({ src: 'comic-overlay', type: 'rest' }, readerOrigin);
  }, { signal: life.signal });

  function close(el) {
    el.life?.abort();
    el.remove();
    chrome.runtime.sendMessage({ type: 'overlay-closed' }).catch(() => {});
  }
})();
