# VietReader — Phase 3: Sentence segmentation & Reader progress consistency

Ngày kiểm tra: 2026-10-09. Dừng sau Phase 3.

## 1. Baseline và segmentation contract

Workspace: C:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader.
Git status báo “not a git repository”; không có thông tin branch/commit đáng tin cậy. Không reset, commit hoặc push. Source đầu Phase 3 được lưu tại diagnostics/phase3_before_{app,tts,storage}.js.txt; các thay đổi Phase 2 và dữ liệu người dùng được giữ nguyên.

Một thuật toán duy nhất nằm trong chunkMapping.js: splitParagraphIntoChunks → buildChapterChunkMap. Input là văn bản SAU cleanChapterText, chạy một lần cho mỗi render/load. Reader truyền chính object map đã render vào TTSEngine.loadText; splitIntoSmartChunks chỉ là adapter tới helper chung, không có regex chia câu độc lập trong app.js/tts.js.

Contract:
- Paragraph index theo sourceText.split(/\n+/), giữ semantics index trước đây; paragraph rỗng không render thành playable chunk.
- Chunk index liên tục, bắt đầu 0 trong từng chương, cùng content/order cho span và TTS.
- start/end là offset UTF-16 trong paragraph đã trim, phù hợp offset text/DOM. Không tự chuyển NFC/NFD hay sửa dấu tiếng Việt.
- Giữ whitespace giữa chunks trong Reader và dấu câu ở ranh giới; không thêm khoảng trắng giả vào spans. Không mất dấu phẩy như nhánh chia clause cũ.
- Paragraph chỉ có dấu câu/emoji không chứa chữ hoặc số vẫn hiển thị, không tạo chunk phát rỗng.
- Giữ quy tắc dấu chấm/hỏi/cảm/thán/ellipsis/semicolon/colon và dấu đóng ngoặc/nháy của TTS trước Phase 3. Ngưỡng 220/180 là soft limit; câu rất dài không có comma vẫn có thể dài hơn ngưỡng.
- Logical word offsets lấy từ cùng map và token /\S+/; một token kiểu TP.HCM không bị đếm thêm mỗi lần nó bị chia thành nhiều chunks. Công thức scale và Analytics không thay đổi.

## 2. Claude patch verified/fixed

CONFIRMED DEFECT trước sửa: Reader còn regex riêng thiếu dấu đóng nháy, còn TTS có regex khác và loại/gộp chunk chỉ chứa punctuation. Không có helper chung thực sự trong source đầu Phase 3. Vì thế báo cáo Claude “đã thống nhất” chưa đúng với workspace này.

Mẫu: “Xin chào.” + newline + Câu hai. Câu ba. Câu bốn. Câu năm.
- Trước: Reader 6 chunks, TTS 5 chunks (closing quote trở thành chunk riêng ở Reader).
- Sau: cả hai 5 chunks: “Xin chào.” / Câu hai. / Câu ba. / Câu bốn. / Câu năm.
- Test so sánh cả count, content và order; không chỉ kiểm tra tên helper tồn tại.

VERIFIED FIXED trong mock behavioral tests: canonical segmentation; click/highlight/Next/Previous/scrub cùng index; cleaner reload dựng lại word map; restore không autoscroll theo chunk; callback cũ và handoff cũ không ghi vị trí/phát chương mới; Stop/seek/manual chapter load hủy autoplay đang chờ.

## 3. Reader/TTS mapping trước và sau

Trước: renderer tự chia câu và thêm spaces, TTS tự chia lần nữa; buildLogicalProgressMap đếm words từ từng DOM span. Cleaner reload reset TTS về 0 và không rebuild logicalProgressMap. Auto chapter handoff làm cleaner/loadText lần thứ hai sau render, có thể lệch mapping nếu rules thay đổi trong thời gian chờ.

Sau: renderChapterContent tạo readerChunkMap, TTSEngine giữ cùng object, logicalProgressMap dùng chunk offsets. Click handler giữ map lúc render và từ chối khi map/book/chapter/generation đã thay đổi. Playback hooks và UI seek kiểm tra ownership; media/keyboard/dock entry points từ chối map cũ trong lúc chương chưa tải xong. Highlight restore có scroll:false.

Auto handoff dùng map mà loadChapter vừa nạp, không clean/loadText lại. Owner gồm book, chapter generation, navigation generation và playback generation. Delay 800ms và unlock timer có cleanup. Chỉ actual chunk start mở khóa; seek/restore không giả là audio đã chạy. Manual navigation có thể thay thế handoff. Callback terminal trùng không tạo double chapter completion trong test với engine thực và native Speech mock.

## 4. Saved progress compatibility

Không đổi IndexedDB schema/version, không migration hoặc xóa dữ liệu. Thêm ttsChunkAnchor là field thông thường của book: segmentation version, source fingerprint, chapter/index, paragraph/start offset, head/tail và context ngắn. Các updateProgress từ Reader gửi anchor cùng index, snapshot payload trước await; pending writer cũ đang chờ initDB không được ghi đè writer mới.

Resolution:
1. Map version/source/chapter/index/offset/text khớp → exact.
2. Text head/tail khớp duy nhất hoặc context phân biệt được → text-anchor.
3. Không đủ dữ liệu → paragraph offset gần nhất, rồi bounded index fallback; đánh dấu gần đúng.
4. Legacy không có anchor → giữ index hợp lệ hoặc clamp index vượt phạm vi; số âm/NaN/Infinity/fraction/invalid → 0. Chương rỗng → 0, không phát.
5. Anchor thuộc chương khác → 0; mở chương khác không tái sử dụng index/anchor của saved chapter.

