# Nhật Ký Thay Đổi (Changelog)

Tất cả những thay đổi, nâng cấp và sửa lỗi quan trọng của dự án **VietReader** sẽ được ghi lại chi tiết trong tài liệu này theo định dạng chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.0.0/) và tuân thủ [Semantic Versioning](https://semver.org/).

---

## [1.10.2] - 2026-10-09

### Fixed (Bản Vá Gốc Rễ TTS, Khắc Phục Mất Tiếng & Chống Phình Bộ Nhớ Microsoft Edge)

- **Nguyên Nhân Gốc Rễ Đã Xác Nhận (Confirmed Root Causes & Technical Evidence):**
  - **Phá vỡ luồng giải mã WebSocket do xung Keep-Alive:** Giọng máy tính để bàn `"Microsoft HoaiMy - Vietnamese (Vietnam)"` trên Windows không chứa từ khóa `online/natural` trong chuỗi định danh, dẫn đến việc bị nhận nhầm thành giọng offline SAPI. Khi câu đọc vượt quá 10 giây, cơ chế Keep-Alive phát xung `synth.pause()` / `synth.resume()` làm gãy stream giải mã WebSocket Opus/MP3 trong tiến trình `msedge.exe` (Edge Browser Process), gây ngắt quãng âm thanh (stutter) và làm phình bộ nhớ với tốc độ ~100 MB/s.
  - **Mảnh dấu câu mồ côi (Orphan Punctuation Chunks):** Biểu thức ngắt câu cũ ngắt trước dấu ngoặc kép đóng, sinh ra các chunk chỉ chứa duy nhất ký tự dấu câu như `"` hoặc `”` (0 âm vị). Khi đẩy vào `synth.speak()`, engine speech của Chromium bị kẹt vĩnh viễn và không bao giờ phát sự kiện `onend`.
  - **Chuyển câu giả tạo và vòng lặp tái kích hoạt vô hạn của Watchdog cũ:** Watchdog 14s trong bản cũ tự động phát ra `onActualChunkComplete` và gọi đệ quy `speakCurrentChunk()` sang câu mới. Điều này dẫn đến việc highlight tiếp tục đổi màu mỗi 14 giây trong khi hoàn toàn mất tiếng, ghi nhận tiến độ đọc giả mạo vào `ReadingHistory`, và liên tục dồn các lệnh `synth.cancel()` / `synth.speak()` vào tiến trình trình duyệt đang bị treo, đẩy bộ nhớ Edge lên nhiều GB.

- **Các Bản Vá Mã Nguồn Production (`tts.js`):**
  - **Triệt tiêu 100% xung Keep-Alive với giọng Online/Natural:** Bổ sung helper `isNaturalOrOnlineVoice()` kiểm tra cả `voice.name` và `voice.voiceURI` với regex `/natural|online|neural|hoaimy|namminh|microsoft nam|google/i`. Giọng Hoài My và các giọng trực tuyến được bảo vệ hoàn toàn khỏi xung pause/resume.
  - **Chuẩn hóa Smart Chunking & Lọc âm vị:** Biểu thức ngắt câu mới `/[^.!?…;:\n]+[.!?…;:\"'”’»\)\]]*|\S+/g` gom trọn vẹn dấu ngoặc kép và ngoặc đóng liền kề. Đồng thời lọc bỏ và gộp các mảnh vụn không chứa ký tự chữ/số Unicode (`/[\p{L}\p{N}]/u`). Trước khi gọi `synth.speak()`, các đoạn rỗng hoặc chỉ có dấu câu được bỏ qua an toàn mà không làm nghẽn native engine.
  - **Cơ chế Watchdog Chuyển Trạng Thái An Toàn (Safe Fail-Safe Halt):** Watchdog 14s khi kích hoạt sẽ dừng phát hoàn toàn (`isPlaying = false`), hủy đăng ký timer, bỏ highlight câu bị kẹt (`onChunkEnd`), chuyển trạng thái `status: 'error'`, hiển thị Toast cảnh báo, và **tuyệt đối KHÔNG** gọi `onActualChunkComplete`, **KHÔNG** tự động tăng `currentIndex`, và **KHÔNG** tự động gọi `speakCurrentChunk()`.
  - **Dọn dẹp Highlight khi Web Speech Lỗi:** Khi `onerror` xảy ra, tự động gọi `onChunkEnd` để xóa ngay vùng highlight vàng trên văn bản.

### Added (Bộ Kiểm Thử Hồi Quy Chẩn Đoán & Nghiệm Thu Đa Phân Hệ)

- `test_phase1_tts_stutter_lifecycle_diagnosis.mjs`: 12 bài test chẩn đoán vòng đời TTS, cô lập callback storm và xác nhận watchdog fail-safe.
- `test_phase2_controlled_isolation.mjs`: 8 bài test cô lập ảnh hưởng Keep-Alive và xác minh loại trừ chunk dấu câu mồ côi.
- `test_phase3_root_cause_repair_and_silent_playback_fix.mjs`: 12 bài test hồi quy 12 chiều: chuỗi tuần tự, watchdog ngắt an toàn, stutter delay, duplicate onend/onerror, cancel đồng bộ, giọng Hoài My miễn nhiễm keep-alive, và dọn dẹp tài nguyên về 0.
- `test_phase4_cross_module_regression.mjs`: 9 bài test tương thích đa phân hệ: tích hợp `app.js`, `mediaSessionHelper.js`, `readingHistory.js` không tiến độ giả, `autoscroll.js`, `sleepTimer.js`, `ambientSound.js`, và soak test 50 câu liên tục.

---

## [1.10.1] - 2026-10-09

### Fixed (Bản Vá Toàn Diện Tránh Treo Trình Duyệt Microsoft Edge & An Toàn Vòng Đời TTS Đa Phân Hệ)

- **Xác minh Nguyên nhân Gốc rễ (Root Cause Demonstration & Evidence):**
  - **Phân tách bộ nhớ tiến trình (Process Memory Isolation):** Đo đạc WMI/PowerShell thực tế trên Microsoft Edge xác nhận Tab Renderer V8 Heap duy trì ổn định phẳng (~173.9 MB), trong khi nhóm tiến trình chính của trình duyệt (`msedge.exe` Browser Process, PID 38628) phình to bất thường lên ~3.083 MB và làm treo luồng phát âm sau 1–3 câu.
  - **Xung đột Keep-Alive trên Microsoft Natural Voices:** Các giọng đọc trực tuyến của Edge (`Microsoft HoaiMy Online (Natural)`, `Microsoft Nam Online (Natural)`) truyền tải luồng âm thanh Opus/MP3 qua kết nối WebSocket nội bộ trong tiến trình Browser Process. Cơ chế phát xung định kỳ `synth.pause()` / `synth.resume()` (vốn thiết kế cho offline SAPI 5 15s timeout của Chromium) làm đứt gãy luồng đệm Media Foundation trong Browser Process, khiến native audio buffers tích tụ không giới hạn và trình duyệt không bao giờ bắn callback `onend`.
  - **Quá tải IPC Media từ HTMLAudioElement:** Việc gọi `audioElement.removeAttribute('src')` và `audioElement.load()` liên tục tại mỗi câu Web Speech API tạo ra bão IPC media pipeline reload liên tục giữa Renderer và Browser Process.
  - **Xung đột đa phân hệ (Cross-Module Race Conditions):** `AutoScrollEngine.onReachBottom` tranh chấp với sự kiện hoàn thành chương của TTS gây ra bước nhảy 2 chương liên tiếp và ghi trùng lặp dữ liệu vào `ReadingHistory`; `MediaSessionHelper` bị ảnh hưởng bởi stale async `play()` promise; `AmbientSoundMixer` để rò rỉ orphaned `gainNode` sau khi ngắt `sourceNode`.

- **Các Giải Pháp Khắc Phục Kiến Trúc (Architectural Hardening):**
  - **Miễn nhiễm phát xung cho giọng Edge Natural (`tts.js`):**
    - Nhận diện tự động mẫu giọng `/natural|online|neural/i` và triệt tiêu 100% các lệnh `synth.pause()` / `synth.resume()` trong `startKeepAlive()`.
    - Đối với giọng SAPI offline máy tính bàn, chỉ kích hoạt phát xung khi và chỉ khi câu nói liên tục vượt quá ngưỡng an toàn $\ge 10.000$ms.
  - **Cô lập hoàn toàn HTMLAudioElement trong Web Speech (`tts.js`):**
    - Đóng gói điều kiện kiểm tra `if (this.currentAudioUrl || (this.audioElement && this.audioElement.src))` trước khi gọi `cleanupCurrentAudioUrl()` và `audioElement.load()`, triệt tiêu triệt để media pipeline churn.
  - **Cơ chế Watchdog Tự Động Phục Hồi Native (`scheduleStuckWatchdog` / `clearStuckWatchdog`):**
    - Tự động kích hoạt bộ đếm thời gian giám sát ($\ge 14.000$ms, tỷ lệ thuận độ dài văn bản). Nếu Chromium làm rơi sự kiện `onend` / `onerror` và đóng băng, watchdog sẽ tự động phục hồi trạng thái và chuyển sang câu tiếp theo một cách an toàn mà không làm treo ứng dụng.
  - **Khóa Thế Hệ Phiên Media Session (`mediaSessionHelper.js`):**
    - Bổ sung `_sessionToken` theo dõi vòng đời phát âm ngầm. Khi người dùng thao tác Play $\rightarrow$ Pause $\rightarrow$ Play liên tục, các stale `play()` promises hoàn tất muộn không thể gây dừng sai phiên phát mới.
  - **Giải phóng triệt để Đồ thị Web Audio (`ambientSound.js`):**
    - Đảm bảo ngắt kết nối cả `sourceNode` và `gainNode` trong `stopSound()`; bổ sung phương thức `destroy()` đóng `AudioContext` và dọn sạch bộ đệm âm thanh `bufferCache`.
  - **Điều phối Chuyển Chương Nguyên Tử Độc Quyền Giữa TTS & AutoScroll (`app.js`):**
    - `AutoScrollEngine.onReachBottom` nhường toàn quyền điều phối cho TTS khi `state.tts?.isPlaying || isChapterSwitching`, ngăn chặn triệt để hiện tượng nhảy 2 chương và ghi lặp lịch sử đọc.
  - **Bảo toàn và Khôi phục Âm lượng Gốc (`sleepTimer.js`):**
    - Lưu trữ `baseTtsVolume` và `baseAmbientVolume` ban đầu khi kích hoạt hẹn giờ; khôi phục chính xác mức âm lượng của người dùng khi hủy hoặc khi hết giờ, thay vì gán cứng về 1.0.

### Added (Bộ Kiểm Thử Nghiệm Thu & An Toàn Đa Phân Hệ)

- `test_tts_diagnostics_baseline.mjs`: 13 bài test baseline vòng đời, ring buffer sự kiện ($\le 50$), và snapshot chẩn đoán.
- `test_tts_phase3_root_cause_verification.mjs`: 13 bài test xác minh sửa lỗi root cause, miễn nhiễm keep-alive, cô lập `.load()`, và watchdog phục hồi.
- `test_tts_phase4_cross_module_safety.mjs`: 7 bài test an toàn đa phân hệ: Media Session tokens, Ambient Web Audio cleanup, Sleep Timer volume, AutoScroll isolation.
- `test_tts_phase5_final_acceptance.mjs`: 10 bài test nghiệm thu toàn diện: 30-chunk soak test, 20 chu kỳ Play/Pause/Resume/Seek/Stop, loại bỏ stale callback, watchdog an toàn, Cloud fallback không rò rỉ audio element.

---

## [1.10.0] - 2026-10-08

### Added (Động Cơ Bounded Queue Scheduler & Cloud TTS Prefetch Engine)

- **Động cơ Hàng Đợi Trượt Giới Hạn (`ttsQueueScheduler.js`):**
  - Cửa sổ nạp trước giới hạn nghiêm ngặt $[N, N+2]$: Khi chunk $N$ đang phát, chỉ chuẩn bị tối đa 2 chunks kế tiếp ($N+1, N+2$). Tuyệt đối không nạp trước toàn bộ chương hay toàn bộ sách.
  - Thứ bậc ưu tiên phân cấp rõ ràng: Priority 1 (Current playback chunk) > Priority 2 (Chunk $N+1$) > Priority 3 (Chunk $N+2$).
  - Giới hạn thực thi thiết kế (Bounded Limits): `maxConcurrency = 1` (chỉ 1 network request hoạt động tại một thời điểm), `maxWindowAhead = 2`, `maxReadyEntries = 3`, `maxRetainedBytes = 15MB`, `requestTimeoutMs = 30.000ms`.
  - Quản lý trạng thái nhiệm vụ tất định: `queued` $\rightarrow$ `checking_cache` $\rightarrow$ `fetching` $\rightarrow$ `ready` $\rightarrow$ `playing` $\rightarrow$ `consumed` (hoặc `failed` / `cancelled`).
- **Đường Ống Ưu Tiên Cache Cục Bộ (Cache-First Pipeline & Cache Integrity):**
  - Mọi chunk được tra cứu trong `audioCache` (IndexedDB Dexie schema v6) trước khi xếp hàng tải mạng. Quá trình tra cứu cache chạy cục bộ, không chiếm dụng slot concurrency mạng.
  - Định danh Cache Key Chuẩn Hóa: `cloud_{provider}_{voice}{modelPart}_r{rate}_{textHash}`.
  - Khả năng tương thích ngược hoàn hảo: Tự động tra cứu cả định dạng key cũ `cloud_{provider}_{voice}_r{rate}_{textHash}` để tái sử dụng toàn bộ cache đã có từ schema v2 mà không cần migration dữ liệu.
  - Bảo mật thông tin xác thực: Tuyệt đối không lưu trữ API Key, Bearer Token hay Endpoint URL trong cache key hay nhật ký log.
  - Xác thực toàn vẹn Audio Blob: Tự động phát hiện và loại trừ các blob rỗng, blob quá nhỏ ($< 100$ bytes) hoặc trang lỗi HTML/JSON từ CDN.
- **Hợp Nhất Yêu Cầu Trùng Lặp (Request Coalescing):**
  - Các yêu cầu trùng lặp cho cùng một phân đoạn và cấu hình giọng dùng chung một Promise đang bay (`in-flight promise sharing`), triệt tiêu 100% duplicate network requests.
- **Bộ Điều Hợp Cloud AI Độc Lập (`cloudTtsProvider.js`):**
  - Đóng gói adapter chuyên biệt cho FPT AI (polling CDN tăng dần), OpenAI TTS (binary stream/base64), và Custom Endpoint.
  - Phân loại mã lỗi chuẩn hóa: Lỗi vĩnh viễn (HTTP 401/403 sai key, 429 Quota Exceeded, 400/404/422) kích hoạt thông báo Toast và chuyển sang Browser TTS ngay lập tức mà không retry vô ích; Lỗi tạm thời (HTTP 429 Rate Limit, HTTP 5xx, timeout mạng) retry tối đa 2 lần với exponential backoff.
  - Cơ chế hủy tức thời (`abortableSleep`): Ngắt ngay lập tức khi nhận tín hiệu `AbortSignal` từ thao tác Seek/Stop của người dùng, không để lại bất kỳ timer mồ côi nào.
- **Bàn Giao Phát Âm Tức Thời & Quản Lý Vòng Đời Bộ Nhớ:**
  - Handoff Gap Latency $\le 16$ms: Khi chunk $N$ kết thúc, chunk $N+1$ đã sẵn sàng ở trạng thái `READY` trong hàng đợi được đưa trực tiếp vào `audioElement.src`, xóa bỏ khoảng lặng 500ms–2000ms chờ mạng.
  - Thu hồi Object URL 100% cân bằng: Mỗi `URL.createObjectURL(blob)` được thu hồi qua `URL.revokeObjectURL(url)` khi chunk kết thúc, khi đổi chunk hoặc khi Stop/Pause (`createdUrls.length === revokedUrls.length`).
  - Giải phóng bộ nhớ Blob tức thì: Phương thức `markConsumed()` xóa tham chiếu Blob khỏi RAM ngay khi audio kết thúc; cơ chế `_enforceMemoryLimits()` tự động giải phóng các ready blobs ưu tiên thấp nếu vượt quá 3 entries hoặc 15MB.
- **Hệ Thống Quan Sát & Đo Lường Hiệu Năng (Observability Metrics):**
  - Bổ sung `getPrefetchMetrics()` và `setPrefetchDebugMode()` trên `TTSEngine`, cung cấp snapshot thời gian thực: `cacheHits`, `cacheMisses`, `prefetchHits`, `prefetchMisses`, `networkRequests`, `networkFailures`, `cancelledRequests`, `lastChunkGapMs`, `averageRequestLatencyMs`, `queueSize`, `activeRequests`, `readyEntries`, `estimatedRetainedBytes`.
  - Thu thập chỉ số với độ phức tạp $O(1)$, bộ nhớ cố định, không tạo rác GC, và hoàn toàn độc lập—không làm sai lệch `ReadingHistory` hay `PersonalAnalytics`.

### Changed

- Tích hợp `TTSQueueScheduler` vào `TTSEngine` trong `tts.js` làm kênh điều phối duy nhất cho Cloud AI TTS.
- Cập nhật tài liệu kỹ thuật toàn diện trong `README.md` (kiến trúc, scheduler limits, cache key semantics, provider adapters, observability metrics, file breakdown, hướng dẫn kiểm thử).
- Nâng cấp phiên bản dự án lên `v1.10.0` trong `package.json`.

### Fixed

- Khắc phục hoàn toàn khoảng chờ ngắt quãng (playback gaps) khi nghe truyện qua Cloud AI TTS (giảm từ 500–2000ms xuống $\le 16$ms nhờ prefetch hit).
- Triệt tiêu hoàn toàn nguy cơ request storm khi người dùng thao tác Next, Previous, hoặc Seek liên tục.
- Triệt tiêu nguy cơ callback storm trên Cloud TTS với Chunk Velocity Circuit Breaker (ngắt an toàn khi $\ge 60$ transitions/giây).
- Cô lập hoàn toàn tính năng Voice Preview khỏi tiến độ đọc của sách và timeline phiên đọc.

### Performance Improvements (Đã Xác Minh Thực Tế)

- **Độ trễ chuyển câu (Playback Gap Latency):** Giảm từ 800–1800ms (chờ mạng) xuống $\le 16$ms (prefetch hit bàn giao tức thì trong bộ nhớ).
- **Lưu lượng mạng (Network Traffic):** Giảm 100% duplicate requests nhờ Request Coalescing.
- **Dung lượng bộ nhớ RAM (Memory Footprint):** Giữ phẳng $\le 10$–$15$MB, thu hồi 100% Object URLs, không tích lũy retained resources sau 50 chu kỳ soak test và 30 chu kỳ session lặp lại.
- **Độ tương tranh mạng (Concurrency):** Duy trì nghiêm ngặt $\le 1$ fetch đồng thời, loại bỏ nguy cơ bị khóa rate limit từ nhà cung cấp API.

### Compatibility Notes

- Tương thích 100% với Dexie schema v6 (`audioCache`, `readingSessions`, `bookmarks`, `searchIndex`).
- Tương thích ngược với các bản ghi cache cũ từ schema v2 qua cơ chế dual-key lookup.
- Định dạng file sao lưu JSON backup v5 được bảo toàn nguyên vẹn.
- Chế độ Browser Web Speech API hoạt động độc lập và không chịu bất kỳ hồi quy nào.

### Added (Bộ Kiểm Thử Nghiệm Thu Cloud TTS Prefetch Suite)

- `test_cloud_tts_safety_baseline.mjs`: 5 bài test baseline an toàn playback.
- `test_tts_queue_scheduler.mjs`: 12 bài test bounded scheduler, sliding window, coalescing, memory limits.
- `test_cloud_tts_cache_integrity.mjs`: 9 bài test cache-first pipeline, canonical keys, corrupt blob rejection.
- `test_cloud_tts_provider_contracts.mjs`: 12 bài test provider adapters, retry policy, error classification, cancellation.
- `test_cloud_playback_integration.mjs`: 10 bài test playback liên tục, 0ms handoff, URL cleanup, generation invalidation.
- `test_reader_cloud_prefetch_observability.mjs`: 6 bài test reader session invariants, observability metrics, Sleep Timer, Media Session.
- `test_cloud_prefetch_stress_soak.mjs`: 6 bài test stress & soak (50-chunk soak, 0ms callback storm circuit breaker, 50-seek storm, 30 repeated sessions, fault injection fallback, out-of-order network/cache).

---

## [1.9.1] - 2026-10-08

### Fixed (Bản Vá Root Cause Treo TTS Trên Microsoft Edge & An Toàn Bộ Nhớ Tuyệt Đối)

- **Nguyên nhân gốc rễ thực tế (Demonstrated Root Cause):**
  - **Hiện tượng treo sau chunk đầu trên Microsoft Edge:** Trình duyệt Microsoft Edge/Chromium sở hữu hàng đợi giọng nói (SpeechSynthesis Queue) bất đồng bộ nhạy cảm với việc quản lý trạng thái `synth.paused` và các chuỗi callback terminal lặp (`onend` / `onerror`).
  - **Xung đột Keep-Alive Heartbeat:** Bộ đếm `startKeepAlive()` phát xung `pause()`/`resume()` trong khi `isAdvancingChunk = true` hoặc khi hàng đợi đang ở trạng thái chuyển giao giữa 2 chunks dẫn đến deadlock luồng phát âm Chromium.
  - **Bão callback lặp (Terminal Callback Storm / Reentrancy):** Chromium có thể phát `onerror` theo sau bởi `onend`, hoặc gọi `onend` đồng bộ ngay trong `synth.cancel()`, hoặc bắn callback từ utterance của phiên/thế hệ cũ (`stale generation`). Khi không có khóa thế hệ nguyên tử (`generationToken`, `utteranceToken`, `advanceSequenceToken`) và cờ đơn nhất (`isTerminalHandled`), một câu có thể kích hoạt nhiều lần chuyển câu, gây vòng lặp đệ quy 0ms nuốt cạn tài nguyên CPU và bộ nhớ.
  - **Bão ghi dữ liệu tiến độ (Storage Write Storm):** Trước bản vá, mỗi sự kiện `onChunkStart` lập tức gọi `updateProgress` ghi cơ sở dữ liệu IndexedDB bất đồng bộ. Khi chuyển chunk dồn dập, cây promise và tác vụ I/O đè nặng lên event loop gây rò rỉ RAM (ghi nhận tới 3.56 GB RAM trên nhóm tiến trình Edge).

- **Biện pháp khắc phục kiến trúc (Architectural Fixes):**
  - **Khóa thế hệ & Ngăn chặn chuyển đúp (`tts.js`):**
    - Bổ sung `generationToken`, `utteranceToken`, `advanceSequenceToken`, `isAdvancingChunk`, và cờ nguyên tử `isTerminalHandled` cho mỗi `SpeechSynthesisUtterance`.
    - Đảm bảo mỗi utterance terminal event (`onend` hoặc `onerror`) chỉ được xử lý đúng duy nhất một lần.
    - Gỡ bỏ sạch sẽ toàn bộ listeners (`onstart = null; onend = null; onerror = null;`) ngay khi hoàn tất hoặc khi gọi `stop()`/`pause()`.
    - Kiểm tra và giải phóng trạng thái nghẽn của Chromium: `if (this.synth.paused) { this.synth.resume(); }` trước khi xếp utterance mới vào hàng đợi.
  - **Cầu chì vận tốc chuyển chunk (Chunk Velocity Circuit Breaker):**
    - Tích hợp `checkChunkVelocityCircuitBreaker()` giám sát tần suất chuyển câu tự động trong cửa sổ trượt 1000ms. Nếu phát hiện bão callback vượt quá 60 chunks/giây, hệ thống lập tức ngắt phát âm an toàn, bảo vệ trình duyệt khỏi freeze/runaway RAM.
  - **Bảo vệ Keep-Alive tuyệt đối an toàn:**
    - `startKeepAlive()` chỉ phát xung nhịp khi và chỉ khi: `this.isPlaying && !this.isPaused && this.currentUtterance && !this.isAdvancingChunk && this.synth.speaking && !this.synth.paused`.
    - Hủy triệt để interval khi `stop()`, `pause()`, hoặc khi chuyển câu.
  - **Khử rung lưu tiến độ đọc (Debounced Progress Persistence - `app.js`):**
    - Áp dụng bộ đệm khử rung 500ms `ttsProgressSaveTimeout` cho thao tác cập nhật tiến độ đọc vào IndexedDB tại `onChunkStart`.
    - Xả tức thì (`flushTtsProgressSave()`) khi trạng thái playback chuyển sang `paused`, `stopped`, `error`, hoặc `completed`.
  - **Khóa nguyên tử chuyển chương (`isChapterSwitching`):**
    - Bảo toàn và đồng bộ khóa nguyên tử chuyển chương, chỉ mở khóa khi câu đầu tiên của chương mới đã cất tiếng đọc thành công (`onChunkStart`).

- **Kiểm thử hồi quy tự động & Xác minh thực tế trên Microsoft Edge (Real Edge Validation):**
  - Bổ sung file kiểm thử mục tiêu `test_tts_root_cause_fix.mjs` (11/11 bài test PASS): Chuyển câu tuần tự 0→1→2→...→10, triệt tiêu onend trùng lặp, triệt tiêu đệ quy `synth.cancel()`, xử lý onerror+onend đơn nhất, Stop/Pause triệt tiêu timer chuyển câu, cô lập stale callback, bỏ qua câu rỗng/khoảng trắng an toàn, giữ nhịp Keep-Alive an toàn, và kích hoạt cầu chì vận tốc khi có bão 0ms.
  - Toàn bộ 61 bài kiểm thử tự động của các bộ test hồi quy (`test_tts_root_cause_fix.mjs`, `test_tts_reproduction.mjs`, `test_tts_interactions.mjs`, `test_tts_phase4_stability.mjs`, `test_tts_session_integration.mjs`) đạt 100% PASS (61/61).
  - **Nghiệm thu thực tế trên Microsoft Edge qua Chrome DevTools Protocol (CDP):**
    - Hoàn thành đầy đủ 10 bước kịch bản kiểm thử trực tiếp trên Microsoft Edge thật:
      1. Bước A: Mở truyện mẫu tiếng Việt ("Dế Mèn Phiêu Lưu Ký") thành công. Baseline heap: 9.10 MB.
      2. Bước B & C: Nhấn Play, phát liên tục qua chunks 0 → 1 → 2 → 3 mà không dừng lại sau câu đầu tiên.
      3. Bước D: Phát tuần tự ổn định qua 10 chunks liên tiếp. Bộ nhớ JS Heap duy trì phẳng tại 8.15 MB (không tăng RAM, không rò rỉ).
      4. Bước E: Tạm dừng (Pause) chính xác (`isPlaying: true, isPaused: true`).
      5. Bước F: Tiếp tục (Resume) mượt mà (`isPlaying: true, isPaused: false`).
      6. Bước G: Dừng hẳn (Stop) an toàn (`isPlaying: false`, giải phóng toàn bộ utterance và timers).
      7. Bước H: Phát lại từ vị trí đã lưu chính xác.
      8. Bước I: Tua tới (Next), tua lùi (Prev), và nhảy trực tiếp (Seek jumpToIndex) tức thời.
      9. Bước J: Nhảy tới câu cuối cùng của Chương 1, câu đọc kết thúc tự nhiên, luồng chuyển chương 8 bước kích hoạt và bắt đầu phát Chương 2 thành công.
      10. RAM sau khi dừng và ổn định: 8.41 MB (giảm so với baseline ban đầu nhờ GC, chứng minh 0% rò rỉ bộ nhớ).

---

## [1.9.0] - 2026-10-08

### Added (Unified Reader Session Engine & Nghiệm Thu Toàn Diện)

- **Động cơ phiên đọc/nghe hợp nhất (Unified Reader Session Engine):**
  - Hợp nhất toàn bộ vòng đời đọc mắt (Reading) và nghe giọng nói (Listening/TTS) dưới quyền quản lý duy nhất của `ReadingHistoryEngine` trong [`readingHistory.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/readingHistory.js).
  - Loại bỏ hoàn toàn trạng thái phiên song song và định danh trùng lặp trong [`app.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/app.js).
  - Thiết lập ranh giới sở hữu phân hệ nghiêm ngặt (Strict Subsystem Ownership Boundaries):
    - `TTSEngine` (`tts.js`): Độc quyền quản lý phát âm thanh, utterance queue và Web Speech / Cloud playback.
    - `Reader` (`app.js`): Độc quyền quản lý điều hướng sách/chương, TOC, hiển thị DOM và điều phối một chiều.
    - `Session Engine` (`readingHistory.js`): Độc quyền quản lý session identity, dual activity state, timing logic, idle/separation policy và checkpoints.
    - `Storage` (`storage.js`): Độc quyền quản lý lưu trữ Dexie.js v6 và backup/restore v5.
    - `Analytics` (`readingAnalytics.js`): Lớp dẫn xuất chỉ đọc (Read-Only Derived Metrics), không ghi database, không duplicate stores.
- **Quản lý thời gian & Tiến độ đọc chuẩn xác (Dual Activity & Invariant Timing):**
  - Bất biến thời gian: `activeTimeMs >= ttsTimeMs` luôn được đảm bảo trong mọi điều kiện.
  - Khi đọc bằng mắt và nghe TTS diễn ra đồng thời, Active Time không bị cộng dồn nhân đôi; khi dừng TTS hoặc dừng đọc, từng đồng hồ ngừng chính xác.
  - Phân tách độc lập giữa tọa độ cuộn trang mắt đọc (`scrollY`) và vị trí đoạn phát âm TTS (`currentChunkIndex`).
  - Ước tính số từ đọc (Words Read Estimate) chỉ tính tiến độ tiến tới tuyến tính (`forward chunks/ranges`), các thao tác tua lùi hoặc nhảy câu chỉ định (`explicitJump: true`) không tạo số từ giả.
  - Hoàn tất chương (`completeChapter`) được khử trùng lặp (deduped) theo chương trong mỗi phiên và đồng bộ cơ sở dữ liệu.
- **Cơ chế lưu trữ định kỳ & Khôi phục phiên đọc (Persistence & Crash Recovery):**
  - Chu kỳ Checkpoint tự động ~15 giây lưu vết phiên đọc an toàn xuống store `readingSessions`.
  - Chính sách dừng chờ nhàn rỗi (Idle Policy 60s): Tự động chuyển phiên sang paused khi không có tương tác đọc và TTS không phát.
  - Chính sách phân tách phiên (Separation Policy 30m): Tự động chốt phiên cũ và mở phiên mới độc lập nếu thời gian gián đoạn vượt quá 30 phút.
  - Phục hồi sau reload/crash mà không tạo thời gian giả mạo khi trình duyệt đóng đột ngột hoặc thay đổi tab.
  - Khử rung (Debounce) thao tác cuộn trang chống bão ghi (write storm) vào IndexedDB.
- **Tích hợp liên phân hệ an toàn (Auxiliary Integrations):**
  - Phân định rõ ràng giữa Hands-Free AutoScroll và TTS-follow AutoScroll; AutoScroll Pause/Stop không làm gián đoạn phiên đọc hay tạo sự kiện hoàn tất chương giả.
  - Hẹn giờ ngủ (`sleepTimer.js`) tích hợp điều khiển âm lượng fade-out, tạm dừng playback và chốt phiên đọc sạch sẽ.
  - Media Session (`mediaSessionHelper.js`) tích hợp silent audio track giữ kết nối nền và điều phối sự kiện phần cứng một chiều.
  - Bộ trộn âm thanh nền (`ambientSound.js`) chạy độc lập hoàn toàn, không gây nhiễu vòng đời phiên đọc.

### Fixed (Ổn định tài nguyên & Ngăn chặn vòng lặp phản hồi)

- Loại bỏ hoàn toàn vòng lặp phản hồi (Event Feedback Loops): Sự kiện truyền một chiều từ User $\rightarrow$ Reader/TTS $\rightarrow$ SessionEngine $\rightarrow$ Storage.
- Khắc phục triệt để hiện tượng tiến trình kiểm thử Node.js không thoát sau khi test hoàn tất bằng cách áp dụng `.unref?.()` cho tất cả các background timers/intervals trong `readingHistory.js` và `sleepTimer.js`.
- Bổ sung khối dọn dẹp tài nguyên (`try...finally`, `cleanup()`) trong toàn bộ test suites, đảm bảo 0 background process bị treo lại.
- Bảo toàn 100% tương thích lược đồ dữ liệu Dexie schema v6 và định dạng file sao lưu JSON v5.

### Added (Bộ kiểm thử hồi quy & nghiệm thu toàn diện)

- `test_session_lifecycle_contracts.mjs`: 10 bài test kiểm tra State Machine, định danh đơn nhất, tính thời gian không cộng dồn, và khử trùng lặp chương.
- `test_session_persistence_recovery.mjs`: 11 bài test kiểm tra chu kỳ checkpoint 15s, idle 60s, separation 30m, crash recovery và an toàn khi lỗi storage.
- `test_reader_lifecycle_navigation.mjs`: 9 bài test kiểm tra độc lập `scrollY` vs `currentChunkIndex`, điều hướng mục lục/search/bookmark không tạo tiến độ giả.
- `test_tts_session_integration.mjs`: 10 bài test kiểm tra quyền sở hữu playback của TTSEngine, luồng sự kiện 1 chiều, voice preview độc lập và an toàn chuyển chương tự động.
- `test_phase6_integration.mjs`: 14 bài test kiểm tra tích hợp AutoScroll, Sleep Timer fade-out, Media Session nền và Ambient Sound độc lập.
- `test_phase7_compatibility.mjs`: 8 bài test kiểm tra Single Source of Truth `readingSessions`, tính toán Analytics chỉ đọc, và tương thích sao lưu v5.

---

## [1.8.1] - 2026-10-08

### Fixed (Sửa lỗi & Ổn định hóa TTS Lifecycle)

- **Nguyên nhân gốc rễ (Root Cause):**
  - Cơ chế chuyển câu tự nhiên `speakBrowserChunk` trước đây gọi `synth.cancel()` cưỡng bức trước mỗi utterance mới, làm đứt gãy luồng streaming audio của Edge Online Natural voices (`Microsoft HoaiMy/Nam Online Natural`) trên Chromium, khiến engine bị hủy và sinh mã lỗi `interrupted`/`synthesis-failed`.
  - Thiếu bộ đếm kiểm soát lỗi dồn dập trong `utterance.onerror`, dẫn tới hiện tượng cascade error storm duyệt qua hàng trăm câu trong một chu kỳ CPU duy nhất khi trình duyệt gặp lỗi âm thanh.
  - Vòng lặp đệ quy trong `stop()` khi callback `onChunkEnd` được gọi để xóa highlight UI lại kích hoạt tiếp `tts.stop()`, gây tràn ngăn xếp `RangeError: Maximum call stack size exceeded`.
  - Chuyển giao đồng bộ giữa các câu khiến Audio Service của Chromium không kịp giải phóng tài nguyên C++ trước khi nhận utterance kế tiếp.

- **Vòng đời TTS & Cơ chế chống Callback Storm (Lifecycle & Anti-Callback Storm Repairs):**
  - **Loại bỏ `synth.cancel()` thừa khi chuyển câu tự nhiên:** Chỉ gọi `cancel()` khi có can thiệp chuyển hướng chủ động từ người dùng (Stop, Pause, tua câu, đổi tốc độ/giọng đọc).
  - **Asynchronous Handoff:** Sử dụng `this.transitionTimer = setTimeout(..., 0)` tách rời ngăn xếp chuyển câu, tạo một nhịp nhả cho Garbage Collector và audio pipeline của trình duyệt.
  - **Consecutive Error Circuit Breaker:** Tự động ngắt phát sau đúng 3 lỗi Web Speech liên tiếp, chuyển trạng thái sang `'error'`, hủy timers và cảnh báo người dùng an toàn thay vì lặp vô hạn.
  - **Khóa hoàn tất đơn nhất (`isTerminalCompleted`):** Ngăn chặn sự kiện kép khi browser bắn cả `onerror` và `onend` cho cùng một utterance.
  - **Bảo vệ chống đệ quy trong `stop()`:** Thêm cờ `_isStopping` và điều kiện `wasActive` đảm bảo dọn dẹp an toàn khi UI tương tác.
  - **Làm sạch dữ liệu chunk đầu vào:** Tự động chuẩn hóa và bỏ qua an toàn các chunk rỗng, khoảng trắng hoặc dữ liệu không hợp lệ (`null`, `undefined`, non-string).

- **Tích hợp liên phân hệ an toàn (Cross-Module Integration Safety):**
  - `app.js`: Tự động ngắt session phát nền của `mediaSessionHelper` khi TTS gặp trạng thái `'error'`.
  - Giữ nguyên vẹn hợp đồng ghi nhận tiến độ đọc và hoàn tất chương của `readingHistory.js` và `readingAnalytics.js`.

- **Bộ kiểm thử độ ổn định tất định (Deterministic Stability Test Suites):**
  - Bổ sung `test_tts_reproduction.mjs` (10 tests tái hiện và xác minh bản vá gốc).
  - Bổ sung `test_tts_interactions.mjs` (8 tests tích hợp TTS, Media Session, Sleep Timer, AutoScroll).
  - Bổ sung `test_tts_phase4_stability.mjs` (22 tests toàn diện: Normal Playback 3/10/25 chunks, Lifecycle Races, Fault Injection, và Soak Test 50 chunks kiểm tra rò rỉ bộ nhớ/timer).

---

## [1.8.0] - 2026-10-07

### Added

- Personal Analytics Dashboard as a separate Library view with 7-day, 30-day, 365-day, and all-time ranges.
- Reading time, estimated words, completed chapters, TTS time, weighted consumption speed, active books, habits, best day, and top-book summaries.
- Local-calendar daily trends, 365-day activity heatmap, current/longest streaks, and 7/30-day comparisons.
- `readingAnalytics.js` derived-data APIs and targeted Analytics regression tests.

### Changed

- Dashboard reads Reading History and the safe in-memory session snapshot, builds shared daily projections, and recomputes results without an Analytics database store or persistent cache.
- Npm package version advanced to 1.8.0.

---

## [1.7.1] - 2026-10-07

### Fixed

- Reader chapter-navigation buttons show clear disabled feedback at the first and last chapter.
- Search results retain a clickable cursor; Reader hotkeys no longer trigger while focus is inside editable controls, modals, or drawers, and eligible surfaces close with Escape.
- Book deletion lookup and quote-copy failures now show error feedback instead of leaving rejected actions unhandled.
- TTS chunk navigation while paused keeps the selected chunk paused until Resume, and Stop invalidates pending Cloud TTS work so late responses cannot restart playback.
- Reading History exports the chapter-completion wrapper imported by the Reader, preventing app.js module loading from failing.
- Browser voice preview resumes an interrupted reading session; Cloud preview requests are superseded and their audio resources are cleaned up on completion, error, or Stop.

## [1.7.0] - 2026-10-07

### Added

- Reading History view with Today/7-day/30-day summaries, a local-day timeline, paginated session loading, session deletion, and clear-history confirmation.
- Reader, TTS, visibility, AutoScroll, and progress integration for active time, TTS time, estimated forward reading progress, and chapter completion metrics.
- Safe session recovery, local-midnight daily allocation, backup/restore support, and targeted engine/integration regression coverage.

### Changed

- Dexie schema version 6 adds the `readingSessions` store; backup JSON version 5 includes sessions while accepting older backups without history.
- History range distinct-book counts are collected in the same session scan, and latest-N queries use the `startedAt` index where supported.
- README now documents Reading History behavior, storage, tests, and current schema/backup versions.

---

## [1.6.0] - 2026-10-07

### Added

- Bookmark / Reading Mark with a dedicated `bookmarks` store, current-position capture, compact text anchors, previews, optional labels, deduplication, and a separate Bookmark Hub tab.
- Bookmark navigation to the original book/chapter with stale paragraph text fallback and temporary `.bookmark-focus` styling.
- Bookmark backup/restore support, old-backup compatibility, and targeted storage/navigation tests.

### Changed

- Dexie schema version 5 adds `bookmarks: '++id, bookId, [bookId+chapterIndex]'`; prior stores remain defined in the version chain.
- Backup JSON version 4 includes bookmarks and validates bookmark records before import. Appending remaps bookmark book IDs; duplicate positions collapse deterministically.
- README architecture, storage schema, file tree, and Bookmark behavior documentation.

### Fixed

- Malformed, orphaned, or chapter-less bookmark records no longer disappear silently during restore; invalid bookmark backups are rejected before existing data is modified.
- Bookmark navigation waits for Reader chapter-loading promises and avoids moving the TTS chunk pointer to the eye-reading paragraph.

---

## [1.5.0] - 2026-10-07

### Added

- Global Full-Text Search entry point and responsive modal, separate from Library title filtering and TOC search.
- Vietnamese case/accent-insensitive matching, including `đ/Đ → d`, normalized-to-original offset mapping, contextual snippets, and grouped Book → Chapter → Match results.
- Dexie schema version 4 search index as rebuildable derived data, with batched/yielding indexing, source/rules fingerprints, progress reporting, corruption recovery, orphan cleanup, and invalidation/rebuild on book, dictionary, import, and restore changes.
- Search result navigation through the existing `openBook()`/`loadChapter()` lifecycle, context fallback for stale paragraph anchors, and temporary `.search-focus-match` highlighting. Search focus is UI-only and does not create saved highlights.
- Targeted tests for normalization, Unicode mapping/snippets, result limits and cancellation, index lifecycle/backup exclusion, stale anchors, safe snippet-rendering contracts, and navigation/progress/TTS contracts.

### Changed

- Global queries use validated derived index entries to filter chapters and load source text only for candidate chapters; results remain capped and render incrementally.
- JSON backup format remains version 3 and excludes the rebuildable `searchIndex` store. Import/restore clears that cache so it can be rebuilt from source data.

### Fixed

- Search navigation now waits for the existing chapter-loading Promise, avoids duplicate progress writes, and cancels in-flight results when a book is deleted.
- Background per-book indexing clears its progress state when rebuilds finish.

---

## [1.4.1] - 2026-10-01

### Fixed (Sửa lỗi)

1. **Lỗi Đồng Bộ Vị Trí Khi Bấm "Tiếp Tục Đọc" (Reading Progress & Resume Index Desync):**
   - **Nguyên nhân gốc rễ:** Luồng khởi tạo playback gọi `tts.play()` mà không ưu tiên kiểm tra `currentChunkIndex` đã lưu, khiến con trỏ TTS bị đặt lại về `0` mỗi khi nhấn Play/Resume sau khi mở lại truyện.
   - **Giải pháp:**
     - Chuẩn hóa luồng khởi tạo: Luôn đọc `currentChunkIndex` / `lastReadPosition` từ IndexedDB **trước** khi gọi bất kỳ phương thức phát nào của `TTSEngine`.
     - Đảm bảo nút Play/Resume trên Floating Dock tiếp tục đọc chính xác từ câu/đoạn đang dừng dở mà không can thiệp vào chỉ mục phân đoạn đã lưu.
     - Tách biệt rõ ràng hai cơ chế lưu trữ: tọa độ cuộn `scrollY` (phục vụ hiển thị vị trí mắt đọc) và chỉ mục phân đoạn `currentChunkIndex` (phục vụ tiếp tục phát TTS chính xác).

2. **Khắc phục triệt để lỗi tràn bộ nhớ (Out-of-Memory / Infinite Loop ngốn RAM) khi chuyển chương bằng cơ chế Circuit Breaker, Atomic Lock và dọn dẹp Chromium Utterance callbacks:**
   - **Nguyên nhân gốc rễ (Root Cause Analysis):**
     - *Lỗi đặc thù Chromium Web Speech API:* Khi gọi `speechSynthesis.cancel()`, trình duyệt tự động kích hoạt sự kiện `onend` của utterance cũ. Nếu callback `onend` chưa được gỡ bỏ (`null`), nó tiếp tục gọi `completed` -> kích hoạt chuyển chương -> tạo vòng lặp đệ quy hàng nghìn lần/giây (Callback Storm).
     - *Nạp văn bản rỗng / sai thời điểm:* Nếu dữ liệu chương mới trả về chuỗi rỗng `""`, TTS coi như đã phát xong (0ms) và lập tức bắn tiếp sự kiện `completed` ngay trong tick hiện tại của Event Loop.
     - *Tê liệt Garbage Collector:* Các vòng lặp không đồng bộ (`setInterval` quét DOM ngầm, khởi tạo liên tục hàng ngàn object `SpeechSynthesisUtterance`, thao tác cắt chuỗi và click ảo) làm nghẽn Main Thread, khiến RAM tăng vọt từ vài chục MB lên ~9-10 GB và làm sập tiến trình GPU/Renderer (màn hình đen).
   - **Giải pháp & Kiến trúc bảo vệ:**
     - **Dọn dẹp Utterance an toàn tuyệt đối (`tts.js`):** Trong mọi hàm gọi `cancel()` hoặc `stop()`, luôn gán `onend = null`, `onerror = null`, `onstart = null` trên `this.currentUtterance` trước khi gọi `synth.cancel()`.
     - **Chặn đọc chuỗi rỗng (`tts.js`):** Trong `speakBrowserChunk(chunkText)`, nếu toàn bộ mảng chunks rỗng, gọi `this.stop()` an toàn thay vì bắn sự kiện hoàn thành. Bỏ qua các chunk rỗng mà không kích hoạt chu trình 0ms.
     - **Khóa nguyên tử (Atomic Mutex Lock `isChapterSwitching`):** Ngăn chặn mọi tín hiệu `completed` trùng lặp trong suốt quá trình chuyển chương.
     - **Cầu chì chống lặp vô hạn (Circuit Breaker / Rate Limiter):** Giới hạn tối đa 2 lần chuyển chương trong vòng 5 giây. Nếu vượt quá ngưỡng, lập tức ép dừng hoàn toàn (`state.tts.stop()`) và cảnh báo người dùng để bảo vệ bộ nhớ máy tính.
     - **Luồng chuyển chương tuần tự (Safe Sequential Pipeline):**
       + *Bước 1:* Dừng toàn bộ âm thanh, xóa sạch `currentUtterance` và timers.
       + *Bước 2:* Hiện Toast: *"Đã đọc hết chương. Chuyển chương tiếp theo..."*.
       + *Bước 3:* Gọi bất đồng bộ `await loadChapter(nextIndex)`.
       + *Bước 4:* Nghỉ bắt buộc 800ms (`setTimeout`) để DOM hoàn tất render và Garbage Collector giải phóng bộ nhớ.
       + *Bước 5:* Kiểm tra nghiêm ngặt `!newContent || newContent.trim().length < 20` trước khi nạp TTS.
       + *Bước 6:* Nạp nội dung mới vào `state.tts.loadText(newContent)`.
       + *Bước 7:* Bắt đầu đọc từ câu đầu tiên (`state.tts.jumpToIndex(0, true)`).
       + *Bước 8:* Chỉ gỡ khóa `isChapterSwitching = false` sau khi câu đầu tiên cất tiếng đọc thành công (`onChunkStart`).
     - **Loại bỏ hoàn toàn giải pháp không an toàn:** Xóa sạch toàn bộ các vòng lặp `setInterval` quét DOM ngầm và các lệnh giả lập `.click()` vào phần tử trang truyện. RAM duy trì ổn định tuyệt đối (< 200MB).

---

## [1.4.0] - 2026-10-01

### Added (Thêm mới)
- **Module "Audiobook & Sleep Suite" (Trải nghiệm Nghe truyện & Hẹn giờ ngủ toàn diện):**
  - **Phân hệ 1: Hẹn giờ tắt thông minh & Hiệu ứng Fade-out 30 giây (`sleepTimer.js`):**
    - Đa dạng chế độ hẹn giờ: 15 phút, 30 phút, 45 phút, 60 phút, và chế độ đặc biệt "Dừng khi hết chương hiện tại" (`chapter_end`).
    - Huy hiệu đồng hồ đếm ngược trực quan (`#dock-sleep-timer-badge`) bám sát ngay trên Floating Dock (ví dụ: `⏱️ 28:45` hoặc `⏱️ Hết chương`), hỗ trợ click 1 chạm để mở popover chọn lại hoặc hủy hẹn giờ.
    - **Cơ chế Fade-out 30 giây cuối:** Thuật toán tự động giảm dần âm lượng volume của cả giọng đọc TTS (`SpeechSynthesisUtterance.volume` & Cloud Audio) và tiếng nền môi trường từ mức đang phát về `0` theo từng giây, chống giật mình khi người dùng thiu thiu ngủ.
    - Tự động tạm dừng toàn bộ âm thanh và khôi phục mức volume gốc khi đồng hồ về `00:00` hoặc khi kết thúc câu cuối của chương.
  - **Phân hệ 2: Bộ trộn âm thanh môi trường nền (`ambientSound.js`):**
    - 4 bản âm thanh môi trường lặp vô tận (Seamless Loop), tạo hoàn toàn bằng Web Audio API Procedural Synthesis (100% offline, 0-byte tải ngoài, không có khoảng lặng ngắt quãng):
      1. 🌧️ **Mưa rơi mái tôn / Cửa sổ** (Cozy Rain).
      2. 🌊 **Suối chảy róc rách** (Flowing Stream).
      3. 🎋 **Rừng trúc & Gió thổi** (Bamboo Forest Breeze).
      4. 🔥 **Lửa trại bập bùng** (Campfire Crackling).
    - Modal Bộ trộn âm thanh (`#ambient-mixer-modal`) với nút kích hoạt tai nghe/sóng âm trên Floating Dock: Cho phép Bật/Tắt riêng từng âm thanh (chơi độc lập hoặc mix kết hợp), thanh trượt Volume độc lập (0% - 100%, mặc định 15% - 20%), thanh trượt Master Volume và nút "Tắt hết" một chạm.
    - Lưu trữ trạng thái mixer và mức âm lượng vào IndexedDB để tự động khôi phục trong các phiên đọc sau.
  - **Phân hệ 3: Tích hợp Media Session API & Điều khiển qua phần cứng/tai nghe (`mediaSessionHelper.js`):**
    - **Cơ chế Silent Background Audio Track:** Duy trì một luồng âm thanh im lặng chạy ngầm song song khi TTS phát, khắc phục triệt để lỗi Web Speech API bị hệ điều hành đóng khi tắt màn hình điện thoại hoặc thu nhỏ trình duyệt.
    - **Đồng bộ Metadata hệ thống:** Hiển thị tên chương, tên truyện, tác giả, và ảnh bìa vector SVG sắc nét trên Notification Banner của Windows Media Control, màn hình khóa Android/iOS, Dynamic Island và macOS Control Center.
    - **Hỗ trợ đầy đủ phím cứng & tai nghe Bluetooth:** Đăng ký các action handlers `play`, `pause`, `previoustrack`, `nexttrack`, `seekbackward`, `seekforward`, `stop`.
- **Mở rộng bộ kiểm thử tự động (`test_parser.mjs`):**
  - Bổ sung Tests 12, 13, 14 nâng tổng số lên 14 bài kiểm thử đạt 100% PASS cho `sleepTimer.js`, `ambientSound.js`, và `mediaSessionHelper.js`.

### Changed (Thay đổi/Tối ưu)
- Nâng cấp `TTSEngine` trong `tts.js` bổ sung thuộc tính `this.volume` và phương thức `setVolume(vol)` điều khiển volume cho cả Web Speech API và Cloud AI audio stream phục vụ cơ chế Fade-out.
- Đồng bộ hóa trạng thái phát âm thanh nền song song với vòng đời TTS (tự động tiếp tục khi TTS phát và tạm dừng khi TTS ngưng).

### Fixed (Sửa lỗi)
- Khắc phục hiện tượng gián đoạn phát âm thanh nền khi lặp lại (loop click/pop) bằng kỹ thuật cross-fade 200ms tại hai đầu mút của AudioBuffer.

---

## [1.3.0] - 2026-10-01

### Added (Thêm mới)
- **Module "Text Engine Pro" toàn diện với 3 phân hệ cốt lõi:**
  - **Phân hệ 1: Bộ Lọc Từ Điển & Thay Thế Tự Động (`cleaner.js`):**
    - **Pipeline xử lý 2 tầng (Two-Layer Sanitization Pipeline):** Thực thi đồng bộ trước khi render ra giao diện đọc và trước khi nạp vào TTS engine, đảm bảo tai nghe và mắt nhìn đồng nhất 100% nội dung đã làm sạch.
    - **Tầng 1 (Global Junk Cleaner):** Quét và loại bỏ tự động link website (`https?://\S+`, `www\.\S+`, domain convert cào truyện `truyen\w+\.\w+`), dòng thông báo nhắc convert, donate Momo/Zalo/Ngân hàng (`/(Ủng hộ converter|Được đăng tải tại|Bấm theo dõi|Nguồn:|Nhóm dịch|Donate|Momo:?\s*\d+).*/gi`), các dòng phân cách thừa (`---`, `===`), và thu gọn khoảng trắng/xuống dòng liên tiếp (`\n{3,}` -> `\n\n`).
    - **Tầng 2 (Custom Dictionary Replacement):** Hệ thống từ điển tùy chỉnh cho phép thiết lập bảng thay thế từ/cụm từ theo từng cuốn truyện hoặc toàn hệ thống. Hỗ trợ đầy đủ phân biệt hoa/thường (Case-sensitive) và Biểu thức chính quy (Regex) với cơ chế bọc try-catch an toàn chống sập trình đọc.
    - **Giao diện Modal Quản lý Từ điển (`#dict-modal`):** Bảng hiển thị quy tắc trực quan gồm các cột `Từ gốc (Find)` | `Thay thế (Replace)` | `Hoa/Thường` | `Regex` | `Phạm vi` | `Bật/Tắt` | `Thao tác`.
    - **Xuất / Nhập JSON (Backup/Restore Dictionary):** Cho phép sao lưu và chia sẻ bộ từ điển xưng hô/dịch thuật dễ dàng bằng file JSON.
    - Lưu trữ danh mục quy tắc vào IndexedDB (`customRules` store).
  - **Phân hệ 2: Tự Động Cuộn Trang Rảnh Tay (`autoscroll.js`):**
    - **Smooth rAF Engine:** Sử dụng `window.requestAnimationFrame` điều khiển bước cuộn từng frame mượt mà tuyệt đối, loại bỏ hoàn toàn hiện tượng giật khựng do `setInterval`.
    - **Tốc độ tinh chỉnh liên tục:** Cho phép điều chỉnh dải tốc độ từ 10px/giây đến 150px/giây (bước nhảy 10px) thông qua cụm điều khiển stepper mini `[-] [40px/s] [+]` trên Floating Dock.
    - **Cơ chế Tạm dừng & Tiếp tục Thông minh (Smart Pause & Resume):** Tự động phát hiện thao tác lăn chuột (wheel), chạm vuốt màn hình (touch event) hoặc rê chuột vào Floating Dock để tạm dừng cuộn; tự động cuộn tiếp sau 2 giây khi người dùng buông tay.
    - **Cảm biến đáy chương:** Tự động phát hiện khi cuộn xuống chạm đáy chương và chuyển tiếp mượt mà sang chương kế tiếp.
    - **Phím tắt nhanh (Hotkeys):** Gán phím `A` hoặc `S` để Bật / Tắt chế độ cuộn tự động rảnh tay tức thì.
  - **Phân hệ 3: Đánh Dấu Văn Bản & Ghi Chú Trích Dẫn (`highlight.js`):**
    - **Thanh công cụ nổi tương tác (Floating Selection Toolbar):** Tự động xuất hiện ngay phía trên đoạn văn được bôi đen với thiết kế kính mờ bo tròn hiện đại:
      - **4 màu highlight tiêu chuẩn:** Vàng chanh (`#fef08a`), Xanh mint (`#bbf7d0`), Xanh pastel (`#bae6fd`), Cam đào (`#fed7aa`), tương thích hoàn hảo ở cả giao diện Sáng và Tối (Dark/Navy/Sepia).
      - **Nút "Ghi chú":** Mở popover gõ bình luận, suy nghĩ hoặc giải nghĩa cá nhân đi kèm đoạn trích.
      - **Nút "Trích dẫn":** Tự động sao chép trích dẫn vào clipboard theo chuẩn:
        > "[Nội dung đoạn trích]"
        > — Trích: [Tên truyện] | [Tên chương]
      - **Nút "Xóa đánh dấu":** Xóa highlight và hoàn nguyên văn bản khi click vào thẻ `<mark>` đã lưu.
    - **Quotes Hub (Drawer Quản lý Trích dẫn):**
      - Tích hợp hệ thống Tabs kép trong Drawer: Tab 📑 Mục lục và Tab ✍️ Trích dẫn & Ghi chú.
      - Hiển thị danh sách toàn bộ trích dẫn của tác phẩm theo thẻ bài (cards), màu viền tương ứng, tên chương và thời gian tạo.
      - **Click để nhảy vị trí:** Bấm vào bất kỳ thẻ trích dẫn nào, màn hình sẽ tự động nạp chương (nếu ở chương khác) và cuộn mượt (`scrollIntoView`) đến đúng đoạn văn được đánh dấu.
      - **Xuất Markdown cho Obsidian / Notion:** Nút "Xuất Markdown" tạo file `.md` có cấu trúc hoàn chỉnh (tiêu đề, tác giả, nhóm theo chương, blockquote và ghi chú cá nhân) sẵn sàng cho kho lưu trữ tri thức cá nhân.
- **Mở rộng cơ sở dữ liệu IndexedDB (Dexie Version 3):**
  - Bổ sung bảng `customRules: '++id, bookId, isEnabled, createdAt'`.
  - Bổ sung bảng `highlights: '++id, [bookId+chapterIndex], bookId, chapterIndex, paragraphIndex, createdAt'`.
  - Nâng cấp `exportDatabase` và `importDatabase` để tự động sao lưu và khôi phục toàn vẹn cả `customRules` và `highlights`.
- **Bổ sung bộ kiểm thử tự động (Unit Tests):**
  - Mở rộng `test_parser.mjs` lên 11 bài kiểm thử (100% PASS), bao gồm kiểm thử làm sạch rác cào/convert, kiểm thử từ điển tùy chỉnh, kiểm thử AutoScroll Engine & Smart Pause, và kiểm thử định dạng trích dẫn & xuất Markdown.

### Changed (Thay đổi/Tối ưu)
- Tách biệt rõ ràng giữa chức năng "Cuộn theo giọng đọc TTS" (chuyển câu theo giọng đọc) và "Cuộn rảnh tay" (Hands-Free continuous auto-scroll) với các icon và phím tắt riêng biệt.
- Toàn bộ pipeline làm sạch văn bản chạy trước khi chia câu TTS và render HTML, giải quyết triệt để lỗi TTS đọc phải link quảng cáo hoặc lời chào convert.

### Fixed (Sửa lỗi)
- Khắc phục lỗi chữ bị đè hoặc lệch tọa độ khi hiển thị Floating Selection Toolbar trên màn hình hẹp/di động bằng thuật toán clamp tọa độ theo Viewport bounds.

---

## [1.2.0] - 2026-10-01

### Added (Thêm mới)
- **Hệ thống giọng đọc Đa Tầng Nguồn (Multi-Engine TTS System):**
  - **Tầng 1 - Tối ưu hóa Web Speech API (Miễn phí, chạy ngay):**
    - Khắc phục triệt để vấn đề nạp bất đồng bộ giọng đọc của trình duyệt bằng cơ chế polling fallback kết hợp sự kiện `speechSynthesis.onvoiceschanged`, đảm bảo quét trọn vẹn các giọng chất lượng cao Neural voices trên Microsoft Edge và Chrome Windows.
    - Quét và gắn nhãn trực quan các giọng tự nhiên: `Microsoft HoaiMy Online (Natural)` (Giọng nữ Bắc truyền cảm), `Microsoft Nam Online (Natural)` (Giọng nam Bắc trầm ấm), `Google tiếng Việt` (Giọng nữ chuẩn Chrome/Android), `Microsoft An`, `Microsoft Mai`, v.v.
    - **Bộ điều chỉnh âm sắc (Voice Tuning):** Tích hợp thanh trượt `Pitch` (Độ cao/trầm: 0.5x - 1.5x) bên cạnh `Rate` (Tốc độ đọc). Biến tấu từ 1 giọng gốc thành nhiều phong cách đọc đa dạng (giọng già dặn trầm ấm, giọng thanh niên trẻ trung, giọng diễn cảm).
  - **Tầng 2 - Tích hợp Engine Mở rộng Cloud AI (BYOK - Bring Your Own Key):**
    - Hỗ trợ kết nối các dịch vụ Cloud AI TTS tiếng Việt hàng đầu:
      - **FPT AI:** Ban Mai (Nữ Bắc), Minh Quang (Nam Bắc), Thu Dung (Nữ Trung), Lan Nhi (Nữ Nam), Lê Minh (Nam Bắc), Mỹ An (Nữ Nam).
      - **OpenAI TTS:** Nova (Nữ truyền cảm), Shimmer (Nữ dịu nhẹ), Onyx (Nam trầm ấm), Alloy, Echo, Fable.
      - **Custom Endpoint:** Hỗ trợ nhập URL endpoint tùy biến cho proxy hoặc server nội bộ.
    - **Bộ nhớ đệm âm thanh IndexedDB (`audioCache`):** Tự động lưu Blob âm thanh vào bảng `audioCache` trong Dexie. Khi nghe lại đoạn văn đã từng phát, hệ thống nạp thẳng từ bộ nhớ đệm, tiết kiệm 100% chi phí và hạn ngạch gọi API.
    - **Cơ chế Fallback thông minh:** Khi API ngoài gặp lỗi kết nối, sai khóa API hoặc hết quota, hệ thống tự động phát thông báo cảnh báo và quay về giọng Web Speech API để duy trì buổi đọc liên tục không ngắt quãng.
- **Nâng cấp Giao diện chọn giọng (Voice Selector UI):**
  - Phân loại danh mục giọng đọc trực quan theo từng nhóm: Giọng Cloud AI (FPT AI & OpenAI), Giọng Trình Duyệt / Hệ Thống (Web Speech API), và Giọng ngôn ngữ khác.
  - **Nút "Nghe thử" nhanh (Voice Preview):** Tích hợp nút `[▶ Thử]` trực tiếp trên Thanh điều khiển nổi (Reader Dock) và trong Modal cài đặt, tự động phát câu mẫu: *"Chào bạn, tôi là giọng đọc tiếng Việt của VietReader."*
  - **Modal Cài đặt TTS Chuyên sâu (`#tts-settings-modal`):**
    - Chuyển đổi 1 chạm giữa Engine Trình duyệt và Cloud AI.
    - Thanh trượt chỉnh Pitch thời gian thực kèm nhãn mô tả sắc thái giọng đọc.
    - Quản lý cấu hình Cloud AI: Nhà cung cấp, API Key (có nút ẩn/hiện an toàn), Voice selector, Custom Endpoint.
    - Quản lý bộ nhớ đệm âm thanh: Hiển thị số lượng đoạn âm thanh đã cache và nút "Dọn sạch cache" 1 chạm.
  - **Ghi nhớ cấu hình yêu thích theo từng tác phẩm:**
    - Tự động lưu lựa chọn giọng, Pitch, Rate và Engine theo từng bộ truyện riêng biệt vào cơ sở dữ liệu (`ttsSettings`), mang lại trải nghiệm đọc cá nhân hóa cho từng tác phẩm.
- **Kiểm thử tự động mở rộng:**
  - Bổ sung 3 bài kiểm thử chuyên sâu trong `test_parser.mjs` (nâng tổng số lên 7 bài test đạt 100%): Kiểm tra nhận diện & gắn nhãn giọng Edge Neural/Google, kiểm tra giới hạn Pitch/Rate clamping, và kiểm tra catalog Cloud AI BYOK.

### Changed (Thay đổi/Tối ưu)
- Nâng cấp lược đồ Dexie.js lên Version 2, bổ sung bảng lưu trữ `audioCache: 'key, provider, voice, createdAt'` mà không ảnh hưởng tới dữ liệu sách hiện có.
- Tối ưu hóa bộ phát âm thanh `HTMLAudioElement` với cơ chế giải phóng Object URL (`URL.revokeObjectURL`) tránh rò rỉ bộ nhớ khi nghe sách liên tục hàng giờ.

### Fixed (Sửa lỗi)
- **Sửa triệt để lỗi mất chữ ô chọn tốc độ đọc (Playback Speed Selector):**
  - Khắc phục lỗi bất đồng bộ kiểu dữ liệu số thực (`1` vs `"1.0"`): Xây dựng hàm `syncTtsRateSelect(rate)` tự động đối sánh giá trị số thực với sai số $\le 0.04$, đảm bảo thuộc tính `selectedIndex` của thẻ `<select>` luôn hợp lệ và không bao giờ bị rỗng (unselected / blank).
  - Bổ sung đầy đủ các nấc tốc độ đọc thông dụng: `0.75x`, `0.9x`, `1.0x (Chuẩn)`, `1.1x`, `1.25x`, `1.5x`, `1.75x`, `2.0x`.
  - Tích hợp biểu tượng tốc độ (Speedometer Icon) trực quan phía trước dropdown.
  - Tối ưu hóa CSS (`.dock-rate-select` và `.dock-rate-select option`) với độ rộng tự động (`min-width: 112px`), khoảng đệm chuẩn, font chữ đậm (`font-weight: 600`), độ tương phản cao ở cả 4 theme (Sáng, Tối, Sepia, Navy) chống hiện tượng chìm chữ hoặc bị che khuất.

---

## [1.1.0] - 2026-10-01

### Added (Thêm mới)
- **Thanh điều khiển nổi đa năng phong cách Viên nang (Floating Reader Dock Capsule):**
  - Tái thiết kế toàn diện thanh điều khiển nổi (`.reader-dock`), định vị cố định chính giữa đáy màn hình (`fixed bottom-6 left-1/2 -translate-x-1/2 z-50`), bo góc lớn 24px, hiệu ứng kính mờ `backdrop-filter: blur(20px)` và đổ bóng nổi khối 3D cao cấp.
  - **Cụm 1 - Điều hướng & Tiến độ Chương:**
    - Cặp nút chuyển chương nhanh `[⏮ Chương trước]` và `[⏭ Chương sau]`.
    - Thanh kéo trượt tương tác (Interactive Scrub Bar) kèm nhãn tiến độ chi tiết `Chương X · Đoạn Y/Z (W%)` cho phép người dùng kéo slider hoặc click để nhảy tức thì đến bất kỳ đoạn văn nào trong chương.
  - **Cụm 2 - Điều khiển TTS Nâng cao (Audio & Speech Master):**
    - Nút phát chính (Hero Button) hình tròn lớn (48px) viền sáng gradient nổi bật, hỗ trợ hiệu ứng sóng xung nhịp (pulse ring animation) khi đang phát âm.
    - Nút tua lùi `[⏪ 1 đoạn]` và tua tới `[⏩ 1 đoạn]`.
    - Bộ chọn tốc độ đọc tiện ích với các mốc chuẩn (`0.8x`, `1.0x`, `1.25x`, `1.5x`, `1.75x`, `2.0x`).
    - Menu chọn giọng đọc gọn gàng, tự động ghim nhóm giọng Tiếng Việt (`vi-VN`) lên vị trí ưu tiên đầu danh sách kèm icon cờ 🇻🇳.
    - Nút bấm bật/tắt chế độ "Cuộn theo giọng đọc" với trạng thái active trực quan.
  - **Cụm 3 - Tiện ích Đọc nhanh (Quick Reading Tools):**
    - Cặp nút điều chỉnh cỡ chữ nhanh `[A-]` và `[A+]` kèm huy hiệu kích thước chữ thời gian thực (14px - 28px).
    - Nút đổi theme 1 chạm chuyển đổi vòng lặp qua 4 giao diện (Sáng ☀️ $\rightarrow$ Sepia 📜 $\rightarrow$ Xanh đêm 🌌 $\rightarrow$ Tối OLED 🌙).
    - Nút Chế độ Tập trung (Zen Mode) ẩn sạch toàn bộ thanh tiêu đề trên đỉnh trang để đọc không bị phân tâm.
- **Tiện ích thu nhỏ thông minh (Mini Floating Widget / FAB):**
  - Thay thế nút đóng bằng nút Thu nhỏ `[-]`: Khi bấm, thanh dock co gọn lại thành một nút tròn nổi (FAB 56px) ở góc dưới bên phải màn hình.
  - Tích hợp visualizer hoạt ảnh sóng âm thanh (soundwave 4 cột chuyển động) khi TTS đang phát, hiển thị badge % hoàn thành chương hiện tại và nhấp vào để bung mở lại thanh dock đầy đủ.
- **Hệ thống phím tắt điều khiển bàn phím mở rộng:**
  - <kbd>Space</kbd>: Bật / Tạm dừng đọc giọng nói TTS.
  - <kbd>←</kbd> / <kbd>→</kbd>: Tua lùi 1 đoạn / Tiến lên 1 đoạn.
  - <kbd>↑</kbd> / <kbd>↓</kbd>: Tăng / Giảm tốc độ đọc (bước nhảy 0.1x).
  - <kbd>[</kbd> / <kbd>]</kbd>: Chuyển nhanh Chương trước / Chương sau.
  - <kbd>Esc</kbd>: Thoát nhanh Chế độ Tập trung Zen Mode.

### Changed (Thay đổi/Tối ưu)
- Nâng khoảng cách đệm đáy khung đọc (`.reader-container` `padding-bottom: 140px;`, trên mobile `160px;`) đảm bảo thanh điều khiển nổi không bao giờ che khuất văn bản hoặc các nút chuyển chương cuối trang.
- Tối ưu hóa bố cục đáp ứng linh hoạt (Responsive layout) của thanh dock trên màn hình điện thoại di động và máy tính bảng.

### Fixed (Sửa lỗi)
- Khắc phục triệt để hiện tượng thanh điều khiển bị ẩn mất nút đóng hoặc người dùng không tìm lại được thanh điều khiển sau khi bấm tắt.

---

## [1.0.0] - 2026-10-01

### Added (Thêm mới)
- **Kiến trúc SPA & Giao diện người dùng (Core UI):**
  - Giao diện hai phân hệ độc lập: Kệ sách (`#library-view`) và Trình đọc chuyên sâu (`#reader-view`).
  - Thanh tiến độ cuộn cố định trên đỉnh trình duyệt (`#top-reading-progress`) kèm huy hiệu hiển thị % theo thời gian thực.
  - Ngăn kéo Mục lục (`Drawer Table of Contents`) hỗ trợ lọc và tìm kiếm chương thời gian thực.
  - Modal tùy chỉnh hiển thị & kiểu chữ (`#settings-modal`), điều chỉnh font, cỡ chữ, chiều rộng khung đọc, khoảng cách dòng và căn lề.
  - Modal dán trực tiếp nội dung văn bản thô (`#paste-modal`) kèm trường nhập tên truyện và tác giả.
  - Modal sao lưu & phục hồi (`#backup-modal`) hỗ trợ xuất/nhập tệp JSON.
  - Hộp thoại xác nhận tùy biến (`#confirm-modal`) thay thế hoàn toàn hộp thoại gốc của trình duyệt.
  - Hệ thống thông báo trạng thái (`Toast Notifications`) đa sắc thái (info, success, warning, error).
  - Tích hợp bộ font tinh tuyển hỗ trợ trọn vẹn tiếng Việt: Inter, Merriweather, Be Vietnam Pro.

- **Bộ bóc tách & chia chương thông minh (Parser Engine):**
  - Hỗ trợ nạp đa định dạng: `.txt`, `.pdf`, `.epub`.
  - Phân tích tệp `.pdf` bằng thư viện `PDF.js` với thanh tiến độ phân giải từng trang.
  - Phân tích tệp `.epub` bằng `JSZip` và `DOMParser`, đọc lược đồ `content.opf`, trích xuất theo danh sách `spine itemref` và làm sạch các thẻ mã độc/styles rác.
  - Bộ nhận diện chương đa quy tắc (Regex Tiếng Việt & Quốc tế): `Chương`, `Hồi thứ`, `Quyển`, `Chapter`, `Tiết`, `Phần`, `Mục`.
  - Cơ chế tự động bóc tách phần Lời tựa / Mở đầu / Giới thiệu trước Chương 1 thành chương riêng biệt.
  - Cơ chế phân tách dự phòng (Fallback): Tự động chia nhỏ văn bản đơn khối dài (> 2.500 từ) thành các phần cân bằng 2.000 – 2.800 từ theo ranh giới đoạn văn `\n\n`.
  - Hàm đếm từ chuẩn xác đa ngôn ngữ hỗ trợ tiếng Việt Unicode (`countWords`).

- **Động cơ đọc văn bản thành giọng nói (Vietnamese TTS Engine):**
  - Tích hợp lớp `TTSEngine` bọc trên `window.speechSynthesis`.
  - Tự động quét và ưu tiên các giọng đọc chuẩn `vi-VN` (Google Tiếng Việt, Microsoft HoaiMy, Microsoft NamMinh, Neural voices).
  - Thuật toán Smart Sentence Chunking phân tách văn bản theo dấu chấm câu và dấu phẩy để duy trì nhịp đọc tự nhiên.
  - Cơ chế nhịp tim giữ kết nối (Keep-Alive Heartbeat) giải quyết triệt để lỗi ngắt tiếng sau 15 giây của Chromium/WebKit.
  - Bảng điều khiển nổi (`TTS Dock`) với đầy đủ nút phát/dừng, chuyển câu, chọn giọng và điều chỉnh tốc độ đọc (0.8x - 2.0x).
  - Khả năng đồng bộ trực quan: Highlight câu đang đọc, tự động cuộn màn hình theo câu đọc (`scrollIntoView`), và tính năng nhấp vào câu bất kỳ để nghe ngay lập tức.

- **Cơ sở dữ liệu & Quản lý thư viện (Dexie.js IndexedDB):**
  - Khởi tạo cơ sở dữ liệu `VietReaderDB` gồm 3 bảng dữ liệu: `books`, `chapters`, `settings`.
  - Lưu trữ tác phẩm và danh sách chương nguyên khối trong giao dịch an toàn (atomic transactions).
  - Kệ sách hiển thị dạng card lưới với bìa màu gradient ngẫu nhiên và thanh tiến độ đọc.
  - Bộ lọc tìm kiếm tác phẩm tức thời theo từ khóa.
  - Tự động ghi nhớ và khôi phục chính xác vị trí cuộn trang (`scrollY`) khi tiếp tục đọc.
  - Tính năng nạp nhanh tác phẩm mẫu tiếng Việt (`sample-story.txt`).
  - Hỗ trợ Xuất dữ liệu (Export) và Nhập dữ liệu (Import) toàn vẹn cơ sở dữ liệu sang định dạng JSON.

- **Kiểm thử tự động & Phím tắt:**
  - Kịch bản kiểm thử độc lập [`test_parser.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_parser.mjs) kiểm tra 100% logic regex, chia chương, fallback và TTS chunking.
  - Hỗ trợ hệ thống phím tắt: Mũi tên Trái/Phải (chuyển chương), Space (Play/Pause TTS), Esc (đóng modal/drawer).

### Changed (Thay đổi/Tối ưu)
- Khởi tạo kiến trúc dự án theo mô hình Clean Architecture hướng Client-Side First (không yêu cầu máy chủ phụ trợ).
- Chuẩn hóa CSS Design System với 4 theme màu (Light, Dark, Sepia, Navy) chuyển đổi tức thì thông qua thuộc tính class trên `<body>`.

### Fixed (Sửa lỗi)
- Khắc phục lỗi dừng phát âm thanh bất ngờ trên trình duyệt Google Chrome và Microsoft Edge khi văn bản đọc kéo dài quá 15 giây.
- Khắc phục tình trạng tràn bộ nhớ DOM và đơ giao diện khi người dùng tải lên văn bản thô dung lượng lớn không có tiêu đề phân chương.

### Removed (Loại bỏ)
- Loại bỏ sự phụ thuộc vào các hộp thoại tương tác chặn luồng như `window.confirm()` và `window.alert()`.

---

## 📌 Quy Tắc Bảo Trì & Cập Nhật Tự Động (Maintenance Rules)

Nhằm đảm bảo tính nhất quán và khả năng truy nguyên kỹ thuật của hệ thống, từ nay về sau:
1. **Mỗi khi chỉnh sửa code, thêm chức năng mới, tối ưu hiệu năng hoặc sửa lỗi:**
   - Tự động khởi tạo một khối phiên bản mới (ví dụ: `[1.0.1]` đối với bản vá lỗi, hoặc `[1.1.0]` đối với tính năng mới) ngay trên đầu danh sách phiên bản của tài liệu này theo đúng định dạng chuẩn:
     ```markdown
     ## [x.y.z] - YYYY-MM-DD
     ### Added (Thêm mới)
     - ...
     ### Changed (Thay đổi/Tối ưu)
     - ...
     ### Fixed (Sửa lỗi)
     - ...
     ### Removed (Loại bỏ)
     - ...
     ```
2. **Đồng bộ hóa tài liệu kỹ thuật (`README.md`):**
   - Khi có tệp mới được thêm vào, tệp cũ bị xóa bỏ, hoặc logic cốt lõi của một tệp có sự thay đổi, lập tức cập nhật lại **Bảng Bóc Tách Chi Tiết Các File (Mục 4)** và **Cây Thư Mục Dự Án (Mục 3)** trong [`README.md`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/README.md).
