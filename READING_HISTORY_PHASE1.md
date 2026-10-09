# VietReader Reading History + Timeline — Phase 1

## Phạm vi

Tài liệu này ghi nhận audit codebase hiện tại và quyết định thiết kế. Phase này không thêm tracking/UI, không thay đổi schema và không sửa README/CHANGELOG. Các mốc dòng dưới đây là tham chiếu đến implementation đã audit.

## 1. Audit implementation hiện tại

### Storage và dữ liệu

- Dexie database là `VietReaderDB`, schema cao nhất **version 5**. Các store: `books`, `chapters`, `settings`, `audioCache`, `customRules`, `highlights`, `searchIndex`, `bookmarks` (`storage.js:66-107`). `searchIndex` là derived cache; bookmarks/highlights là dữ liệu người dùng.
- Book được tạo ở `saveBookWithChapters()` có các trường chính: `id`, `title`, `author`, `coverGradient`, `totalChapters`, `currentChapterIndex`, `currentChunkIndex`, `scrollProgress`, `scrollY`, `wordCount`, `createdAt`, `lastReadAt` (`storage.js:116-148`). Record book không có field `readingProgress`; `scrollProgress` là phần trăm tiến độ tổng đang được truyền vào writer.
- Chapter lưu `id`, `bookId`, `chapterIndex`, `title`, `content`, `wordCount`; không có schema riêng cho chapter vì Dexie chỉ khai báo store và index.
- `countWords()` đếm các nhóm ký tự không phải whitespace (`/\S+/g`) (`parser.js:143-147`). Parser áp dụng cho văn bản nguồn trước cleaner; storage cũng có fallback đếm bằng `trim().split(/\s+/)` (`storage.js:138-144`). Vì token punctuation, markup/heading, cleaner và cách nhập khác nhau có thể làm lệch số, `chapter.wordCount` dùng được làm ước lượng/quy mô, không phải ground truth. UI hiện đếm lại nội dung đã clean để hiển thị từ/chương (`app.js:2276-2286`).
- Backup JSON hiện có `version: 4`; export gồm books, chapters, settings, customRules, highlights, bookmarks và không gồm audio/search cache (`storage.js:363-386`). Import replace/append xử lý các store user data hiện có; append remap ID book/chapter/highlight/bookmark (`storage.js:393-480`). Xóa book hiện xóa chapters/bookmarks trong transaction, rồi dọn search cache; chưa có reading history store để dọn (`storage.js:321-331`).

### Progress và lifecycle Reader

- `openBook()` lấy book + chapter metadata, gán state book, đổi view, chọn chapter đã lưu hoặc chapter đích, rồi gọi `loadChapter()` (`app.js:2168-2231`). Chuyển sách khi Reader đang mở không có lifecycle/history boundary riêng. `loadChapter()` dừng TTS và AutoScroll trước khi đọc chapter mới; cập nhật chapter hiện tại, render nội dung/metadata/TTS chunks, khôi phục scroll và gọi writer progress (`app.js:2236-2373`).
- `updateProgress(bookId, chapterIndex, scrollProgress, scrollY, currentChunkIndex)` ghi `currentChapterIndex`, chunk, phần trăm 0–100, `scrollY` và `lastReadAt=Date.now()` (`storage.js:304-316`). Do được gọi khi load chapter, scroll debounce và TTS chunk start, `lastReadAt` thực tế là “lần gần nhất writer tiến độ chạy”, không phải thời điểm session đọc bắt đầu/kết thúc.
- Scroll listener chỉ chạy khi Reader active; debounce 400 ms rồi ghi `scrollY`, phần trăm tổng và chunk (`app.js:2452-2471`). `calculateOverallProgress()` chia đều trọng số giữa số chapter, phần lẻ là `window.scrollY / (document scrollHeight - viewport)` (`app.js:2473-2487`). Đây là tiến độ UI/resume hiện có, không phải logical word progress. TTS chunk start cũng lưu `currentChunkIndex` cùng progress (`app.js:563-566`).
- Enter Reader xảy ra tại `openBook()`. Leave qua `showLibraryView()` dừng TTS/AutoScroll, ẩn Reader và về thư viện (`app.js:2556-2576`). Chapter previous/next gọi `loadChapter()` và không tự phát TTS lại (`app.js:2441-2450`). Auto-next sau TTS hoàn tất tự dừng, load chương kế, chờ 800 ms, xác thực nội dung/chunks rồi autoplay từ chunk 0 (`app.js:594-697`).
- Search/Bookmark có anchor navigation riêng, gọi `openBook()`/`loadChapter()` khi cần rồi scroll/focus anchor (`app.js:2021-2085`, `app.js:3503-3577`). `scrollIntoView()`/`window.scrollTo()` được dùng trong Reader, Search, Bookmark, TTS highlight và render; các sự kiện này không nên được xem tự động là người dùng activity.
- `app.js` không đăng ký `visibilitychange`, `pagehide`, `beforeunload` hay `unload` (không có lifecycle flush hiện tại). Không có session/history state machine.

