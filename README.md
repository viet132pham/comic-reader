# Comic Reader

Extension Chrome: bấm icon → khung đọc truyện nhỏ nổi ngay trên trang đang xem (như cửa sổ video thu nhỏ). Dán link chương, kéo/đổi cỡ thoải mái, chặn quảng cáo, tự cuộn theo vị trí chuột.

## Cài

1. Chrome → `chrome://extensions` → bật **Developer mode**.
2. **Load unpacked** → chọn thư mục này (trên Windows: `\\wsl$\<distro>\home\zit\comic`).
3. Ghim icon extension lên thanh công cụ cho dễ bấm.

Sửa code xong: bấm nút reload của extension ở `chrome://extensions`, rồi tải lại trang đang xem.

## Dùng

| Việc | Cách |
|---|---|
| Mở / đóng khung | Bấm icon extension. Đóng: nút × hoặc bấm icon lần nữa. |
| Di chuyển | Kéo thanh tiêu đề "Đọc truyện". |
| Đổi cỡ | Kéo góc dưới phải của khung. Vị trí và cỡ được nhớ. |
| Tự cuộn | Bấm thanh dọc **Tự cuộn**. Chuột ở dưới → cuộn xuống, ở trên → cuộn lên, ở giữa → dừng. Càng sát mép càng nhanh. Đưa chuột ra ngoài truyện là dừng. |
| Chặn quảng cáo | Bật sẵn. Bỏ tick **Chặn quảng cáo** nếu site bị lỗi (khung tự tải lại). |
| Ẩn banner còn sót | **Ẩn phần tử** → bấm vào banner. Danh sách ở *Phần tử đã ẩn* phía dưới, xoá dòng để hiện lại. |

Chương đang đọc được nhớ: mở lại khung là về đúng chương đó.

Trang không cho chèn khung (`chrome://`, tab mới, Chrome Web Store) → bấm icon sẽ mở khung đọc trong tab riêng. Ở tab riêng có thêm nút **Cửa sổ nổi**: cửa sổ luôn nằm trên mọi ứng dụng khác.

## Cơ chế

- **Khung nổi**: `overlay.js` được chèn vào trang khi bấm icon, tạo một khung nằm trong Shadow DOM (CSS của trang không làm vỡ được), bên trong là `reader.html`.
- **Nhúng trang truyện**: session rule gỡ `X-Frame-Options` + `CSP` cho sub-frame của **đúng tab đó**. Đóng khung hoặc đóng tab thì rule bị xoá.
- **Chống nhảy khỏi khung**: iframe truyện có `sandbox` không kèm `allow-top-navigation` và `allow-popups`. Site không đẩy được trang đi, quảng cáo không bật được tab popup.
- **Chặn quảng cáo**, 3 lớp:
  1. Session rule chặn request tới domain quảng cáo (`rules/ads.json`).
  2. `adsbygoogle.js` bị thay bằng bản giả (`surrogates/`), nên site kiểm tra "có bật adblock không" sẽ không phát hiện.
  3. CSS ẩn các ô quảng cáo phổ biến, cộng với phần tử bạn tự chọn ẩn.
  4. Chiêu "bấm Sau → khung truyện nhảy sang Shopee, chương thật mở tab mới": khung bị đưa sang Shopee/Lazada/link affiliate thì bị chặn lại, và reader chuyển thẳng tới link chương mà site định mở trong tab mới (`hook.js` bắt link đó, `bounce.html` báo cho reader).
- **Tự cuộn**: `content.js` chạy bên trong iframe truyện. Chỉ hoạt động khi được reader của extension nhúng; ở mọi trang khác nó thoát ngay.
- **Bảo vệ**: `reader.html` chỉ chạy khi được nhúng bằng token dùng một lần do `overlay.js` tạo. Trang lạ tự nhúng reader không lợi dụng được việc gỡ header.

## Test

```
npm install
npm test                       # logic tốc độ cuộn
npm run e2e                    # Chromium thật + extension, site giả cố tình khó
npm run e2e -- --headed        # thêm test cửa sổ nổi PiP (cần màn hình, WSLg được)
npm run e2e -- --real <link>   # thêm smoke test trên site truyện thật
```

Ảnh chụp từng bước nằm ở `test/shots/`.

Đã kiểm chứng tự động: nhúng được trang có `X-Frame-Options: DENY`; site không thoát khung được; popup bị chặn; tự cuộn đủ 4 chiều (xuống, lên, đứng ở giữa, dừng khi rời chuột); ẩn phần tử chỉ ẩn đúng cái được bấm; chặn request + thay `adsbygoogle.js`; rule không lan sang tab khác; kéo/đổi cỡ/đóng/mở lại khung nổi; cửa sổ PiP + chuyển chương bên trong; site zettruyen3 đọc và tự cuộn được.

## Giới hạn đã biết

- Khung nổi sống trong trang hiện tại: chuyển trang khác ở tab đó là khung đóng (mở lại sẽ về đúng chương).
- Khi khung nổi đang mở, chặn quảng cáo áp dụng cho cả tab đó, kể cả trang nằm bên dưới.
- Link mở tab mới (`target=_blank`) trong khung bị chặn (do sandbox chặn popup).
- Site tự ẩn nội dung khi phát hiện bị nhúng (`if (top !== self)`) thì không gỡ được.
- Danh sách domain quảng cáo còn nhỏ. Thêm domain vào `requestDomains` trong `rules/ads.json`.
- Site cần đăng nhập: chưa kiểm chứng cookie có được gửi trong khung không.
- Chưa có icon riêng.
