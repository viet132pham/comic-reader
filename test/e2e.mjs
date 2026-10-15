// End-to-end check: real Chromium with the extension loaded, driven like a user.
//   npm run e2e                 -> hostile fake comic site served locally
//   npm run e2e -- --real <url> -> also smoke-test a real chapter page
//   add --headed to watch it (needs a display; WSLg works)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(EXT, 'test', 'shots');
const args = process.argv.slice(2);
const realUrl = args.includes('--real') ? args[args.indexOf('--real') + 1] : '';
const headed = args.includes('--headed');
fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- a deliberately hostile comic page ----
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>\${TITLE}</title>
<style>body{margin:0;font:16px sans-serif} .p{height:900px;border-bottom:4px solid #333;
background:linear-gradient(#ddd,#999);display:grid;place-items:center;font-size:40px}</style></head><body>
<a id="next" href="/chuong-2">Chuong 2</a>
<button id="trap-tabunder" onclick="window.open('/chuong-2'); location.href='https://shopee.vn/aff?id=1'">Sau (tab-under)</button>
<button id="trap-reverse" onclick="window.open(location.href); location.href='https://s.shopee.vn/abc'">Sau (reverse)</button>
<a id="trap-link" href="/chuong-2" target="_blank" onclick="setTimeout(() => location.href='https://shope.ee/xyz', 0)">Sau (link)</a>
<a id="trap-swallow" href="/chuong-2" onclick="event.preventDefault(); window.open(this.href)">Sau (swallowed)</a>
<a id="plain-js" href="/chuong-2" onclick="event.preventDefault()">Theo doi</a>
<button id="trap-top" onclick="try { top.location.href='https://shopee.vn/top' } catch (e) {}">Sau (top)</button>
<div id="top-banner" style="height:100px;background:#e33;color:#fff">TOP BANNER AD</div>
<div class="wrap"><div><div style="height:80px;background:#f90">NOCLASS AD</div></div></div>
<ins class="adsbygoogle" style="display:block;height:90px;background:#fc0">ADSENSE SLOT</ins>
${Array.from({ length: 12 }, (_, i) => `<div class="p">Trang ${i + 1}</div>`).join('')}
<img src="https://ad.doubleclick.net/pixel.gif" width="1" height="1">
<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
<script>
  try { if (top !== self) top.location = location.href; } catch (e) { window.bustError = String(e); }
  document.addEventListener('click', () => { try { window.open('https://example.com/popunder'); } catch (e) {} }, { once: true }); // popunders fire once per page
</script></body></html>`;

const HOST_PAGE = `<!doctype html><title>Trang bat ky</title><body style="margin:0;font:18px serif">
${Array.from({ length: 40 }, (_, i) => `<p style="padding:0 40px">Doan van ${i + 1} cua mot trang web binh thuong.</p>`).join('')}`;

const server = http.createServer((req, res) => {
  if (req.url === '/host') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(HOST_PAGE);
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });
  res.end(PAGE.replace('\${TITLE}', req.url.includes('chuong-2') ? 'Chuong 2' : 'Chuong 1'));
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const FAKE = `http://127.0.0.1:${server.address().port}/chuong-1`;

// ---- browser with the extension ----
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !headed,
  viewport: { width: 1280, height: 1000 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
const READER = `chrome-extension://${id}/reader.html`;

const blocked = [];
ctx.on('requestfailed', r => { if (/BLOCKED_BY_CLIENT/.test(r.failure()?.errorText)) blocked.push(r.url()); });

const page = await ctx.newPage();
const errors = [];
// Only our own code: comic sites throw plenty of errors of their own.
page.on('pageerror', e => { if (/chrome-extension:/.test(e.stack || '')) errors.push(e.message); });
await page.goto(READER);
await page.screenshot({ path: path.join(SHOTS, '01-empty.png') });

async function openChapter(url) {
  await page.fill('#url', url);
  const f = await reloadsFrame(() => page.click('#open'));
  await page.waitForFunction(() => document.title !== 'Đọc truyện', null, { timeout: 45000 }).catch(() => {});
  return f;
}

// Move the real mouse to a fraction of the frame's height.
async function hover(ratio) {
  const b = await page.locator('#frame').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * ratio, { steps: 4 });
}

// Run an action that reloads the comic frame; resolve with the fresh frame once loaded.
async function reloadsFrame(action) {
  // Skip the about:blank a fresh iframe starts on; wait for the real page.
  const nav = page.waitForEvent('framenavigated',
    { predicate: f => f.parentFrame() === page.mainFrame() && f.url().startsWith('http'), timeout: 45000 });
  await action();
  const f = await nav;
  // Not 'load': real sites often keep one resource hanging (a social widget) forever.
  await f.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
  await sleep(500);
  return f;
}

async function autoScroll(frame, label) {
  await page.click('#rail');
  check(`${label}: rail toggles on`, await page.getAttribute('#rail', 'aria-pressed') === 'true');
  await hover(0.97);
  await sleep(1200);
  const down = await frame.evaluate(() => scrollY);
  await page.screenshot({ path: path.join(SHOTS, `${label}-scrolling.png`) });
  check(`${label}: cursor at bottom scrolls down`, down > 100, `scrollY=${down}`);
  await hover(0.5);
  await sleep(300);
  const a = await frame.evaluate(() => scrollY);
  await sleep(700);
  const b = await frame.evaluate(() => scrollY);
  check(`${label}: cursor in middle rests`, a === b, `${a} -> ${b}`);
  await hover(0.03);
  await sleep(800);
  const up = await frame.evaluate(() => scrollY);
  check(`${label}: cursor at top scrolls up`, up < b, `${b} -> ${up}`);
  await hover(0.97);
  await sleep(300);
  await page.mouse.move(5, 500); // leave the frame
  await sleep(300);
  const c = await frame.evaluate(() => scrollY);
  await sleep(600);
  check(`${label}: leaving the frame stops scrolling`, c === await frame.evaluate(() => scrollY));
  await page.click('#rail');
}

// ================= fake hostile site =================
console.log('\n--- fake site (X-Frame-Options: DENY, frame-busting, popunder) ---');
let frame = await openChapter(FAKE);
await frame.waitForLoadState('domcontentloaded');
check('header-blocked page renders in the frame', await frame.evaluate(() => document.querySelectorAll('.p').length) === 12);
check('frame-busting did not hijack the tab', page.url() === READER, page.url());
check('reader title follows the chapter', await page.title() === 'Chuong 1');
check('url box shows the chapter', await page.inputValue('#url') === FAKE, await page.inputValue('#url'));

const pagesBefore = ctx.pages().length;
await hover(0.5);
const fb = await page.locator('#frame').boundingBox();
await page.mouse.click(fb.x + 50, fb.y + 400);
await sleep(800);
check('popunder on click is blocked', ctx.pages().length === pagesBefore, `${ctx.pages().length} tabs`);

await autoScroll(frame, 'fake');
await frame.evaluate(() => scrollTo(0, 0));

// element picker on a class-less ad
await page.click('#pick');
const noclass = frame.locator('text=NOCLASS AD');
const nb = await noclass.boundingBox();
await page.mouse.move(nb.x + 20, nb.y + 20, { steps: 3 });
await page.screenshot({ path: path.join(SHOTS, 'fake-picking.png') });
await page.mouse.click(nb.x + 20, nb.y + 20);
await sleep(300);
const pickedSel = await page.inputValue('#hidden');
check('picker hides the clicked ad', await noclass.evaluate(el => getComputedStyle(el).display) === 'none', pickedSel);
check('picker hides nothing else', await frame.evaluate(() =>
  [...document.querySelectorAll('.p, #top-banner, .wrap')].every(e => getComputedStyle(e).display !== 'none')));
check('picker click did not trigger the site', ctx.pages().length === pagesBefore);

// ad blocking
check('ad blocking is on by default', await page.isChecked('#adblock'));
await reloadsFrame(() => page.uncheck('#adblock'));
frame = await reloadsFrame(() => page.check('#adblock'));
check('adsense slot hidden', await frame.evaluate(() => getComputedStyle(document.querySelector('ins.adsbygoogle')).display) === 'none');
check('ad network request blocked', blocked.some(u => u.includes('doubleclick.net')), blocked.join(', ') || 'none');
check('adsbygoogle swapped for the stub (no adblock alarm)', await frame.evaluate(() =>
  window.adsbygoogle?.loaded === true && String(window.adsbygoogle.push).replace(/\s/g, '') === 'function(){}'));
check('picked element stays hidden after reload', await frame.locator('text=NOCLASS AD').evaluate(el => getComputedStyle(el).display) === 'none');
await page.screenshot({ path: path.join(SHOTS, 'fake-adblock.png') });

// shopping-redirect tricks on a "next chapter" button (ad blocking on)
const ORIGIN = new URL(FAKE).origin;
check('popup hook active inside the reader frame', await frame.evaluate(() => String(window.open).includes('comic-reader-open')));
async function trap(sel, expectTitle, label, { warmup = false } = {}) {
  frame = await openChapter(FAKE);
  await sleep(500);
  if (warmup) { await frame.click('.p', { position: { x: 20, y: 20 } }); await sleep(300); } // use up the one-shot popunder
  const tabs = ctx.pages().length;
  const seen = [];
  const onNav = f => { if (f.parentFrame() === page.mainFrame()) seen.push(f.url()); };
  page.on('framenavigated', onNav);
  await frame.click(sel);
  await sleep(2500);
  page.off('framenavigated', onNav);
  const cur = page.frames().find(f => f.parentFrame() === page.mainFrame());
  const title = await cur.evaluate(() => document.title).catch(() => '?');
  check(`${label}: no new tab opened`, ctx.pages().length === tabs, `${ctx.pages().length} tabs`);
  check(`${label}: never shows the shopping page`, !seen.some(u => /shopee|shope\.ee/.test(u)) && page.url() === READER, seen.join(' -> '));
  check(`${label}: lands on ${expectTitle}`, title === expectTitle && cur.url().startsWith(ORIGIN), `${title} @ ${cur.url()}`);
}
await trap('#trap-tabunder', 'Chuong 2', 'tab-under (chapter in new tab, page to Shopee)');
await trap('#trap-reverse', 'Chuong 1', 'reverse (same page in new tab, page to Shopee)');
await trap('#trap-link', 'Chuong 2', 'link target=_blank + redirect');
await trap('#trap-top', 'Chuong 1', 'top.location to Shopee');
await trap('#trap-swallow', 'Chuong 2', 'popunder swallows the link (Adcash style)');
await trap('#plain-js', 'Chuong 1', 'site handles its own link in JS (left alone)', { warmup: true });
await page.screenshot({ path: path.join(SHOTS, 'fake-shopee-blocked.png') });
frame = await openChapter(FAKE);

// header stripping is scoped to the reader tab only
// every network rule is scoped to the reader tab only
const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
const readerTab = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
check('all network rules scoped to the reader tab', rules.length > 1 &&
  rules.every(r => JSON.stringify(r.condition.tabIds) === JSON.stringify([readerTab])), `${rules.length} rules`);
const other = await ctx.newPage();
blocked.length = 0;
await other.setContent(`<iframe src="${FAKE}"></iframe>`);
await sleep(1500);
const leaked = await other.frames()[1]?.evaluate(() => document.querySelectorAll('.p').length).catch(() => 0);
check('other tabs still honour X-Frame-Options', !leaked, `frame rendered ${leaked} pages`);
await other.goto(FAKE);
await sleep(1500);
check('ad blocking does not leak into other tabs', !blocked.length, blocked.join(', '));
check('popup hook not installed on normal pages', !(await other.evaluate(() => String(window.open).includes('comic-reader-open'))));
await other.close();

// resize by dragging the corner inward, i.e. across the iframe
const w0 = await page.locator('#wrap').boundingBox();
await page.mouse.move(w0.x + w0.width - 3, w0.y + w0.height - 3);
await page.mouse.down();
await page.mouse.move(w0.x + w0.width - 120, w0.y + w0.height - 200, { steps: 10 });
await page.mouse.up();
await sleep(500);
const w1 = await page.locator('#wrap').boundingBox();
check('drag-resize shrinks over the iframe', w1.width < w0.width - 80 && w1.height < w0.height - 150,
  `${Math.round(w0.width)}x${Math.round(w0.height)} -> ${Math.round(w1.width)}x${Math.round(w1.height)}`);
await page.reload();
await page.waitForFunction(() => document.title === 'Chuong 1');
const w2 = await page.locator('#wrap').boundingBox();
check('size and chapter survive reopening', Math.abs(w2.width - w1.width) < 2 && Math.abs(w2.height - w1.height) < 2);
await page.screenshot({ path: path.join(SHOTS, 'fake-resized.png') });

// picture-in-picture (needs a real window)
if (headed) {
  await page.click('#pip');
  await sleep(1500);
  const pipFrame = () => ctx.pages().flatMap(p => p.frames()).find(f => f.url().startsWith(FAKE.replace('/chuong-1', '')));
  const n = await pipFrame()?.evaluate(() => document.querySelectorAll('.p').length).catch(() => 0);
  check('picture-in-picture window shows the chapter', n === 12, `frame pages=${n}`);
  const pip = ctx.pages().find(p => p.frames().includes(pipFrame()));
  await pip?.screenshot({ path: path.join(SHOTS, 'fake-pip.png') }).catch(() => {});
  // auto-scroll inside the PiP window
  if (pip) {
    await pip.locator('#rail').click();
    const pb = await pip.locator('#frame').boundingBox();
    await pip.mouse.move(pb.x + pb.width / 2, pb.y + pb.height * 0.97, { steps: 4 });
    await sleep(1200);
    const sy = await pipFrame().evaluate(() => scrollY);
    await pip.screenshot({ path: path.join(SHOTS, 'fake-pip-scrolling.png') }).catch(() => {});
    check('PiP: cursor at bottom scrolls down', sy > 100, `scrollY=${sy}`);
    await pip.mouse.move(pb.x + pb.width / 2, pb.y + pb.height * 0.5, { steps: 4 });
    await sleep(300);
    const r1 = await pipFrame().evaluate(() => scrollY);
    await sleep(600);
    check('PiP: cursor in middle rests', r1 === await pipFrame().evaluate(() => scrollY));
    await pip.mouse.move(pb.x + pb.width / 2, pb.y + pb.height * 0.03, { steps: 4 });
    await sleep(800);
    check('PiP: cursor at top scrolls up', await pipFrame().evaluate(() => scrollY) < r1);
    await pip.locator('#rail').click();
    await pipFrame().evaluate(() => scrollTo(0, 0));
  }
  await pipFrame()?.click('#next').catch(() => {});
  await sleep(1500);
  const t2 = await pipFrame()?.evaluate(() => document.title + ':' + document.querySelectorAll('.p').length).catch(() => 'blocked');
  check('in-frame link to next chapter works inside PiP', t2 === 'Chuong 2:12', t2);
  await page.evaluate(() => documentPictureInPicture.window?.close());
  await sleep(1500);
  const back = page.frames().find(f => f.parentFrame() === page.mainFrame());
  check('closing PiP brings the current chapter back to the tab',
    await back?.evaluate(() => document.title).catch(() => '') === 'Chuong 2');
} else console.log('SKIP  picture-in-picture (run with --headed)');

// ================= floating panel on any page =================
console.log('\n--- floating panel over the current page (toolbar icon) ---');
const HOST = FAKE.replace('/chuong-1', '/host');
const site = await ctx.newPage();
await site.goto(HOST);
const tabsBefore = ctx.pages().length;
const clickIcon = () => sw.evaluate(async url => {
  const t = (await chrome.tabs.query({})).find(t => t.url === url);
  await toggleOverlay(t);
}, HOST);
await clickIcon();
const panel = site.locator('#comic-reader-overlay .panel');
await panel.waitFor({ timeout: 5000 });
check('icon opens no new tab or window', ctx.pages().length === tabsBefore, `${ctx.pages().length} pages`);
const vp = site.viewportSize();
let pb = await panel.boundingBox();
check('panel floats at the bottom-right of the page',
  Math.abs(vp.width - (pb.x + pb.width) - 16) < 3 && Math.abs(vp.height - (pb.y + pb.height) - 16) < 3,
  `${Math.round(pb.x)},${Math.round(pb.y)} ${Math.round(pb.width)}x${Math.round(pb.height)}`);

const readerIn = () => site.frames().find(f => f.url().startsWith(`chrome-extension://${id}/reader.html`));
await sleep(800);
let rf = readerIn();
check('reader runs inside the panel in compact mode', await rf?.evaluate(() => document.body.classList.contains('embed')));
await site.screenshot({ path: path.join(SHOTS, 'overlay-empty.png') });

await rf.fill('#url', FAKE);
await rf.click('#open');
await sleep(1500);
const comic = () => site.frames().find(f => f.parentFrame() === readerIn() && f.url().startsWith('http'));
check('chapter loads inside the floating panel', await comic()?.evaluate(() => document.querySelectorAll('.p').length).catch(() => 0) === 12);
await site.screenshot({ path: path.join(SHOTS, 'overlay-reading.png') });

// auto-scroll inside the panel, and stopping when the cursor goes back to the page
await rf.click('#rail');
const cb = await rf.locator('#frame').boundingBox();
await site.mouse.move(cb.x + cb.width / 2, cb.y + cb.height * 0.97, { steps: 4 });
await sleep(1000);
const s1 = await comic().evaluate(() => scrollY);
check('panel: cursor at bottom scrolls the comic', s1 > 100, `scrollY=${s1}`);
await site.screenshot({ path: path.join(SHOTS, 'overlay-scrolling.png') });
await site.mouse.move(cb.x - 200, cb.y + cb.height * 0.97, { steps: 3 }); // straight out onto the page
await sleep(300);
const s2 = await comic().evaluate(() => scrollY);
await sleep(600);
check('panel: moving onto the page stops scrolling', s2 === await comic().evaluate(() => scrollY));
await rf.click('#rail');

// drag by the title bar
pb = await panel.boundingBox();
await site.mouse.move(pb.x + 60, pb.y + 14);
await site.mouse.down();
await site.mouse.move(pb.x - 340, pb.y - 220, { steps: 8 });
await site.mouse.up();
const moved = await panel.boundingBox();
check('panel drags by its title bar', Math.abs(moved.x - (pb.x - 400)) < 3 && Math.abs(moved.y - (pb.y - 234)) < 3,
  `${Math.round(pb.x)},${Math.round(pb.y)} -> ${Math.round(moved.x)},${Math.round(moved.y)}`);

// shrink with the corner grip (cursor crosses the iframe)
await site.mouse.move(moved.x + moved.width - 3, moved.y + moved.height - 3);
await site.mouse.down();
await site.mouse.move(moved.x + moved.width - 80, moved.y + moved.height - 120, { steps: 10 });
await site.mouse.up();
await sleep(300);
const shrunk = await panel.boundingBox();
check('panel resizes from its corner', shrunk.width < moved.width - 50 && shrunk.height < moved.height - 90,
  `${Math.round(moved.width)}x${Math.round(moved.height)} -> ${Math.round(shrunk.width)}x${Math.round(shrunk.height)}`);

// close, then reopen where it was
const siteTab = await sw.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, HOST);
const rulesFor = () => sw.evaluate(t => chrome.declarativeNetRequest.getSessionRules()
  .then(rs => rs.filter(r => r.condition.tabIds?.includes(t)).length), siteTab);
check('panel tab has frame rules while open', await rulesFor() > 0);
await site.locator('#comic-reader-overlay button[aria-label="Đóng"]').click();
await sleep(500);
check('× closes the panel', await site.locator('#comic-reader-overlay').count() === 0);
check('closing drops the tab\'s network rules', await rulesFor() === 0);
await clickIcon();
await panel.waitFor();
const again = await panel.boundingBox();
check('panel reopens where it was left', Math.abs(again.x - shrunk.x) < 3 && Math.abs(again.width - shrunk.width) < 3);
await sleep(1000);
check('auto-scroll setting is remembered (off after it was switched off)', await readerIn().getAttribute('#rail', 'aria-pressed') === 'false');
check('reopened panel resumes the chapter', await comic()?.evaluate(() => document.title).catch(() => '') === 'Chuong 1');
await clickIcon();
await sleep(300);
check('icon again closes the panel', await site.locator('#comic-reader-overlay').count() === 0);

// another site framing reader.html directly gets nothing
const evil = await ctx.newPage();
await evil.goto(HOST + '?evil');
await evil.evaluate(src => { const f = document.createElement('iframe'); f.src = src; document.body.prepend(f); },
  `chrome-extension://${id}/reader.html`);
await sleep(1500);
const evilTab = await sw.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, HOST + '?evil');
const evilRules = await sw.evaluate(t => chrome.declarativeNetRequest.getSessionRules()
  .then(rs => rs.filter(r => r.condition.tabIds?.includes(t)).length), evilTab);
