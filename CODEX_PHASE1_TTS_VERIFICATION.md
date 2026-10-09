# VietReader — Phase 1: Codex takeover và xác minh patch

Ngày: 2026-10-09 (Asia/Bangkok). Phạm vi: source workspace hiện tại; không triển khai Phase 2.

## 1. Repository baseline

- Workspace/source root đã đọc: C:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader.
- Không có .git tại root (ENOENT). git rev-parse --show-toplevel, git branch --show-current và git status --short đều trả fatal: not a git repository. Vì vậy Git root, branch, HEAD và danh sách thay đổi chưa commit: UNVERIFIED. Không coi workspace là clean; không chứng minh được patch do ai tạo hay thuộc commit nào.
- package.json: 1.10.1; mục đầu CHANGELOG.md: 1.10.2 ngày 2026-10-09. Không có bằng chứng source cho bản vá v1.10.3 bàn giao. Phiên bản tài liệu không được dùng để suy ra hành vi.
- Đã đọc phần README/CHANGELOG về TTS. README còn mâu thuẫn: đoạn watchdog tự chuyển câu và callback cleanup khi pause không khớp implementation hiện tại. Các tuyên bố RAM/100% anti-OOM trong tài liệu chưa được Codex xác minh.
- Không thấy AGENTS.md trong source tree hoặc các ancestor đã kiểm tra. Tìm ba test bàn giao trong source tree, loại trừ node_modules, dist và thư mục %SystemDrive%.
- exec_command không khởi tạo được helper; dùng Node filesystem + execFile để đọc và chạy Git/Node tuần tự. Không mở terminal hoặc Edge song song.

## 2. Ba bản vá Claude

| Patch bàn giao | Source thực tế | Kết luận |
|---|---|---|
| A: same-value no-op + debounce 250ms | tts.js:543–572 setters gán giá trị rồi gọi speakCurrentChunk; không so sánh effective value/voice URI, không có restart debounce | KHÔNG TỒN TẠI trong source đã đọc |
| B: bounded retry + silentCompletionGuard | tts.js:1071 vẫn reset consecutiveErrorCount ở onstart; onerror:1237–1267 bỏ qua sang câu kế hoặc completed; không có retry cùng chunk hay silentCompletionGuard | KHÔNG TỒN TẠI |
| C: shared splitParagraphIntoChunks | tts.js:607 chia bằng regex mới và lọc âm vị; app.js:2791 vẫn chia riêng bằng regex cũ; không có shared helper | KHÔNG TỒN TẠI |

250ms tại initVoices:371 là polling load voice, không phải debounce restart. Không có debounce để kiểm tra cleanup Stop/Dispose. TTSEngine không có dispose/destroy; pollTimer là biến local và onvoiceschanged giữ closure engine, chưa có lifecycle teardown riêng. Chưa kết luận mức rò rỉ native từ các chi tiết này.

## 3. Tests đã xác minh

| File | Kết quả |
|---|---|
| test_tts_v1103_repro.mjs | MISSING |
| test_tts_v1103_regression.mjs | MISSING |
| test_tts_mock.mjs | MISSING |
| tests/test_phase3_root_cause_repair_and_silent_playback_fix.mjs | Chạy bản nguyên gốc: FAIL khởi tạo module, 0 behavioral assertions được chạy |
| tests/test_tts_root_cause_fix.mjs | Chạy bản nguyên gốc: FAIL khởi tạo module, 0 behavioral assertions được chạy |
| tests/test_codex_phase1_patch_verification.mjs | Chạy thành công harness: 15 tests, 3 PASS / 12 FAIL, khoảng 386ms, exit code 1 |

Lệnh: node --test <file>, timeout 15 giây cho từng child process. Hai suite cũ import ./tts.js từ tests/, nhưng tests/tts.js không tồn tại; lỗi ERR_MODULE_NOT_FOUND. Không sửa import hay assertions của tests cũ. Không chạy full suite/build, stress/soak Edge hay xóa IndexedDB.

Test mới dùng TTSEngine production thực tế, Speech mocks có counters và terminal callbacks. Hai kiểm tra Reader/controller trích nguyên function/callback từ app.js và thực thi với DOM/dependency stubs; không chỉ grep tên helper. Voice-refresh test mô phỏng callback setVoice theo đường populateVoiceSelect thực tế, không chạy DOM dropdown đầy đủ. Assertions yêu cầu hành vi đúng và cố ý giữ đỏ khi production sai.

Đánh giá assertions hiện có:
- Hai suite cũ có nhiều behavioral assertions thật (currentIndex, count speak, completion callbacks, timer state), không phải toàn bộ chỉ kiểm tra source.
- test_phase3...:212–236 và test_tts_root_cause_fix:160–183 yêu cầu advance sau error: chúng chấp nhận chính hành vi bỏ qua câu đang cần sửa.
- Pause/Resume tests chủ yếu kiểm tra flags hoặc Seek sau Resume; không chứng minh utterance giữ lại có thể onend và phát câu tiếp.
- Stale callback test kiểm tra index, thiếu assertion watchdog của utterance mới còn tồn tại.
- test_phase2_controlled_isolation có kiểm tra regex cũ qua local constants; đó không phải bằng chứng implementation hiện tại còn lỗi nhận diện voice.
- test_phase4_cross_module_regression:320 dùng assert.ok(true) cho Ambient cleanup; mock flags/timer baseline không chứng minh native RAM không tăng. Suite này chỉ đọc có chọn lọc, không chạy.

