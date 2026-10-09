# VietReader — Phase 1 Interaction Audit

Ngày audit: 2026-10-07  
Phạm vi: đọc source hiện có, không sửa ứng dụng, không chạy build/test. Đã đối chiếu trực tiếp index.html, app.js, styles.css và các module tương tác được import trong app.js: tts.js, autoscroll.js, highlight.js, bookmark.js, search.js, searchNavigation.js, readingHistory.js, sleepTimer.js, ambientSound.js, mediaSessionHelper.js, storage.js, cleaner.js, parser.js.

## Kết quả kiểm kê

- 102 nút button tĩnh trong HTML; 84 nút có ID. Không có role=button, anchor dùng làm action, hoặc data-action trong HTML tĩnh.
- Không có ID trùng trong HTML tĩnh (207 ID). 201 literal getElementById selector đều khớp ID hiện có. Sáu ID không được truy vấn là node trình bày/bao ngoài, không phải control: top-reading-progress, library-filter-container, history-dashboard-title, history-empty-title, global-search-title, global-search-help.
- Tất cả 84 nút có ID được cache trong app.js; không phát hiện ID control đổi tên nhưng selector chưa cập nhật.
- HTML có một form tĩnh (global-search-form); nút bên trong khai báo type=button. Form bookmark động khai báo nút Lưu là type=submit và Hủy là type=button.
- Đã kiểm tra các action động: Library card, TOC, Search result, History session, Bookmark, Quote, Dictionary và Ambient.
- Đây là audit tĩnh. Không chạy app để xác nhận click thật, bắt console runtime hoặc gọi elementFromPoint; hit-testing dưới đây được ghi là rủi ro có bằng chứng cấu trúc, không khẳng định control đã chết trong runtime.

## Interaction inventory và trace