### TTS, AutoScroll và timer

- Play request: `play()` đặt `isPlaying=true`, phát callback status `playing`, bật keepalive rồi mới gọi `speakCurrentChunk()` (`tts.js:343-359`). Resume phát `playing` sau lệnh resume (`tts.js:378-396`). Vì vậy `onStatusChange('playing')` là trạng thái yêu cầu/điều khiển, không phải bằng chứng playback đã thực sự phát.
- Browser Speech: chunk start được báo từ `SpeechSynthesisUtterance.onstart`; chunk end từ `onend`. Lỗi `interrupted`/`canceled` bị bỏ qua; lỗi khác có thể tự tăng index và đọc chunk tiếp (`tts.js:548-636`). Hết chunk cuối phát `completed`; current status có thể là `playing` trước sự kiện đó.
- Cloud: `speakCloudChunk()` gọi `emitChunkStart()` trước cache lookup/fetch và trước `audioElement.play()` (`tts.js:641-690`), nên hiện tại callback chunk start không chứng minh audio đã phát. `HTMLAudioElement.ended` mới là tín hiệu chunk hoàn tất; error fallback sang browser. Cần thêm callback actual-start/pause/resume/end/error dùng sự kiện audio (`playing`/`pause`/`ended`/`error`) và browser utterance start/end, tách khỏi status intent.
- Safe Utterance Cleanup hiện gỡ `onend`/`onerror`/`onstart` của utterance cũ trước `synth.cancel()`, và gỡ callback của utterance đã kết thúc/lỗi (`tts.js:504-517`, `566-574`, `604-614`). Stop cũng gỡ callback, cancel synth, pause/reset audio, thu hồi object URL, phát `stopped` (`tts.js:398-428`). Đây là vùng regression risk; History không được gọi `stop()` hay thay ownership của cleanup.
- Empty defense: `loadText()` tạo `[]` cho text trống; `play()` no-op khi chunks rỗng; `speakCurrentChunk()` stop nếu array rỗng; whitespace chunk được bỏ qua khi đang phát (`tts.js:296-340`, `346-348`, `479-546`). App auto-next còn dừng nếu nội dung mới trống/ngắn dưới 20 ký tự hoặc chunks rỗng (`app.js:650-684`).
- `isChapterSwitching` lock chỉ set cho nhánh status `completed` auto-next; được mở khi chunk đầu chương mới bắt đầu, có timeout 8s, hoặc nhánh lỗi/dừng (`app.js:507-509`, `594-697`). Circuit breaker chặn từ lần chuyển thứ ba trong rolling 5s (`app.js:602-613`). Manual chapter navigation không dùng lock này. History chỉ quan sát chapter thay đổi đã hoàn tất; không dùng lock làm session state.
- TTS `completed` được phát sau final chunk; app gọi `sleepTimer.notifyChapterEnd()`, và trước auto-next kiểm tra stop-at-chapter-end (`app.js:574-624`). Timed timer đếm bằng interval; expire dừng TTS, ambient audio và Media Session rồi reset volume/UI (`sleepTimer.js:45-63`, `169-179`; `app.js:4296-4320`). Timer expire vì vậy kết thúc TTS activity, không nhất thiết kết thúc Reading Session nếu Reader vẫn được dùng.
- AutoScroll có `start()`, `stop()`, toggle; pause/resume tự động 2s khi wheel/touch và 1.5s sau khi rời dock, không có public pause/resume riêng (`autoscroll.js:41-53`, `75-117`, `150-195`). RAF tự clamp delta tối đa 100ms khi tab bị chậm; bottom trong 6px thì stop và gọi callback (`autoscroll.js:201-232`). App bottom callback đợi 1.5s rồi `navigateChapter(1)` nếu còn chương (`app.js:3074-3107`).
- Media Session play/pause/stop handlers gọi callback tương ứng; app callback điều khiển TTS. Silent audio chỉ giữ Media Session nền, không đại diện audio sách (`mediaSessionHelper.js:143-219`, `app.js:4490-4541`). TTS status hiện đồng bộ playback state/ambient, nhưng do status `playing` sớm nên không dùng nó làm clock nguồn (`app.js:574-592`).

