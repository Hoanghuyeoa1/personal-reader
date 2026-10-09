# Global Full-Text Search — Phase 1

Audit và quyết định kiến trúc ngày 2026-10-07. Đây là tài liệu thiết kế; Search và migration V4 chưa được triển khai.

## 1. Phạm vi và kết luận

Đã đọc trực tiếp các đường dữ liệu liên quan trong `storage.js`, `cleaner.js`, `app.js`, `highlight.js`, `tts.js`, `index.html`, `styles.css`, toàn bộ `test_parser.mjs`, và đối chiếu README/CHANGELOG; đọc thêm `parser.js` và `package.json`. Không tìm thấy AGENTS.md trong workspace hoặc các thư mục cha đã kiểm tra. Đây là audit tĩnh trên mã nguồn, không phải kiểm tra dữ liệu IndexedDB thực tế của người dùng hay đo hiệu năng thư viện lớn.

Chốt phương án:

- Module `search.js` chịu trách nhiệm engine/cache; `app.js` chỉ orchestration, navigation adapter và UI.
- **Một index record cho mỗi chapter**, chứa danh sách paragraph đã normalize và logical paragraph index. Không tạo một store record cho mỗi paragraph.
- Search tìm trên **text thực sự được trình đọc hiển thị sau cleaner/dictionary và chia chunk**, không tìm quảng cáo đã bị xóa hoặc từ gốc đã bị thay thế. Source of truth vẫn là `chapters.content` và các rules/settings.
- Cache persistent cần **DB schema V4 ở phase triển khai**, chỉ thêm store `searchIndex`; Phase 1 không cần sửa schema hay runtime.
- Navigation dùng `bookId + chapterIndex + paragraphIndex + UTF-16 match range/context`, đợi Promise render thật. Không dùng scrollY làm anchor; không thêm timer đoán DOM.
- Backup giữ danh sách user-data stores hiện tại. Không export/import search cache, không yêu cầu cache để đọc hoặc restore sách.

## 2. Audit thực tế

### 2.1. Dexie và shape dữ liệu

`storage.js:8–35`: tên DB `VietReaderDB`, schema hiện tại **3**. Đây là version schema của ứng dụng, khác với version thư viện Dexie **3.2.4** được nạp CDN tại `index.html:16`.

| Version khai báo | Store và schema literal |
| --- | --- |
| 1 | `books: '++id, title, author, totalChapters, currentChapterIndex, lastReadAt, createdAt'` |
| 1 | `chapters: '++id, [bookId+chapterIndex], bookId, chapterIndex, title'` |
| 1 | `settings: 'key'` |
| 2 | `audioCache: 'key, provider, voice, createdAt'` |
| 3 | `customRules: '++id, bookId, isEnabled, createdAt'` |
| 3 | `highlights: '++id, [bookId+chapterIndex], bookId, chapterIndex, paragraphIndex, createdAt'` |

Schema literal chỉ liệt kê primary key/indexes, không phải toàn bộ field object. Index `isEnabled` là boolean trong record; không dùng index đó để suy ra effective rules, vì code hiện tại lấy `toArray()` rồi filter.

Book mới thực sự được tạo tại `saveBookWithChapters()` (`storage.js:43–75`):

```js
{
  id,                         // number, Dexie sinh
  title, author, coverGradient,
  totalChapters,               // chaptersList.length, không lấy bookData.totalChapters
  currentChapterIndex: 0,
  currentChunkIndex: 0,
  scrollProgress: 0,
  scrollY: 0,
  wordCount,
  createdAt, lastReadAt        // Date.now()
}
```

`ttsSettings` được thêm về sau bởi `updateBookTtsSettings()` (`storage.js:362`). Caller `handleSaveTtsSettings()` lưu voice/engine/rate/pitch. Import database chép nguyên object hoặc spread object nên backup cũ có thể thiếu field mới hoặc mang thêm field; shape trên là shape sách mới, không phải validation contract cho mọi backup.

Chapter mới:

```js
{ id, bookId, chapterIndex, title, content, wordCount }
```

`content` là **plain text**, không phải HTML, không phải `rawText` hay `text`. `chapterIndex` được storage đánh lại bằng vị trí `idx` trong array, dù parser có cung cấp field này. `getChapter()` tìm compound index `[bookId+chapterIndex]`, ép hai tham số thành Number, lấy `.first()`. Compound index hiện tại không khai báo unique. `getBookChaptersMeta()` sort theo chapterIndex rồi chỉ trả `{id, chapterIndex, title, wordCount}`; không thể build index bằng metadata này vì không có content.

### 2.2. Save, import, delete, restore

| Luồng | Hành vi hiện tại và bằng chứng |
| --- | --- |
| TXT/PDF/EPUB | `handleFileSelection()` (`app.js:1413`) đọc parser; TXT/PDF split rawText, EPUB dùng chapters từ spine hoặc fallback split; gọi `saveBookWithChapters()`, refresh library rồi openBook. Trong vòng lặp, mỗi file thành công đều được mở, dù comment nói first imported book. |
| Paste | `handleRawTextSubmit()` (`app.js:1484`) split nội dung, count words, save rồi refresh/open. |
| Sample | `loadSampleStory()` (`app.js:2271`) cùng đi qua saveBookWithChapters. |
| Save | Transaction `rw` books + chapters; add book rồi bulkAdd chapters; không chạy cleaner ở bước ghi. |
| Delete | `handleDeleteBook()` (`app.js:1643`) confirm rồi gọi `deleteBook()`; transaction chỉ xóa chapters và book (`storage.js:140`). **Không cascade customRules/highlights** hiện tại. |
| Restore replace | `importDatabase(data, true)` (`storage.js:202`) transaction 5 stores books/chapters/settings/customRules/highlights; clear cả 5 rồi bulkAdd/bulkPut dữ liệu, giữ IDs từ backup. |
| Restore append | Sinh book IDs mới, remap chapter.bookId và highlight.bookId, xóa ID cũ trước add. Không nhập settings. Custom rules được add với ID mới nhưng **bookId không được remap** (`storage.js:261–267`). |

