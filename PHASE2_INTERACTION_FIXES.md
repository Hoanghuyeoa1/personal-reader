# VietReader — Phase 2 Interaction Fixes

Ngày: 2026-10-07  
Phạm vi: sửa các finding có bằng chứng ở Phase 1, bổ sung guard cho Reader hotkeys theo yêu cầu, chạy kiểm tra mục tiêu. Không refactor rộng app.js và không thay TTSEngine.

## Các thay đổi

| Root cause / hành vi | Thay đổi |
|---|---|
| Search results hoạt động nhưng cursor bị override thành default | Xóa declaration ghi đè; .global-search-match-row giữ cursor: pointer. Click/keyboard handlers không đổi. |
| Chapter navigation có native disabled nhưng thiếu trạng thái nhìn thấy | Thêm style cho sáu nút prev/next ở header, đáy Reader và dock: giảm opacity, cursor not-allowed, bỏ hover/transform/shadow gây hiểu nhầm. Logic .disabled không đổi. |
| Lỗi getBook() trước try thoát khỏi handleDeleteBook() | Bắt lỗi lookup, hiện toast và dừng trước confirm/delete. Lỗi delete vẫn giữ nhánh báo lỗi đã có. |
| Clipboard reject không có feedback | Bắt lỗi navigator.clipboard.writeText() và chỉ báo thành công sau khi ghi thành công; reject hiện toast lỗi. |
| Reader hotkey có thể chạy khi focus ở control modal/drawer hoặc editable | Guard không cho phím Reader chạy trong input, textarea, select, contenteditable, modal hoặc drawer. Global Search và Confirm tiếp tục tự xử lý phím riêng. |
| Một số modal/drawer chưa có Escape close | Escape đóng surface đang mở theo thứ tự ưu tiên, dùng close function sẵn có. Confirm và Global Search vẫn giữ handler riêng. Không dùng timeout. |

## Hạng mục không đổi

- Không có selector/cache mismatch hoặc duplicate ID/listener để sửa.
- Dynamic lists tiếp tục dùng controlled rebind sau render; Search và History giữ delegation hiện có. Không có stale listener được xác nhận.
- Không cần async lock mới. Search/History/Bookmark navigation vẫn reset trạng thái trong finally.
- Không chỉnh z-index ở TOC/dock/FAB: Phase 1 mới xác định rủi ro từ DOM order và stacking, chưa xác nhận hit target thực tế.
- Không chỉnh TTSEngine, Safe Transition, utterance cleanup, chapter lock hoặc Circuit Breaker.

## Files

- app.js: Reader hotkey guard/Escape; error feedback cho delete lookup và quote copy.
- styles.css: disabled feedback cho chapter navigation; bỏ cursor override của Search result.

## Kiểm tra

| Check | Kết quả | Ghi chú |
|---|---|---|
| node --check app.js | PASS | Không lỗi cú pháp. |
| Isolated behavior check cho hotkey từ source hiện tại | PASS, 8 trường hợp | Modal/input/contenteditable chặn Reader Space/arrows; Escape đóng Settings/TOC; Reader Space vẫn click Play; Global Search và Confirm giữ handler Escape riêng. |
| Isolated error-path check cho delete lookup | PASS | Lookup reject tạo một toast và không mở confirm/delete. |
| Source assertion disabled controls/cursor | PASS, 2 assertions | Sáu nút chapter có rule :disabled; Search result không còn cursor: default. |
| npm run build | BLOCKED | vite không được cài trong workspace (node_modules chỉ có .vite); lệnh báo 'vite' is not recognized. Không cài package trong lượt này. |
| Browser/modal/drawer hit-test và full UI flow | NOT RUN | Không có browser/app surface khả dụng trong computer-use inventory; không thể xác minh elementFromPoint hoặc click qua UI. |

## Checkpoint

- Root causes đã sửa: cursor affordance, disabled feedback, hai async error-feedback gaps, hotkey leakage vào modal/drawer/editable, thiếu Escape close cho các modal/drawer còn lại.
- Controls được cải thiện: Search results, sáu chapter navigation buttons, delete book, copy quote, toàn bộ modal/drawer controls có thể nhận focus.
- Selector/cache changes: không cần.
- Duplicate listener fixes: không cần; không phát hiện duplicate listener.
- Dynamic DOM: không thay đổi vì các action hiện có listener lifecycle đúng.
- Async lock recovery: không phát hiện lock treo; không thêm lock không cần thiết.
- Overlay/propagation: chưa sửa vì conflict TOC/dock chưa được runtime-confirm.
- Modal/Drawer: open/close/backdrop hiện có giữ nguyên; Escape được bổ sung cho modal/drawer thiếu handler. Reopen/backdrop chưa được kiểm tra qua browser.
- Chưa có nút nào được xác nhận click-dead. Hit-testing TOC/dock/FAB và browser UI flows cần kiểm tra tiếp; TTS core vẫn nằm ngoài Phase 2.

README và CHANGELOG không cập nhật.
