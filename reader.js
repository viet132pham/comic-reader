const $ = id => document.getElementById(id);
const bar = $('bar'), urlIn = $('url'), adblockIn = $('adblock'), speedIn = $('speed');
const pickBtn = $('pick'), pipBtn = $('pip'), note = $('note');
const home = $('home'), stage = $('stage'), rail = $('rail'), wrap = $('wrap'), empty = $('empty');
let frame = $('frame');
const panel = $('hidden-panel'), hostLabel = $('host'), hiddenIn = $('hidden');

const DEAD = 0.25; // middle band where auto-scroll rests; #rail rows in reader.css mirror it

// Common ad slots, hidden when "Chặn quảng cáo" is on. Kept narrow on purpose:
// broad guesses like [class*="ad"] also hide "header", "loading", "thread"...
const GENERIC = [
  'ins.adsbygoogle', '[id^="google_ads_"]', '[id^="div-gpt-ad"]',
  'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]',
  // self-hosted formats on Vietnamese comic sites: sticky bottom "catfish", side floaters, pop layers
  '[id*="catfish" i]', '[class*="catfish" i]', '[id^="floating-banner"]', '[id^="_pop-"]',
];

// Framed = the floating panel from overlay.js. Only run with the one-time token it set,
// otherwise any site could frame this page to strip frame protection in its own tab.
const embedded = window !== top;
if (embedded) {
  const { overlayToken } = await chrome.storage.local.get('overlayToken');
  if (!overlayToken || location.hash.slice(1) !== overlayToken) {
    document.body.replaceChildren();
    throw new Error('reader.html was framed without the overlay token');
  }
  chrome.storage.local.remove('overlayToken');
  document.body.classList.add('embed');
  pipBtn.hidden = true; // Document PiP can only be opened from a top-level page
}

const state = await chrome.storage.local.get({ url: '', w: 480, h: 820, adblock: true, speed: 12, auto: false, hidden: {} });
const tabId = (await chrome.tabs.getCurrent()).id;
let host = '', frameOrigin = '', popups = [], auto = state.auto, failTimer = 0, sizeTimer = 0, typeTimer = 0;

const save = patch => { Object.assign(state, patch); chrome.storage.local.set(patch); };
const post = msg => frameOrigin && frame.contentWindow?.postMessage({ src: 'comic-reader', ...msg }, frameOrigin);

// Only http(s). Anything else (javascript:, data:, chrome:) is refused: the frame starts
// as about:blank in this extension's origin.
function normalize(v) {
  v = String(v ?? '').trim();
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch { return ''; }
}

// Strip the "don't embed me" headers from the comic frame.
const UNFRAME = {
  priority: 1,
  action: {
    type: 'modifyHeaders',
    responseHeaders: ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only']
      .map(header => ({ header, operation: 'remove' })),
  },
  condition: { resourceTypes: ['sub_frame'] },
};
const AD_RULES = await (await fetch('rules/ads.json')).json();
let pipTabId = 0, ruleIds = [];

// All network rules live as session rules scoped to this tab, so nothing leaks into normal
// browsing. (A static ruleset would also skip the iframe that already exists when it's enabled.)
async function applyRules() {
  const tabIds = pipTabId ? [tabId, pipTabId] : [tabId];
  const want = [UNFRAME, ...(state.adblock ? AD_RULES : [])];
  const all = await chrome.declarativeNetRequest.getSessionRules();
  const mine = all.filter(r => r.condition.tabIds?.includes(tabId)).map(r => r.id);
  // ponytail: ids are max+1, so two readers opening in the same instant could collide; reopen fixes it.
  let next = Math.max(0, ...all.filter(r => !mine.includes(r.id)).map(r => r.id)) + 1;
  const addRules = want.map(r => ({ ...r, id: next++, condition: { ...r.condition, tabIds } }));
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: mine, addRules });
  ruleIds = addRules.map(r => r.id);
}

// One rule per selector, so a bad line only drops itself.
function css() {
  const picked = (state.hidden[host] || '').split('\n').map(s => s.trim()).filter(isSelector);
  return [...(state.adblock ? GENERIC : []), ...picked].map(s => `${s}{display:none!important}`).join('\n');
}

function isSelector(s) {
  if (!s || s.length > 500 || /[{}]/.test(s)) return false;
  try { document.createDocumentFragment().querySelector(s); return true; } catch { return false; }
}

const sendConfig = () => post({ type: 'config', auto, speed: state.speed, dead: DEAD, css: css() });