Không thấy API/chức năng chỉnh sửa chapter content hiện tại: các write nội dung là save và restore. Nếu phase sau thêm chỉnh sửa thì phải tạo đường write có invalidation rõ ràng; không giả định đang có `updateChapter()`.

### 2.3. openBook và Promise render

`openBook(bookId, targetChapterIndex = null)` (`app.js:1666`):

1. Await getBook; thiếu sách thì toast và return undefined.
2. Gán state.currentBook; await chapter metadata; áp dụng per-book TTS settings.
3. Nếu không có explicit target: lấy currentChapterIndex, scrollY và currentChunkIndex từ book. Nếu có target: scroll/chunk khởi tạo bằng 0.
4. Chuyển view, scroll top; **await loadChapter(...)**.
5. Catch lỗi và toast, không rethrow; success cũng không trả render metadata.

`loadChapter(chapterIndex, initialScrollY = 0, initialChunkIndex = 0)` (`app.js:1729–1862`) là async, thứ tự thực:

1. Guard currentBook và chapter bounds theo chaptersMeta.length.
2. Stop TTS và AutoScroll, hide selection toolbar.
3. Gán currentChapterIndex; await getChapter; thiếu chapter thì return.
4. Gán currentChapter, cập nhật heading/media metadata.
5. Await getCustomRules; chạy cleanChapterText với enableGlobalCleaner.
6. **Render DOM đồng bộ** bằng renderChapterContent; nạp cleaned text vào TTS.
7. Await loadAndApplyChapterHighlights và refreshQuotesHubCount.
8. Clamp initialChunkIndex; `jumpToIndex(validChunk, false)`; cập nhật dock/TOC.
9. initialScrollY > 50 thì **schedule** scroll smooth sau 150ms; ngược lại scroll top ngay.
10. Await updateProgress, update progress bar rồi Promise resolve.

Vì vậy `await loadChapter()` đã chờ gắn paragraph/chunk/highlight vào DOM; **không** chờ scroll timer 150ms chạy xong, paint hay font tải xong. Search luôn truyền initialScrollY = 0 khi phải load, nên không cần timer này. `jumpToHighlight()` hiện dùng delay 200ms (`app.js:3073`); không sao chép cách đó sang Search. Delay TTS 800ms cũng không phải contract render cho Search.

Hai hàm dùng mutable global state qua nhiều await, chưa có navigation request token. Bounds/metadata/TOC đang dựa vào chapter positions liên tục từ 0; backup có index gap/duplicate không được normalize. Search phải validate chapter đích thật, không điều hướng bằng thứ tự result hoặc TOC row.

### 2.4. DOM và text projection

Container thật: `#reader-body-content` (`index.html:231`). Markup do `renderChapterContent()` tạo (`app.js:1867–1926`):

```html
<p class="reader-paragraph" data-para-index="0">
  <span class="tts-chunk" data-chunk-index="0" title="Nhấp để nghe từ câu này">Câu một. </span>
  <span class="tts-chunk" data-chunk-index="1" title="Nhấp để nghe từ câu này">Câu hai! </span>
</p>
```

Không có node/class `.sentence` riêng. Một câu ngắn là một tts-chunk; câu > 220 ký tự được ghép/tách clause theo dấu phẩy với ngưỡng < 180. data-chunk-index tăng trên toàn chapter, không reset theo paragraph.

Paragraph = `cleanedContent.split(/\n+/)`; trim từng phần, skip phần rỗng nhưng **giữ pIdx của array trước skip**. Vì thế paragraphIndex có thể có gap, nhất là cleaner off hoặc dictionary tạo dòng chỉ whitespace. Không dùng `querySelectorAll('p')[paragraphIndex]`; phải select theo data-para-index.

Mỗi chunk escapeHTML text rồi thêm **một space cuối**. Sentence regex, trim và nối clause có thể thay whitespace của cleaned text. Ví dụ `A.B!` hiển thị thành `A. B! `; normalized offset từ raw/cleaned text không tự động là offset DOM. Paragraph trống cả chapter tạo placeholder `<p class="reader-paragraph">Nội dung chương trống.</p>` không có anchor; placeholder này không được index.

Saved highlight (`highlight.js:95–149`): `<mark class="reader-highlight hl-yellow" data-highlight-id="..." title="...">text</mark>` bên trong text node/chunk. TreeWalker chạy toàn container, skip text node đã trong mark, xử lý highlight dài trước và dừng ở text node đầu tiên match. Có thể thay nhiều occurrences trong node đó; không match xuyên nhiều text nodes. CSS thật dùng `.reader-highlight` (`styles.css:1611`), còn TTS dùng `.tts-chunk.active-tts-chunk` (`styles.css:695`). Không dùng `.reader-mark` trong mô tả README làm contract.

### 2.5. Cleaner/rules/highlight anchors