### Search, bookmark, UI và test

- Search/Bookmark navigation là các lệnh jump có chủ đích, dùng paragraph anchor/context; đây là integration points cho tín hiệu `jump` có origin, không phải scroll activity (`searchNavigation.js`, `bookmark.js`, `app.js:2021-2085`, `3503-3577`). Reader hiện có progress bar/phần trăm, chapter meta, ToC/Quotes/Bookmarks; `index.html` và `styles.css` chưa có Reading History/Timeline dashboard.
- Test hiện là Node ESM với `node:assert/strict`, chạy file độc lập; `test_parser.mjs` kiểm tra parser và một số module TTS/AutoScroll/SleepTimer/Media Session bằng stubs. README liệt kê thêm test riêng cho search/bookmark/storage và source-contract checks; chưa có browser interaction suite (`README.md:433-456`). Phase này không chạy test/build theo brief.

## 2. Quyết định semantics

### Time

- **Session Duration** = wall-clock span `endedAt - startedAt` của một session book; có thể bao gồm short idle/pause được giữ trong session. Không dùng số này làm Dashboard reading time.
- **Active Reading Time (`activeDurationMs`)** = tổng các khoảng được phân loại là đọc chủ động hoặc nghe TTS thực sự phát. Reading và TTS là các tập con hợp; `activeDurationMs` luôn là union, không cộng TTS lần hai.
- **TTS Listening Time (`ttsDurationMs`)** = tổng các khoảng actual playback; luôn là subset của Active Time. TTS đang tải audio, play request chưa thành công, paused/stopped/error hoặc Media Session silent audio không được tính.
- **Idle Time** = Reader còn mở nhưng không có qualifying activity/playback. Idle không cộng active. Với một tương tác người dùng, inactivity grace 60 giây được tính là active ước lượng; khi hết grace thì trạng thái chuyển idle và accumulator dừng tại deadline đó. Đây là ước lượng rõ ràng, không tuyên bố chính xác sinh lý.
- `activeDurationMs` và `ttsDurationMs` là elapsed wall milliseconds, không suy từ số chunk/word/rate và không cộng hai loại hoạt động chồng nhau. TTS subset duy trì `ttsDurationMs <= activeDurationMs`.

### Session start, pause, resume, end

- Một session thuộc đúng **một book**. Chỉ tạo khi Reader đã load book/chapter thành công và nhận qualifying activity đầu tiên (scroll/navigation/AutoScroll/actual TTS); mở book đơn thuần không tự tạo session.
- Inactivity 60 giây pause accumulator nhưng giữ session đang mở để có thể resume. Resume trong vòng 30 phút từ last qualifying activity dùng lại session hiện tại. Từ 30 phút trở lên, đóng session cũ tại idle deadline (`lastActivityAt + 60s`), khi có cơ hội flush; activity sau đó mở session mới.
- Book switch: flush/end session book cũ trước khi state chuyển sang book mới; chỉ bắt đầu session mới khi book mới load thành công và có qualifying activity.
- Leave Reader: end session sau flush; reload/crash: session còn `endedAt: null` được recover khi app init, cắt effective end tại `safeCheckpointAt`/last persisted active endpoint, rồi đóng record để tránh cộng thời gian app đã chết. `pagehide` flush là best-effort, không phải bảo đảm duy nhất.
- `visibilitychange` sang hidden dừng manual reading clock ngay. Nếu actual TTS vẫn phát, chỉ TTS interval tiếp tục được tính; khi playback dừng/lỗi và Reader vẫn hidden thì active clock dừng. Khi visible lại không tự resume active reading: chờ activity mới hoặc actual TTS.
- Manual chapter changes và app auto-next giữ cùng session nếu cùng book và chưa quá long-idle. Book switch luôn tách session. Chapter transition tự nó không cộng completion.

### Activity signals