check('a site framing the reader itself gets no rules', evilRules === 0, `${evilRules} rules`);
await evil.close();
await site.close();

// ================= real site =================
if (realUrl) {
  console.log(`\n--- real site: ${realUrl} ---`);
  blocked.length = 0;
  await page.uncheck('#adblock');
  await sleep(500);
  const t0 = Date.now();
  let real = await openChapter(realUrl);
  check('real chapter announces itself in the frame', !!real, `${Date.now() - t0} ms`);
  await sleep(4000);
  check('real site did not hijack the tab', page.url() === READER, page.url());
  const info = await real.evaluate(() => ({
    title: document.title,
    imgs: [...document.images].filter(i => i.naturalHeight > 300).length,
    iframes: [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 80)),
    height: document.documentElement.scrollHeight,
  }));
  console.log('      ', JSON.stringify(info));
  check('real chapter shows comic images', info.imgs > 0, `${info.imgs} large images`);
  await page.screenshot({ path: path.join(SHOTS, 'real-1-loaded.png') });

  await autoScroll(real, 'real');
  await page.screenshot({ path: path.join(SHOTS, 'real-2-after-scroll.png') });

  real = await reloadsFrame(() => page.check('#adblock'));
  await sleep(3000);
  const after = await real.evaluate(() => ({
    imgs: [...document.images].filter(i => i.naturalHeight > 300).length,
    iframes: [...document.querySelectorAll('iframe')].filter(f => f.offsetHeight > 0).map(f => f.src.slice(0, 80)),
  }));
  console.log('       blocked requests:', new Set(blocked.map(u => new URL(u).host)).size, [...new Set(blocked.map(u => new URL(u).host))].join(', '));
  console.log('       visible iframes after adblock:', JSON.stringify(after.iframes));
  check('comic images still load with adblock on', after.imgs > 0, `${after.imgs} large images`);
  await page.screenshot({ path: path.join(SHOTS, 'real-3-adblock.png') });
}

check('no errors from extension code', errors.length === 0, errors.join(' | '));
console.log(`\n${failed ? failed + ' failed' : 'all passed'}. Screenshots: ${SHOTS}`);
await ctx.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