`cleanChapterText()` (`cleaner.js:103`) giữ raw storage nguyên vẹn, xử lý:

```text
chapters.content
  -> cleanGarbageText nếu enableCleaner
  -> applyCustomRules theo thứ tự array
  -> cleanedContent
  -> paragraph/sentence/clause projection của renderer
  -> DOM và TTS chunks
```

Global junk patterns nằm trong code `GLOBAL_JUNK_PATTERNS` (`cleaner.js:9`), không có store cho từng pattern. Cleaner xóa URL/dòng crawler/divider, đổi CRLF, bỏ trailing spaces, co 3+ newline về 2 rồi trim. Custom rules áp dụng tuần tự, skip disabled/find rỗng, literal được escape regex, flags g/gi, regex lỗi được catch; replacement sử dụng semantics của String.replace (kể cả `$` substitutions). Rule có thể chèn/xóa newline: phải clean toàn chapter trước khi split paragraph, không clean từng paragraph độc lập.

Toggle toàn hệ thống lưu `settings` key `enableGlobalCleaner` (`app.js:439`, `3151`); load mặc định true. Dictionary lưu `customRules` object `{id, bookId, findText, replaceText, isRegex, isCaseSensitive, isEnabled, createdAt}`. Scope global là null/undefined/'global'; scope book so bằng Number. `getCustomRules(null)` trả **tất cả** rules, không chỉ global; build Search bắt buộc gọi với bookId cụ thể. Không có bước book-rule override global-rule; thứ tự là array trả từ toArray/filter.

Mutations: add (`handleAddDictionaryRule`), toggle/delete trong `renderDictionaryRulesTable`, import (`handleImportRulesJSON`), storage CRUD/import API. Chúng gọi `reloadCurrentChapterText()` (`app.js:3329`) để fetch rules, render, loadText, reapply highlights và giữ scrollY. Hàm này **không giữ TTS currentIndex**: loadText reset về 0. Đây là hành vi hiện có, không sửa trong Phase 1.

Saved highlights lưu paragraphIndex từ startContainer.closest('.reader-paragraph') khi add/color/note (`app.js:2755`, `2841`; `storage.js:520`). Nhưng **applyHighlightsToContainer không đọc paragraphIndex**, chỉ tìm selectedText trên toàn chapter. Do đó index là metadata lưu, chưa là anchor được dùng khi restore highlight. Dictionary/content đổi có thể làm selectedText mất hoặc match nhầm lần đầu. Search phải có range/context riêng, không tái sử dụng hàm restore saved highlight để định vị match và không rewrite các highlight cũ.

### 2.6. Search và keyboard hiện có

- Library: input `#library-search-input`, input event (`app.js:816`), `filterLibraryCards()` (`1621`) trim/lowercase rồi includes trên **title hoặc author của card DOM**, display flex/none, cập nhật count. Không search content và không bỏ dấu tiếng Việt.
- TOC: input `#toc-search-input`, input event (`app.js:839`), `filterTocChapters()` (`2023`) includes lowercase trên toàn button.textContent, gồm title và word-count badge. Không search content/bỏ dấu. Mở drawer xóa filter và focus input.
- `handleKeyboardShortcuts()` (`app.js:1336`) bỏ qua khi activeElement là input/textarea/select; chỉ chạy reader active. Space play/pause, arrows chunk/speed, brackets chapter, A/S auto-scroll, Escape selection/Zen. Chưa có guard contenteditable, modal/search focus, composing, modifiers hoặc defaultPrevented. Phase UI bổ sung guard cho Search overlay và IME, không vô tình chiếm phím nhập liệu hoặc browser shortcuts. Giữ hai filters cũ; thêm đường Global Search riêng.

### 2.7. TTS navigation và các bảo vệ phải giữ

- `TTSEngine.stop()` (`tts.js:401`) stopKeepAlive; null onend/onerror/onstart và currentUtterance **trước** synth.cancel; pause/reset audio, revoke object URL; tắt playing/paused, onChunkEnd, status stopped. Không reset currentIndex.
- `loadText()` (`tts.js:296`) gọi stop, split text rồi **reset currentIndex = 0**. `jumpToIndex(index, false)` vẫn emitChunkStart, có highlight/autoscroll/persist side effects; không phát âm thanh nhưng không phải setter thuần.
- `speakBrowserChunk()` (`tts.js:504`) cleanup utterance trước cancel; chunks array rỗng thì stop, không completed; chunk whitespace thì skip khi playing và chưa paused. onend/onerror cleanup callbacks; interrupted/canceled bị bỏ qua; hoàn thành valid sequence mới emit completed. `speakCurrentChunk()` cũng guard empty array.
- Pause/resume (`tts.js:364`, `381`) dùng audio hoặc speechSynthesis, giữ currentIndex; keepAlive browser pause/resume mỗi 10s, stop xóa timer.
- Auto-next tại `initTTSEngine().onStatusChange` (`app.js:519–641`): chặn completed lặp bằng isChapterSwitching; history trong 5s, đã có 2 lần thì stop, mở khóa, toast. Set lock; kiểm tra sleep timer/chương kế; stop, await loadChapter, nghỉ 800ms, raw content >= 20 ký tự, clean lại, loadText, guard chunks, jumpToIndex(0,true); timeout fallback mở khóa 8s, catch/no next/empty mở khóa.
- **Khác comment:** `onChunkStart` mở khóa (`app.js:482`), nhưng `loadChapter` gọi jumpToIndex(false), vốn cũng emitChunkStart; lock có thể mở trước khi thực sự nói. Không coi lock hiện tại là mutex cho mọi navigation. Giữ cơ chế này và ghi regression test trước khi thêm guard mới.
- `speakCloudChunk()` (`tts.js:641`) await cache/fetch/play chưa có AbortController/generation check; stop không hủy fetch đang pending. Cloud response cũ có khả năng phát sau khi Search chuyển sách. Cần kiểm thử và bổ sung check generation tối thiểu khi triển khai, không đơn giản hóa Safe Utterance Cleanup.
- AutoScroll onReachBottom schedule navigation sau 1.5s (`app.js:2582`); stop engine không tự xóa timer này trong app. Một navigation mới phải vô hiệu hóa callback cũ bằng generation, không thêm timer/polling DOM.

