# Comic Reader Extension — Plan

Extension Chrome (MV3): dán link truyện → mở trong panel thu nhỏ, resize được, chặn quảng cáo, auto-scroll theo vị trí chuột.

---

## 1. Cơ chế cốt lõi: nhúng web truyện vào iframe

Đây là phần khó nhất, phải làm trước. 90% web truyện gửi header chặn nhúng:
- `X-Frame-Options: SAMEORIGIN / DENY`
- `Content-Security-Policy: frame-ancestors 'self'`

Extension gỡ được 2 header này bằng **declarativeNetRequest (DNR)** — luật khai báo tĩnh, không cần code chạy:

```json
// rules_unframe.json
[{
  "id": 1,
  "priority": 1,
  "action": {
    "type": "modifyHeaders",
    "responseHeaders": [
      { "header": "x-frame-options", "operation": "remove" },
      { "header": "content-security-policy", "operation": "remove" },
      { "header": "content-security-policy-report-only", "operation": "remove" }
    ]
  },
  "condition": { "resourceTypes": ["sub_frame"] }
}]
```

`resourceTypes: ["sub_frame"]` → chỉ áp dụng khi site bị nhúng, không ảnh hưởng lúc duyệt bình thường.

Cần permissions: `declarativeNetRequest`, `declarativeNetRequestWithHostAccess`, `host_permissions: ["<all_urls>"]`.

**Vẫn sẽ có site fail**, vì 2 lý do không gỡ được bằng header:
- JS chống nhúng: `if (window.top !== window.self) top.location = self.location`
- Site yêu cầu cookie `SameSite=Strict`/`Lax` → trong iframe cross-site cookie không gửi → bị coi là chưa login. Gỡ bằng DNR sửa `set-cookie` thành `SameSite=None; Secure` (chỉ khả thi với site HTTPS).

→ Chuẩn bị **Plan B** ngay từ đầu (xem §6).

---

## 2. Khung UI