- Qualifying direct activity: wheel/scroll/touch (trusted user events), reader keyboard navigation, prev/next chapter, click TTS chunk, scrubber seek, Search/Bookmark jump, TTS play/resume chỉ khi actual playback bắt đầu, và bật AutoScroll.
- Synthetic/programmatic scroll từ `scrollTo`, `scrollIntoView`, render/layout restore, TTS highlight/autoscroll-to-chunk không reset inactivity. Với scroll, lọc `event.isTrusted` và bỏ qua khoảng programmatic scroll có gắn cờ/origin; không dùng listener `scroll` làm activity duy nhất.
- AutoScroll được bật bởi user là active reading trong lúc engine `isActive && !isPaused`; khoảng temporary pause, dock pause, stop và bottom callback không tính AutoScroll active. Bottom được gửi như completion evidence, không coi delayed chapter load là user activity.
- Search/Bookmark jump tạo signal loại `jump` và cập nhật anchor baseline; khoảng nội dung bị nhảy qua không được tính là từ đã đọc.

### TTS actual lifecycle

- Giữ các callback hiện có để UI/compatibility; History nhận lifecycle mới phân biệt intent với actual playback.
- Browser: actual start ở `utterance.onstart`, actual pause/resume theo pause state của SpeechSynthesis khi có thể xác định; actual end ở `onend`; error/cancel/stop đóng khoảng ngay. Bỏ qua callbacks của utterance cũ theo identity/token như Safe Cleanup hiện tại.
- Cloud: start khi audio element thực sự phát (`playing`/`play` đã resolve phù hợp); pause/resume theo audio events; end ở `ended`; error/rejected play đóng actual segment trước fallback. Browser fallback mở segment mới khi utterance thực sự start.
- Chunk transition không kết thúc session. Không tạo row hay flush DB mỗi chunk; chunk start/end chỉ cập nhật in-memory time/anchor checkpoints. Chapter completion chỉ được phát một lần khi final TTS chunk kết thúc tự nhiên, không phải stop/error.
- Không dùng `onStatusChange('playing')` hoặc Cloud `onChunkStart` hiện tại làm actual-start vì cả hai đến sớm hơn playback thực.

## 3. Word và chapter metrics

- `chapter.wordCount` chỉ là ước lượng mẫu số. Ưu tiên anchor logical theo paragraph/token index trên nội dung Reader đã normalize/clean, vì progress UI hiện tại chỉ là tỷ lệ scroll toàn document.
- Words/session estimate tính theo forward coverage kể từ anchor gần nhất, quy đổi tỉ lệ bằng chapter word estimate. Backward navigation không trừ; replay cùng chunk/đoạn đã tính trong cùng session không cộng lần hai. Jump/seek/Search/Bookmark rebase baseline và không credit khoảng bị nhảy qua. Không suy words từ thời lượng TTS/rate.
- Lưu `startChapterIndex`, `endChapterIndex`, `wordsReadEstimate`, high-water/current anchor cần resume aggregation; tránh record mỗi paragraph/scroll/chunk. Có thể coi đọc lại ở session khác là lần đọc mới; metric cần gắn nhãn estimate.
- Chapter completion: chỉ tăng một lần mỗi chapter/session khi có evidence: final TTS chunk completed tự nhiên, AutoScroll chạm bottom, hoặc người dùng bấm Next khi đã gần cuối (>=90% logical/scroll progress). `loadChapter(next)` đơn thuần, Search/Bookmark jump và mở chapter khác không phải completion. Near-end rồi bấm Next là evidence rõ hơn chỉ near-end.

## 4. Local day và midnight

- Dashboard day theo local calendar date. Today từ local midnight tới now; 7 ngày = hôm nay và 6 ngày lịch trước; 30 ngày = hôm nay và 29 ngày lịch trước. Không tính bằng `now - N*24h`.
- Một session giữ một record; accumulator giữ bucket gọn theo local day `{date, activeDurationMs, ttsDurationMs, wordsReadEstimate, chaptersCompleted}`. Khi interval đi qua local midnight, cắt contribution tại timestamp của nửa đêm kế tiếp được tạo bằng local date constructor (DST-safe). Không lưu event theo scroll/chunk.
- Dashboard aggregate từ daily buckets, không phân bổ đều `session.activeDurationMs` theo span. Chuyển timezone giữa một session là edge case: date key được chụp theo local calendar tại thời điểm interval tích lũy.

## 5. Storage và module architecture