### 2.8. Reading state và backup

Không có persisted field `currentChapter`, `readingProgress`, `lastRead` hoặc `lastReadPosition` trong code hiện tại. `state.currentChapter` là full chapter object trong RAM. Tên thực tế:

| Ý nghĩa | Field/luồng thật |
| --- | --- |
| Chương đang đọc | books.currentChapterIndex; state.currentChapterIndex |
| Tọa độ mắt đọc | books.scrollY, px làm tròn >= 0 |
| Con trỏ nghe | books.currentChunkIndex, số >= 0, loadChapter clamp theo chunks |
| Tiến độ sách | books.scrollProgress: percent làm tròn/clamp 0–100 |
| Lần đọc gần nhất | books.lastReadAt, Date.now() |

`updateProgress()` (`storage.js:126`) ghi cả 5 field. Call sites: loadChapter khi load xong; onChunkStart khi phát **hoặc jumpToIndex(false)**; scroll debounce 400ms (`app.js:1943`). Overall progress = `(chapterIndex + clamped scroll fraction) / totalChapters * 100`; không tính bằng chunk index. updateBookTtsSettings cũng cập nhật lastReadAt. Scroll và onChunkStart writes không await; đang có khả năng ghi cạnh tranh. Không thấy flush progress riêng trên beforeunload; search navigation cần chụp/flush outgoing state trước đổi currentBook, không lấy global state mới trong callback lưu cũ.

`exportDatabase()` (`storage.js:177`) trả `{version:3, appName, exportedAt, books, chapters, settings, customRules, highlights}`. **Không export audioCache**. Restore transaction cũng không xóa/restore audioCache, kể cả replace. Export dictionary riêng version 1; export highlights riêng Markdown. README schema (`README.md:265`) dùng nhiều tên không khớp code; mô tả restore theo paragraph và số test cũng không hoàn toàn khớp. Báo cáo lấy code làm chuẩn, không sửa README/CHANGELOG để tuyên bố Search đã có.

### 2.9. Tests tái sử dụng

`test_parser.mjs` thực tế có 15 nhóm assert, là script ESM chạy trực tiếp `node test_parser.mjs`; package.json chỉ có dev/build/preview, **không có npm test**.

| Nhóm | Tái sử dụng cho Search |
| --- | --- |
| 1–3 | Parser headings/chapter split/fallback, fixture nội dung nhập |
| 4 | TTS sentence chunking, mở rộng parity projection/DOM |
| 9 | Cleaner/rules/validateRules; thêm CRLF, newline replacements, scope/order |
| 11 | Quote/Markdown formatting, không phải test DOM highlight |
| 15 | Safe Utterance stop cleanup và empty-array no-completed |
| 5–8,10,12–14 | Baseline voice/rate/autoscroll/sleep/ambient/media khi chạm các integration đó |

Chưa có test Dexie migration/restore remap, DOM offset/highlight xuyên chunks, openBook/loadChapter concurrency, lock/circuit breaker trong app, cloud fetch cancellation, scroll/chunk persistence thực tế. Không suy diễn 15 nhóm pass trong README thành coverage cho các case này.

## 3. Module contract và hành vi Search

Các API sau là **đề xuất cho phase tiếp theo**, chưa tồn tại:

| Module/API | Trách nhiệm |
| --- | --- |
| search.js: normalizeVietnameseWithMap(text) | Text normalize + hai chiều range mapping UTF-16 |
| search.js: projectChapterText(content, rules, enableCleaner) | Chạy cleaner toàn chương rồi tạo text projection giống renderer |
| search.js: buildChapterIndex / buildBookIndex / ensureChapterIndex | Build/lazy validate, update theo compound key |
| search.js: removeBookIndex / invalidateChapter / invalidateBook / invalidateAll | Cache invalidation, cancel builders theo scope |
| search.js: search(query, {bookId, limit, signal, requestId}) | Matching/ranking/limits, snippets và logical metadata; bookId optional để lọc |
| search.js: cancelPendingSearch() | Hủy request cũ, không thao tác TTS/reader |
| storage.js: cache get/put/remove/clear và mutation notification | DB access + sự kiện sau khi source transaction commit; không chạy matching hoặc render |
| app.js: navigateToSearchResult / locateSearchRange / clearSearchHighlight | Điều phối reader, resolve DOM Range, temporary decoration |

Search engine không mở sách, không thay reading progress, không gọi play/stop/jumpToIndex, không giữ DOM node trong cache. Projection có thể gọi **hàm thuần hiện tại** `TTSEngine.prototype.splitIntoSmartChunks(paragraph)` để khớp sentence/clause logic; không tạo TTSEngine instance (tránh voice/audio timers), không sửa thân splitter hay cleanup. Đây là phụ thuộc hẹp cần parity test; nếu splitter sau này dùng instance state thì adapter phải được cập nhật/version bump. Không copy một thuật toán chia câu thứ ba vào search.js.