Một trang `reader.html` của extension (chrome-extension:// origin) chứa:

```
┌─ toolbar ────────────────────────────┐
│ [URL input] [Go] [AdBlock●] [Auto●]  │
├──────────────────────────────────────┤
│                                      │
│          <iframe src=...>            │
│                                      │
└───────────────────────────────── ◢ ──┘  ← resize handle
```

Mở trang này ở đâu:
- **Tab riêng** (`chrome.tabs.create`) — đơn giản nhất, làm trước.
- **Popup** — bị giới hạn 800×600, chật, bỏ.
- **Side panel** (`chrome.sidePanel`) — hay, nhưng chỉ resize được chiều ngang.
- **Overlay nổi trên tab hiện tại** — linh hoạt nhất nhưng phải inject content script + lo z-index/shadow DOM. Để phase sau.

**Resize: dùng CSS native, không viết JS.**
```css
#frame-wrap { resize: both; overflow: hidden; width: 480px; height: 800px; min-width: 300px; }
iframe { width: 100%; height: 100%; border: 0; }
```
`resize: both` là của browser, không cần lib drag handle. Lưu size cuối vào `chrome.storage.local` để lần sau mở lại giữ nguyên.

---

## 3. Chặn quảng cáo — cơ chế thật sự

Trả lời thẳng câu hỏi "không hiểu cơ chế chặn quảng cáo":

### Có 2 tầng chặn, hoàn toàn khác nhau

**Tầng 1 — Chặn network (DNR).** Extension khai báo luật: request tới domain quảng cáo thì không cho đi. Quảng cáo không bao giờ tải về.
```json
{ "id": 100, "priority": 1,
  "action": { "type": "block" },
  "condition": { "urlFilter": "||doubleclick.net", "resourceTypes": ["script","image","sub_frame","xmlhttprequest"] } }
```
Nguồn danh sách domain: EasyList / EasyList China / filter của uBlock. Convert sang format DNR bằng tool có sẵn (`adblock2dnr`, hoặc tự parse — chỉ cần hỗ trợ subset rule đơn giản `||domain^`). Giới hạn: 30.000 static rule / ruleset, 5.000 dynamic.

**Tầng 2 — Ẩn phần tử (cosmetic).** Quảng cáo nhúng sẵn trong HTML (banner, div sticky) không có request riêng để chặn → phải ẩn bằng CSS inject:
```css
.ads, #banner-top, [id^="ads-"], iframe[src*="ad"] { display: none !important; }
```
Inject qua `chrome.scripting.insertCSS` hoặc content script với `all_frames: true` (content script **chạy cả trong iframe** — đây là lý do kiến trúc iframe vẫn chặn ads được).

### Vì sao "một số web không cho bật chặn quảng cáo"

Đó là **anti-adblock detection**. Site làm 1 trong các cách:

| Cách phát hiện | Nguyên lý |
|---|---|
| Bait element | Tạo `<div class="adsbox">`, sau 100ms đo `offsetHeight === 0` → biết bị ẩn |
| Kiểm tra biến global | `if (!window.adsbygoogle) → bị chặn` |
| Script onerror | `<script src="ads.js" onerror="detected()">` |
| Đếm request | Server thấy page load mà không có request tới ad endpoint |

Cách xử lý (đây là lý do uBlock Origin dùng "scriptlet" và "surrogate"):

1. **Redirect thay vì block.** Thay vì chặn `ads.js`, trả về một file JS rỗng nhưng có đủ API giả (`window.adsbygoogle = {push: ()=>{}}`). Site thấy script load OK, biến tồn tại → không báo.
   ```json
   { "action": { "type": "redirect", "redirect": { "extensionPath": "/surrogates/noop.js" } } }
   ```
   Cần khai báo `web_accessible_resources`.
2. **Ẩn không phá layout.** Dùng `visibility: hidden; position: absolute` thay vì `display: none` để bait element vẫn có `offsetHeight > 0`.
3. **Vá hàm detect.** Content script chạy ở `world: "MAIN"`, `run_at: "document_start"`, ghi đè hàm/property mà site dùng để kiểm tra.
4. **Chỉ ẩn, không chặn.** Để ad tải bình thường (site hài lòng) nhưng CSS ẩn đi. Tốn băng thông nhưng gần như luôn hoạt động.

**Khuyến nghị cho v1:** làm tầng 1 + tầng 2 với một blocklist nhỏ tự soạn cho đúng 3–5 site mình đọc. Không cố làm uBlock. Gặp site anti-adblock thì bật chế độ (4) cho riêng site đó — một toggle per-domain lưu trong storage.

---

## 4. Auto-scroll theo vị trí con trỏ

Logic: chia khung đọc thành 3 vùng dọc. Chuột ở vùng dưới → scroll xuống; vùng trên → scroll lên; giữa → dừng. Tốc độ tỉ lệ với độ sâu vào vùng (càng gần biên càng nhanh) — cảm giác tự nhiên hơn tốc độ cố định.

```js
// content script, all_frames: true — chạy BÊN TRONG iframe truyện
let speed = 0, enabled = false, raf = null;
const DEAD = 0.25;      // 25% giữa là vùng chết
const MAX  = 14;        // px mỗi frame ở biên

addEventListener('mousemove', e => {
  const r = e.clientY / innerHeight;          // 0..1
  if (r > 0.5 + DEAD/2)      speed =  MAX * (r - (0.5+DEAD/2)) / (0.5-DEAD/2);
  else if (r < 0.5 - DEAD/2) speed = -MAX * ((0.5-DEAD/2) - r) / (0.5-DEAD/2);
  else                       speed = 0;
});

function tick() {
  if (speed) scrollBy(0, speed);
  raf = enabled ? requestAnimationFrame(tick) : null;
}
```

Lưu ý quan trọng:
- Chuột nằm **trên iframe** thì trang cha **không nhận** `mousemove`. Vì vậy script phải nằm trong iframe. Nút toggle ở toolbar cha → gửi `iframe.contentWindow.postMessage({type:'autoscroll', on:true}, '*')`, script trong iframe nghe `message`.
- Dùng `requestAnimationFrame`, không `setInterval` — mượt và tự dừng khi tab ẩn.
- `mouseleave` → `speed = 0`.
- Vẫn để scroll chuột thường hoạt động song song (không `preventDefault`).
- Nên có phím tắt dừng nhanh (Space) vì auto-scroll dễ gây chóng mặt.

---

## 5. Cấu trúc file

```
manifest.json
background.js        # mở reader tab, bật/tắt dynamic DNR ruleset
reader.html / .js    # toolbar + iframe + resize + lưu state
content.js           # auto-scroll + cosmetic CSS (all_frames: true)
rules/unframe.json   # gỡ X-Frame-Options
rules/ads.json       # blocklist
surrogates/noop.js   # stub cho anti-adblock
```

`manifest.json` khung:
```json
{
  "manifest_version": 3,
  "permissions": ["declarativeNetRequest", "declarativeNetRequestWithHostAccess", "storage", "scripting", "tabs"],
  "host_permissions": ["<all_urls>"],
  "declarative_net_request": {
    "rule_resources": [
      { "id": "unframe", "enabled": true,  "path": "rules/unframe.json" },
      { "id": "ads",     "enabled": false, "path": "rules/ads.json" }
    ]
  },
  "content_scripts": [{ "matches": ["<all_urls>"], "all_frames": true, "js": ["content.js"], "run_at": "document_start" }],
  "web_accessible_resources": [{ "resources": ["surrogates/*"], "matches": ["<all_urls>"] }]
}
```

Toggle AdBlock = `chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['ads'] })`.

---

## 6. Plan B nếu iframe fail

Nếu site chống nhúng bằng JS (`top.location = self.location`) thì không có cách gỡ sạch. Lúc đó:

**Overlay mode** — mở site ở tab riêng bình thường, content script inject một container cố định rồi **dời `<body>` thật của site vào trong đó**:
```js
const box = document.createElement('div');   // position:fixed, resize:both
document.documentElement.append(box);
box.append(document.body);
```
Không có cross-origin, không có X-Frame-Options, không có vấn đề cookie. Đổi lại: CSS của site có thể vỡ (fixed header, `100vh`), phải vá từng site.

Thực tế nên làm: **thử iframe trước, phát hiện fail thì tự chuyển overlay**. Detect fail bằng cách iframe `load` xong mà `contentWindow.length === 0` + timeout, hoặc lắng nghe tab bị navigate.

---

## 7. Thứ tự làm

| # | Việc | Xác nhận xong khi |
|---|---|---|
| 1 | manifest + reader.html + iframe + DNR unframe | Dán link 3 site truyện, hiện được trong iframe |
| 2 | Resize `resize:both` + lưu size vào storage | Kéo góc, reload vẫn giữ size |
| 3 | Auto-scroll trong content script + postMessage toggle | Chuột xuống dưới tự cuộn, nhả về giữa thì dừng |
| 4 | Cosmetic CSS ẩn ads cho đúng site đang đọc | Banner mất, truyện vẫn đọc được |
| 5 | DNR ads ruleset + toggle | Network tab không còn request ad |
| 6 | Surrogate noop.js cho site anti-adblock | Site không còn popup "tắt adblock" |
| 7 | Overlay fallback | Site chống nhúng vẫn đọc được |

Dừng ở bước 4 là đã dùng được. Bước 5–7 chỉ làm khi thực sự gặp vấn đề.

---

## 8. Lưu ý

- Firefox dùng `browser.*` + MV2/MV3 khác nhau ở DNR. Làm Chrome trước.
- Chrome Web Store xét duyệt khá chặt với extension gỡ CSP + chặn ads. Dùng **Load unpacked** (chế độ developer) cho mục đích cá nhân, không cần publish.
- Không hardcode blocklist khổng lồ. Bắt đầu bằng danh sách site mình đọc, mở rộng khi cần.
- Nếu chỉ muốn "thu nhỏ màn hình đọc" mà không cần chặn ads: bước 1–3 là đủ, bỏ hẳn §3.
