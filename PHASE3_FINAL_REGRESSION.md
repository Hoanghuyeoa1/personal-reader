# VietReader — Phase 3 Final Regression

Ngày: 2026-10-07  
Phạm vi: re-audit finding Phase 1/2 còn lại; kiểm tra Reader/TTS lifecycle; thêm regression test cho nguyên nhân tái hiện được.

## Kết quả audit và root cause

| Control / trạng thái | Expected | Root cause đã xác minh | Fix |
|---|---|---|---|
| Reader khởi động / chapter completion history | app.js import markChapterCompleted as markReadingHistoryChapterCompleted | readingHistory.js có method trên engine nhưng thiếu named export wrapper; ESM linking dừng toàn bộ app trước khi chạy | Thêm wrapper export gọi engine singleton và test import API. readingHistory.js, test_reading_history.mjs |
| TTS Previous/Next chunk khi paused; scrubber seek với autoplay=false | Đổi chunk/highlight nhưng vẫn pause; Resume đọc đúng chunk đang chọn một lần | prev(), next() và seek trước đây có thể gọi phát chunk mới dù isPlaying còn true và isPaused; Cloud path không tuân theo trạng thái pause | Các nhánh paused hủy source hiện tại, giữ currentIndex, đánh dấu pausedChunkChanged; chỉ Resume mới đọc chunk được chọn. Bounds giữ nguyên. tts.js |
| Stop / đổi chương khi Cloud request đang chờ | Stop kết thúc session; kết quả cũ không phát lại hay bị gán vào chương mới | Cloud fetch/cache bất đồng bộ không có generation token; phản hồi đến muộn vẫn đặt source và gọi play | Token tăng khi source bị hủy; kiểm tra token sau await/cache/fetch và trước fallback/play; listener audio bỏ qua event cũ. Stop dùng cancelCurrentSource(), không phát completed. tts.js |
| Browser voice preview trong lúc đọc | Preview không làm session đang đọc mắc kẹt; sau preview tiếp tục chunk hiện tại | Preview gọi synth.cancel() và thay current utterance, nhưng không khôi phục phiên TTS | Preview dùng utterance riêng; tạm dừng phiên, giữ chunk, Resume lại chunk hiện tại sau onend/onerror; nhấn Resume thủ công hủy preview đang chạy trước khi tiếp tục. Nếu session vốn paused, vẫn paused. tts.js |
| Cloud voice preview lặp/Stop/error | Chỉ preview mới nhất được phát; audio/URL được dọn khi kết thúc, lỗi hoặc Stop | Request preview bất đồng bộ không được quản lý; URL chỉ thu hồi trong onended, play Promise không được await | Preview generation token loại kết quả cũ; lưu Audio và URL để cleanup; await play(), xử lý reject và thu hồi resource; Stop hủy preview đang chờ. tts.js |

Đã sửa thêm lỗi module load: app.js import named export markChapterCompleted nhưng readingHistory.js trước đó chỉ có method trên engine, không có wrapper export. Không phát hiện mapping button → API sai trong Reader dock. TTS UI vẫn gọi state.tts.play/pause/stop/prev/next; chapter buttons đi qua navigateChapter() → loadChapter(). Không có UI bypass trực tiếp speechSynthesis.cancel(). Safe utterance cleanup, Empty Chunk Defense, chapter-switch lock, Safe Sequential Transition và Circuit Breaker được giữ.

## Trace controls đã rà lại