Chốt matching khởi đầu: literal phrase contains sau normalize, không regex query, không fuzzy/stemming, không match xuyên paragraph. Search body của mọi chapter; book/chapter titles là display metadata đọc từ source, không thay thế filters title/TOC hiện tại. Normalize cả query và text giống nhau: NFD, bỏ dấu combining tiếng Việt U+0300–036F, đ/Đ -> d, lowercase, collapse whitespace và trim query; giữ punctuation. Query rỗng hoặc < 2 normalized non-whitespace characters trả empty. Unicode code point/grapheme processing phải ghi offset UTF-16 để làm DOM Range, không lấy code-point index làm JS string offset.

`original` trong mapping là **projected visible paragraph text**, không phải chapters.content. Mỗi normalized code unit map tới `[start,end)` của cụm original (gồm combining marks, surrogate pair hoặc cả whitespace run). Match range map bằng start của unit đầu/end của unit cuối; reverse mapping dùng interval overlap/boundary cho text bị loại bỏ. Normalization không giả định 1:1. Map dựng lại trong RAM cho paragraph ứng viên khi tạo snippet/anchor; không lưu hai mảng offset O(n) cho mọi ký tự vào IndexedDB.

Ranking deterministic: exact original phrase (case-insensitive nhưng giữ dấu) trước accent-folded-only; ties theo numeric bookId, chapterIndex, paragraphIndex, original matchStart. Không phụ thuộc lastReadAt/indexedAt/locale sort hay current book để thứ tự không đổi do một lần open. Mỗi paragraph tối đa 3 non-overlapping occurrences; global limit mặc định 200, hard cap 500. Áp limit trên kết quả **đã ranking** (bounded top-K trong lúc scan), không dừng scan chỉ vì đã gặp K matches. `truncated` true nếu bỏ occurrence/result; không trả total chính xác khi chưa đếm hết. Snippet khoảng 80 UTF-16 units mỗi bên, điều chỉnh biên Unicode/word; text và match ranges được trả riêng, UI dùng textContent/text nodes để escape, không chèn raw HTML từ sách.

Mỗi request có monotonically increasing requestId + AbortSignal và source generation. Kiểm tra sau mỗi await, giữa chapter batches, trước publish. Query mới/close overlay/invalidation khiến request cũ trả cancelled hoặc bị discard; UI chỉ commit đúng requestId. Cancellation search khác navigation generation và khác isChapterSwitching của TTS.

## 4. Chốt index model và migration

### 4.1. A — chapter record, paragraphs là metadata nội bộ

Source content fetch/update/restore hiện ở đơn vị chapter; rules có thể đổi paragraph boundaries. Vì vậy rebuild một chapter atomically vừa đủ, không cần hàng nghìn paragraph keys cùng metadata lặp. Store record dự kiến:

```js
{
  bookId: 12,
  chapterIndex: 4,
  formatVersion: 1,            // cache shape
  algorithmVersion: 1,         // normalize + DOM projection/splitter + cleaner code
  contentFingerprint: '...',  // hash chính xác chapters.content
  rulesFingerprint: '...',    // ordered effective rules + enableGlobalCleaner
  indexedAt: 0,               // timestamp; không dùng làm freshness proof
  paragraphs: [
    { paragraphIndex: 0, normalizedText: '...' },
    { paragraphIndex: 2, normalizedText: '...' }
  ]
}
```

Fingerprint dùng SHA-256 của UTF-8 raw content và canonical JSON effective rules theo **đúng thứ tự áp dụng**, gồm findText/replaceText/isRegex/isCaseSensitive/isEnabled và cleaner toggle. Không sort rule theo findText hoặc ưu tiên book scope mới. Vô hiệu hóa/rule scope thay đổi phải thay fingerprint effective set. algorithmVersion bao phủ GLOBAL_JUNK_PATTERNS/renderer/splitter changes; sửa algorithm phải bump version.

Không lưu raw content, cleaned content, paragraph original text, snippet, DOM, audio hoặc map từng ký tự vào cache. Lấy lại source và project paragraph ứng viên để generate original text/map; index cache thêm xấp xỉ một normalized copy của body và metadata nhỏ. Empty chapter có record paragraphs=[] hợp lệ, tránh rebuild vô hạn. Đây là **cache để scan text**, không phải inverted index/B-tree full-text: substring matching vẫn O(tổng text), phải batch/yield để không chặn main thread. Hiệu năng hàng nghìn sách chưa được đo; không hứa độ trễ cố định.

### 4.2. Dexie V4 chính xác, chưa apply

Khi phase cache bắt đầu, giữ toàn bộ version(1–3), thêm trước db.open:

```js
db.version(4).stores({
  searchIndex: '[bookId+chapterIndex], bookId'
});
```

Compound primary key đã unique, không cần ++id hoặc secondary chapterIndex/normalizedText indexes. Không khai báo null cho store cũ. Không cần `.upgrade()` rewrite sách, không migrate progress/highlight, không build index trong versionchange transaction. DB từ V1/V2/V3 hoặc mới đều có store cache rỗng và build lazy. Đổi DB schema version không đồng nghĩa đổi backup user-data format version: backup hiện version 3 vẫn đọc được và không cần searchIndex.