| Khu vực / control | DOM → binding → handler | Module/state → kết quả dự kiến | Kết quả audit |
|---|---|---|---|
| Library: mở sách | .book-card [data-action=read] và click card → renderBookCards() → openBook(bookId) (app.js:1779-1843) | storage.getBook() → state.currentBook, chapters, loadChapter() → Reader và vị trí lưu | Action động được tạo lại cùng card rồi mới gắn listener. Nút con dừng propagation; không thấy listener stale/nhân đôi. bookId từ dataset được storage chuẩn hóa bằng Number() (storage.js:168-171). |
| Library: xóa sách | [data-action=delete] → renderBookCards() → handleDeleteBook() (app.js:1835-1838, 2292-2309) | showCustomConfirm() → deleteBook() → refreshLibrary() | Mapping đúng. Nhánh lỗi lookup trước try có ghi ở Findings. |
| Import / paste / mẫu / backup | #file-input, #dropzone, #btn-open-paste, #btn-submit-paste, #btn-load-sample, #btn-backup-menu → bindEventListeners() (app.js:947-991, 1300-1316) | Parser/storage; modal; refreshLibrary() | Selector khớp HTML; dropzone ngăn default và propagation đúng mục đích. Các nút không nằm trong form. |
| Tìm tên sách trong Library | #library-search-input → filterLibraryCards() (app.js:974-977, 1849-1866) | Lọc title/author, cập nhật hiển thị và count | Không render lại card, nên listener card còn nguyên. Selector trong card khớp template. |
| Global Search | #btn-global-search, form/input, More và container results → bindEventListeners() (app.js:978-988) | searchIndexService, generation + AbortController; result có data-search-result-index; delegation → navigateToGlobalSearchResult() → mở sách/chương, focus match | Results dùng delegation nên replaceChildren() không làm mất listener. Keyboard Enter/Space và Escape được xử lý (app.js:2246-2287). Không thấy ID/dataset mismatch. CSS cursor affordance có finding riêng. |
| Reader: chương trước/sau | #btn-prev-chapter-nav, #btn-next-chapter-nav, bottom và dock buttons → navigateChapter() → loadChapter() (app.js:993-997, 1108-1114, 2705-2717) | state.currentBook/currentChapterIndex; progress/history; cập nhật Reader | Mapping đúng; biên chương đặt native disabled (app.js:2450-2454, 2496-2500). Stylesheet chưa có feedback riêng cho disabled. |
| TTS Play/Pause/Stop/Prev/Next | #btn-tts-* → state.tts.play/pause/stop/prev/next (app.js:1140-1158) | TTSEngine trong tts.js; status/chunk/progress/media callbacks | Gọi đúng API TTSEngine; không thấy bypass core safety guards. Core được audit tĩnh, không chạy audio runtime. |
| TTS rate/voice/preview/settings | #tts-rate-select, #tts-voice-select, dock preview/settings và modal controls → handlers app.js:1160-1274, 1204-1258 | TTSEngine.setRate/setVoice/setEngine/setCloudConfig và lưu setting/per-book | IDs khớp; browser/cloud value được phân nhánh; binding một lần khi khởi tạo. |
| AutoScroll / dock / FAB / Zen / theme / font | ID dock/FAB → binding app.js:1088-1105, 1276-1298, 1353-1367; theme/font theo class | AutoScrollEngine, state.isDockMinimized/isZenMode/settings; cập nhật CSS/style | Handler có mặt. CSS stacking giữa drawer backdrop và dock/FAB cần xác nhận runtime (P4). |
| TOC / Quotes / Bookmark drawer | Toggle/close/backdrop/search/tab → toggleTocDrawer/closeTocDrawer/switchDrawerTab; chapter item sinh động rồi gắn listener (app.js:1022-1029, 1332-1350, 2770-2798) | chaptersMeta/currentChapterIndex; loadChapter; renderQuotesHubList/renderBookmarkHubList | Backdrop chỉ đóng khi target đúng backdrop. chapter index parse bằng parseInt. Dynamic list được thay rồi bind lại, không tích lũy listener. |
| Bookmark: tạo / đến / sửa nhãn / xóa | #btn-dock-bookmark và card sinh trong renderBookmarkHubList() (app.js:3988-4021, 4146-4223) | bookmark.js capture/create/get/update/delete/resolve; navigation lock; cập nhật list | data-bookmark-id chuyển sang Number; form có type hợp lệ; submit preventDefault. Dynamic DOM bind sau render. |
| Quotes: export / đến / copy / delete | #btn-export-quotes-md; .btn-quote-* bind sau innerHTML (app.js:4317-4363) | highlight storage, clipboard, jumpToHighlight() | Nút con stopPropagation để không kích hoạt click card thêm lần nữa. Clipboard reject chưa có catch (P5). |
| Settings / Dictionary / Sleep Timer / Ambient | ID tĩnh được cache/bind; preset/track/rules render rồi gắn listener (app.js:1032-1086, 1406-1432, 4436-4529, 4686-4990) | settings storage, cleaner/rules, SleepTimer, AmbientSoundMixer | IDs khớp. Render children trước khi bind; không thấy stale listener/bind chồng. |
| Modal / confirm | Backdrop so event.target === modal; confirm bind/cleanup listener khi mở (app.js:980-983, 1035-1037, 1413-1416, 3227-3310) | open/close class; Promise true/false; Escape | Trigger mở ở ngoài modal/backdrop; không thấy open-click bubble rồi tự đóng. Cleanup của confirm có mặt. |
| Reading History | Open/back/clear/period/load-more; session action delegate từ historyGroups (app.js:929-945, 2936-3049, 3051-3069) | readingHistory.js; generation tránh render kết quả cũ; mở sách/xóa session | innerHTML không phá listener delegation. Generation được kiểm tra sau await chính. |
| Highlight / selection toolbar | Color/action buttons; reader content selection/click (app.js:1370-1404, 3678-3978) | highlight.js, storage highlight, quote hub | Color buttons stopPropagation đúng mục đích. Listener content nằm trên container persistent. |

## Findings đã xác minh từ source

| Control | Expected / observed | Root cause và evidence | Files/functions | Severity / phạm vi | Fix tối thiểu đề nghị |
|---|---|---|---|---|---|
| Search result .global-search-match-row | Click/Enter/Space mở kết quả; con trỏ nên thể hiện có thể click. Handler click và keyboard có, nhưng con trỏ hiển thị mặc định. | Selector khai báo cursor:pointer rồi ghi đè cursor:default ở dòng kế tiếp (styles.css:2786-2797). Lỗi affordance, không phải click handler. | styles.css | P5, local UX | Bỏ declaration cursor:default hoặc giữ pointer duy nhất. |
| Nút chương trước/sau tại biên | Native disabled ngăn action, nhưng không có feedback CSS đặc biệt. | loadChapter đặt .disabled (app.js:2450-2454, 2496-2500); styles.css có base/hover class (227-270, 1113-1138), không có :disabled/[disabled]. | styles.css | P3 UX, local | Thêm trạng thái disabled rõ ràng và bỏ hover cho chapter nav; giữ native disabled. |
| Xóa sách trên Library card | Lỗi đọc/xóa DB cần được báo cho người dùng. | handleDeleteBook await getBook() nằm trước try (app.js:2292-2300); caller không await/catch (1835-1838). Nếu lookup reject, toast trong catch xóa không chạy. | app.js renderBookCards/handleDeleteBook | P5, local, conditional | Bao lookup trong error handling và hiện toast; giữ confirm. |
| Copy quote .btn-quote-copy | Copy thành công hoặc báo lỗi. | writeText() chỉ có toast sau await, không catch rejection (app.js:4327-4339). Nếu Clipboard API từ chối, không có toast lỗi và Promise reject từ listener. | app.js renderQuotesHubList | P5, local, conditional theo quyền/context clipboard | Catch lỗi clipboard; chỉ hiện thành công sau write thành công. |
| TOC backdrop so với dock/FAB | Drawer backdrop nên nhận click ngoài panel; lớp panel nằm phía trên backdrop. | Backdrop z-index 50, panel 51; dock và FAB cùng z-index 50. Backdrop đứng trước dock/FAB trong DOM nên các control sau có thể được paint trên backdrop tại vùng chồng lấp (styles.css:737-770, 988-994, 1333-1339; thứ tự node trong index.html). | index.html, styles.css | P4, systemic hit-testing risk; chưa xác nhận hit target runtime | Kiểm tra elementFromPoint khi drawer mở, dock mở và minimized. Nếu dock/FAB nhận hit ngoài ý muốn, điều chỉnh riêng layer/order để backdrop phủ chúng và panel vẫn ở trên. |

