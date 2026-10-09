# VietReader — Phase 2: TTS Core Lifecycle & Silent Playback Repair

Ngày: 2026-10-09 (Asia/Bangkok).
Trạng thái: COMPLETED trong phạm vi Phase 2 — production đã sửa, targeted core tests đạt.
Không phải nghiệm thu toàn bộ VietReader hoặc native Edge. Dừng sau Phase 2.

## 1. Defects đã sửa và bằng chứng

| Phase 1 | Production repair | Bằng chứng targeted |
|---|---|---|
| D01: same-value setters restart | So sánh effective rate/pitch và voice URI (fallback name/lang); cập nhật object cùng voice identity không tạo restart | Không tăng speak/cancel cả sau debounce window |
| D02: voice refresh restart, mất lựa chọn | initVoices giữ preferredVoiceId, rebind object mới cùng identity; dropdown chỉ render UI; voice load không restart pending Cloud | 20 voiceschanged không restart; giữ offline selection; async preferred voice được phục hồi |
| D03: onstart reset budget, errors skip chunks | onstart không reset budget; network được một retry async ở cùng index; lỗi thứ hai halt; lỗi khác halt ngay | onstart→network→onstart→network: đúng 2 speak, index=0, không completion, error, không timer |
| D04: completion thiếu start | silentCompletionGuard từ chối missing-start và completion dài quá sớm | Không emit actual/natural completion, không advance/retry |
| D05: lỗi câu cuối báo completed | Error path không có đường emit completed/onNaturalComplete | Hai network failures ở câu cuối giữ index và emit error |
| D06: Pause/Resume mất ownership | Giữ generation của utterance đang retain; chỉ hủy pending transition; Resume rearm watchdog/heartbeat | Resume dùng cùng utterance, onend advance đúng một lần |
| D07: paused config chưa áp dụng | Đánh dấu config thực sự thay đổi, tạo một replacement khi Resume; revert về config đang phát thì giữ utterance | Voice/rate/pitch áp dụng cùng một lần; revert paused không restart |
| D08: stale terminal xóa watchdog mới | Validate generation/request/token/index/current utterance trước mọi shared cleanup; timer callback kiểm tra handle ownership | Captured old onstart/onend/onerror/onresume/watchdog không chạm watchdog mới hoặc progress |

Củng cố thêm: Play idempotent; status/observer reentrancy guards; preview terminal generation check; pending restart/retry bị vô hiệu hóa sau Stop/Error/Dispose; audio event registration idempotent, listener removal khi dispose; voice polling có owned timer và teardown.

D09 (segmentation) và D10 (Stop trong chapter handoff) không sửa tại Phase 2. Đã kiểm tra lại riêng: vẫn FAIL đúng như Phase 1.

## 2. File/function thay đổi

Production chỉ hai file:

- tts.js: initAudioElement (204), initVoices (351), setEngine/setCloudConfig; getVoiceIdentity (560), getPlaybackConfigurationKey (564), clearConfigurationRestart (570), scheduleConfigurationRestart (575), setVoice/setRate/setPitch (601/619/630); play/pause/resume/stop/cancelCurrentSource; dispose (865); detachUtterance (1078), silentCompletionGuard (1085), haltBrowserPlayback (1093), speakBrowserChunk (1108); previewVoice terminal ownership; startKeepAlive, scheduleStuckWatchdog; bounded diagnostic snapshot.
- app.js: initTTSEngine (612) áp dụng saved browser voice riêng, render voice dropdown ngay khi init; populateVoiceSelect (858) render active voice/Cloud config mà không gọi engine/voice setters.

Tests:

- Thêm tests/test_codex_phase2_tts_core.mjs: 49 deterministic behavioral cases; virtual clock, Speech mocks, audio listeners, actual production engine.
- tests/test_codex_phase1_patch_verification.mjs: chỉ sửa case stale onend thành async và đợi 275ms để replacement sau debounce đã xảy ra trước khi gọi captured callback. Giữ nguyên assertion watchdog. Không hạ tiêu chuẩn hay xóa case đỏ ngoài scope.
- Không chỉnh hai suite legacy bị lỗi ./tts.js import từ tests/ của Phase 1.

Đã so sánh trực tiếp nội dung function: splitIntoSmartChunks, renderChapterContent và app.onStatusChange/chapter handoff giữ nguyên. Không sửa cloudTtsProvider, scheduler, History, MediaSession, SleepTimer, Ambient hoặc AutoScroll.