| Nhóm control | Binding → API/state | Kết quả source audit |
|---|---|---|
| Play/Pause/Stop | app.js 1140–1150 → TTSEngine.play/pause/stop; status callback cập nhật icon/FAB | Idle → play, playing → pause, paused → resume; Stop cleanup source và không gọi natural completion. Không reset chunk index trong resume. |
| Previous/Next chunk và scrubber | app.js 1152–1158, scrubber → prev/next/jumpToIndex | Bounds giữ; chunk callback đồng bộ highlight; khi paused không speak cho tới Resume; không tạo hai lần speak trong đường đi đã test. |
| Previous/Next chapter | app.js 994–995, bottom/dock bindings → navigateChapter() | Native disabled ở biên; vẫn dùng lifecycle load chapter hiện hữu, stop TTS/AutoScroll và nạp text. Anti-OOM transition không bị thay. |
| Rate/voice/preview | app.js 1160–1274 → setter của TTSEngine, settings storage và preview handlers | Selector/setting handler vẫn một lần lúc init; preview path đã sửa. Readiness và âm thanh thật cần browser để kiểm tra. |
| AutoScroll/speed | initAutoScrollEngine(), callback state và nút dock | Dùng một AutoScrollEngine lifecycle hiện có; không thêm rAF loop hay listener. Runtime timing chưa kiểm tra. |
| Theme/font/Zen/Dock/FAB | handler trong app.js và CSS class/state | Minimize/expand dùng state hiện hữu; source không cho thấy bind lại qua render. Hit target và focus visual chưa kiểm tra runtime. |
| Sleep Timer/Ambient/Bookmark/Media | module timer/mixer/bookmark và Media Session gọi các API dùng chung | Không đổi trong Phase 3; các contract tích hợp hiện hữu vẫn qua regression suite. Không tạo audio lifecycle thứ hai. |
| Library, Search, History, drawers, modals và dynamic lists | Inventory và trace trong Phase 1; fixes Phase 2 tại app.js/styles.css | Không tìm thấy selector ID sai/trùng, duplicate ID/listener hay stale dynamic listener từ source audit. Dynamic list được bind sau render hoặc dùng delegation. |

## Regression và error paths

- Thêm test_tts_interactions.mjs: paused next/previous/scrubber không phát trước Resume; Resume phát chunk cuối được chọn; Stop vô hiệu hóa Cloud response đến muộn và không phát audio/natural-complete; browser preview khôi phục session; Cloud preview bị Stop không thể phát sau khi request về.
- Cập nhật source-contract assertion trong test_reading_history.mjs import và kiểm tra wrapper chapter completion; test_reading_history_integration.mjs cho phép stale-event guard chạy trước callback trong Cloud error listener, đồng thời vẫn yêu cầu listener đóng actual playback khi có lỗi.
- node --check app.js, tts.js và hai file test: PASS.
- Toàn bộ test suite hiện có và test mới: 10 test files PASS, 13 tests PASS, 0 fail. Test parser bên trong xác nhận thêm 15 assertion. Một số test cố ý log simulated IndexedDB failure; test Cloud stale request cũng log cảnh báo cache do Node không có window. Đây là test environment, suite vẫn PASS.
- npm run build: BLOCKED vì Vite không cài trong workspace (vite không được nhận diện; node_modules/.bin/vite không tồn tại). Không cài dependency.
- Browser/app inventory không có surface khả dụng, nên không thể chạy click sweep, browser console capture, elementFromPoint, desktop/mobile, 4 themes, audio thực, RAM/timer profiling hoặc xác minh focus/pointer hit testing. Vì vậy các tiêu chí runtime/full visual acceptance chưa được chứng minh. TOC backdrop/dock/FAB stacking risk ở Phase 1 vẫn chưa xác nhận và không được đổi tùy suy đoán.

## Listener, overlay, locks và runtime

- Duplicate ID: không có theo Phase 1 audit trên HTML tĩnh.
- Duplicate/stale listeners: không thấy bằng source audit; repeated open/close chưa được click thực tế.
- Overlay/pointer conflict: rủi ro TOC backdrop với dock/FAB chưa có hit-test runtime, còn mở.
- Async locks: Search/History/Bookmark navigation hiện có cleanup/finally; Phase 3 không thêm lock. Cloud playback/preview request mới dùng generation token và được invalidate khi Stop/source replacement.
- Runtime click exception: chưa thể kết luận không có do không có browser; source error paths của Phase 2 và regression tests liên quan đều PASS.

## Release và tài liệu

- Package version: 1.7.0 → 1.7.1 (patch).
- CHANGELOG.md: ghi fixes Phase 2 và TTS fixes Phase 3.
- README không đổi vì không thay kiến trúc/module responsibility; TTS lifecycle được gia cố trong module hiện hữu.

## Files

- Runtime: app.js, styles.css, tts.js, readingHistory.js.
- Tests: test_tts_interactions.mjs, test_reading_history.mjs, test_reading_history_integration.mjs.
- Release/docs: package.json, CHANGELOG.md.

## Rủi ro còn lại

Build chưa xác nhận do thiếu Vite; UI/audio runtime, layout mobile/theme, hit testing và repeated click lifecycle vẫn cần chạy trong browser thật. Không có bằng chứng source nào cho thấy các nút đã audit bị click-dead; các lỗi Phase 3 được phát hiện là lỗi state/lifecycle của TTS, không phải event binding.