## Lifecycle, delegation, locks, errors

- Init: DOMContentLoaded → cacheDOMElements() → PDF/storage/settings init (await) → khởi tạo TTS, AutoScroll, highlight, Dictionary, timer/audio → bindEventListeners() → refreshLibrary() → search index nền (app.js:191-209). bindEventListeners không được gọi từ openBook/loadChapter/render/reopen modal trong source đã kiểm tra.
- Persistent controls giữ nguyên node. Library/TOC/Bookmark/Quotes/Dictionary/Ambient thay children bằng innerHTML rồi gắn listener lên node mới; Search và History dùng delegation trên container không bị thay. Không thấy listener mất hoặc bind trùng trong các lifecycle đã trace.
- Modal backdrop kiểm tra target chính xác; không phát hiện event open rồi bubble vào backdrop cùng click. Confirm gỡ listener mỗi lần đóng.
- Global Search dùng generation/abort; History dùng historyLoadGeneration; Search/Bookmark navigation dùng pending flags và reset trong finally (app.js:2165-2231, 2936-3049, 4040-4116). Không thấy các lock đó bị giữ lại ở nhánh đọc được.
- isChapterSwitching (app.js:557-558, 663-785) có reset cho stop-at-end, hết sách, chunk lỗi, timeout và catch. Đây là core TTS được yêu cầu giữ nguyên; không sửa/bypass và chưa xác minh playback runtime.
- Một số listener async có error-feedback gap ghi ở Findings. Chưa có runtime console capture; không khẳng định các conditional rejection đã thực sự xảy ra.
- Không phát hiện selector ID sai/thiếu, duplicate listener, duplicate ID, hoặc control bị pointer-events chặn trong CSS đã kiểm tra. Điểm chồng lớp TOC/dock là rủi ro cần runtime hit-test.

## Checkpoint

- Tổng đã audit: **102 nút tĩnh**, đủ 84 ID nút, selector tĩnh liên quan và các nhóm action động trong inventory.
- Control được chứng minh “click không chạy”: **0 từ source**. Không thực hiện click runtime.
- Findings: cursor Search result bị override; chapter nav disabled thiếu feedback; nhánh lookup xóa sách không bắt lỗi; copy quote không bắt lỗi clipboard; rủi ro z-layer TOC/dock/FAB cần xác minh.
- Control có thể bị hiểu nhầm: prev/next chapter disabled hợp lệ ở biên; Search result có vẻ không action do cursor default dù click/keyboard binding có; các Reader action phụ thuộc state sách/chương; dock/FAB ẩn tùy mode.
- Duplicate ID/selector: không có. Duplicate listener/stale dynamic listener: không thấy.
- Runtime errors: chưa capture. Hai Promise rejection path có bằng chứng tĩnh như trên. Async navigation locks có finally; chapter switch core có reset/catch/timeout paths.
- Thứ tự Phase 2/3 đề nghị: (1) P3 disabled feedback; (2) xác nhận P4 bằng hit-test rồi mới chỉnh; (3) bắt lỗi lookup xóa sách và clipboard; (4) sửa cursor; (5) chỉ thay core TTS khi có reproduction runtime riêng, giữ nguyên safety guards hiện tại.

Phase 1 không sửa code ứng dụng. README và CHANGELOG không được cập nhật.