Chỉ thêm persistent store ở phase triển khai để migration và cache APIs được kiểm tra cùng nhau; Phase 1 không có consumer nên áp V4 ngay không đem lại lợi ích. Schema syntax/large-field indexing đã đối chiếu [Dexie Version.stores](https://dexie.org/docs/Version/Version.stores%28%29): chỉ index keys cần query, không index full text.

Cache get/put/delete lỗi (quota/corrupt) không rollback một thao tác lưu sách/rules đã thành công. Source write transaction không phụ thuộc searchIndex. Cache miss/error dùng build trong RAM hoặc source scan; nếu cả nguồn không đọc được thì báo lỗi nguồn, không ngụy trang thành zero results. Cache write fail không làm reader mất khả năng mở sách.

## 5. Invalidation lifecycle và consistency

| Trigger sau source commit | Scope và hành động Search |
| --- | --- |
| saveBookWithChapters (file/paste/sample) | Book mới không có cache; enqueue build hoặc lazy build khi query, không chặn import/open. |
| deleteBook | Cancel book builders/queries, removeBookIndex; result click luôn recheck book. Nếu cache delete fail, orphan rows bị bỏ qua vì source book không còn. Không mở rộng việc xóa user highlights/rules trong phase này. |
| importDatabase replace | Cancel mọi request/build, tăng generation, clear toàn cache sau commit; build từ dữ liệu restore, không tin IDs/fingerprints cũ dù bookId trùng. Reload reader/source settings đang mở trước query/navigation mới để tránh state rules/toggle cũ. |
| importDatabase append | Invalidate toàn cache để an toàn: global rules append có thể ảnh hưởng mọi sách; build theo IDs mới, không nhập cache từ dump. Hiện book-specific rule bookId remap có lỗi; phải sửa nhỏ và test trước release Search dùng restore append, không dùng invalidation để che lỗi source này. |
| Chỉnh chapter content trong tương lai | Storage API source update commit rồi invalidateChapter; nếu move/reorder, invalidate các keys cũ và mới hoặc cả book. |
| Add/update/delete/toggle book rule | invalidateBook của scope cũ **và** scope mới nếu update bookId. Đọc rule cũ trước update/delete để xác định scope. |
| Add/update/delete/toggle global rule | invalidateAll (cả trường hợp scope chuyển từ/to global). |
| importCustomRulesJSON | Dựa vào scope bị replace và scope imported. targetBookId cụ thể: cả book; target null hoặc mixed/global: toàn bộ. target null + replaceExisting hiện clear toàn rules. |
| settings enableGlobalCleaner đổi | invalidateAll, reload current chapter theo pipeline hiện tại; Search đọc toggle từ nguồn settings, không từ default tùy ý. |
| Algorithm/format thay đổi | Version mismatch -> ignore/remove/rebuild; không cần migrate nội dung cache. |
| Missing/corrupt/outdated index | Kiểm tra shape, key, paragraph indices/text types/version/fingerprints; malformed chỉ bỏ row/cache, rebuild từ source, không sửa source. |
| Highlight/note, font/theme, scroll/chunk/progress/TTS voice | Không đổi indexed text nên không invalidate. Title/author cập nhật đọc trực tiếp từ source, không sao chép vào index. |

Chốt đảm bảo freshness bằng **source validation**, không chỉ notifications: mỗi search lấy sách/chapter keys hiện có từ nguồn, đọc content/rules/settings theo batch, so fingerprints trước dùng cache. Thiếu index/chapter key được phát hiện kể cả chương không match cache cũ (tránh false-negative sau sửa content). Các batch có thể dùng readonly transaction đọc source và cache nhất quán; hashing/normalization ở ngoài transaction. Nếu source generation đổi trong khi scan, discard/restart query; trước commit cache re-read fingerprint/source trong transaction và chỉ put nếu vẫn khớp. Cùng scope chỉ một builder đang chạy.

Mutations phát notification sau commit, source generation tăng ngay tại điểm commit; cùng app serialize đoạn cuối revalidate/cache write với mutation. Multi-tab thông báo invalidation bằng BroadcastChannel và cùng generation checks; tab không nhận notification vẫn được bảo vệ ở lần query tiếp nhờ so source. Trước emit/click result revalidate những chapter candidate; nếu đổi thì refresh, không trả offset cũ. Không hứa snapshot toàn thư viện khi tab khác liên tục sửa dữ liệu; có thể trả cancelled/retry, không silently coi stale cache là mới.

Đổi rules/restore/delete trong khi build không được để task cũ publish hoặc put lại cache đã invalidated. Notification/cache deletion **không phải** điều kiện duy nhất cho correctness: browser crash giữa source commit và invalidation sẽ được phát hiện bằng fingerprints ở query sau. Cách này phải đọc/hash raw content khi scan, có chi phí; cache chủ yếu tránh cleaner/projection/normalize lại. Tối ưu revision store/memo/inverted index chỉ xem xét sau đo hiệu năng, không thêm migration user content ở Phase 1.

## 6. Navigation contract

### 6.1. Result object

```js
{
  requestId,
  bookId, chapterIndex, paragraphIndex,
  bookTitle, chapterTitle,      // live display metadata
  queryNormalized,
  matchStart, matchEnd,         // [start,end), UTF-16 projected paragraph text
  normalizedStart, normalizedEnd,
  matchedText,
  contextBefore, contextAfter,  // bounded context, ~32 units mỗi phía
  contentFingerprint, rulesFingerprint, algorithmVersion,
  snippet: { text, matchStart, matchEnd }, // offsets riêng tương đối với snippet
  rank                         // tuple theo contract ranking
}
```

Không dùng chapter database id, DOM node, scrollY hay chunk index làm identity chính. Fingerprints áp dụng chapter/rules snapshot tạo result. ParagraphIndex luôn từ clean + renderer projection, không phải raw newline index.

### 6.2. Luồng click, render barrier, range

1. Tạo navigationId riêng; validate book/chapter/result fingerprints từ source. Stale result thì recompute query/location: offset/context chỉ được chấp nhận nếu xác minh text. Nếu nhiều occurrence cùng context hoặc không tìm được thì yêu cầu chọn result mới bằng UI; không nhảy occurrence đầu chapter tùy ý.
2. Clear pending outgoing scroll debounce; capture bookId/chapterIndex/scrollY/currentIndex, await updateProgress cho **sách cũ** trước thay state. Stop qua TTSEngine.stop/AutoScroll.stop hiện tại; không gọi speechSynthesis.cancel trực tiếp ở Search.
3. Nếu đúng sách/chương và rendered generation/fingerprints còn đúng: dùng DOM hiện tại, giữ currentChunkIndex, không loadText lại. Nếu khác sách: `await openBook(bookId, chapterIndex)`; nếu cùng sách khác chương: `await loadChapter(chapterIndex, 0, 0)`. Chương mới dùng chunk=0 như manual navigation hiện tại, **không suy chunk từ matchStart hoặc scrollY**.
4. Phase integration thêm return value additive cho loadChapter: `{status:'rendered', bookId, chapterIndex, renderGeneration, contentFingerprint, rulesFingerprint}` sau bước await cuối; early returns phân biệt invalid/missing/stale. openBook propagate return này, catch trả error result. Không sửa thứ tự cleaner/render/TTS/highlight/progress. Caller cũ có thể bỏ qua return; Search phải xác minh status + identities, không coi resolved undefined là success.
5. Navigation/render generation kiểm tra sau từng await và trước DOM/state commit để một load cũ không ghi đè load mới. Đặt guard hẹp trong openBook/loadChapter/reloadCurrentChapterText và auto-next; không dùng isChapterSwitching làm Search lock. Search bắt đầu trong auto-next khiến continuation cũ sau load/800ms/rules await thoát; **không clear lock của transition mới** bằng stale finally/timer. Giữ circuit history/threshold/empty defenses/utterance cleanup nguyên logic. Guard cần phân biệt transition owner, vì jumpToIndex(false) cũng emit onChunkStart.
6. Sau Promise load thành công (DOM đã gắn), select `#reader-body-content .reader-paragraph[data-para-index="N"]`, kiểm tra paragraph.textContent đúng projected snapshot. TreeWalker cộng UTF-16 lengths của **mọi text node**, kể cả text trong saved mark và các tts-chunk khác nhau, để dựng DOM Range [matchStart,matchEnd). Không dùng regex innerHTML, Range.surroundContents xuyên nodes hoặc bỏ qua saved mark (sẽ làm offsets lệch).
7. Scroll paragraph/chunk chứa range bằng scrollIntoView; nếu cần đo rectangle, await requestAnimationFrame để layout trước đo. Không dùng setTimeout 1000ms/MutationObserver polling để đoán render. Scroll anchor là logical range; vị trí px sau scroll chỉ tiếp tục lưu qua luồng persistence hiện có.
8. Temporary highlight ưu tiên CSS Custom Highlight API (`CSS.highlights`/Highlight feature-detected): range không mutate DOM và không tạo saved highlight. Fallback lớp `.search-result-target` trên paragraph, rõ mức chính xác là paragraph nếu browser không hỗ trợ range decoration. Không dùng `.reader-highlight`/`.active-tts-chunk`, không ghi store highlights, không làm mất click-to-speak listeners. Clear khi query/nav/render đổi hoặc overlay đóng; timer chỉ được dùng cho thời gian hiệu ứng, không làm render barrier.

Search không tự phát TTS sau click. Play/Resume vẫn dùng currentIndex engine sau manual navigation, và scroll persistence vẫn độc lập. Trên cùng chapter Search chỉ scroll, giữ con trỏ nghe. Qua chapter/sách khác, luồng load hiện tại định nghĩa con trỏ chương mới; vị trí cũ phải được lưu trước. Không gộp state mắt đọc và tai nghe.

Pending cloud audio fetch cần generation check trước play/fallback, và pending onReachBottom/auto-next callbacks cần navigation generation check. Đây là guard bổ sung hẹp cho phase navigation, không thay kiến trúc TTS hay bỏ các defenses; phải được targeted regression coverage trước UI Search dùng đường này.

## 7. Integration map và phạm vi phase sau

| File/function | Thay đổi dự kiến |
| --- | --- |
| **search.js (mới)** | Toàn engine/projection/mapping/fingerprint/cache lifecycle/query cancellation/ranking/snippets; không UI reader. |
| **storage.js**: initDB | Thêm schema V4 searchIndex duy nhất, cache APIs. |
| storage.js: saveBookWithChapters/deleteBook/importDatabase | Source commit notifications, invalidation adapter; restore append remap rules theo oldId -> newId cần fix có test, không rewrite backup format. |
| storage.js: add/update/deleteCustomRule/importCustomRulesJSON/setSetting | Notify scope/rules/cleaner changes; setSetting errors hiện bị swallow, cần re-read setting thành công trước dùng làm snapshot. Không invalidate mọi settings key. |
| **app.js**: init/cacheDOMElements/bindEventListeners | Khởi tạo search service, query lifecycle và overlay wiring riêng. |
| app.js: openBook/loadChapter/reloadCurrentChapterText | Render return contract + generation checks nhỏ; giữ cleaner/render/highlights/TTS order. |
| app.js: initTTSEngine/onStatusChange, initAutoScrollEngine | Guard continuation cũ bằng navigation owner/generation, giữ lock/circuit/delays hiện hữu. |
| app.js: handleWindowScroll/handleKeyboardShortcuts | Capture/flush outgoing progress khi Search navigation, guard Search modal/IME/modifier keys. |
| **tts.js**: speakCloudChunk/stop | Bổ sung generation check/cancel pending cloud nếu test chứng minh late play; không sửa Safe Utterance, splitter, resume hay empty-array defense. |
| **index.html / styles.css** | Phase UI: entry point Global Search, input/results/empty/loading/error, focus/keyboard và temporary decoration theo theme. Không dùng library filter như content search. |
| **test_search.mjs (mới)** | Pure engine/normalization/mapping/ranking/limits/stale requests. |
| **test_search_storage.mjs (mới)** | Dexie upgrade/cache rebuild/fingerprint/restore/remap/quota/cancel writer với isolated test DB. |
| **test_search_navigation** (browser harness mới) | Render/range/saved marks/cross-chunk match, resume/persistence/races/hotkeys. Chọn harness ở phase thực thi, không thêm dependency chỉ để audit. |
| cleaner.js / highlight.js / parser.js | Tái sử dụng public behavior; không cần sửa core pipeline hoặc saved highlight algorithm cho Search. |
| README.md / CHANGELOG.md | Chỉ cập nhật khi tính năng/fix đã thực sự triển khai và kiểm tra. |

Thứ tự thực hiện: (1) engine + cache/migration/invalidation tests; (2) navigation contract + race guards/targeted checks; (3) UI + browser integration checks. Không bắt đầu bằng UI hoặc migration eager rebuild toàn thư viện.

## 8. Regression risks và tiêu chí chấp nhận

| Risk | Check bắt buộc ở phase tương ứng |
| --- | --- |
| Bỏ dấu sai offset (NFC/NFD, Đ/đ, surrogate/whitespace) | Range khôi phục đúng original substring; match không cắt combining mark/surrogate; query không dấu tìm chữ có dấu. |
| Renderer biến đổi spacing/clause | Parity `projectChapterText` với p.textContent, câu dính punctuation, >220 chars, nhiều dấu phẩy, CRLF/whitespace-only lines và cleaner off. |
| Rules đổi paragraph indices | Add/toggle/delete/import global/book, scope change, newline insertion/deletion và rule-order collisions; cache cũ không gây false-negative. |
| Saved highlights | Range xuyên saved marks/chunks và lặp text trong chapter; highlight IDs/notes/export không đổi, click-to-speak vẫn hoạt động. |
| Search A/query B hoặc click nhanh nhiều result | Query/navigation cũ không publish/render/scroll/persist cho target mới. Không dùng polling DOM hay timer render. |
| Lock/circuit/utterance | Fake completed duplicate + switching, cleanup callbacks trước cancel, 2 transitions/5s breaker, empty chapter stop, no-next/sleep end, timeout không mở khóa transition khác. |
| Pending auto/cloud callbacks | Click Search lúc auto-next nghỉ 800ms, cloud fetch pending, AutoScroll timer pending: continuation cũ không phát/chuyển chương khác. |
| Resume/persistence | Scroll thay đổi giữ chunk của cùng chapter; load sách bình thường khôi phục scroll/chunk độc lập; outgoing snapshot lưu đúng ID, không bị debounce cũ overwrite. |
| Migration/cache | Upgrade V1/V2/V3, giữ book/rule/highlight/progress bytes, cache empty/lazy; partial/corrupt/quota cache vẫn đọc được source. |
| Restore/delete | Replace cùng ID nhưng content khác, append remap rules/highlights, cache không xuất hiện trong dump, orphan cache không có result; invalidation trong lúc build không resurrect row hợp lệ cũ. |
| Main-thread/memory | Scan batch/yield, cancel nhanh; maps/snippets chỉ cho candidates; đo thư viện lớn trước claim hiệu năng. |

## 9. Những gì đã thay đổi và kiểm tra trong Phase 1

Chỉ thêm tài liệu này. Không sửa runtime, không tạo search.js, không nâng DB schema, không sửa README/CHANGELOG.

Đã chạy targeted Node assertions dùng **cleanChapterText và splitter thật** để xác minh: source không bị mutate; junk cleaner; dictionary chèn newline đổi paragraphs; paragraph index gap khi cleaner off; DOM projection khác whitespace raw; NFD + Đ normalize. Check cuối pass. Hai lần thử fixture trước đó cần sửa encoding stdin PowerShell sang UTF-8 và sửa kỳ vọng: cleaner bật đã loại whitespace line nên gap không còn trong fixture đó. Kết quả này đã được đưa vào mô tả trên.

Không chạy full `npm test`/build hoặc toàn script test_parser chỉ để hoàn tất audit. Chưa chạy browser/IndexedDB migration/Search tests vì các thay đổi runtime đó chưa tồn tại. Các API, schema và checks trong mục 3–8 là contract triển khai tiếp theo, không phải tính năng đã phát hành.