function showNote(text, link) {
  note.replaceChildren(text);
  if (link) {
    note.append(' ', Object.assign(document.createElement('a'),
      { href: link, target: '_blank', rel: 'noopener', textContent: 'Mở ở tab thường' }));
  }
  note.hidden = false;
}

function load(u) {
  frame.src = u;
  empty.hidden = true;
  note.hidden = true;
  clearTimeout(failTimer);
  failTimer = setTimeout(() =>
    showNote('Trang chưa hiện trong khung sau 15 giây. Có thể mạng chậm hoặc trang chặn nhúng.', u), 15000);
}

// Chrome only applies network rules added after an iframe was created to *new* iframes:
// re-navigating the old one keeps loading ads. So swap in a fresh element.
function replaceFrame() {
  const f = frame.cloneNode();
  f.removeAttribute('src');
  frame.replaceWith(f);
  frame = f;
}

function setRail(v) {
  rail.style.setProperty('--up', Math.max(0, -v));
  rail.style.setProperty('--down', Math.max(0, v));
}

function setPicking(on) {
  pickBtn.setAttribute('aria-pressed', on);
  post({ type: 'pick', on });
  if (on) showNote('Bấm vào quảng cáo trong khung để ẩn nó. Bấm Esc để huỷ.');
  else note.hidden = true;
}

function setHidden(text) {
  save({ hidden: { ...state.hidden, [host]: text } });
  sendConfig();
}

// Messages from the frame are page-controlled data: validate before use.
function onMessage(e) {
  const m = e.data;
  if (embedded && e.source === parent && m?.src === 'comic-overlay') {
    if (m.type === 'rest' && auto) post({ type: 'rest' });
    return;
  }
  if (e.source !== frame.contentWindow || m?.src !== 'comic-frame') return;

  if (m.type === 'hello') {
    clearTimeout(failTimer);
    frameOrigin = e.origin;
    host = String(m.host || '');
    hostLabel.textContent = host || 'trang này';
    hiddenIn.value = state.hidden[host] || '';
    hiddenIn.disabled = !host;
    pickBtn.setAttribute('aria-pressed', false);
    setRail(0);
    sendConfig();
  } else if (m.type === 'meta') {
    const u = normalize(m.url);
    if (u) { urlIn.value = u; save({ url: u }); }
    if (m.title) document.title = String(m.title);
  } else if (m.type === 'speed') {
    setRail(Math.max(-1, Math.min(1, Number(m.v) || 0)));
  } else if (m.type === 'picked') {
    if (!isSelector(m.selector)) return setPicking(false);
    const list = (state.hidden[host] || '').trim();
    setHidden((list ? list + '\n' : '') + m.selector);
    hiddenIn.value = state.hidden[host];
    panel.open = true;
    setPicking(false);
  } else if (m.type === 'pick-cancel') {
    setPicking(false);
  } else if (m.type === 'popup') {
    const u = normalize(m.url);
    if (u) popups = [...popups.slice(-9), { url: u, at: Date.now() }];
  }
}

// rules/ads.json sent the frame to bounce.html instead of a shopping/affiliate page. If the
// site tried to open one of its own pages in a new tab at the same moment (usually the next
// chapter), go there; otherwise reload the chapter we were on.
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m?.type !== 'bounced' || ![tabId, pipTabId].includes(sender.tab?.id)) return;
  const mine = popups.find(p => Date.now() - p.at < 5000 && new URL(p.url).hostname === host);
  const target = mine ? mine.url : state.url;
  popups = [];
  if (!target) return;
  load(target);
  showNote(mine ? 'Đã chặn chuyển hướng quảng cáo, chuyển thẳng tới trang bạn bấm.' : 'Đã chặn chuyển hướng quảng cáo.');
});

// ---- wiring ----

bar.addEventListener('submit', e => {
  e.preventDefault();
  const u = normalize(urlIn.value);
  if (!u) return showNote('Link không hợp lệ. Dán link bắt đầu bằng http:// hoặc https://.');
  urlIn.value = u;
  save({ url: u });
  load(u);
});

adblockIn.checked = state.adblock;
adblockIn.addEventListener('change', async () => {
  save({ adblock: adblockIn.checked });
  await applyRules();
  if (state.url && frame.hasAttribute('src')) { replaceFrame(); load(state.url); }
});

speedIn.value = state.speed;
speedIn.addEventListener('input', () => { state.speed = +speedIn.value; sendConfig(); });
speedIn.addEventListener('change', () => save({ speed: +speedIn.value }));

rail.setAttribute('aria-pressed', auto);
rail.addEventListener('click', () => {
  auto = !auto;
  save({ auto }); // remembered: some readers have no working scroll wheel at all
  rail.setAttribute('aria-pressed', auto);
  if (!auto) setRail(0);
  sendConfig();
});