## 3. Restart logic trước/sau

Trước: mỗi setter gọi speakCurrentChunk ngay cả cùng giá trị; voiceschanged gọi chọn voice mặc định rồi populateVoiceSelect gọi setVoice, tạo restart liên tiếp.

Sau:

1. Normalize trước và return nếu effective value không đổi.
2. Identity voice dựa URI/name+lang, không dựa object reference. Khi voice list chưa đầy đủ, giữ lựa chọn trước đó; preferred voice được lưu khi yêu cầu trước lúc voice khả dụng.
3. Một configurationRestartTimer duy nhất, 250ms theo debounce được bàn giao. Rapid changes gộp một restart; revert về cấu hình utterance hiện tại hủy restart. Không thêm debounce tầng khác.
4. Timer sở hữu generation + playbackRequestId + index + handle. Stop/Pause/cancel/Error/Dispose và bắt đầu chunk mới clear timer. Captured timer cũ không thể phát phiên mới.
5. Khi paused, không tự speak. Resume thay utterance một lần nếu final config khác; nếu không thì giữ native utterance.
6. Khi đang handoff/retry, câu/attempt tiếp theo dùng final config, không thêm restart cạnh tranh.
7. Replacement detach callbacks trước cancel rồi mới submit utterance; index không reset. Explicit engine/cloud voice configuration cũng đi qua cùng scheduling để tránh Browser/Cloud overlap do đổi mode.

## 4. Terminal event/error handling

Mỗi utterance có một context sở hữu generation, utteranceToken, requestId, index, startedAt, paused duration và terminal guard. Đây là metadata của engine hiện có, không phải engine/state machine thứ hai.

| Event | Hành vi |
|---|---|
| Valid onstart | Ghi lifecycle start một lần; không reset error budget; kiểm tra lại ownership sau observer callbacks |
| Valid onend | Guard completion → cleanup → completion observer → ownership check → một async advance hoặc natural end |
| Duplicate terminal | Return, không cleanup shared state hoặc advance lần hai |
| Stale callback | Return trước shared cleanup; không xóa watchdog/timer của utterance mới |
| network error lần 1 | Cleanup failed attempt, một setTimeout(0) retry cùng chunk |
| network error lần 2 | Halt/error; giữ index; không skip, không retry thêm |
| Lỗi khác | Halt/error ngay; không retry |
| Active canceled/interrupted | Halt với outcome cancel/interrupted, trạng thái error; không completion |
| Cancel/Stop chủ động | Invalidate ownership và detach callbacks trước synth.cancel; sync cancel-onend không recurse |
| Terminal khi paused | Không advance/complete; retained utterance đã kết thúc thì Resume phát lại cùng chunk |
| Watchdog | Halt với outcome timeout; giữ index, không completion/advance/retry |

Error budget chỉ reset bởi valid completion hoặc thao tác phiên/seek mới của người dùng; không reset tại onstart/Resume/config replacement. haltBrowserPlayback đặt inactive trước native cancellation, cleanup timers/utterance, xóa highlight, emit error và warning rõ ràng. Outcome được giữ trong diagnostic snapshot.

Chunk rỗng/dấu câu được lọc bằng vòng lặp, không gọi speakCurrentChunk đệ quy. Native speak exceptions được chuyển thành synthesis-failed và halt. Observer thay generation/Stop không cho callback cũ tiếp tục submit/advance hoặc ghi đè trạng thái phiên mới.

## 5. silentCompletionGuard

Source bàn giao chưa có guard; Phase 2 đã triển khai guard trong engine hiện tại.

- onend thiếu onstart: missing-start, halt.
- Câu dưới 80 ký tự chữ/số Unicode: không có elapsed threshold; câu ngắn hợp lệ ở rate 0.7, 1 và 2.2 được chấp nhận.
- Câu dài: elapsed active time (trừ thời gian user pause) nhỏ hơn min(200ms, số ký tự chữ/số * 2ms / utterance.rate) bị đánh dấu premature-end. Rate lấy từ utterance đang phát, không lấy pending slider value.
- Suspicious completion không được advance, count completion hay retry tự động. Giữ câu để người dùng quyết định Play lại.