## 4. Inventory — CONFIRMED DEFECT

| ID | Bằng chứng thực tế | Function/file cần sửa | Phase |
|---|---|---|---|
| D01 | setVoice/setRate/setPitch cùng giá trị: speak 1→2, cancel 0→1 cho từng setter | tts.js:543 setVoice, 558 setRate, 568 setPitch | 2 |
| D02 | 3 voiceschanged với object mới và preferred URI như app tạo 3 restart: speak 1→4. loadVoices còn gọi selectBestVietnameseVoice vô điều kiện, không bảo toàn lựa chọn trong core | tts.js:339 initVoices, 385 selectBestVietnameseVoice; app.js:665 onVoicesLoaded, 854 populateVoiceSelect | 2 + 4 |
| D03 | 6 lần onstart→network error khiến index 0→5; completion callbacks vẫn 0 nhưng các câu lỗi bị bỏ qua. Reset tại onstart khiến ngưỡng 3 lỗi không chặn chuỗi này | tts.js:1057 onstart, 1183 onerror | 2 |
| D04 | onend không có onstart vẫn emit onActualChunkComplete một lần; không kiểm tra started/elapsed trước completion | tts.js:1097 onend | 2 |
| D05 | onerror ở chunk cuối emit playing→stopped→completed, dù không natural complete | tts.js:1264 error terminal; app.js:718 onStatusChange | 2 + 4 |
| D06 | Play→onstart→Pause→Resume→onend giữ index=0 thay vì 1. Pause/Resume tăng generation nhưng giữ utterance và callbacks bắt activeGeneration cũ; watchdog cũng không được tái lập trên retained Resume | tts.js:685 pause, 721 resume, terminal generation checks | 2 |
| D07 | Đổi rate khi paused không speak ngay (đúng), nhưng Resume vẫn giữ utterance.rate=1 thay vì 1.5. Voice/pitch cũng không đánh dấu cần tạo utterance mới theo source | tts.js setters và resume/pausedChunkChanged | 2 |
| D08 | Gọi captured onend của utterance bị thay sau setRate xóa watchdog của utterance mới. onend/onerror clearStuckWatchdog trước kiểm tra ownership | tts.js:1097 onend, 1183 onerror | 2 |
| D09 | Render cùng text tạo Reader 6 chunks/TTS 5, orphan quote chiếm index 1. Highlight, click-to-speak và logical word progress dùng DOM index nên lệch từ đó | app.js:2791 renderChapterContent, 2699 buildLogicalProgressMap, 960 highlightSentenceChunk; tts.js:607 splitIntoSmartChunks | 3 |
| D10 | Stop trong khoảng handoff 800ms không hủy pending autoplay: callback cũ vẫn gọi jumpToIndex(0,true) một lần sau Stop | app.js:718 onStatusChange, đặc biệt await loadChapter/800ms/cleaning và autoplay:819 | 4 |

D03 không phải retry vô hạn cùng utterance: implementation thực tế skip qua các chunk, bị giới hạn bởi độ dài chương và velocity breaker khi đủ nhanh. Chuỗi lỗi chậm có thể tiếp tục hết chương và đẩy đường completed sang chuyển chương. Native phát ra chuỗi này thường xuyên đến mức nào: UNVERIFIED.

D04 chứng minh lifecycle chấp nhận completion thiếu start; không chứng minh có/không âm thanh vật lý. Không có silentCompletionGuard hiện tại, nên nguy cơ guard chặn câu ngắn hợp lệ chưa thể đánh giá.

Ví dụ D09:
Text: “Xin chào.”\nCâu hai. Câu ba. Câu bốn. Câu năm.
Reader: [“Xin chào., ”, Câu hai., Câu ba., Câu bốn., Câu năm.]
TTS: [“Xin chào.”, Câu hai., Câu ba., Câu bốn., Câu năm.]

## 5. VERIFIED FIXED — các guard có sẵn, không gán cho v1.10.3

- Single-terminal guard: captured onend gọi hai lần rồi onerror vẫn chỉ completion một lần, index→1, speak count=2. Guard tts.js:1052/1098/1184 hoạt động trong case ownership hợp lệ.
- Watchdog fail-safe: timeout mô phỏng 5ms giữ index=0, không completion, trạng thái error, dọn keepalive/transition. Không tự speak câu tiếp. Production timeout max(14000, textLength*200), không phải luôn 14 giây.
- Stop dọn currentUtterance, keepalive, transition, watchdog trong test. HoaiMy được classifier nhận diện online/natural; source Keep-Alive return trước pulse khi classifier true. PASS này không đo native stream/RAM hay thử pulse vật lý.

## 6. Playback call graph và ownership