pickBtn.addEventListener('click', () => {
  if (!frameOrigin) return showNote('Mở một trang truyện trước rồi mới chọn phần tử để ẩn.');
  setPicking(pickBtn.getAttribute('aria-pressed') !== 'true');
});
addEventListener('keydown', e => {
  if (e.key === 'Escape' && pickBtn.getAttribute('aria-pressed') === 'true') setPicking(false);
});

hiddenIn.disabled = true;
hiddenIn.addEventListener('input', () => {
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => setHidden(hiddenIn.value), 300);
});

// The frame never hears the cursor leave it, but this page hears it arrive: tell the frame to rest.
function onPointerOver(e) { if (auto && e.target !== frame) post({ type: 'rest' }); }

// An iframe swallows the drag once the cursor crosses it, so shrinking the box would stall.
// The resize grip is the only part of #wrap not covered by the frame.
wrap.addEventListener('pointerdown', e => {
  if (e.target !== wrap) return;
  frame.style.pointerEvents = 'none';
  e.view.addEventListener('pointerup', () => { frame.style.pointerEvents = ''; }, { once: true });
});

if (!embedded) {
  wrap.style.width = state.w + 'px';
  wrap.style.height = state.h + 'px';
}
const sizeObserver = new ResizeObserver(() => {
  // In the panel or PiP, the outer box sets the size; only the tab's own size is remembered.
  if (embedded || wrap.ownerDocument !== document) return;
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => save({ w: wrap.offsetWidth, h: wrap.offsetHeight }), 300);
});
sizeObserver.observe(wrap);

// Load probe.html inside `win` and read its tab id off the message it sends.
function probeTabId(win) {
  const nonce = crypto.randomUUID();
  const probe = Object.assign(win.document.createElement('iframe'),
    { hidden: true, src: chrome.runtime.getURL('probe.html?' + nonce) });
  return new Promise(resolve => {
    const done = id => {
      chrome.runtime.onMessage.removeListener(listen);
      clearTimeout(timer);
      probe.remove();
      resolve(id || 0);
    };
    const listen = (m, sender) => { if (m?.type === 'probe' && sender.url?.endsWith(nonce)) done(sender.tab?.id); };
    const timer = setTimeout(done, 3000);
    chrome.runtime.onMessage.addListener(listen);
    win.document.body.append(probe);
  });
}

// Moving an iframe between documents reloads it, so point it at the current chapter
// while it is detached (a detached iframe doesn't navigate).
function moveStage(to, where = 'append') {
  stage.remove();
  if (state.url && frame.hasAttribute('src')) frame.src = state.url;
  to[where](stage);
  sizeObserver.observe(wrap); // re-arm after the cross-document move
}

pipBtn.addEventListener('click', async () => {
  if (!window.documentPictureInPicture) {
    return showNote('Trình duyệt này chưa hỗ trợ cửa sổ nổi. Cần Chrome 116 trở lên.');
  }
  if (documentPictureInPicture.window) return documentPictureInPicture.window.focus();

  const pip = await documentPictureInPicture.requestWindow({
    width: wrap.offsetWidth + rail.offsetWidth,
    height: wrap.offsetHeight,
  });
  // The PiP window has its own tab id; rules must cover it before the frame moves in.
  pipTabId = await probeTabId(pip);
  if (!pipTabId) {
    pip.close();
    return showNote('Không mở được cửa sổ nổi. Thử tải lại trang đọc.');
  }
  await applyRules();
  pip.document.head.append(Object.assign(pip.document.createElement('link'),
    { rel: 'stylesheet', href: chrome.runtime.getURL('reader.css') }));
  pip.document.title = document.title;
  pip.document.body.className = 'pip';
  pip.addEventListener('message', onMessage);
  pip.addEventListener('pointerover', onPointerOver);
  moveStage(pip.document.body);
  pipBtn.setAttribute('aria-pressed', true);
  showNote('Đang đọc trong cửa sổ nổi. Đóng cửa sổ đó để đưa truyện về đây.');

  pip.addEventListener('pagehide', () => {
    moveStage(home, 'prepend');
    pipTabId = 0;
    applyRules();
    pipBtn.setAttribute('aria-pressed', false);
    note.hidden = true;
  });
});

addEventListener('message', onMessage);
addEventListener('pointerover', onPointerOver);
// Leaving the reader (reload, typing another URL): drop our rules. background.js covers tab close.
addEventListener('pagehide', () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }));

// ---- start ----

await applyRules(); // rules first, then load
urlIn.value = state.url;
if (state.url) load(state.url);