Đây là heuristic kiểm tra lifecycle cực kỳ bất thường, có ngưỡng thấp hơn nhiều so với thời gian đọc bình thường. Nó KHÔNG chứng minh âm thanh thật, không dùng onstart hoặc elapsed hợp lệ làm bằng chứng đã có tiếng, và không phát hiện chắc chắn native silent playback. Engine vẫn giữ tên callback onActualChunkComplete vì compatibility; ý nghĩa xác nhận ở đây chỉ là lifecycle hợp lệ. Khả năng false positive/missing native events phải xác minh Phase 5.

## 6. Keep-Alive findings

- Không vô hiệu hóa Keep-Alive toàn bộ. Offline SAPI vẫn pulse sau 10 giây active playback.
- Microsoft HoaiMy/Natural/Online tiếp tục được classifier loại khỏi pulse.
- Một heartbeat timer cho context đang phát; không dùng pending selectedVoice để phân loại. Timer mới thay timer cũ; captured old tick không chạm timer mới.
- Không pulse trước onstart, khi paused, khi handoff, khi config restart pending, khi native không speaking/đã paused, hay sau Stop/Error/Dispose.
- Retained Resume rearm một watchdog/heartbeat. Replacement lập context/timer mới.
- Sau synth.pause, kiểm tra ownership/state lại trước paired resume để synchronous terminal/Stop không resume phiên đã kết thúc.
- Tests giả lập xác nhận một pause/resume pair cho offline, không pair cho HoaiMy, không duplicate timer, không heartbeat sau Stop. Chưa chạy native Edge để chứng minh stream/RAM an toàn.

## 7. Tests và execution

| Run | Kết quả |
|---|---|
| Phase 1 core subset trước sửa | 13 tests: 3 PASS / 10 FAIL |
| Cùng subset sau sửa (stale test đợi actual replacement) | 13/13 PASS, khoảng 490ms |
| Phase 2 targeted suite cuối | 49/49 PASS, khoảng 88ms |
| Hai diagnostics riêng dành Phase 3–4 | 0 PASS / 2 FAIL, expected outstanding defects |
| app.js syntax check | PASS |
| tts.js syntax/import | PASS qua syntax check và cả hai targeted runs |

Lệnh core subset:
node --test --test-name-pattern "same effective|voiceschanged|onstart then|onend without|last-chunk|Pause ->|paused rate|stale captured|duplicate captured|watchdog halts|online voice" tests/test_codex_phase1_patch_verification.mjs

Lệnh Phase 2:
node --test tests/test_codex_phase2_tts_core.mjs

Mọi child process chạy tuần tự, timeout 15 giây; không có background test process. Virtual-clock tests gồm bounded timer execution, single native utterance assertion, zero playback timers sau halt/Stop, listener bounds và duplicate init guard. Synthetic circuit-breaker test kiểm tra đúng ngưỡng 60; đây không phải browser stress test hoặc native RAM đo đạc.

Không chạy full suite/build, Edge, Cloud network, IndexedDB deletion, commit/push/reset. Git metadata vẫn không có trong source workspace; không thể báo branch/clean working tree.

## 8. Rủi ro còn lại và artifacts

UNVERIFIED: native Edge audio output, event ordering/voice object behavior thực, false-positive threshold trên Native voices, Browser Process RAM, offline pulse tác động vật lý, toàn bộ Cloud/module integrations và full legacy regression. Không diễn giải counters/zero timers thành bằng chứng native RAM không tăng.

CONFIRMED DEFERRED:
- Phase 3: Reader vẫn 6 chunks/TTS 5 với quoted sentence; highlight/currentChunkIndex/logical progress cần chung mapping.
- Phase 4: Stop trong 800ms chapter handoff vẫn bị old controller autoplay; module cancellation token chưa sửa theo giới hạn Phase 2.

Artifacts:
- diagnostics/phase2_before_core_tests.txt và phase2_after_core_tests.txt: FAIL trước → PASS sau.
- diagnostics/phase2_targeted_test_output.txt: 49/49 PASS.
- diagnostics/phase2_deferred_phase3_phase4_tests.txt: hai defects ngoài scope vẫn đỏ.
- diagnostics/phase2_before_tts.js.txt và phase2_before_app.js.txt: snapshot đầu phase để review khi thiếu Git metadata.
- diagnostics/phase2_production_changes.patch: diff hai production files.
- tests/test_codex_phase2_tts_core.mjs: repeatable targeted behavioral tests.

DỪNG SAU PHASE 2.