UI Play/dock/keyboard/media controls (app.js:1160, 1209, 5434)
→ TTSEngine.play (tts.js:656): generation++, playing, startKeepAlive
→ speakCurrentChunk (945): playbackRequestId++, giải phóng Cloud URL nếu tồn tại
→ browser: speakBrowserChunk (986): kiểm tra request + generation, detach/cancel utterance cũ, unpause synth, lọc phonemes
→ SpeechSynthesisUtterance (1036): voice/rate/pitch/volume, utteranceToken++, terminal guard, watchdog
→ synth.speak (1272)
→ onstart (1057): actual start/history callbacks, watchdog và highlight; vẫn reset error count
→ onend (1097): cleanup → generation checks → actual completion → onChunkEnd → velocity check
→ setTimeout(0) với advanceSequenceToken → currentIndex = nextIndex → speakCurrentChunk
→ câu cuối: onNaturalComplete → stop → status completed
→ app.onStatusChange: chapter mutex + limiter → loadChapter → đợi 800ms → clean/loadText → jumpToIndex(0,true).

Nhánh onerror: terminal cleanup → canceled/interrupted return; lỗi khác count++ → ngưỡng 3 thì stop/error; dưới ngưỡng skip sang nextIndex, câu cuối completed. Canceled/interrupted không tính actual completion, nhưng nếu native tự báo khi engine còn active thì source return sau khi bỏ utterance/watchdog, không có halt status: rủi ro cần kiểm tra Phase 2/5.

Nhánh watchdog: ownership checks → detach/cancel → cleanup → error, không completion/advance.

Nhánh Cloud: speakCurrentChunk → speakCloudChunk → bounded scheduler/cache/provider → audio.play; audio ended dùng activeCloudRequestId rồi advance. Audio error hoặc Cloud request failure invalidate scheduler và fallback browser cùng chunk. Sau await audio.play, source còn cập nhật scheduler/start observer mà thiếu kiểm tra request lại: candidate race UNVERIFIED, dành Phase 4, không mở rộng sửa trong Phase 1.

Native call sites (source hiện tại):
- speak: tts.js:1272 playback và 1501 preview.
- cancel: 835 cancelCurrentSource; 1006 replace utterance; 1651 watchdog.
- pause: 709 user pause; 1596 offline Keep-Alive.
- resume: 675 play; 744 resume; 840 cancel cleanup; 1014 trước speak; 1597 Keep-Alive.

Nguồn phát lại: same-value setters; voiceschanged→onVoicesLoaded→populateVoiceSelect→setVoice; next/prev/seek; preview restore; terminal next-chunk handoff; Cloud fallback; chapter autoplay. Velocity limiter chỉ đếm auto terminal transitions, không giới hạn restart từ setters/voice refresh.

Anti-OOM hiện có: diagnostics ring<=50; generation/utterance/advance tokens; stop reentrancy guard; async 0ms handoff; velocity breaker >=60 transitions/1000ms; online voice không pulse; watchdog halt; tránh media src/load churn khi browser không có Cloud source; scheduler defaults maxConcurrency=1, ahead=2, ready=3, retained bytes=15MiB; progress save debounce 500ms; chapter mutex/limiter 2 lần/5s; AutoScroll nhường TTS (app.js:3987). Các giới hạn này có trong code, không phải bằng chứng RAM native đã an toàn. D06/D08/D10 cho thấy ownership còn thiếu dù đã có tokens.

## 7. Phạm vi Phase tiếp theo và phần chưa xác minh

- Phase 2: setters/voice identity + restart scheduling; initVoices lifecycle; pause/resume generation; terminal ownership trước cleanup; bounded error retry không skip; completion validity; canceled/interrupted halt policy. Giữ các guard đang PASS.
- Phase 3: shared paragraph chunking, DOM indices, highlight/click mapping, logical progress/history và currentChunkIndex restore theo cùng chunk list.
- Phase 4: populateVoiceSelect không tạo playback side effect khi refresh; chapter autoplay cancellation token và kiểm tra sau từng await; completion/error contract với History/SleepTimer/MediaSession/AutoScroll; Cloud audio.play stale result/fallback ownership. Chưa xác minh toàn bộ module integrations.
- Phase 5: native Edge fresh voice objects/events, âm thanh thật, câu ngắn hợp lệ, pause/resume/preview/fallback, Browser Process RAM và tác động Keep-Alive. Chưa mở Edge, chưa stress test, chưa đo RAM.
- Chưa xác minh full regression cũ; hai suite đã chạy bị lỗi import. Báo cáo 6/6 và 12/12 của Claude không được tái lập từ artifacts bàn giao.

Artifacts mới duy nhất do Phase 1 tạo: tests/test_codex_phase1_patch_verification.mjs; diagnostics/phase1_targeted_test_output.txt; CODEX_PHASE1_TTS_VERIFICATION.md. tts.js và app.js đã so sánh lại byte nội dung với baseline đã đọc: không thay đổi. Không sửa tests cũ/production, không commit/push/reset, không xóa dữ liệu.

DỪNG SAU PHASE 1.