Dữ liệu cũ chỉ có integer index không đủ để khôi phục chính xác câu khi segmentation/cleaner đổi. Không giả vờ đó là exact; UI thông báo gần đúng khi restore có vị trí cần giữ. Không suy ra TTS index từ scrollY.

scrollY tiếp tục là vị trí đọc bằng mắt; currentChunkIndex là vị trí TTS. Scroll 23px vẫn được restore (ngưỡng >50 cũ bị bỏ). Seek/scroll xảy ra khi đang await highlights hoặc sau load nhưng trước timer restore không bị ghi đè. Cleaner reload giữ seek/scroll mới nhất, không autoplay. Navigation chỉ rebase progress baseline; không tự gọi markActivity qua noteTrustedKeyboardActivity. Các trusted input listeners và actual audio signals vẫn giữ vai trò activity.

Giới hạn writer token: bảo vệ await/initDB trong một app instance, không phải cơ chế phối hợp nhiều tab hay sửa thứ tự transaction đã dispatch.

## 5. Files/functions thay đổi

- chunkMapping.js (mới): splitParagraphIntoChunks, buildChapterChunkMap, createChunkAnchor, resolveSavedChunkIndex.
- tts.js: import helper, loadText(fullText, chunkMap), splitIntoSmartChunks adapter. Không sửa lifecycle Phase 2; diff chỉ thay segmentation/load mapping.
- app.js: renderChapterContent, buildLogicalProgressMap, highlightSentenceChunk, openBook/loadChapter, reloadCurrentChapterText, progress writers; ownership cho chunk hooks/handoff/async highlights/navigation; guards ở scrub/dock/keyboard/media controls; showLibraryView invalidates pending loads.
- storage.js: optional anchor payload, validate numeric values và latest pending write token trong updateProgress. Không sửa schema.
- tests/test_codex_phase3_chunk_mapping.mjs (mới): behavioral harness thực thi selected production functions và TTSEngine thực, với DOM/Speech/clock/DB mocks.
- tests/test_codex_phase1_patch_verification.mjs: bổ sung helper/context/owner mới vào harness, giữ assertions segmentation và Stop/autoplay.
- tests/test_bookmark_navigation.mjs, tests/test_search_navigation.mjs: sửa đường import/URL từ ./ thành ../ vì file nằm trong tests; giữ các assertions gốc.
- diagnostics/: before snapshots, production diffs, JSON output của final targeted runs.

## 6. Regression tests thực sự chạy

Mỗi file chạy tuần tự bằng node --test, timeout 15 giây/file; không full suite/build/stress.

| Target | Kết quả |
|---|---|
| test_codex_phase3_chunk_mapping.mjs | 36/36 PASS |
| test_codex_phase2_tts_core.mjs | 49/49 PASS |
| test_codex_phase1_patch_verification.mjs | 15/15 PASS |
| test_bookmark_navigation.mjs | PASS — script assertions, Node tính 1 file-test |
| test_search_navigation.mjs | PASS — script assertions, Node tính 1 file-test |
| node --check app.js, tts.js, storage.js, chunkMapping.js | PASS |

Phase 3 bao gồm punctuation/ellipsis/quotes/dialogue/newlines/Unicode/NFD/empty/nopunctuation/abbreviation/long comma/unbroken text; 250 mẫu deterministic fuzz kiểm tra bảo toàn ký tự; rendering content/order; highlight/click/next/prev/scrub; saved exact/legacy/invalid/deleted/ambiguous anchor; independent scroll; stale rules/highlight/native callbacks; async book open; cleaner reload và real cleaner dictionary pipeline; bookmark/search same/other chapter; Stop/manual seek/chapter load during handoff; final actual terminal event duplication; stale DB await.

Bookmark/Search scripts cũ kết hợp pure helper behavior và source assertions, không phải browser E2E. Harness mới chạy handlers production nhưng mock visual focus/anchor/DB; pure anchor resolution được kiểm tra ở scripts cũ. Không sửa tests để bỏ qua defect: initial highlight assertion được chỉnh timing để phát onstart giống contract thực của TTSEngine; assertions về index/highlight giữ nguyên. Hai Phase 1 failures trước đó nay PASS với harness dependencies phù hợp.

Output đầy đủ: diagnostics/phase3_targeted_test_results.json. Diff: diagnostics/phase3_app.diff, phase3_tts.diff, phase3_storage.diff.

## 7. Chưa thể bảo đảm chính xác

UNVERIFIED: Native Edge/audio output, scroll layout/selection trong browser thật, Browser Process RAM/OOM; không khởi chạy browser hoặc stress test.

Anchor cũ chỉ có index, text đã bị cleaner xóa/thay mạnh, nhiều đoạn lặp giống cả context, đoạn dài có cùng head/tail nhưng middle khác, hoặc fingerprint collision không đủ để khẳng định exact semantic sentence. Fallback được công khai là approximate, giữ dữ liệu thay vì migration đoán.

Abbreviation/decimal/time punctuation vẫn là heuristic của splitter có sẵn; ví dụ TP.HCM hoặc 9:30 có thể thành nhiều chunks. Reader/TTS cùng mapping, không tuyên bố đã có phân tích ngôn ngữ hoàn hảo. Câu rất dài không có dấu phẩy không có hard cap; giới hạn native Speech chưa được thử.

Saved highlight module hiện tìm match trong từng text node và occurrence đầu tiên; không bảo đảm highlight cũ bắc qua nhiều chunk/text node hoặc vị trí text lặp được khôi phục chính xác. Search focus giữ chunk parent khi wrap text nodes; không thay schema/algorithms highlight/bookmark/search ở Phase 3. Các semantics DOM/native và integrations sâu hơn thuộc Phase 4/5.

Không thay công thức Analytics, không thay lifecycle core Phase 2, không thay UI lớn, không xóa IndexedDB, không tự commit/push. Dừng tại đây.