- Thêm module riêng `readingHistory.js`; `app.js` chỉ forward lifecycle/activity/chapter/progress signals từ các state owner đang có. Module history quan sát Reader, không tạo state machine Reader thứ hai.
- Thêm Dexie store `readingSessions`, store version tăng từ 5 lên 6. Đây là **user data**: phải export/import và xóa theo book trong cùng lifecycle/transaction; không nằm trong cache search/audio. Backup JSON version tăng có migration/compatibility cho backup cũ.
- Một record/session có các field: `id`, `bookId`, `startedAt`, `endedAt`, `activeDurationMs`, `ttsDurationMs`, `startChapterIndex`, `endChapterIndex`, `wordsReadEstimate`, `chaptersCompleted`, `safeCheckpointAt`, anchor/high-water metadata và daily buckets. Implementation Phase 2 dùng string `id` (UUID) làm primary key để retry `put()` idempotently khi write fail; schema v6 chỉ index `bookId` và `startedAt`, không thêm compound/endedAt index khi chưa có query cần chúng.
- Giữ accumulator trong memory; flush lúc mỗi 15 giây và tại idle/pause, chapter/book transition, Reader leave, visibility hidden, timer stop, pagehide (best effort). Không flush từng scroll/chunk. `safeCheckpointAt` chỉ tăng sau write thành công.
- Không thêm `readingEvents`: session + daily buckets đủ cho time-series dashboard, không có nhu cầu audit trail theo từng input. Nếu sau này cần seek-level replay analytics thì xem xét riêng.
- Query tối thiểu: sessions theo book và date range; daily contribution aggregation; book latest session. Dùng local midnight boundaries; giữ calculations thuần trong module để unit test riêng.

## 6. Integration points dự kiến

1. `storage.js`: schema v6/store API, CRUD/query/atomic per-book delete, backup export/import/replace/append/remap IDs.
2. `readingHistory.js`: session accumulator, 60s idle/30m split timers, actual TTS intervals, local-day buckets, anchor metrics, flush/recovery/query.
3. `app.js`: sau thành công `openBook/loadChapter`, trước book state switch, trong `showLibraryView`, `navigateChapter`, auto-next, Search/Bookmark jump, trusted activity handlers, AutoScroll state/bottom, `visibilitychange`, `pagehide`, sleep timer stop.
4. `tts.js`: callback actual playback boundaries cho Web Speech và Cloud audio, giữ Safe Utterance Cleanup; actual error/fallback segmentation.
5. Dashboard UI phase sau: thêm view/entry point trong `index.html`, styles trong `styles.css`, query aggregate read-only qua module history.
6. Tests phase implement: storage migration/backup/delete/ID remap; deterministic fake clock idle/session/midnight; fake TTS events including cloud rejected play/fallback and stale utterance; trusted vs synthetic activity; jump/backward/replay/near-end completion; recovery/pagehide best effort. Không thực hiện trong Phase 1.

## 7. Regression risks

- Không đổi semantics hiện hữu của `books.lastReadAt`, `scrollProgress`, `scrollY`, `currentChunkIndex` hay thứ tự ưu tiên resume. History writer phải tách khỏi `updateProgress()` để activity logging không vô tình làm đổi resume/last-read behavior.
- `openBook()` hiện gán `state.currentBook` trước khi `loadChapter()` dừng TTS cũ; implement cần đóng session cũ trước đổi book identity để callback TTS đang chạy không gán duration/chapter sang book mới.
- TTS final event và auto-next diễn ra cùng callback chain; chapter completion phải dedupe, và History không được chen vào Safe Cleanup/lock/circuit breaker sequencing.
- Cloud status/start callback hiện không phản ánh playback thật; dùng nhầm sẽ tính cả mạng chậm/fetch fail. Web Speech có thể trả callback cũ; token/identity guards cần được giữ.
- AutoScroll bottom chờ 1.5s mới navigate; cần hủy/đối soát timeout nếu user đổi chapter/book/leave trong lúc chờ để không gắn completion/transition sai.
- Search/Bookmark/TTS `scrollIntoView`, scroll restore và render có thể phát sinh scroll event; không lọc nguồn sẽ reset idle giả và đếm progress bị nhảy.
- Import append phải remap `readingSessions.bookId`; replace phải thay toàn bộ sessions; deleteBook phải cascade sessions. Thiếu bất kỳ nhánh nào sẽ làm orphan user data hoặc mất lịch sử.
- Session đang mở sau reload/crash và pagehide asynchronous write có rủi ro mất phần cuối; periodic checkpoint là cơ chế chính. Recovery không được tính khoảng giữa checkpoint và lần mở app lại.
- Chapter word count khác nhau theo nguồn/cleaner và chapter completion là estimate; phải hiển thị rõ estimated, không so sánh như số tuyệt đối.
- Midnight + DST + timezone change cần test riêng; không dùng UTC ISO date để đại diện local day.
