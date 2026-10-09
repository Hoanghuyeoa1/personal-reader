# VietReader - Ứng Dụng Đọc & Nghe Truyện Tiếng Việt Cá Nhân (Local Web App)

> **VietReader** là ứng dụng web cá nhân chuyên dụng chạy hoàn toàn trên máy cục bộ (Local / Client-Side First), tối ưu hóa trải nghiệm đọc sách chuyên sâu và phát giọng đọc tiếng Việt (Text-to-Speech) thông minh. Không phụ thuộc máy chủ backend, bảo mật tuyệt đối dữ liệu người dùng và hoạt động ngoại tuyến mượt mà.

---

## 1. Tổng Quan Dự Án (Project Overview)

- **Mục đích sử dụng:**
  - Cung cấp môi trường đọc truyện số hóa tinh gọn, sạch sẽ, không quảng cáo và không thu thập dữ liệu cá nhân.
  - Hỗ trợ đa định dạng tài liệu (`.txt`, `.pdf`, `.epub`) và dán trực tiếp văn bản thô từ clipboard.
  - Trải nghiệm đọc kết hợp nghe sách nói (Audiobook) tự nhiên nhờ bộ tổng hợp giọng nói tiếng Việt thời gian thực (Web Speech API) đồng bộ highlight trực quan.
  - Lưu trữ thư viện, cấu hình hiển thị và tọa độ đọc vĩnh viễn trong trình duyệt.

- **Ngăn xếp công nghệ (Tech Stack):**
  - **HTML5 Semantic & Modern DOM:** Cấu trúc phân trang dạng SPA (Single Page Application) gồm các view độc lập `#library-view`, `#reader-view`, `#history-view` và `#analytics-view` cùng hệ thống drawer và dialog modal tùy biến.
  - **Vanilla CSS3 Design System:** Hệ thống biến màu CSS (CSS Variables / Tokens), hỗ trợ chuyển đổi mượt mà 4 bảng màu (Light, Dark, Sepia, Navy), hiệu ứng kính mờ (Glassmorphism), thanh tiến độ cuộn trang cố định và giao diện đáp ứng linh hoạt (Responsive Mobile / Tablet / Desktop).
  - **Modern JavaScript (ES Modules):** Kiến trúc module tách rời (`storage.js`, `readingHistory.js`, `readingAnalytics.js`, `parser.js`, `search.js`, `searchNavigation.js`, `tts.js`, `app.js`); Analytics là lớp suy ra chỉ đọc phía client.
  - **Dexie.js (v3.2.4):** Thư viện trừu tượng hóa IndexedDB tối ưu hiệu năng cao, quản lý thư viện, tiến độ đọc, bookmarks, highlights, settings và cache với giao dịch phi đồng bộ (Atomic Transactions) và cơ chế bulk insert.
  - **Web Speech Synthesis API:** Công cụ TTS gốc của trình duyệt kết hợp thuật toán độc quyền *Smart Chunking* và cơ chế *Keep-Alive Pulse* nhằm ngăn chặn triệt để lỗi treo âm thanh của Chromium sau 15 giây.
  - **PDF.js (v3.11.174):** Thư viện phân giải và bóc tách luồng văn bản theo trang từ file PDF của Mozilla.
  - **JSZip (v3.10.1) & DOMParser:** Giải nén tệp tin EPUB dạng nén ZIP, phân tích lược đồ cấu trúc Open Packaging Format (`content.opf`), bảng phân giải tài nguyên (manifest/spine) và bóc tách từng chương HTML/XHTML.
  - **Google Fonts Typography:** Tích hợp bộ font tinh tuyển hỗ trợ trọn vẹn dấu thanh tiếng Việt: *Merriweather* (Serif kinh điển), *Inter* (Sans-serif hiện đại) và *Be Vietnam Pro* (Tối ưu hóa hiển thị tiếng Việt).
  - **Vite (v5.x):** Máy chủ phát triển (Dev Server) phục vụ biên dịch module tĩnh và kiểm thử hot-reload tốc độ cao.

---

## 2. Chức Năng Chính Của Trang Web (Key Features)

### 2.1. Bộ Bóc Tách Dữ Liệu & Phân Rã Chương (Parser Engine)
- **Đa kênh nạp dữ liệu:**
  - Hỗ trợ kéo & thả (Drag & Drop) hoặc duyệt chọn nhiều tệp tin cùng lúc: `.txt`, `.pdf`, `.epub`.
  - Hỗ trợ dán văn bản thô từ bộ nhớ tạm (Paste Raw Text Modal) với tính năng tự động chuẩn hóa định dạng dòng (`\r\n` $\rightarrow$ `\n`).
- **Thuật toán chia chương thông minh (Smart Vietnamese Splitter):**
  - **Nhận diện regex đa biểu thức:** Tự động phát hiện các mẫu đầu mục chương phổ biến trong văn học Việt Nam và quốc tế:
    `Chương [X]`, `Hồi thứ [X]`, `Quyển [X]`, `Chapter [X]`, `Tiết [X]`, `Phần [X]`, `Mục [X]` (hỗ trợ số Ả Rập, số La Mã, chữ số viết hoa/thường).
  - **Tách phân đoạn dẫn nhập:** Tự động cô lập các phần "Lời tựa", "Mở đầu", "Giới thiệu" đứng trước Chương 1 để lưu thành một chương riêng biệt, tránh mất mát nội dung mở đầu.
  - **Cơ chế phân tách dự phòng (Fallback Word-Boundary Splitter):** Đối với các văn bản đơn khối dài (> 2.500 từ) không có tiêu đề phân chương, thuật toán tự động phân tách văn bản thành các chương đồng đều khoảng 2.000 – 2.800 từ dựa trên ranh giới đoạn văn `\n\n`, ngăn chặn hoàn toàn hiện tượng nghẽn luồng DOM trình duyệt khi hiển thị tài liệu hàng triệu từ.
- **Bóc tách sâu EPUB & PDF:**
  - EPUB: Đọc và giải mã `META-INF/container.xml`, lần theo đường dẫn `full-path` đến tệp `content.opf`, duyệt qua mảng `spine itemref` để lấy thứ tự chuẩn xác của từng chương sách, đồng thời làm sạch các thẻ `<script>`, `<style>` trước khi kết xuất.
  - PDF: Khởi chạy `pdfjsLib` với web worker chuyên dụng, bóc tách `TextContent` tuần tự từng trang kèm thông báo phần trăm tiến độ xử lý.

### 2.2. Trình Đọc Chuyên Sâu (Reader UI & Experience)
- **Bộ 4 Theme màu sắc tối ưu quang học:**
  - **Paper White (Sáng):** Nền trắng kem `#f8fafc` dịu mắt, độ tương phản vừa phải theo tiêu chuẩn sách in truyền thống.
  - **OLED Dark (Tối):** Nền đen thẳm `#0b0f19` tương phản cao, tối ưu tuyệt đối cho màn hình OLED/AMOLED và tiết kiệm pin.
  - **Sepia Reading (Vàng ấm):** Nền vàng ngà ấm `#fbf0d9` triệt tiêu ánh sáng xanh, chống mỏi mắt khi đọc sách kéo dài vào ban đêm.
  - **Navy Midnight (Xanh đêm):** Nền xanh đen huyền ảo `#0f172a` mang đến không gian tĩnh lặng, tăng cường sự tập trung.
- **Bảng tùy biến Typography (Aa Modal):**
  - Lựa chọn linh hoạt giữa 3 font chữ hàng đầu: *Merriweather*, *Inter*, *Be Vietnam Pro*.
  - Điều chỉnh trực quan qua thanh trượt mượt mà:
    - Cỡ chữ (Font Size): 14px đến 28px.
    - Dãn khoảng cách dòng (Line Height): 1.4 đến 2.2.
    - Giới hạn chiều rộng khung đọc (Max Width): 600px đến 1100px.
    - Chế độ căn dòng: Căn đều 2 bên (Justify) hoặc Căn lề trái (Left).
  - Lưu trữ thiết lập tức thì vào bảng `settings` trong IndexedDB và tự động khôi phục trong mọi phiên đọc tiếp theo.
- **Thanh đo tiến độ & Tọa độ cuộn thông minh:**
  - Thanh tiến độ gradient cố định trên nóc cửa sổ trình duyệt (Fixed Header Progress Bar) hiển thị tỷ lệ hoàn thành tác phẩm theo thời gian thực (tính kết hợp giữa chỉ mục chương và vị trí cuộn trang hiện tại).
  - Huy hiệu phần trăm `%` động tại thanh công cụ.
  - Tự động ghi nhận và lưu tọa độ `scrollY` khi người dùng cuộn trang (với cơ chế debounce tiết kiệm hiệu năng). Khi mở lại tác phẩm, màn hình tự động trượt chính xác về vị trí đọc dở trước đó.
- **Drawer Mục Lục (Table of Contents):**
  - Thanh trượt mục lục từ cạnh trái kèm bộ lọc tìm kiếm tức thời theo từ khóa chương.
  - Đánh dấu trạng thái chương đang đọc (`active chapter badge`).
- **Thanh Điều Khiển Nổi Viên Nang Đa Năng (Floating Reader Dock Capsule):**
  - Đặt cố định chính giữa đáy màn hình (`fixed bottom-6 left-1/2 -translate-x-1/2 z-50`), bo góc lớn 24px, hiệu ứng kính mờ `backdrop-filter: blur(20px)` và bóng đổ 3D sâu tinh tế.
  - **Tự động tránh che chữ:** Khung đọc nội dung được thiết lập `padding-bottom: 140px` (trên mobile `160px`) đảm bảo khi cuộn đến dòng cuối cùng của truyện hoặc cụm nút chân trang không bao giờ bị thanh dock che khuất.
  - **Cụm 1 - Điều hướng & Tiến độ:** Cặp nút chuyển chương nhanh `[⏮]` / `[⏭]`, thanh kéo trượt tương tác (Scrub Bar Slider) kèm nhãn `Chương X · Đoạn Y/Z (W%)` cho phép người dùng kéo hoặc click để nhảy tức thì đến câu bất kỳ trong chương.
  - **Cụm 2 - Động cơ TTS Âm thanh:** Nút Hero Play hình tròn lớn (48px) gradient nổi bật có hiệu ứng vòng xung nhịp (pulse ring animation) khi đang đọc, nút tua lùi `[⏪ 1 đoạn]`, tua tới `[⏩ 1 đoạn]`, nút dừng hẳn, danh sách chọn giọng tiếng Việt ưu tiên đầu bảng, menu tốc độ đọc chuẩn `0.8x - 2.0x`, và nút bật/tắt "Cuộn theo giọng".
  - **Cụm 3 - Tiện ích Đọc nhanh:** Cặp nút tăng/giảm cỡ chữ nhanh `[A-]` / `[A+]` kèm hiển thị kích cỡ tức thời, nút đổi theme 1 chạm xoay vòng 4 màu sắc, và nút kích hoạt Chế độ Tập trung (Zen Mode).
- **Tiện ích Thu Nhỏ Thông Minh (Mini Floating Widget / FAB):**
  - Thay thế nút đóng bằng nút Thu nhỏ `[-]`: Thanh dock co gọn lại thành một nút tròn nổi (FAB 56px) ở góc dưới bên phải màn hình.
  - Tích hợp visualizer cột sóng âm chuyển động (soundwave 4 cột) khi đang đọc âm thanh, hiển thị huy hiệu % tiến độ chương và nhấp để bung mở lại thanh dock đầy đủ.
- **Chế độ Tập trung (Zen Mode / Fullscreen):**
  - Tự động ẩn toàn bộ header trên đỉnh trang, giữ lại khung truyện và thanh điều khiển nổi giúp trải nghiệm đọc hoàn toàn không bị phân tâm. Hỗ trợ phím <kbd>Esc</kbd> để thoát nhanh.
- **Hệ thống phím tắt bàn phím (Keyboard Shortcuts):**
  - <kbd>Space</kbd> (Phím cách): Phát / Tạm dừng trình đọc giọng nói TTS.
  - <kbd>A</kbd> hoặc <kbd>S</kbd>: Bật / Tắt chế độ Tự động cuộn trang rảnh tay (Hands-Free Auto-Scroll).
  - <kbd>←</kbd> / <kbd>→</kbd> (Mũi tên trái / phải): Tua lùi 1 đoạn / Tiến lên 1 đoạn.
  - <kbd>↑</kbd> / <kbd>↓</kbd> (Mũi tên lên / xuống): Tăng / Giảm tốc độ đọc (bước nhảy 0.1x).
  - <kbd>[</kbd> / <kbd>]</kbd> (Ngoặc vuông mở / đóng): Chuyển nhanh Chương trước / Chương sau.
  - <kbd>Esc</kbd>: Thoát nhanh Chế độ Tập trung Zen Mode, ẩn thanh công cụ bôi đen, hoặc đóng Drawer / Modal.

### 2.3. Hệ Thống Giọng Đọc Đa Nguồn Tiếng Việt (Multi-Engine Vietnamese TTS)
Hệ thống giọng đọc được kiến trúc theo mô hình **Đa tầng 2 lớp (Two-Tier Multi-Engine)**, mang đến kho giọng đọc tiếng Việt phong phú, truyền cảm và khắc phục hoàn toàn sự nghèo nàn của giọng đọc robot mặc định:

#### A. Tầng 1: Tối ưu triệt để Web Speech API (Miễn phí, chạy ngay)
- **Bắt trọn vẹn Voice Hệ thống & Edge Neural Voices:**
  - Khắc phục tình trạng tải bất đồng bộ (async voice loading) bằng cơ chế polling kép kết hợp sự kiện `speechSynthesis.onvoiceschanged`.
  - Quét và gắn nhãn phân loại giọng tự nhiên trực quan:
    + `👩 Hoài My (Nữ - Bắc, Tự nhiên - Edge Natural)`: Giọng nữ Bắc ấm áp, diễn cảm.
    + `👨 Nam (Nam - Bắc, Trầm ấm - Edge Natural)`: Giọng nam Bắc truyền cảm, đọc truyện đêm khuya.
    + `👩 Google Tiếng Việt (Nữ chuẩn - Chrome/Android)`: Giọng đọc phổ thông tròn vành rõ chữ.
    + Các giọng `vi-VN` của hệ điều hành: `Microsoft An`, `Microsoft Mai`, `Apple Linh`...
- **Bộ điều chỉnh âm sắc (Voice Tuning):**
  - Tích hợp thanh trượt `Pitch` (Độ cao/trầm: 0.5x - 1.5x) bên cạnh `Rate` (Tốc độ đọc).
  - Cho phép người dùng tùy biến 1 giọng đọc thành nhiều sắc thái: giọng ông lão/trung niên trầm ấm (0.5x - 0.8x), giọng người dẫn chuyện chuẩn (1.0x), hoặc giọng thiếu nhi/thanh niên tươi sáng (1.2x - 1.5x).
- **Thuật toán Smart Sentence Chunking & Lọc âm vị:**
  - Ngắt câu thông minh theo dấu ngắt câu (`.`, `!`, `?`, `…`, `:`, `;`) gom trọn vẹn dấu ngoặc kép và ngoặc đóng liền kề (`"`, `”`, `)`, `]`), triệt tiêu 100% nguy cơ sinh mảnh dấu câu mồ côi (0 âm vị).
  - Tách nhỏ mệnh đề dài (> 220 ký tự) theo dấu phẩy `,` thành các phân đoạn 180 ký tự tự nhiên.
  - Tự động lọc và gộp các phân đoạn không chứa âm vị chữ/số Unicode (`/[\p{L}\p{N}]/u`) trước khi gọi `synth.speak()`.
- **Cơ chế Keep-Alive Heartbeat thích ứng:**
  - **Miễn nhiễm phát xung đối với giọng Online/Natural:** Các giọng trực tuyến như Microsoft Hoài My (`Microsoft HoaiMy - Vietnamese (Vietnam)`), Nam Minh và Google TTS được bảo vệ tuyệt đối khỏi xung `synth.pause()` / `synth.resume()`, loại trừ nguy cơ phá vỡ stream giải mã WebSocket và rò rỉ RAM ~100 MB/s của Edge Browser Process.
  - **Phát xung an toàn cho giọng SAPI Offline:** Đối với giọng SAPI cục bộ, chỉ phát xung khi câu đọc vượt quá 10 giây để chống lỗi treo 15s của Chromium.
- **Giám sát Native SpeechSynthesis & Watchdog Ngắt An Toàn (Safe Fail-Safe):**
  - Bộ đếm Watchdog 14s phát hiện trình duyệt bị đóng băng luồng phát âm. Khi timeout xảy ra, hệ thống tự động ngắt phát an toàn (`status: 'error'`), dọn dẹp highlight, bảo toàn nguyên vẹn `currentIndex`, cảnh báo Toast, và **tuyệt đối không ghi nhận tiến độ giả** hay tự động chuyển câu trong yên lặng.
- **Giới hạn của chuẩn Web Speech API:** Chuẩn Web Speech API không hỗ trợ đo lường áp suất âm thanh vật lý; cơ chế fail-safe của VietReader dựa trên các tín hiệu quan sát được đáng tin cậy của vòng đời trình duyệt để bảo đảm không xảy ra bão callback hay phình bộ nhớ.

#### B. Tầng 2: Tích hợp Engine Mở rộng Cloud AI (BYOK - Bring Your Own Key)
- **Hỗ trợ các nền tảng AI Voice hàng đầu:**
  - **FPT AI (Chuyên ngữ điệu vùng miền Việt Nam):**
    + *Ban Mai*: Nữ miền Bắc truyền cảm.
    + *Minh Quang*: Nam miền Bắc trầm ấm, đĩnh đạc.
    + *Thu Dung*: Nữ miền Trung dịu dàng.
    + *Lan Nhi*: Nữ miền Nam ngọt ngào, truyền hình.
    + *Lê Minh*: Nam miền Bắc phong cách phát thanh viên.
    + *Mỹ An*: Nữ miền Nam trẻ trung, hiện đại.
  - **OpenAI TTS (Chuẩn quốc tế tự nhiên):**
    + *Nova*, *Shimmer*: Giọng nữ biểu cảm cao, diễn đạt cảm xúc tinh tế.
    + *Onyx*: Giọng nam trầm, dày, thích hợp cho truyện trinh thám/kiếm hiệp.
    + *Alloy*, *Echo*, *Fable*: Giọng đọc cân bằng, sinh động.
- **Bộ nhớ đệm âm thanh IndexedDB (`audioCache`):**
  - Các đoạn âm thanh sau khi tải từ Cloud API được lưu trữ dạng nhị phân (`Blob`) vào bảng `audioCache` trong IndexedDB của trình duyệt.
  - Khi người dùng nghe lại đoạn văn, chuyển qua lại hoặc đọc lại chương, hệ thống phát ngay lập tức từ bộ nhớ đệm nội bộ mà **không tốn thêm bất kỳ hạn ngạch API hay chi phí nào**.
  - Tích hợp nút *"Dọn sạch cache"* một chạm trong Modal cài đặt để giải phóng dung lượng khi cần.
- **Cơ chế Dự phòng Thông minh (Graceful Fallback):**
  - Nếu API ngoài bị gián đoạn mạng, hết quota hoặc cấu hình sai key, hệ thống tự động hiển thị thông báo nhẹ (Toast) và chuyển sang giọng Web Speech API của trình duyệt ngay lập tức mà không làm dừng bài đọc.

#### C. Tính năng Nghe Thử & Cá Nhân Hóa Theo Từng Tác Phẩm
- **Nút "Nghe thử" nhanh (Voice Preview):** Tích hợp nút `[▶ Thử]` trực tiếp trên thanh điều khiển nổi và trong Modal cấu hình, tự động đọc câu mẫu: *"Chào bạn, tôi là giọng đọc tiếng Việt của VietReader."* giúp kiểm tra âm sắc trước khi đọc truyện.
- **Ghi nhớ cấu hình riêng biệt từng truyện:** Cấu hình giọng, tốc độ đọc, pitch và engine được tự động lưu vào bản ghi của cuốn sách (`ttsSettings`). Truyện kiếm hiệp có thể cài giọng nam trầm, trong khi tiểu thuyết tình cảm có thể chọn giọng nữ Bắc truyền cảm.
- **Đồng bộ hóa thị giác & thính giác (Audio-Visual Sync):**
  - Highlight nổi bật câu đang được phát thanh.
  - Tự động cuộn theo câu đọc (`scrollIntoView`) với tùy chọn bật/tắt.
  - Click vào câu bất kỳ để nghe ngay lập tức.
  - Kéo Scrub Bar để vừa tua giọng đọc vừa cuộn trang đồng bộ.

#### D. Cơ Chế Chuyển Chương & Chuyển Câu An Toàn Tuyệt Đối (Safe Sentence/Chapter Pipeline & Anti-OOM)
Hệ thống giải quyết triệt để vấn đề treo trình duyệt trên Microsoft Edge sau đoạn đầu, bão callback lặp (callback storm) và rò rỉ bộ nhớ (Memory Leak ngốn RAM):
- **Khóa thế hệ & Xử lý sự kiện kết thúc đơn nhất (Generational Tokens & Single Terminal Guard - `tts.js`):**
  - Mỗi phiên phát và từng câu phát được gán định danh nguyên tử: `generationToken`, `utteranceToken`, và `advanceSequenceToken`.
  - Cờ nguyên tử `isTerminalHandled` đảm bảo mỗi utterance chỉ kích hoạt sự kiện kết thúc đúng một lần duy nhất, triệt tiêu hoàn toàn trường hợp Chromium phát `onerror` rồi tiếp tục gọi `onend`.
  - Toàn bộ callbacks (`onstart`, `onend`, `onerror`) được gỡ bỏ ngay lập tức sau khi hoàn tất hoặc khi gọi `stop()`/`pause()`, ngăn chặn lưu giữ tham chiếu bộ nhớ.
  - Tự động unpause hàng đợi Chromium: `if (this.synth.paused) { this.synth.resume(); }` trước khi xếp utterance mới vào hàng đợi, xóa bỏ triệt để hiện tượng đứng tiếng sau câu đầu.
- **Cầu chì vận tốc chuyển câu (Chunk Velocity Circuit Breaker):**
  - Tích hợp bộ đệm trượt `checkChunkVelocityCircuitBreaker()` đếm số lần chuyển câu tự động trong 1000ms. Nếu xuất hiện bão callback vượt quá 60 chunks/giây (dấu hiệu loop 0ms), hệ thống tự động ép dừng phát an toàn.
- **Bảo vệ nhịp tim Keep-Alive an toàn & Tương thích Edge Natural Voices:**
  - `startKeepAlive()` được thiết kế miễn nhiễm 100% đối với các giọng đọc trực tuyến Microsoft Edge (`/natural|online|neural/i` như `HoaiMy Online`, `Nam Online`). Các giọng này truyền luồng âm thanh qua WebSocket nội bộ trong Browser Process; việc phát xung `pause()`/`resume()` làm vỡ buffer và rò rỉ RAM native. Do đó, các xung này bị triệt tiêu hoàn toàn trên giọng Natural.
  - Đối với các giọng SAPI offline máy tính bàn, hệ thống chỉ phát xung khi câu nói kéo dài liên tục $\ge 10.000$ms (giải quyết triệt để 15s SAPI timeout mà không gây xung nhịp thừa trên câu ngắn).
  - Triệt tiêu hoàn toàn xung nhịp khi đang chuyển câu (`isAdvancingChunk`), khi tạm dừng, hoặc khi đã dừng phát.
- **Cô lập HTMLAudioElement trong Web Speech API:**
  - Tuyệt đối không gọi `audioElement.load()` hay thao tác xóa thuộc tính `src` trong các chu kỳ chuyển câu của Browser TTS, loại bỏ 100% tải IPC media churn giữa Renderer và Browser Process.
- **Cơ chế Watchdog Tự Động Phục Hồi Native (`scheduleStuckWatchdog`):**
  - Tự động giám sát native SpeechSynthesis ($\ge 14.000$ms). Nếu Chromium không phát sinh sự kiện `onend` hay `onerror`, watchdog sẽ tự động giải phóng trạng thái nghẽn và chuyển tiếp câu đọc an toàn mà không làm treo ứng dụng.
- **Khóa Thế Hệ Phiên Media Session (`mediaSessionHelper.js`):**
  - Định danh `_sessionToken` ngăn chặn race condition khi người dùng thao tác Play/Pause liên tục, bảo đảm stale `play()` promise không thể vô tình tạm dừng phiên phát mới.
- **Giải phóng Đồ thị Web Audio (`ambientSound.js`):**
  - Ngắt kết nối đồng bộ cả `sourceNode` và `gainNode`, bổ sung `destroy()` đóng `AudioContext` và xóa cache buffer.
- **Khử rung lưu tiến độ đọc (Debounced Progress Persistence - `app.js`):**
  - Thao tác ghi tiến độ vào IndexedDB tại `onChunkStart` được khử rung 500ms (`ttsProgressSaveTimeout`), ngăn chặn bão ghi I/O làm phình bộ nhớ RAM.
- **Khóa nguyên tử chuyển chương & Phân quyền TTS vs AutoScroll:**
  - `AutoScrollEngine.onReachBottom` tự động nhường quyền cho TTS khi đang đọc truyện, triệt tiêu hiện tượng nhảy 2 chương và trùng lặp lịch sử đọc.
  - Cầu chì giới hạn: Không cho phép chuyển chương quá 2 lần trong 5 giây.
- **Luồng chuyển chương tuần tự 8 bước (Safe Sequential Pipeline):**
  1. *Dừng toàn bộ âm thanh:* Hủy sạch utterance cũ và các bộ đếm thời gian.
  2. *Thông báo giao diện:* Hiển thị Toast *"Đã đọc hết chương. Chuyển chương tiếp theo..."*.
  3. *Chuyển chương bất đồng bộ:* Gọi `await loadChapter(nextIndex)`.
  4. *Khoảng nghỉ bắt buộc 800ms:* Chờ trình duyệt hoàn tất render DOM và Garbage Collector (GC) giải phóng bộ nhớ RAM.
  5. *Kiểm tra dữ liệu hợp lệ:* Xác minh nội dung chương mới (`newContent.trim().length >= 20 ký tự`). Nếu rỗng hoặc quá ngắn, dừng phát an toàn.
  6. *Nạp nội dung đã làm sạch:* Nạp dữ liệu vào `state.tts.loadText()`.
  7. *Khởi động phát từ câu đầu:* Kích hoạt `state.tts.jumpToIndex(0, true)`.
  8. *Mở khóa an toàn:* Chỉ gỡ bỏ cờ `isChapterSwitching = false` sau khi câu đầu tiên của chương mới đã cất tiếng đọc thành công (`onChunkStart`).
- **Nói KHÔNG với DOM polling & click ảo:**
  - Xóa bỏ hoàn toàn các vòng lặp `setInterval` dò tìm phần tử DOM và thao tác `.click()` giả lập. Đảm bảo bộ nhớ RAM duy trì ổn định lý tưởng (< 200MB trên môi trường đầy đủ, ~8-10MB trên Edge sạch) trong suốt nhiều giờ đọc liên tục.

#### E. Động Cơ Hàng Đợi & Nạp Trước Bounded Cloud TTS (Cloud TTS Queue Scheduler & Prefetch Engine)
Hệ thống giải quyết triệt để vấn đề gián đoạn độ trễ mạng (playback gap latency) khi phát Cloud AI TTS từng câu bằng kiến trúc Bounded Event-Driven Queue Scheduler ([`ttsQueueScheduler.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/ttsQueueScheduler.js)) kết hợp cùng bộ điều hợp độc lập ([`cloudTtsProvider.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/cloudTtsProvider.js)):

- **Kiến trúc Hàng Đợi Trượt Giới Hạn (Bounded Sliding Window [N, N+2]):**
  - **Cửa sổ nạp trước:** Khi chunk $N$ đang phát, scheduler tự động chuẩn bị tối đa 2 chunks kế tiếp ($N+1, N+2$). Tuyệt đối không nạp trước toàn bộ chương hay toàn bộ sách.
  - **Hệ thống ưu tiên nghiêm ngặt (Strict Priority Hierarchy):**
    + *Priority 1 (Current chunk):* Câu hiện tại đang cần phát ngay lập tức. Được ưu tiên xử lý mạng/cache hàng đầu.
    + *Priority 2 (Chunk N+1):* Câu tiếp theo ngay sau câu đang phát.
    + *Priority 3 (Chunk N+2):* Câu tiếp sau câu $N+1$.
  - **Giới hạn thực thi thiết kế (Scheduler Boundaries):**
    + `maxConcurrency = 1`: Tối đa 1 network fetch hoạt động đồng thời, triệt tiêu hoàn toàn request storm và rate limiting.
    + `maxWindowAhead = 2`: Tối đa 2 chunks phía trước.
    + `maxReadyEntries = 3`: Giữ tối đa 3 blobs sẵn sàng trong bộ nhớ.
    + `maxRetainedBytes = 15 MB`: Ngưỡng an toàn bộ nhớ; tự động giải phóng các entry ưu tiên thấp nếu vượt quá 15MB.
    + `requestTimeoutMs = 30.000 ms`: Tự động ngắt request nếu mạng bị treo.
  - **Máy trạng thái nhiệm vụ (Task State Machine):**
    `queued` $\rightarrow$ `checking_cache` $\rightarrow$ `fetching` $\rightarrow$ `ready` $\rightarrow$ `playing` $\rightarrow$ `consumed` (hoặc `failed` / `cancelled`).

- **Đường Ống Ưu Tiên Cache Cục Bộ (Cache-First Pipeline & Cache Integrity):**
  - **Tra cứu IndexedDB trước:** Mọi chunk được tra cứu trong `audioCache` (Dexie v6) trước khi xếp hàng tải mạng. Quá trình tra cứu cache chạy cục bộ, không chiếm dụng slot concurrency mạng.
  - **Định danh Cache Key Chuẩn Hóa (Canonical Cache Key):**
    `cloud_{provider}_{voice}{modelPart}_r{rate}_{textHash}`
    (Ví dụ: `cloud_fpt_banmai_r1.0_minmo0`, `cloud_openai_nova_tts-1-hd_r1.2_k3j1n9`).
  - **Khả năng tương thích ngược (Backward Compatibility):** Tự động tra cứu cả định dạng key cũ `cloud_{provider}_{voice}_r{rate}_{textHash}` để tận dụng các bản ghi cache trước đây mà không cần migrate database.
  - **Bảo mật tuyệt đối:** Tuyệt đối không đưa API Key, Authorization Bearer, Endpoint URL vào cache key hay log hệ thống.
  - **Xác thực toàn vẹn Audio Blob:** Phát hiện và từ chối các blob rỗng, blob quá nhỏ ($< 100$ bytes) hoặc trang phản hồi lỗi HTML/JSON từ CDN. Tự động xóa bản ghi cache hỏng và tái yêu cầu mạng sạch sẽ.

- **Hợp Nhất Yêu Cầu Trùng Lặp (Request Coalescing):**
  - Khi có nhiều nơi (hoặc nhiều lượt bấm) yêu cầu cùng một chunk và cấu hình giọng, scheduler tái sử dụng cùng một `Promise` đang thực thi (`in-flight promise sharing`). Không bao giờ phát sinh 2 HTTP requests đồng thời cho cùng một nội dung.

- **Bộ Điều Hợp Cloud AI & Cơ Chế Hủy Tức Thì (`cloudTtsProvider.js`):**
  - **FPT AI Adapter:** Gửi văn bản $\rightarrow$ nhận URL xử lý bất đồng bộ $\rightarrow$ polling CDN có độ trễ tăng dần $\rightarrow$ tải file âm thanh mp3.
  - **OpenAI TTS Adapter:** Gửi payload chuẩn JSON $\rightarrow$ stream nhị phân trực tiếp (audio/mpeg) hoặc base64/JSON.
  - **Custom Endpoint Adapter:** Hỗ trợ tương thích ngược OpenAI endpoint tùy biến.
  - **Phân loại lỗi chuẩn hóa (Error Classification):**
    + *Lỗi không thể thử lại (Permanent):* HTTP 401/403 (sai key), 429 Quota Exceeded (hết hạn ngạch), 400/404/422 $\rightarrow$ ngắt ngay và kích hoạt Toast cảnh báo, chuyển sang Browser Web Speech API mà không retry vô ích.
    + *Lỗi có thể thử lại (Transient):* HTTP 429 Rate Limit tạm thời, HTTP 5xx, lỗi rớt mạng $\rightarrow$ retry tối đa 2 lần với exponential backoff.
  - **Phản hồi hủy tức thời (Immediate Abort Responsiveness):** Hàm `abortableSleep` lắng nghe trực tiếp `AbortSignal`. Khi người dùng bấm Stop, Seek hoặc đổi giọng, mọi timer chờ polling hoặc backoff bị hủy ngay lập tức trong 0ms, không có timer mồ côi chạy ngầm.

- **Bàn Giao Phát Âm Tức Thời & An Toàn Bộ Nhớ (Playback Handoff & Memory Lifecycle):**
  - **Handoff Gap Latency $\approx 0$–$15$ms:** Khi chunk $N$ kết thúc, chunk $N+1$ đã sẵn sàng ở trạng thái `READY` trong hàng đợi. Hệ thống gán trực tiếp Blob URL vào `audioElement.src` và phát ngay, xóa bỏ hoàn toàn khoảng lặng 500ms–2000ms chờ mạng.
  - **Quản lý vòng đời Object URL đơn nhất:** Mỗi `URL.createObjectURL(blob)` được theo dõi và thu hồi bằng `URL.revokeObjectURL(url)` ngay khi chunk kết thúc, khi đổi chunk hoặc khi Stop/Pause. Tỷ lệ tạo và thu hồi đạt 100% cân bằng (1:1).
  - **Giải phóng bộ nhớ Blob:** Phương thức `markConsumed(chunkIndex)` xóa tham chiếu Blob khỏi RAM ngay khi audio kết thúc. Cửa sổ trượt giới hạn 3 blobs ngăn chặn triệt để hiện tượng phình RAM (JS Heap giữ phẳng $\le 10$–$15$MB).

- **Khóa Thế Hệ & Triệt Tiêu Công Việc Cũ (Generational Invalidation):**
  - Mọi thao tác Seek, Chuyển chương, Stop, hoặc Đổi cấu hình giọng đọc đều tăng `generationToken`.
  - Scheduler lập tức hủy (`entry.cancel()`), kích hoạt `AbortController.abort()` cho toàn bộ tác vụ của thế hệ cũ.
  - Các phản hồi mạng đến muộn (Late Abort / Async CDN response) từ thế hệ cũ bị loại bỏ an toàn, không bao giờ phát nhầm âm thanh đè lên phiên đọc mới.

- **Hệ Thống Đo Lường & Quan Sát Hiệu Năng (Observability Metrics):**
  - Cung cấp phương thức `getPrefetchMetrics()` và `setPrefetchDebugMode()` trên `TTSEngine` phục vụ kiểm tra và theo dõi:
    + `cacheHits` / `cacheMisses`: Số lượt trúng/trượt cache IndexedDB.
    + `prefetchHits` / `prefetchMisses`: Số lượt trúng/trượt âm thanh nạp trước (Prefetch Hit mang lại độ trễ chuyển câu $< 15$ms).
    + `networkRequests` / `networkFailures` / `cancelledRequests`: Số lượng yêu cầu mạng và hủy an toàn.
    + `lastChunkGapMs`: Độ trễ bàn giao âm thanh thực tế giữa 2 chunks liên tiếp (ms).
    + `lastRequestLatencyMs` / `averageRequestLatencyMs`: Thời gian phản hồi của Cloud API.
    + `queueSize`, `activeRequests`, `readyEntries`, `estimatedRetainedBytes`: Trạng thái hàng đợi và bộ nhớ sử dụng thời gian thực.
  - **Tính chất cô lập an toàn:** Số liệu được thu thập với độ phức tạp $O(1)$, bộ nhớ cố định, không tạo rác GC, và hoàn toàn độc lập—không can thiệp hay ghi đè vào `ReadingHistory` hay `PersonalAnalytics`.

### 2.4. Module "Text Engine Pro": Bộ Lọc Rác & Từ Điển, Cuộn Trang Rảnh Tay & Đánh Dấu Trích Dẫn
Nâng cấp toàn diện trải nghiệm xử lý văn bản, tương tác rảnh tay và lưu trữ trích dẫn với 3 phân hệ chuyên sâu:

#### A. Phân hệ 1: Bộ Lọc Từ Điển & Thay Thế Tự Động (`cleaner.js`)
- **Pipeline làm sạch 2 tầng (Two-Tier Text Processing Pipeline):**
  - Thực thi tuần tự **trước khi render văn bản ra giao diện** và **trước khi nạp vào TTS engine**, đảm bảo mắt đọc và tai nghe luôn đồng bộ 100% nội dung đã làm sạch.
  - **Tầng 1 (Global Junk Cleaner):** Quét và tự động triệt tiêu các đoạn văn bản rác cào/convert:
    + Link website, URL, tên miền (`https?://\S+`, `www\.\S+`, domain nguồn cào `truyen\w+\.\w+`).
    + Dòng thông báo convert, nhắc theo dõi, nhóm dịch, donate Momo/ZaloPay/Ngân hàng (`/(Ủng hộ converter|Được đăng tải tại|Bấm theo dõi|Nguồn:|Nhóm dịch|Donate|Momo:?\s*\d+).*/gi`).
    + Các đường kẻ phân cách vô nghĩa (`---`, `===`, `***`) và chuẩn hóa khoảng trắng thừa, thu gọn xuống dòng liên tiếp quá 2 lần (`\n{3,}` $\rightarrow$ `\n\n`).
  - **Tầng 2 (Custom Dictionary Replacement):** Cho phép người dùng tự định nghĩa quy tắc thay thế từ/cụm từ theo từng cuốn truyện hoặc áp dụng toàn hệ thống (Global):
    + Hỗ trợ đầy đủ phân biệt hoa/thường (Case-sensitive) và Biểu thức chính quy (Regex).
    + Có cơ chế bọc kiểm tra Regex an toàn (Try-Catch Safe Guard) tránh treo trình duyệt nếu người dùng nhập cú pháp lỗi.
- **Modal Quản lý Từ điển (Dictionary Manager UI - `#dict-modal`):**
  + Bảng quản lý quy tắc trực quan gồm các cột: `Từ gốc (Find)` | `Thay thế (Replace)` | `Hoa/Thường` | `Regex` | `Phạm vi` | `Bật/Tắt` | `Thao tác (Xóa)`.
  + Nút "Thêm quy tắc mới" nhanh chóng.
  + Nút "Xuất JSON" và "Nhập JSON" giúp sao lưu hoặc chia sẻ bộ từ điển xưng hô/dịch thuật dễ dàng giữa các thiết bị.
  + Dữ liệu từ điển được lưu trữ vĩnh viễn trong IndexedDB (`customRules` store).

#### B. Phân hệ 2: Tự Động Cuộn Trang Rảnh Tay (`autoscroll.js`)
- **Động cơ cuộn siêu mượt (Smooth rAF Engine):**
  - Ứng dụng `window.requestAnimationFrame` để kiểm soát vận tốc cuộn từng khung hình (sub-pixel delta scroll), loại bỏ triệt để hiện tượng giật cục của `setInterval`.
  - Tốc độ cuộn có thể tinh chỉnh liên tục từ **10px/giây đến 150px/giây** (mặc định 40px/giây) qua cặp nút `[-] [Tốc độ] [+]` tích hợp trực tiếp trên Floating Dock.
- **Cơ chế Tạm dừng & Tiếp tục Thông minh (Smart Pause & Resume):**
  - Tự động tạm dừng cuộn ngay lập tức khi phát hiện tương tác: Lăn chuột thủ công (wheel), chạm vuốt màn hình cảm ứng (touch), hoặc rê chuột vào thanh Floating Dock.
  - Tự động kích hoạt cuộn tiếp mượt mà sau **2 giây** người dùng buông tay (không cần nhấn bật lại).
  - Khi cuộn đến đáy chương: Cảm biến đáy tự động dừng lại và chuyển tiếp mượt mà sang chương tiếp theo.
- **Phím tắt nhanh:** Nhấn phím <kbd>A</kbd> hoặc <kbd>S</kbd> trên bàn phím để Bật / Tắt chế độ cuộn tự động tức thì.

#### C. Phân hệ 3: Đánh Dấu Văn Bản & Ghi Chú Trích Dẫn (`highlight.js`)
- **Thanh công cụ nổi tương tác bôi đen (Floating Selection Toolbar):**
  - Tự động xuất hiện ngay phía trên đoạn văn được bôi đen bằng chuột hoặc cảm ứng:
    + **Bảng 4 màu highlight:** Vàng chanh (`#fef08a`), Xanh mint (`#bbf7d0`), Xanh pastel (`#bae6fd`), Cam đào (`#fed7aa`). Tự động thích ứng màu nền trên cả 4 giao diện Sáng, Tối, Sepia, Navy.
    + **Nút "Ghi chú" (Add Note):** Mở ô popover nhỏ tại chỗ để nhập bình luận, cảm nghĩ hoặc giải nghĩa cá nhân.
    + **Nút "Trích dẫn" (Copy Quote):** Tự động sao chép vào bộ nhớ tạm theo định dạng chuẩn:
      > "[Nội dung đoạn trích]"
      > — Trích: [Tên truyện] | [Tên chương]
    + **Nút "Xóa đánh dấu":** Bỏ highlight đoạn văn và hoàn nguyên trạng thái ban đầu khi click vào thẻ `<mark>` đã lưu.
- **Drawer Quản lý Trích dẫn (Quotes Hub):**
  - Tích hợp 2 tab chuyên biệt trong Drawer bên trái: Tab 📑 Mục lục và Tab ✍️ Trích dẫn & Ghi chú.
  - Hiển thị danh sách tất cả các trích dẫn của cuốn sách hiện tại dạng thẻ bài (Cards), có huy hiệu màu, tên chương và thời gian tạo.
  - **Click để nhảy (`scrollIntoView`):** Bấm vào bất kỳ thẻ trích dẫn nào, trình đọc sẽ tự động mở chương tương ứng (nếu cần) và cuộn mượt đến đúng vị trí đoạn văn được đánh dấu.
  - **Xuất toàn bộ trích dẫn ra Markdown:** Tự động tạo tệp `.md` chuẩn nhóm theo từng chương để nhập vào các ứng dụng ghi chú tri thức thứ hai như Obsidian, Notion hoặc Logseq.

### 2.5. Module "Audiobook & Sleep Suite": Hẹn Giờ Ngủ, Fade-out, Bộ Trộn Âm Thanh & Media Session
Nâng tầm trải nghiệm nghe truyện audio đêm khuya với bộ 3 tính năng chăm sóc giấc ngủ và điều khiển phần cứng chuyên sâu:

#### A. Phân hệ 1: Hẹn Giờ Tắt Thông Minh & Fade-out 30 Giây (`sleepTimer.js`)
- **Các chế độ hẹn giờ linh hoạt:**
  - Lựa chọn nhanh các mốc thời gian: `15 phút`, `30 phút`, `45 phút`, `60 phút`.
  - **Chế độ đặc biệt "Dừng khi hết chương hiện tại":** Trình đọc tiếp tục phát bình thường và tự động tắt ngay sau khi đọc xong câu cuối cùng của chương đang mở.
- **Huy hiệu đồng hồ đếm ngược trực quan (Badge Countdown):**
  - Hiển thị trực tiếp trên Floating Dock (ví dụ: `⏱️ 28:45` hoặc `⏱️ Hết chương`).
  - Nhấp vào huy hiệu để mở modal hủy hoặc điều chỉnh mốc thời gian tức thì.
- **Thuật toán Fade-out 30 giây cuối (Giảm dần âm lượng):**
  - Khi đồng hồ đếm ngược còn $\le 30$ giây, hệ thống tự động kích hoạt tiến trình hạ âm lượng:
    $$\text{Tỷ lệ Volume} = \frac{\text{Số giây còn lại}}{30}$$
  - Cả giọng đọc TTS (`SpeechSynthesisUtterance.volume` & Cloud AI) và âm thanh nền (Ambient Mixer) đều giảm êm ái về `0`, triệt tiêu hoàn toàn cảm giác giật mình khi âm thanh bị cắt đột ngột.
  - Khi về `00:00`, tự động dừng phát, tạm dừng âm thanh môi trường và hoàn nguyên mức volume gốc 100% cho lần đọc tiếp theo.

#### B. Phân hệ 2: Bộ Trộn Âm Thanh Môi Trường Nền (`ambientSound.js`)
- **Web Audio API Procedural Synthesis (Không tải file ngoài, 100% Offline):**
  - Tích hợp sẵn 4 bản âm thanh môi trường tạo hoàn toàn bằng toán học âm thanh (Pink/Brown noise filter, Poisson crackle bursts, LFO resonance):
    1. 🌧️ **Mưa rơi mái tôn / Cửa sổ** (Cozy Rain): Tiếng mưa rào êm ái kèm hạt mưa gõ hiên.
    2. 🌊 **Suối chảy róc rách** (Flowing Stream): Dòng nước chảy róc rách qua ghềnh đá thanh tịnh.
    3. 🎋 **Rừng trúc & Gió thổi** (Bamboo Forest Breeze): Gió thoảng lay động rừng trúc rì rào.
    4. 🔥 **Lửa trại bập bùng** (Campfire Crackling): Tiếng củi nổ lách tách ấm cúng trong đêm.
  - **Lặp vô tận không ngắt quãng (Zero-gap Looping):** Kỹ thuật cross-fade 200ms giữa điểm đầu và điểm cuối của `AudioBuffer` đảm bảo vòng lặp 100% không phát ra tiếng click hay khoảng lặng.
- **Bảng điều khiển Mixer (`#ambient-mixer-modal`):**
  - Mở nhanh qua nút tai nghe `🎧` trên Floating Dock.
  - Cho phép Bật/Tắt độc lập từng âm thanh (có thể bật riêng lẻ hoặc hòa âm kết hợp cả 4 loại).
  - Thanh trượt Volume riêng biệt từng âm thanh (0% - 100%, mặc định 15% - 20% tôn giọng đọc).
  - Thanh trượt Master Volume tổng và nút "Tắt hết" một chạm.
  - Tự động lưu trạng thái vào IndexedDB (`settings`) để khôi phục trong các phiên đọc sau.

#### C. Phân hệ 3: Tích Hợp Media Session API & Điều Khiển Tai Nghe Bluetooth (`mediaSessionHelper.js`)
- **Cơ chế Silent Background Audio Track (Chống ngắt khi tắt màn hình):**
  - Khắc phục giới hạn của Web Speech API trên Chrome/Edge/Android bằng luồng Audio chạy ngầm phát một track siêu nhẹ (data URI WAV im lặng lặp vô tận) song song khi TTS đọc.
  - Giữ cho tiến trình âm thanh luôn "sống" trong nhân hệ điều hành, cho phép nghe truyện ngay cả khi khóa màn hình điện thoại hoặc chuyển tab làm việc.
- **Sơ đồ kiến trúc Media Session:**
  ```mermaid
  flowchart TD
    TTS["TTS Engine (Web Speech / Cloud AI)"] -->|Phát âm thanh| App["Controller app.js"]
    App -->|Bật Audio ngầm| Silent["Silent Audio Track (WAV Loop)"]
    Silent -->|Duy trì kết nối OS| MS["navigator.mediaSession"]
    App -->|Cập nhật Metadata| MS
    MS -->|Hiển thị Banner| OS["Windows Media Center / Android Lockscreen / iOS Dynamic Island"]
    OS -->|Phím cứng / Tai nghe Bluetooth| MS
    MS -->|Action Handlers| Handlers["play / pause / previoustrack / nexttrack / seek"]
    Handlers -->|Điều khiển| App
  ```
- **Đồng bộ hóa Metadata & Bìa sách Notification:**
  - Đăng ký tiêu đề chương, tên tác phẩm, tác giả và tự động tạo bìa vector SVG 512x512 hiển thị trên thanh điều khiển hệ thống.
- **Danh mục thao tác tai nghe & phím cứng:**
  - `Play / Pause`: Tiếp tục hoặc tạm dừng bài đọc và âm thanh nền.
  - `Previous Track`: Lùi lại 1 đoạn văn (hoặc chuyển về chương trước nếu ở đầu chương).
  - `Next Track`: Nhảy đến đoạn văn tiếp theo (hoặc chuyển sang chương sau nếu ở cuối chương).
  - `Seek Backward / Forward`: Tua lùi hoặc tiến 10 giây (tương đương 1-2 câu).
  - `Stop`: Dừng hẳn toàn bộ phiên đọc.

---

### 2.6. Quản Lý Thư Viện & Lưu Trữ Vĩnh Viễn (Library & Storage - Dexie Schema Version 6)
- **Lưu trữ IndexedDB cục bộ:**
  - Quản trị sách, chương, cài đặt, cache âm thanh, từ điển, trích dẫn, bookmarks, search index và reading sessions qua `VietReaderDB` (Dexie schema version 6; 9 object stores).
- **Cơ chế lưu và khôi phục tiến độ đọc 2 tầng (Two-Layer Progress Persistence):**
  - **Tầng 1 — Tọa độ cuộn (`scrollY`):** Được lưu với cơ chế debounce mỗi khi người dùng cuộn trang. Khi mở lại tác phẩm, màn hình tự động trượt về đúng vị trí đọc dở phục vụ trải nghiệm đọc bằng mắt liền mạch.
  - **Tầng 2 — Chỉ mục phân đoạn TTS (`currentChunkIndex`):** Được lưu riêng biệt và luôn được nạp từ IndexedDB **trước khi gọi bất kỳ phương thức phát nào** của `TTSEngine`. Đảm bảo nút Play/Resume tiếp tục đọc chính xác từ câu/đoạn đang dừng dở, không bao giờ bị reset về `0` sau khi mở lại truyện.
  - Hai tầng hoạt động độc lập: Vị trí cuộn mắt đọc và con trỏ TTS được quản lý riêng biệt để tránh xung đột trạng thái.
- **Lược đồ cấu trúc cơ sở dữ liệu (Dexie schema):**
  - Các migration được khai báo tăng dần từ version 1 đến version 6; version 4 thêm object store `searchIndex`, version 5 thêm `bookmarks`, version 6 thêm `readingSessions`. Dexie giữ các store cũ khi nâng phiên bản.
  - Schema thực tế trong `storage.js`:

  ```js
  db.version(1).stores({
    books: '++id, title, author, totalChapters, currentChapterIndex, lastReadAt, createdAt',
    chapters: '++id, [bookId+chapterIndex], bookId, chapterIndex, title',
    settings: 'key'
  });
  db.version(2).stores({ audioCache: 'key, provider, voice, createdAt' });
  db.version(3).stores({
    customRules: '++id, bookId, isEnabled, createdAt',
    highlights: '++id, [bookId+chapterIndex], bookId, chapterIndex, paragraphIndex, createdAt'
  });
  db.version(4).stores({ searchIndex: '[bookId+chapterIndex], bookId' });
  db.version(5).stores({ bookmarks: '++id, bookId, [bookId+chapterIndex]' });
  db.version(6).stores({ readingSessions: 'id, bookId, startedAt' });
  ```
  - Entry `searchIndex` là derived cache: chứa phiên bản thuật toán/định dạng, fingerprint nội dung và rules, cùng text chuẩn hóa theo paragraph. Không lưu kết quả search hay temporary focus.
  - `bookmarks` là dữ liệu người dùng, không dùng store `highlights`: schema chỉ index theo `id`, `bookId` và `[bookId+chapterIndex]` để đọc theo sách/chương.
- **Kệ sách trực quan:**
  - Hiển thị danh sách truyện dạng thẻ lưới (Grid Cards). Mỗi tác phẩm được gán một dải màu gradient ngẫu nhiên rực rỡ, kèm tiêu đề, tác giả, số lượng chương, dung lượng từ và thanh phần trăm tiến độ đọc.
  - Bộ lọc tìm kiếm nhanh truyện trên kệ theo thời gian thực.
  - Tích hợp sẵn nút "Nạp truyện mẫu tiếng Việt" để người dùng trải nghiệm ngay tính năng mà không cần chuẩn bị file trước.
- **Sao lưu & Khôi phục trọn vẹn (Backup / Restore JSON):**
  - **Export JSON:** Xuất dữ liệu thư viện, tiến độ, bookmarks và reading sessions ra file `.json` định dạng backup version 5. Search index không được backup vì có thể dựng lại từ dữ liệu nguồn.
  - **Import JSON:** Backup cũ thiếu `bookmarks` hoặc `readingSessions` vẫn được chấp nhận. Khi ghép nối, book ID và session ID được ánh xạ sang dữ liệu mới; session mồ côi hoặc sai cấu trúc làm import bị từ chối trước khi thay đổi dữ liệu hiện có. Xóa sách cũng xóa các session của sách trong cùng transaction.
- **Hộp thoại xác nhận tùy biến (Custom Confirmation Modal):**
  - Loại bỏ hoàn toàn hộp thoại chặn `window.confirm()` mặc định của trình duyệt, thay thế bằng Custom Modal có hiệu ứng làm mờ nền hiện đại và cảnh báo hành động nhạy cảm.


### 2.7. Tìm kiếm toàn văn trong thư viện (Global Full-Text Search)
- Nút **Tìm trong thư viện** mở tìm kiếm nội dung, độc lập với bộ lọc tên sách/tác giả và tìm chương trong TOC.
- Tìm theo từ hoặc cụm từ, không phân biệt hoa/thường và dấu tiếng Việt; `đ/Đ` được chuẩn hóa thành `d`, dấu kết hợp Unicode được bỏ và khoảng trắng được gộp. Offset của match vẫn ánh xạ về chuỗi gốc để tạo snippet và điều hướng.
- `search.js` chứa search engine và `createSearchIndexService`. Index có entry theo book/chapter, lưu paragraph đã chuẩn hóa cùng content/rules fingerprint và version. Build được chia batch, nhường event loop; query debounce 250 ms, stale query bị hủy. Entry thiếu/hỏng được dựng lại; các candidate được kiểm tra fingerprint nguồn, còn cập nhật sách, dictionary và restore/import phát invalidation để loại entry cũ. Orphan entry được dọn khi khởi tạo.
- Kết quả hiển thị theo **Sách → Chương → Match**, kèm snippet context; snippet render bằng text node và `<mark>` an toàn. Mặc định lấy tối đa 200 match, render 50 mỗi lượt, có thể tải tiếp đến giới hạn 500.
- Chọn match dùng `openBook()`/`loadChapter()` hiện có và chờ Promise hoàn tất. Anchor dựa vào chapter, paragraph, original offset và context; nếu paragraph thay đổi, app tìm lại trong chapter. Match được focus tạm bằng `.search-focus-match`; nó không ghi vào bảng `highlights`. Việc chuyển chương tiếp tục dùng lifecycle TTS/progress hiện hữu.
- Giao diện theo theme tokens hiện tại, hỗ trợ Light, Dark, Sepia, Navy và layout mobile.

### 2.8. Bookmark / Reading Mark
- Nút **🔖 Bookmark** lưu vị trí đọc hiện tại mà không cần chọn text. Nếu TTS đang phát và chunk đang hoạt động ánh xạ được tới paragraph, vị trí đó được ưu tiên; khi đọc bằng mắt, app chọn paragraph gần đường đọc khoảng 35% vùng viewport sau khi trừ header và dock.
- Mỗi bookmark lưu `bookId`, `chapterIndex`, `paragraphIndex`, text anchor/context gọn, preview tối đa 180 ký tự và metadata tùy chọn như nhãn ngắn. Preview chỉ giúp nhận diện; chapter/paragraph và anchor là dữ liệu điều hướng.
- Bookmark Hub là tab riêng trong Drawer TOC/Quotes. Danh sách sách hiện tại được sắp theo chương rồi đoạn, có preview, nhãn, thời gian, chỉnh nhãn, xóa và **Đến vị trí**.
- Điều hướng kiểm tra sách/chương trước, dùng `openBook()` hoặc `loadChapter()` hiện có và chờ Promise hoàn tất. Trong cùng chương không reload Reader/TTS. Khi mở sách khác, scroll restore cũ bị bỏ qua để không ghi đè đích bookmark; TTS chunk đã lưu được giữ nếu chương bookmark trùng chương đọc gần nhất, còn chương khác dùng reset chunk theo lifecycle chuyển chương.
- Focus điều hướng là class UI tạm `.bookmark-focus`, tách khỏi `<mark>` đã lưu và `.search-focus-match`; không ghi vào `highlights`. Cùng chương chỉ cuộn mắt đọc và tạm dừng AutoScroll theo API hiện có; không đặt TTS pointer theo paragraph bookmark. Đổi chương/sách tiếp tục theo lifecycle TTS và progress hiện có.
- Bookmark được xóa cùng sách trong transaction. Cleaner/từ điển không tự xóa bookmark; index còn hợp lệ vẫn dùng được và anchor text làm đường dự phòng khi nội dung thay đổi.

### 2.9. Động Cơ Phiên Đọc/Nghe Hợp Nhất & Lịch Sử (Unified Reader Session Engine & Reading History)
- **Kiến trúc Hợp nhất (Unified Session Architecture):**
  - Quản lý phiên đọc mắt (Reading) và nghe giọng nói (Listening/TTS) dưới quyền kiểm soát độc quyền của một động cơ phiên duy nhất: `ReadingHistoryEngine` (trong `readingHistory.js`).
  - Loại bỏ hoàn toàn trạng thái phiên song song hoặc định danh session trùng lặp trong `app.js`.
  - **Ranh giới sở hữu & Hợp đồng API (Ownership Boundaries & Subsystem Contracts):**
    - `TTSEngine` (`tts.js`): Độc quyền sở hữu audio playback, speech utterance queue và Web Speech / Cloud playback. Không can thiệp vào session identity hay timing logic.
    - `Reader` (`app.js`): Độc quyền sở hữu điều hướng (navigation: open book, switch chapter, TOC), DOM render, và điều phối sự kiện theo một chiều.
    - `Session Engine` (`readingHistory.js`): Độc quyền sở hữu session identity, dual activity state, timing logic, idle/separation policy, checkpoint và persistence.
    - `Storage` (`storage.js`): Độc quyền sở hữu tính bền vững (Persistence) qua Dexie IndexedDB v6 và định dạng sao lưu/khôi phục v5.
    - `Analytics` (`readingAnalytics.js`): Là lớp dẫn xuất chỉ đọc (Read-Only Derived Metrics), không bao giờ ghi trực tiếp vào cơ sở dữ liệu hay tạo store song song.
  - **Điều phối sự kiện một chiều (One-Way Event Coordination):**
    - Luồng dữ liệu: `Người dùng tương tác` $\rightarrow$ `Reader UI / TTSEngine` $\rightarrow$ `SessionEngine` $\rightarrow$ `Storage (IndexedDB)`.
    - Tuyệt đối loại bỏ vòng phản hồi: Không bao giờ có luồng `Session Event` $\rightarrow$ `TTS Play` $\rightarrow$ `Session Event`. Session Engine không tự ý khởi phát audio playback khi khôi phục metadata hoặc nhận tín hiệu hoạt động.
- **Vòng đời phiên & Máy trạng thái tất định (Session Lifecycle & State Semantics):**
  - Các trạng thái hoạt động: `idle` $\leftrightarrow$ `reading` / `listening` / `both` $\leftrightarrow$ `paused` $\leftrightarrow$ `ended`.
  - **Bất biến thời gian (Timing Invariants):**
    - `activeTimeMs >= ttsTimeMs` luôn được đảm bảo tại mọi thời điểm.
    - Khi người dùng đọc bằng mắt và nghe TTS diễn ra đồng thời, Active Time không bị cộng dồn nhân đôi; khi dừng TTS hoặc dừng đọc, từng đồng hồ ngừng chính xác.
    - Loại bỏ hoàn toàn thời gian trôi khi ứng dụng ẩn (tab hidden), màn hình khóa không phát âm hoặc mất mạng.
  - **Phân định tiến độ độc lập (Progress & Resume Semantics):**
    - `scrollY`: Tọa độ vị trí đọc bằng mắt, lưu trữ có debounce tránh bão ghi.
    - `currentChunkIndex`: Chỉ mục phân đoạn TTS của audio playback, được nạp riêng trước khi phát.
    - Hai chỉ số hoàn toàn độc lập, không ghi đè hoặc hợp nhất bừa bãi.
  - **Ghi nhận số từ tuyến tính (Logical Forward Word Accounting):**
    - `wordsReadEstimate`: Chỉ cộng dồn tiến độ tiến tới tuyến tính (`max(0, newChunk - lastChunk)` hoặc khoảng tiến độ mới).
    - Thao tác tua lùi (rewind), nghe lại (replay), seek, hoặc nhảy câu chủ động (`explicitJump: true`) không tạo số từ giả mạo.
  - **Khử trùng lặp hoàn tất chương (Deduplicated Chapter Completion):**
    - `completeChapter()` kiểm tra tập hợp deduplication set trong session và database; cùng một chương chỉ được ghi nhận hoàn thành tối đa một lần trong một phiên đọc.
- **Chính sách lưu vết định kỳ & Khôi phục sự cố (Checkpoint & Recovery Policies):**
  - **Chu kỳ Checkpoint ~15s:** Tự động ghi snapshot phiên đọc xuống store `readingSessions` định kỳ, hạn chế mất mát dữ liệu nếu trình duyệt tắt đột ngột.
  - **Chính sách nhàn rỗi (Idle Policy 60s):** Nếu không có hoạt động đọc hợp lệ và TTS đang dừng, phiên tự động chuyển sang `paused` sau 60 giây để tránh tính thời gian treo máy.
  - **Chính sách phân tách (Separation Policy 30m):** Nếu phiên đọc bị gián đoạn quá 30 phút, hệ thống tự động chốt (finalize) phiên cũ và mở phiên đọc mới độc lập khi phát hiện hoạt động tiếp theo.
  - **Khôi phục sự cố (Crash Recovery):** Khi khởi động lại sau crash/reload, phiên dở dang được khôi phục và giới hạn mốc kết thúc tại checkpoint an toàn cuối cùng cộng idle grace, không tính thời gian ứng dụng offline.
  - **Chống bão ghi (Write Storm Prevention):** Tác vụ cuộn màn hình và sự kiện từng câu TTS chỉ cập nhật bộ nhớ đệm (in-memory snapshot); chỉ ghi xuống IndexedDB tại checkpoint hoặc khi kết thúc phiên.
- **Tích hợp liên phân hệ an toàn (Auxiliary Integrations):**
  - **AutoScroll:** Phân biệt rõ Hands-Free AutoScroll (cuộn rảnh tay) và TTS-follow AutoScroll (cuộn theo câu phát). AutoScroll Pause/Stop không làm gián đoạn phiên đọc hay tạo sự kiện hoàn tất chương giả.
  - **Sleep Timer:** Hẹn giờ ngủ tích hợp điều khiển âm lượng fade-out 30s, tạm dừng playback và chốt phiên đọc hoàn chỉnh mà không tạo rò rỉ timer.
  - **Media Session:** Silent audio track duy trì kết nối nền, đồng bộ metadata và tiếp nhận phím bấm tai nghe/phần cứng một chiều.
  - **Ambient Sound:** Bộ trộn âm thanh môi trường hoạt động độc lập hoàn toàn, không can thiệp timeline phiên đọc.
- **Giao diện Lịch sử Đọc (Reading History UI & Timeline):**
  - History là view riêng trong Library, hiển thị tổng quan hôm nay/7 ngày/30 ngày và timeline theo ngày có hoạt động. Timeline tải từng trang tối đa 40 session và cho phép mở sách tại vị trí đọc hiện đã lưu.
  - Xóa một session hoặc xóa toàn bộ History chỉ tác động dữ liệu session; không xóa tiến độ sách, bookmarks hay highlights.
  - `readingSessions` là dữ liệu nguồn duy nhất (Single Source of Truth); truy vấn latest-N tận dụng index `startedAt` tối ưu hiệu năng.

### 2.10. Personal Analytics
- Mở **📊 Thống kê** từ Library. Dashboard là view riêng, có khoảng 7 ngày, 30 ngày, 365 ngày và Toàn bộ; đổi khoảng ngày lấy một result model và render ngay trong view.
- Pipeline: `Reader / TTS → Reading Session Engine → readingSessions → readingAnalytics.js → Analytics UI`. Analytics chỉ đọc session đã lưu cùng safe in-memory snapshot; không thêm scroll/TTS listener, không đo active time/progress lần nữa và không ghi Analytics vào IndexedDB.
- `getDashboardData(range)` trả `range`, `totals`, `dailyActivity`, `comparison`, `comparisons`, `lifetime`, `heatmap`, `streaks`, `trends` và `insights`. Dashboard tải sessions, snapshot và book catalog một lần mỗi lần mở/đổi range. Một daily index dùng chung cho range, trend, heatmap, streak và comparison. Không có bảng/cache Analytics; sau restore, kết quả được tính lại từ `readingSessions`.
- **Metric semantics:** Active Time là tổng thời gian hoạt động; TTS là phần con nằm trong Active Time và không cộng lần hai. Words dùng `wordsReadEstimate`, là ước lượng từ các logical ranges tiến về phía trước. Chapters chỉ gồm `chaptersCompleted` do History ghi nhận. Books Active là số `bookId` hợp lệ duy nhất có activity trong range, không phải số sách trong thư viện.
- **Tốc độ:** UI gọi là *Tốc độ tiêu thụ trung bình*, không gọi là tốc độ đọc bằng mắt. Phiên cần ít nhất 2 phút hoạt động và số từ dương; phiên vượt 1.500 từ/phút bị loại. Công thức weighted là tổng từ hợp lệ chia tổng phút hợp lệ. TTS vẫn có thể nằm trong mẫu, nên metric phản ánh đọc/nghe tiêu thụ.
- **Habits:** Hourly activity chia thời lượng theo overlap từng giờ lịch địa phương. Preferred Window chỉ sẵn sàng khi có ít nhất 7 ngày hoạt động, 5 giờ hoạt động trong cửa sổ 2 giờ tốt nhất và ít nhất 3 phiên có dữ liệu theo giờ. Weekday leader cần tối thiểu 14 ngày quan sát. Best Day lấy ngày Active Time cao nhất; nếu hòa, chọn ngày gần nhất.
- **Top Books:** Xếp theo Active Time, rồi words, chapters, TTS và `bookId` để phá hòa ổn định. Nếu session còn nhưng sách không có trong catalog, dùng tên “Truyện đã xóa”.
- **Ngày và heatmap:** Các range dùng local calendar day. 7 ngày gồm hôm nay và 6 ngày trước; 30 ngày gồm hôm nay và 29 ngày trước. Heatmap có 365 ngày gần nhất, tuần bắt đầu thứ Hai; intensity: 0 phút, dưới 15 phút, 15–<30, 30–<60, từ 60 phút. Cell giữ date, active, TTS, words, chapters, books và intensity cho tooltip/accessibility.
- **Streak:** Một active day cần ít nhất 5 phút. Current streak có thể giữ chuỗi kết thúc hôm qua đến hết hôm nay. Longest Streak tính chuỗi ngày liên tiếp; các giá trị được tính lại, không lưu DB.
- **So sánh và no-data:** So sánh 7 ngày với 7 ngày liền trước và 30 ngày với 30 ngày liền trước. Baseline bằng 0 dùng thông điệp trung tính, không tạo phần trăm vô hạn. Tốc độ, khung giờ, weekday, streak và Top Books hiển thị “Chưa đủ dữ liệu” khi source chưa đủ. History trống hiển thị lời nhắc bắt đầu đọc/nghe.
- Analytics tính trong trình duyệt từ IndexedDB hiện có; không gửi reading history ra server và không thay schema/backup. Cloud TTS là tính năng riêng, không thuộc Analytics.

---

## 3. Cấu Trúc Thư Mục Dự Án (Project File Tree)

Dưới đây là cấu trúc toàn bộ các file mã nguồn và tài nguyên đang có trong workspace:

```
c:\Users\hoang\.gemini\antigravity-ide\scratch\personal-reader\
│
├── index.html          # Bộ khung SPA, Library, Reader, History, Analytics, Drawer và Modals
├── styles.css          # Design tokens, 4 themes, Responsive UI, Reader, History và Analytics
├── storage.js         # Lớp dịch vụ cơ sở dữ liệu IndexedDB Dexie.js (schema version 6; readingSessions/bookmarks user data, searchIndex derived)
├── readingHistory.js  # Session engine, recovery, daily/range aggregation và timeline cho Reading History
├── readingAnalytics.js # Derived Analytics ranges, sanitization, metrics, trends, comparison, heatmap và streaks
├── bookmark.js        # Bookmark service, current-position capture, preview và anchor resolver
├── search.js          # Search engine, chuẩn hóa tiếng Việt và lifecycle của derived search index
├── searchNavigation.js # Tìm lại logical anchor và context trong paragraph hiện tại
├── parser.js          # Bộ bóc tách tài liệu đa định dạng (TXT, PDF, EPUB) & chia chương thông minh
├── tts.js             # Động cơ Text-to-Speech tiếng Việt (Multi-Engine, Smart Chunking, Volume & Fade-out)
├── ttsQueueScheduler.js # Bounded Event-Driven Queue Scheduler & sliding window [N, N+2] cho Cloud TTS
├── cloudTtsProvider.js # Cloud TTS provider adapters (FPT AI polling, OpenAI binary, Custom endpoints, error classification)
├── cleaner.js         # Bộ lọc rác tự động (Global Junk Cleaner) & Từ điển thay thế (Custom Dictionary)
├── autoscroll.js      # Động cơ cuộn trang rảnh tay rAF siêu mượt (10-150px/s) kèm Smart Pause & Auto-next
├── highlight.js       # Phân hệ bôi đen đánh dấu, ghi chú trích dẫn, sao chép định dạng & xuất Markdown
├── sleepTimer.js      # Phân hệ Hẹn giờ ngủ thông minh (15-60m / Hết chương) & Fade-out 30s âm lượng
├── ambientSound.js    # Phân hệ Bộ trộn âm thanh môi trường (Web Audio synthesis 4 âm thanh lặp vô tận)
├── mediaSessionHelper.js # Tích hợp Media Session API, Silent audio background & Bluetooth headset controls
├── app.js             # Controller trung tâm điều phối trạng thái, sự kiện và tích hợp toàn bộ phân hệ
├── package.json       # Tệp khai báo cấu hình npm & Vite dev server
├── sample-story.txt   # Tệp truyện mẫu tiếng Việt dùng để thử nghiệm nạp nhanh
├── test_parser.mjs    # Regression tests cho parser, TTS, cleaner, highlight và audio suite
├── test_tts_root_cause_fix.mjs # Tests 11 ca nghiệm thu root cause fix treo TTS và circuit breaker
├── test_tts_reproduction.mjs # Tests tái hiện & phòng ngừa hồi quy TTS lõi
├── test_tts_interactions.mjs # Tests tích hợp liên phân hệ TTS, MediaSession, SleepTimer, AutoScroll
├── test_tts_phase4_stability.mjs # Tests độ ổn định tất định 3/10/25/50 chunks và an toàn tài nguyên
├── test_cloud_tts_safety_baseline.mjs # Tests baseline an toàn playback Cloud TTS, audio lifecycle và user gesture rejection
├── test_tts_queue_scheduler.mjs # Tests bounded scheduler, sliding window [N, N+2], request coalescing và memory limits
├── test_cloud_tts_cache_integrity.mjs # Tests cache-first pipeline, canonical keys, schema v2/v6 compatibility và corrupt blob rejection
├── test_cloud_tts_provider_contracts.mjs # Tests provider adapters (FPT/OpenAI/Custom), retry policy, error classification và abortable sleep
├── test_cloud_playback_integration.mjs # Tests tích hợp playback liên tục, handoff tức thì, audio url lifecycle và generation invalidation
├── test_reader_cloud_prefetch_observability.mjs # Tests reader session invariants và observability metrics (gap latency, cache/prefetch hits)
├── test_cloud_prefetch_stress_soak.mjs # Bounded mock stress suite (50-chunk soak, 0ms callback storm trip, 50 rapid seeks, 30 repeated sessions)
├── test_bookmark.mjs  # Tests cho bookmark CRUD, dedup, migration, cleanup và backup/restore
├── test_bookmark_navigation.mjs # Tests cho anchor fallback và navigation/focus contracts
├── test_bookmark_storage_errors.mjs # Tests cho IndexedDB open/migration failure recovery
├── test_reading_history.mjs # Tests engine, aggregation, checkpoint cadence, storage và cleanup
├── test_reading_history_integration.mjs # Tests tích hợp Reader/TTS/progress/History contracts
├── test_reading_analytics.mjs # Tests core totals, ranges, sanitation, midnight, snapshot và comparisons
├── test_reading_insights.mjs # Tests weighted speed, hourly overlap, habits, Top Books và Best Day
├── test_reading_analytics_trends.mjs # Tests heatmap, local calendar, streaks, trends và comparisons
├── test_reading_analytics_dashboard.mjs # Tests DashboardResult, heatmap layout và single-load contract
├── test_search.mjs   # Tests cho normalization, mapping, snippets, query và concurrency
├── test_search_index.mjs # Tests cho schema, lifecycle, invalidation, cache và restore
├── test_search_navigation.mjs # Tests cho anchor fallback, an toàn snippet và navigation contracts
├── test_session_lifecycle_contracts.mjs # Tests hợp đồng vòng đời session, trạng thái và timing invariants
├── test_session_persistence_recovery.mjs # Tests checkpoint 15s, idle 60s, separation 30m và crash recovery
├── test_reader_lifecycle_navigation.mjs # Tests tách biệt scrollY / TTS chunk, navigation và tiến độ
├── test_tts_session_integration.mjs # Tests tích hợp TTSEngine, luồng 1 chiều, voice preview và auto-next
├── test_phase6_integration.mjs # Tests tích hợp AutoScroll, SleepTimer, MediaSession và AmbientSound
├── test_phase7_compatibility.mjs # Tests single source of truth readingSessions, derived Analytics và backup v5
├── README.md          # Tài liệu kiến trúc kỹ thuật và hướng dẫn sử dụng chi tiết của hệ thống
└── CHANGELOG.md       # Nhật ký theo dõi lịch sử cập nhật phiên bản DUY NHẤT theo chuẩn Keep a Changelog
```

> [!IMPORTANT]
> **Quy chuẩn ghi nhận lịch sử phiên bản:** Dự án loại bỏ hoàn toàn tệp `change.md`. Mọi cập nhật, bổ sung tính năng và sửa lỗi được lưu trữ duy nhất và chuẩn hóa tại [`CHANGELOG.md`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/CHANGELOG.md).

---

## 4. Bảng Bóc Tách Chi Tiết Các File (File Breakdown & Responsibilities)

Phần `.analytics-*` trong `styles.css` định dạng dashboard, biểu đồ, responsive heatmap và focus/accessibility states; activity colors dùng theme tokens riêng trong cả bốn theme.

| Tên File | Vai Trò & Trách Nhiệm Chính | Các Hàm / Module / Thành Phần Cốt Lõi |
| :--- | :--- | :--- |
| [`index.html`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/index.html) | Khung SPA DOM nạp thư viện bên ngoài, tổ chức Header, Library, Reader, History, Analytics, Drawer, Floating Reader Dock và modals. | - Semantic views: `#library-view`, `#reader-view`, `#history-view`, `#analytics-view`<br>- Analytics entry: `#btn-open-analytics`; range, KPI, trends, heatmap, habits, books và lifetime sections<br>- History: dashboard và timeline theo ngày<br>- Drawer: `#tab-btn-toc`, `#tab-btn-quotes`, `#tab-btn-bookmarks`<br>- Bookmark entry: `#btn-dock-bookmark`; Bookmark Hub: `#tab-view-bookmarks`<br>- Dock: `#tts-dock`, scrubber, Sleep Timer, Ambient Mixer, Auto-Scroll và Mini FAB<br>- Highlights/Notes: `#selection-toolbar`, `#hl-note-popover`<br>- Modals: settings, backup, confirm, dictionary, TTS, sleep timer, ambient mixer và global search |
| [`styles.css`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/styles.css) | Đảm nhiệm toàn bộ phần định dạng, layout, hệ thống màu sắc và hiệu ứng chuyển cảnh của ứng dụng. Định nghĩa biến CSS (tokens) cho 4 theme màu (Light, Dark, Sepia, Navy), huy hiệu đồng hồ đếm ngược hẹn giờ ngủ `.dock-timer-badge` (kèm hiệu ứng nhấp nháy khi fade-out), chấm phát sáng âm thanh nền `.dock-ambient-dot`, thẻ âm thanh môi trường `.ambient-track-card`, giao diện thanh trượt mixer, bảng màu highlight, thanh dock Capsule, stepper cuộn rảnh tay, chế độ tập trung Zen Mode (`body.zen-mode`), và khoảng đệm an toàn chống che chữ (`padding-bottom: 140px`). | - Theme tokens: `:root`, `body.theme-dark`, `body.theme-sepia`, `body.theme-navy`<br>- Sleep Timer UI: `.btn-dock-timer`, `.dock-timer-badge`, `@keyframes timerFadePulse`, `.timer-countdown-display`, `.timer-preset-btn`<br>- Ambient Mixer UI: `.btn-dock-ambient`, `.dock-ambient-dot`, `.ambient-track-card`, `.ambient-master-bar`<br>- Highlight marks: `.reader-mark`, `.hl-yellow`, `.hl-green`, `.hl-blue`, `.hl-orange`; temporary search focus: `.search-focus-match`<br>- Selection toolbar: `.selection-toolbar`, `.color-swatch`<br>- Popover ghi chú: `.note-popover`<br>- Drawer tabs: `.drawer-tab-btn`, `.drawer-tab-content`, `.quote-card`<br>- Auto-Scroll stepper: `.dock-stepper`, `.stepper-btn`<br>- Dictionary Table: `.dict-table`, `.dict-scope-badge`<br>- Reader Dock Capsule: `.reader-dock`, `.dock-top-row`, `.dock-controls-row`, `.dock-cluster`<br>- Multi-Engine TTS UI: `.tts-engine-tabs`, `.tts-tab-btn`<br>- Mini FAB & Visualizer: `.reader-mini-fab`, `.mini-fab-visualizer`<br>- Zen Mode: `body.zen-mode` |
| [`storage.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/storage.js) | Data Access Layer dùng Dexie, schema version 6 với 9 stores; `readingSessions`/`bookmarks` là user data, `searchIndex` là derived cache không nằm trong backup. Backup JSON version 5 có reading sessions. | `getReadingSessions()`, `putReadingSession()`, History CRUD, `getSearchIndexSnapshot()`, books/rules/highlights/bookmarks CRUD, `exportDatabase()`, `importDatabase()` |
| [`readingHistory.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/readingHistory.js) | Engine quản lý vòng đời session, safe recovery, idle/active/TTS, progress ranges, phân ngày theo giờ địa phương, dashboard aggregation và timeline grouping. | `startSession()`, `recordActivity()`, `recordTtsProgress()`, `recordChapterProgress()`, `getRangeStats()`, `getTimelineGroups()`, xóa session/history |
| [`readingAnalytics.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/readingAnalytics.js) | Read-only derived-data layer cho Analytics; sanitize session, dựng local daily index, range summaries, metrics, comparisons, hourly/weekday insights, heatmap, streak và trend datasets. | `getLifetimeStats()`, `getStatsForRange()`, `getDailyActivity()`, `comparePeriods()`, `getHeatmapData()`, `getStreaks()`, `getDashboardData()` |
| [`bookmark.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/bookmark.js) | Service Bookmark độc lập với highlight; xác định vị trí mắt/TTS khi được yêu cầu, tạo preview và resolve anchor với text fallback. | `captureCurrentReadingPosition()`, `createBookmark()`, `getBookBookmarks()`, `updateBookmark()`, `deleteBookmark()`, `resolveBookmarkAnchor()` |
| [`search.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/search.js) | Core Global Full-Text Search: Vietnamese normalization/mapping, result ranking/snippets, persistent derived-index lifecycle, batching and invalidation. | `searchLibrary()`, `normalizeVietnameseWithMap()`, `createSearchIndexService()` |
| [`searchNavigation.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/searchNavigation.js) | Resolves a search result against current rendered paragraphs using original offsets and surrounding context. | `findSearchAnchor()`; stale paragraph fallback |
| [`parser.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/parser.js) | Đóng vai trò là phân hệ trích xuất và tiền xử lý tài liệu văn bản. Nhận đầu vào là file hoặc chuỗi văn bản thô, nhận diện ngôn ngữ chương tiếng Việt, tách phân đoạn tự động và phân giải cấu trúc tệp nén EPUB/PDF. | - `CHAPTER_REGEX_PATTERNS`: Mảng mẫu Regular Expression chuẩn nhận diện tiêu đề chương tiếng Việt & quốc tế<br>- `isChapterHeading(line)`: Kiểm tra một dòng văn bản có phải tiêu đề chương hay không<br>- `splitTextIntoChapters(rawText, fallbackTitle)`: Thuật toán tách chương thông minh, tự động tách Lời tựa và kích hoạt fallback nếu cần<br>- `fallbackSplitByWordCount(text, titlePrefix)`: Thuật toán chia đều văn bản theo đoạn văn 2.000-2.800 từ<br>- `countWords(str)`: Đếm số lượng từ Unicode tiếng Việt<br>- `parseTxtFile(file)`, `parsePdfFile(file, onProgress)`, `parseEpubFile(file)` |
| [`cleaner.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/cleaner.js) | Phân hệ lọc rác tự động & từ điển tùy chỉnh (Text Filter & Replacement Engine). Chịu trách nhiệm dọn dẹp các đường link rác, tên miền cào, câu chào convert/donate, khoảng trắng thừa, và áp dụng bảng quy tắc thay thế danh xưng/thuật ngữ theo từng cuốn truyện hoặc toàn cục. | - `GLOBAL_JUNK_PATTERNS`: Danh mục biểu thức chính quy quét sạch link, domain, lời nhắc donate/convert<br>- `cleanGarbageText(text)`: Quét và loại bỏ văn bản rác tự động (Tầng 1)<br>- `applyCustomRules(text, rules)`: Áp dụng bảng từ điển tùy chỉnh (Tầng 2) kèm Try-Catch an toàn cho Regex<br>- `cleanChapterText(text, customRules)`: Pipeline làm sạch hoàn chỉnh kết hợp cả 2 tầng trước khi render và nạp TTS<br>- `escapeRegExp(str)` / `validateRules(rules)`: Tiện ích xử lý chuỗi và xác thực quy tắc |
| [`autoscroll.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/autoscroll.js) | Phân hệ tự động cuộn trang rảnh tay (Hands-Free Auto-Scroll Engine). Sử dụng `requestAnimationFrame` điều khiển bước cuộn siêu mượt (10-150px/giây), tích hợp cơ chế Tạm dừng & Tiếp tục Thông minh (Smart Pause & Resume 2 giây) khi người dùng tương tác chuột, cảm ứng hoặc dock, và phát hiện chạm đáy chương để chuyển tiếp. | - `class AutoScrollEngine`: Lớp điều khiển cuộn trang rảnh tay<br>- `start()` / `stop()` / `toggle()`: Bật / tắt vòng lặp `requestAnimationFrame`<br>- `setSpeed(speed)` / `getSpeed()`: Tinh chỉnh tốc độ cuộn trong dải 10 - 150 px/s<br>- `pause(autoResumeDelay)`: Tạm dừng cuộn và tự động lên lịch chạy lại sau khoảng hoãn (2000ms)<br>- `resume()`: Tiếp tục cuộn ngay lập tức<br>- `bindSmartInteractions(container, dock)`: Gắn lắng nghe sự kiện lăn chuột, vuốt chạm và rê dock |
| [`highlight.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/highlight.js) | Phân hệ quản lý đánh dấu văn bản, ghi chú trích dẫn và xuất Markdown. Chịu trách nhiệm định nghĩa bảng màu, bọc thẻ `<mark>` vào DOM đoạn văn, chuẩn hóa định dạng trích dẫn sao chép vào bộ nhớ tạm, và chuyển đổi toàn bộ trích dẫn của truyện thành tệp Markdown cấu trúc phục vụ Obsidian / Notion. | - `HIGHLIGHT_COLORS`: Danh mục 4 màu highlight (yellow, green, blue, orange)<br>- `formatQuoteForClipboard(selectedText, bookTitle, chapterTitle)`: Tạo trích dẫn chuẩn hóa theo mẫu văn bản<br>- `exportHighlightsToMarkdown(book, chapters, highlights)`: Tạo nội dung tệp Markdown trọn vẹn nhóm theo chương<br>- `applyHighlightsToContainer(container, highlights)`: Quét và chèn thẻ `<mark>` theo chỉ mục đoạn văn chính xác |
| [`sleepTimer.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/sleepTimer.js) | Phân hệ Hẹn giờ tắt đọc sách thông minh (Sleep Timer & Fade-out Engine). Hỗ trợ các mốc 15-60 phút, chế độ kết thúc theo chương, đếm ngược từng giây, phát hiện 30 giây cuối để kích hoạt thuật toán giảm dần âm lượng (Fade-out 1.0 $\rightarrow$ 0.0), dừng hoàn toàn TTS và âm thanh nền, khôi phục mức volume gốc. | - `class SleepTimer`: Lớp điều khiển hẹn giờ tắt và fade-out<br>- `SLEEP_TIMER_PRESETS`: Mảng các mốc hẹn giờ định sẵn (15m, 30m, 45m, 60m, chapter_end)<br>- `start(minutes, baseTtsVolume, baseAmbientVolume)`: Kích hoạt đếm ngược thời gian<br>- `setChapterEndMode()`: Chuyển sang chế độ dừng khi hết chương hiện tại<br>- `notifyChapterEnd()` / `notifySentenceProgress()`: Hook nhận tín hiệu hoàn thành chương từ TTS<br>- `cancel()`: Hủy hẹn giờ và khôi phục âm lượng ngay lập tức<br>- `tick()` / `expire()`: Xử lý bước đếm ngược và kích hoạt callback `onFade` và `onExpire` |
| [`ambientSound.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/ambientSound.js) | Phân hệ Bộ trộn âm thanh môi trường nền (Ambient White Noise Mixer). Ứng dụng Web Audio API tổng hợp âm thanh thủ tục (Procedural Synthesis) 4 nguồn âm thanh (Mưa rơi mái tôn, Suối chảy róc rách, Rừng trúc & Gió thổi, Lửa trại bập bùng) lặp vô tận không ngắt quãng (zero-gap loop crossfade), điều chỉnh âm lượng từng kênh và master volume. | - `class AmbientSoundMixer`: Động cơ tổng hợp và trộn âm thanh môi trường<br>- `AMBIENT_SOUND_PRESETS`: Danh mục 4 nguồn âm thanh môi trường<br>- `synthesizeRain()`, `synthesizeStream()`, `synthesizeBamboo()`, `synthesizeCampfire()`: Thuật toán lọc nhiễu hồng, nâu và mô phỏng giọt nước/tiếng củi nổ<br>- `applySeamlessCrossfade()`: Kỹ thuật hòa âm 200ms loại bỏ hoàn toàn tiếng click khi lặp lại buffer<br>- `toggleSound(soundId)` / `startSound()` / `stopSound()`: Điều khiển từng kênh âm thanh<br>- `setSoundVolume()` / `setMasterVolume()` / `setFadeFactor()`: Tinh chỉnh âm lượng và tiếp nhận tín hiệu fade-out<br>- `getState()` / `loadState()`: Đóng gói và khôi phục trạng thái bộ trộn từ IndexedDB |
| [`mediaSessionHelper.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/mediaSessionHelper.js) | Phân hệ Tích hợp Media Session API & Điều khiển qua phần cứng/tai nghe. Duy trì Silent Audio Track chạy ngầm giúp Web Speech API không bị hệ điều hành tắt khi khóa màn hình, đồng bộ metadata chương và ảnh bìa vector SVG lên Notification Center, đăng ký action handlers nhận phím bấm tai nghe Bluetooth. | - `class MediaSessionHelper`: Bộ điều hợp Media Session API<br>- `initSilentAudio()`: Khởi tạo audio element phát track WAV im lặng lặp vô tận<br>- `startBackgroundSession()` / `pauseBackgroundSession()` / `stopBackgroundSession()`: Duy trì session âm thanh nền cùng TTS<br>- `updateMetadata()`: Đồng bộ tên chương, tên tác phẩm, tác giả và ảnh bìa<br>- `generateDefaultCoverSvg()`: Sinh ảnh bìa vector SVG 512x512 hiển thị trên màn hình khóa<br>- `initActionHandlers()`: Đăng ký các sự kiện `play`, `pause`, `previoustrack`, `nexttrack`, `seekbackward`, `seekforward`, `stop` |
| [`tts.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/tts.js) | Cung cấp hệ thống TTS Đa nguồn (Multi-Engine TTS). Hỗ trợ Tầng 1 (Web Speech API với cơ chế polling chống sót Edge Neural voices, Voice Tuning Pitch & Rate, thuộc tính `volume` & phương thức `setVolume` hỗ trợ Fade-out) và Tầng 2 (Cloud AI BYOK FPT AI & OpenAI, IndexedDB Audio Caching, Bounded Queue Scheduler N+1/N+2, và Graceful Fallback). Tích hợp vòng đời phát âm an toàn: **Safe Auto-Next Chapter** với cờ `chapterSwitchLock`, không gọi `synth.cancel()` thừa khi chuyển câu tự nhiên, Asynchronous Handoff tách luồng GC/audio, Circuit Breaker ngắt an toàn sau 3 lỗi liên tiếp hoặc bão callback 60 chunks/giây, khóa hoàn tất đơn `isTerminalCompleted`, chống đệ quy trong `stop()`, dọn dẹp utterance, thu hồi Object URL 100% cân bằng và khoảng đệm GC (~1.5s–2s) chống rò rỉ bộ nhớ. | - `class TTSEngine`: Đóng gói logic Multi-Engine TTS<br>- `setVolume(volume)`: Tinh chỉnh âm lượng phát (0.0 - 1.0) phục vụ hiệu ứng Fade-out hẹn giờ ngủ<br>- `VIETNAMESE_VOICE_CATALOG` / `formatBrowserVoiceLabel()`: Danh mục định danh giọng tự nhiên & AI<br>- `initVoices()`: Polling kép chống sót giọng Edge Neural voices bất đồng bộ<br>- `setPitch(pitch)`: Tinh chỉnh cao độ giọng đọc (0.5x - 1.5x)<br>- `setEngine(engine)` / `setCloudConfig(config)`: Quản lý nguồn phát và thông số BYOK<br>- `speakCurrentChunk()` / `speakCloudChunk()` / `speakBrowserChunk()`: Phát âm thanh tương ứng với cache IndexedDB & fallback tự động<br>- `previewVoice()`: Phát câu đọc mẫu kiểm tra âm sắc<br>- `getPrefetchMetrics()` / `setPrefetchDebugMode()`: Truy xuất chỉ số hiệu năng nạp trước thời gian thực<br>- `splitIntoSmartChunks(text)` / `startKeepAlive()`: Chia câu thông minh và giữ kết nối Chromium |
| [`ttsQueueScheduler.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/ttsQueueScheduler.js) | Động cơ Bounded Queue Scheduler cho Cloud TTS Prefetching: kiểm soát cửa sổ trượt [N, N+2], thứ tự ưu tiên 1 > 2 > 3, giới hạn concurrency tối đa 1, gom cụm yêu cầu trùng lặp (Request Coalescing), kiểm tra cache-first và quản lý an toàn dung lượng RAM ($\le 15$MB). | - `class TTSQueueScheduler`: Bộ điều phối hàng đợi nạp trước<br>- `class QueueEntry`: Thực thể nhiệm vụ kèm AbortController và deferred promise<br>- `updateWindow({ currentIndex, chunks, config, rate })`: Cập nhật cửa sổ trượt [N, N+2]<br>- `requestChunk({ chunkIndex, text, config, rate })`: Yêu cầu chunk với Priority 1 kèm coalescing<br>- `getMetrics()` / `resetMetrics()` / `setDebugMode()`: Đo lường hiệu năng $O(1)$<br>- `buildCacheKey()` / `buildLegacyCacheKey()` / `hashText()`: Tạo khóa cache chuẩn hóa |
| [`cloudTtsProvider.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/cloudTtsProvider.js) | Bộ điều hợp HTTP cho các nhà cung cấp Cloud TTS (FPT AI, OpenAI TTS, Custom Endpoint): phân loại lỗi vĩnh viễn vs tạm thời, cơ chế thử lại có số mũ (exponential backoff), phản hồi hủy tức thì với `abortableSleep`, và xác thực định dạng nhị phân âm thanh. | - `class CloudTtsError`: Lớp lỗi tùy biến kèm cờ `isRetryable`<br>- `fetchCloudAudio()`: Bộ định tuyến yêu cầu theo provider<br>- `fetchOpenAiSpeech()`: Gọi API nhị phân OpenAI TTS<br>- `fetchFptSpeech()` / `downloadAudioWithRetry()`: Polling và tải âm thanh từ CDN FPT<br>- `classifyError()`: Phân loại mã lỗi HTTP (401, 403, 429, 5xx)<br>- `abortableSleep()`: Timer ngủ có khả năng ngắt ngay lập tức theo AbortSignal<br>- `sanitizeErrorMessage()`: Tẩy sạch API keys và tokens nhạy cảm khỏi log |
| [`app.js`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/app.js) | Bộ điều khiển UI kết nối Storage, Parser, TTS, Search, Bookmark, History và Reader modules. | - `openBook()` / `loadChapter()`: điều hướng sách/chương<br>- Analytics view: mở/đóng, yêu cầu một DashboardResult theo range và render<br>- History view: summaries, timeline theo trang, xóa session/history<br>- Bookmark Hub và Search: điều hướng/focus tạm<br>- TTS, progress, Auto-Scroll, Highlights/Quotes, Dictionary, Sleep Timer, Ambient Sound và Media Session |
| [`package.json`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/package.json) | Tệp cấu hình gói dự án npm, định nghĩa kiểu module (`"type": "module"`) và các lệnh thực thi Vite server. | - Scripts: `npm run dev` (chạy Vite server), `npm run build`, `npm run preview`<br>- DevDependencies: `vite` (^5.4.14) |
| [`sample-story.txt`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/sample-story.txt) | Tệp văn bản mẫu gồm 3 chương viết bằng tiếng Việt với cấu trúc chuẩn (`Chương 1: Khởi nguồn huyền thoại`, `Chương 2: Thử thách trong cổ động`, `Chương 3: Đại đạo vô song`). | Dùng để thử nghiệm nhanh bộ phân tách chương và tính năng nạp tự động của ứng dụng khi người dùng mở trang lần đầu. |
| [`test_parser.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_parser.mjs) | Kịch bản regression độc lập chạy trực tiếp trên Node.js (ESM), gồm 15 bài test thuật toán lõi, Multi-Engine TTS, Text Engine Pro, và Audiobook & Sleep Suite. | - Test 1–14: parser, TTS, cleaner, AutoScroll, highlights, sleep timer, ambient sound và Media Session<br>- Test 15: Safe Utterance Cleanup & Empty Chunk Defense |
| [`test_tts_reproduction.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_tts_reproduction.mjs) | Kiểm thử tái hiện và xác minh bản vá gốc TTS lifecycle, Edge Natural voice transitions, circuit breaker chống cascade error và chống stale callback. | 10 bài test tái hiện & phòng ngừa hồi quy TTS lõi |
| [`test_tts_interactions.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_tts_interactions.mjs) | Kiểm thử tích hợp TTS với các module phần cứng MediaSession, SleepTimer, AutoScroll và Reading History lifecycle. | 8 bài test tích hợp liên phân hệ TTS |
| [`test_tts_phase4_stability.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_tts_phase4_stability.mjs) | Bộ kiểm thử độ ổn định tất định (Deterministic Stability Suite) kiểm tra phát 3/10/25 câu liên tiếp, Lifecycle Races, Fault Injection, và Soak Test 50 câu kiểm soát rò rỉ bộ nhớ/listener/timers. | 22 bài test độ ổn định & an toàn tài nguyên TTS |
| [`test_search.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_search.mjs) | Tests search normalization, Unicode offset mapping, matching, snippets, limits and stale-query cancellation. | Node.js ESM targeted tests |
| [`test_search_index.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_search_index.mjs) | Tests Dexie schema, derived-cache behavior, invalidation/rebuild, corruption recovery, batching, progress and cancellation. | Fake Dexie/storage lifecycle tests |
| [`test_search_navigation.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_search_navigation.mjs) | Tests exact/stale logical anchors and search navigation/security contracts. | Node.js anchor and source-contract assertions |
| [`test_bookmark.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_bookmark.mjs) | Tests Bookmark CRUD, safe storage failures, v5 schema, dedup, book cleanup and backup restore compatibility/remapping. | Fake Dexie/storage lifecycle tests |
| [`test_bookmark_navigation.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_bookmark_navigation.mjs) | Tests valid/stale/degraded anchor resolution and navigation/TTS/progress/focus contracts. | Node.js anchor and source-contract assertions |
| [`test_bookmark_storage_errors.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_bookmark_storage_errors.mjs) | Tests failed IndexedDB open/migration handling and safe retry behavior. | Fake Dexie failure injection |
| [`test_reading_history.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_reading_history.mjs) | Tests session lifecycle, recovery, local-day/range aggregation, timeline, backup cleanup and bounded checkpoint/storage behavior. | Fake Dexie and deterministic clock |
| [`test_reading_history_integration.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_reading_history_integration.mjs) | Tests Reader/TTS/visibility/progress integration and UI source contracts. | Node.js integration/source assertions |
| [`test_reading_analytics.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_reading_analytics.mjs) | Tests core totals, local ranges, sanitation, active snapshot, midnight buckets and period comparisons. | Deterministic session fixtures |
| [`test_reading_insights.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_reading_insights.mjs) | Tests weighted consumption speed, hourly overlap, preferred window, weekday activity, Top Books and Best Day. | Deterministic session fixtures |
| [`test_reading_analytics_trends.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_reading_analytics_trends.mjs) | Tests 365-day heatmap, local calendar, intensity, streak, trend and comparison boundaries. | Deterministic local-date fixtures |
| [`test_reading_analytics_dashboard.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_reading_analytics_dashboard.mjs) | Tests dashboard result shape, daily layout, derived sections and single session/snapshot/catalog load. | Deterministic session fixtures |
| [`test_session_lifecycle_contracts.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_session_lifecycle_contracts.mjs) | Kiểm thử toàn diện hợp đồng vòng đời Unified Session: máy trạng thái (idle, reading, listening, both, paused, ended), định danh session đơn nhất, bất biến thời gian active >= tts, đọc và nghe đồng thời không cộng dồn, và khử trùng lặp hoàn tất chương. | 10 bài test hợp đồng cốt lõi |
| [`test_session_persistence_recovery.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_session_persistence_recovery.mjs) | Kiểm thử lưu vết và phục hồi phiên: chu kỳ checkpoint 15s, chính sách nhàn rỗi 60s, chính sách phân tách 30m, khôi phục crash an toàn không tạo thời gian giả, thay đổi đồng hồ hệ thống và cách ly lỗi lưu trữ. | 11 bài test persistence & recovery |
| [`test_reader_lifecycle_navigation.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_reader_lifecycle_navigation.mjs) | Kiểm thử tích hợp Reader với Session Engine: phân định độc lập scrollY vs currentChunkIndex, chuyển sách/chương an toàn, điều hướng TOC/Search/Bookmark không sinh tiến độ giả, và chống bão ghi cuộn trang. | 9 bài test Reader lifecycle & progress |
| [`test_tts_session_integration.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_tts_session_integration.mjs) | Kiểm thử tích hợp TTS với Unified Session: quyền sở hữu phát âm thanh của TTSEngine, luồng sự kiện 1 chiều không vòng lặp, cô lập voice preview, tự động chuyển chương an toàn và graceful fallback. | 10 bài test tích hợp TTS playback |
| [`test_phase6_integration.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_phase6_integration.mjs) | Kiểm thử tích hợp các phân hệ điều khiển: AutoScroll (Hands-Free vs TTS-follow), Sleep Timer (đếm ngược, fade-out 30s, kết thúc phiên sạch sẽ), Media Session (silent audio track nền, hardware keys) và Ambient Sound độc lập. | 14 bài test auxiliary integrations |
| [`test_phase7_compatibility.mjs`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/test_phase7_compatibility.mjs) | Kiểm thử tương thích dữ liệu và số liệu: Single Source of Truth `readingSessions`, tính toán Analytics hoàn toàn chỉ đọc, tương thích Dexie schema v6 và tệp sao lưu JSON v5. | 8 bài test compatibility & data truth |
| [`README.md`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/README.md) | Tài liệu kỹ thuật chính thức của toàn bộ hệ thống, mô tả tổng quan, tính năng, cây thư mục, bảng chi tiết từng file và hướng dẫn khởi chạy. | Tài liệu tổng thể dành cho nhà phát triển và người dùng. |
| [`CHANGELOG.md`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/CHANGELOG.md) | Tệp lưu vết lịch sử cập nhật phiên bản phần mềm DUY NHẤT theo chuẩn "Keep a Changelog", ghi nhận chi tiết các thay đổi Added, Changed, Fixed qua từng phiên bản (v1.0.0 đến phiên bản mới nhất). | Đảm bảo khả năng bảo trì và truy nguyên lịch sử phát triển của dự án. Tuyệt đối không sử dụng `change.md`. |

---

## 5. Hướng Dẫn Cài Đặt & Khởi Chạy (Local Setup & Usage)

Ứng dụng được thiết kế hoàn toàn theo tiêu chuẩn **Vanilla Web Client-Side** và **ES Modules**. Bạn có thể lựa chọn 1 trong các phương thức sau để chạy ứng dụng:

### Cách 1: Khởi chạy bằng Vite Dev Server (Khuyên Dùng)
Vite mang lại trải nghiệm phát triển tối ưu với khả năng tải module tức thì:
1. Mở cửa sổ dòng lệnh (Terminal/PowerShell) tại thư mục dự án:
   ```bash
   cd c:\Users\hoang\.gemini\antigravity-ide\scratch\personal-reader
   ```
2. Cài đặt các gói phụ thuộc (nếu chưa cài):
   ```bash
   npm install
   ```
3. Chạy máy chủ phát triển cục bộ:
   ```bash
   npm run dev
   ```
4. Mở trình duyệt và truy cập vào địa chỉ cục bộ được hiển thị (thường là `http://localhost:5173/`).

---

### Cách 2: Khởi chạy bằng Live Server (VS Code Extension)
1. Mở thư mục `c:\Users\hoang\.gemini\antigravity-ide\scratch\personal-reader` trong Visual Studio Code.
2. Cài đặt tiện ích mở rộng **Live Server** (nếu chưa có).
3. Nhấp chuột phải vào file [`index.html`](file:///c:/Users/hoang/.gemini/antigravity-ide/scratch/personal-reader/index.html) và chọn **"Open with Live Server"**. Trang web sẽ tự động mở tại địa chỉ `http://127.0.0.1:5500/index.html`.

---

### Cách 3: Khởi chạy nhanh bằng Python HTTP Server hoặc npx serve
Nếu máy tính của bạn đã cài sẵn Python hoặc Node.js:
- **Sử dụng lệnh Python:**
  ```bash
  python -m http.server 8080
  ```
  Sau đó truy cập `http://localhost:8080/`.

- **Sử dụng lệnh npx serve:**
  ```bash
  npx serve .
  ```
  Sau đó truy cập địa chỉ cổng được cung cấp trên màn hình.

> [!NOTE]
> **Lưu ý về giao thức HTTP vs `file://`:**
> Do ứng dụng sử dụng tiêu chuẩn JavaScript ES Modules (`import`/`export`) và Web Workers cho `pdfjsLib`, trình duyệt sẽ chặn việc nạp module khi mở trực tiếp file qua giao thức `file:///index.html` vì chính sách bảo mật CORS. Do đó, **bắt buộc phải chạy ứng dụng thông qua một máy chủ web cục bộ** (như Vite, Live Server hoặc Python HTTP Server) như hướng dẫn ở trên.

---

## 6. Chạy Kiểm Thử Tự Động (Unit Testing)

Chạy toàn bộ regression tests mục tiêu theo từng module, rồi production build (cần cài dev dependency `vite`):

```bash
# Bộ kiểm thử Cloud TTS Bounded Queue & Prefetch Engine (Phase 1–7)
node --test test_cloud_tts_safety_baseline.mjs
node --test test_tts_queue_scheduler.mjs
node --test test_cloud_tts_cache_integrity.mjs
node --test test_cloud_tts_provider_contracts.mjs
node --test test_cloud_playback_integration.mjs
node --test test_reader_cloud_prefetch_observability.mjs
node --test test_cloud_prefetch_stress_soak.mjs

# Bộ kiểm thử nghiệm thu Unified Session Engine (Phase 1–7)
node test_session_lifecycle_contracts.mjs
node test_session_persistence_recovery.mjs
node test_reader_lifecycle_navigation.mjs
node test_tts_session_integration.mjs
node test_phase6_integration.mjs
node test_phase7_compatibility.mjs

# Bộ kiểm thử TTS, Bookmark, Search, History & Analytics
node --test test_phase1_tts_stutter_lifecycle_diagnosis.mjs
node --test test_phase2_controlled_isolation.mjs
node --test test_phase3_root_cause_repair_and_silent_playback_fix.mjs
node --test test_phase4_cross_module_regression.mjs
node --test test_tts_diagnostics_baseline.mjs
node --test test_tts_phase3_root_cause_verification.mjs
node --test test_tts_phase4_cross_module_safety.mjs
node --test test_tts_phase5_final_acceptance.mjs
node test_parser.mjs
node --test test_tts_root_cause_fix.mjs
node --test test_tts_reproduction.mjs
node --test test_tts_interactions.mjs
node --test test_tts_phase4_stability.mjs
node test_bookmark.mjs
node test_bookmark_navigation.mjs
node test_bookmark_storage_errors.mjs
node test_search.mjs
node test_search_index.mjs
node test_search_navigation.mjs
node test_reading_history.mjs
node test_reading_history_integration.mjs
node test_reading_analytics.mjs
node test_reading_insights.mjs
node test_reading_analytics_trends.mjs
node test_reading_analytics_dashboard.mjs

# Production bundle build
npm run build
```

- `test_cloud_tts_safety_baseline.mjs` kiểm tra 5 ca an toàn cốt lõi của Cloud TTS: vòng đời HTMLAudioElement, thu hồi Object URL khi dừng hoặc hoàn thành, triệt tiêu fallback trùng lặp khi có lỗi sau `ended`, xử lý từ chối user gesture, và cách ly voice preview.
- `test_tts_queue_scheduler.mjs` kiểm tra 12 ca động cơ scheduler: ưu tiên Priority 1 > 2 > 3, giới hạn cửa sổ trượt [N, N+2], kiểm soát concurrency tối đa 1 (hoặc cấu hình), hợp nhất yêu cầu trùng lặp (Request Coalescing), xử lý out-of-order, điều chuyển cửa sổ khi Seek, hủy thế hệ cũ khi Invalidate, giới hạn bộ nhớ RAM $\le 15$MB và triệt tiêu vòng lặp scheduler lặp.
- `test_cloud_tts_cache_integrity.mjs` kiểm tra 9 ca toàn vẹn cache: pipeline Cache-First tra cứu trước không tốn mạng, canonical cache key theo rate/model/voice/hash, tương thích ngược legacy keys schema v2/v6, loại trừ audio blob hỏng/quá nhỏ ($< 100$ bytes) hoặc trang phản hồi lỗi HTML/JSON từ CDN.
- `test_cloud_tts_provider_contracts.mjs` kiểm tra 12 ca hợp đồng nhà cung cấp: FPT AI polling CDN, OpenAI binary stream, Custom endpoints, phân loại lỗi vĩnh viễn (401/403/429 quota) vs tạm thời (5xx, rate limit), chính sách thử lại 2 lần có backoff, phản hồi hủy tức thì `abortableSleep` (0ms), và tẩy sạch API key khỏi log.
- `test_cloud_playback_integration.mjs` kiểm tra 10 ca tích hợp playback liên tục: phát tuần tự 3/10/25 chunks, bàn giao tức thì từ ready prefetch, theo dõi và thu hồi 100% Object URLs, Seek/Pause/Resume, và kiểm soát late response sau thế hệ mới.
- `test_reader_cloud_prefetch_observability.mjs` kiểm tra 6 ca tích hợp Reader và giám sát hiệu năng: nạp trước chạy ngầm tuyệt đối không thay đổi tiến độ đọc, không tăng Listening Time, không ghi nhầm History/Analytics; thu thập chỉ số $O(1)$ (`getPrefetchMetrics()`, gap latency, cache/prefetch hits); Sleep Timer fade-out/expire và Media Session.
- `test_cloud_prefetch_stress_soak.mjs` kiểm tra bộ stress và soak test với 6 kịch bản gắt gao: Soak test 50 chunks liên tục có nhịp điệu kiểm soát rò rỉ RAM và thu hồi 100% Object URLs; Cầu chì vận tốc ngắt tức thì khi có bão callback 0ms (60 chunks/giây); Bão Seek 50 lần ngẫu nhiên hủy sạch fetch đang bay; 30 chu kỳ Play/Stop lặp lại không tích lũy tài nguyên; Fault Injection lỗi mạng 500 suy thoái sạch sẽ sang browser TTS; và Out-of-order cache/network hoàn tất an toàn.

- `test_tts_root_cause_fix.mjs` kiểm tra 11 ca nghiệm thu root cause fix: chuỗi phát 0→1→2→...→10 với đúng 1 terminal handling per utterance, triệt tiêu onend lặp và cancel() đệ quy, cô lập onerror+onend, triệt tiêu timer khi Stop/Pause, cô lập stale callback, bỏ qua chunk rỗng an toàn, cô lập nhịp Keep-Alive khi chuyển câu, và ngắt tức thì bằng Chunk Velocity Circuit Breaker khi có bão callback 0ms.
- **Kiểm thử thực tế trên Microsoft Edge (CDP Test Harness):** Đã kiểm thử tự động trực tiếp trên tiến trình Microsoft Edge thật thông qua Chrome DevTools Protocol (CDP), xác minh trọn vẹn 10 bước playback (Mở truyện, Play, Chunks 0→1→2→3, 10 chunks liên tục, Pause, Resume, Stop, Phát lại từ vị trí lưu, Next/Prev/Seek, và Chuyển chương). Bộ nhớ JS Heap được đo lường chính xác, duy trì phẳng ở mức 8–9 MB không rò rỉ RAM.
- `test_session_lifecycle_contracts.mjs` kiểm tra 10 ca hợp đồng vòng đời: máy trạng thái (idle, reading, listening, both, paused, ended), định danh phiên đơn nhất, bất biến thời gian active >= tts, đọc và nghe đồng thời không cộng dồn, và khử trùng lặp hoàn tất chương.
- `test_session_persistence_recovery.mjs` kiểm tra 11 ca lưu trữ và phục hồi: chu kỳ checkpoint 15s, chính sách nhàn rỗi 60s, chính sách phân tách 30m, khôi phục crash an toàn không tạo thời gian giả, thay đổi đồng hồ hệ thống và cách ly lỗi lưu trữ.
- `test_reader_lifecycle_navigation.mjs` kiểm tra 9 ca Reader lifecycle: phân định độc lập scrollY vs currentChunkIndex, chuyển sách/chương an toàn, điều hướng TOC/Search/Bookmark không sinh tiến độ giả, và chống bão ghi cuộn trang.
- `test_tts_session_integration.mjs` kiểm tra 10 ca tích hợp TTS: quyền sở hữu phát âm thanh của TTSEngine, luồng sự kiện 1 chiều không vòng lặp, cô lập voice preview, tự động chuyển chương an toàn và graceful fallback.
- `test_phase6_integration.mjs` kiểm tra 14 ca tích hợp phân hệ điều khiển: AutoScroll (Hands-Free vs TTS-follow), Sleep Timer (đếm ngược, fade-out 30s, kết thúc phiên sạch sẽ), Media Session (silent audio track nền, hardware keys) và Ambient Sound độc lập.
- `test_phase7_compatibility.mjs` kiểm tra 8 ca tương thích dữ liệu: Single Source of Truth `readingSessions`, tính toán Analytics hoàn toàn chỉ đọc, tương thích Dexie schema v6 và tệp sao lưu JSON v5.
- `test_tts_reproduction.mjs` kiểm tra 10 ca kiểm thử hồi quy: chuyển câu tự nhiên 1 -> 2 -> 3 không gọi `synth.cancel()` thừa, chặn đúp sự kiện `onend`/`onerror`, hủy timer khi Stop/Pause, và Circuit Breaker ngắt an toàn tại 3 lỗi liên tiếp chống cascade storm.
- `test_tts_interactions.mjs` kiểm tra 8 ca tích hợp: điều hướng câu khi pause, vô hiệu hóa Cloud request khi Stop, khôi phục session sau voice preview, tích hợp Media Session tai nghe, Sleep Timer kết thúc chương, và hủy đồng bộ AutoScroll/TTS.
- `test_tts_phase4_stability.mjs` kiểm tra 22 ca độ ổn định tất định: Normal Playback 3/10/25 chunks không đệ quy callback, Lifecycle Races (Rapid play/pause, seek while playing/paused, voice change, stale callback), Fault Injection (duplicate onend, synchronous cancel onend, empty/malformed chunks, cloud fallback), và Soak Test 50 chunks dọn dẹp sạch 100% listeners và timers.
- `test_bookmark.mjs` kiểm tra schema v5, CRUD, dedup, anchor resolver, capture mắt/TTS, delete-book cleanup, export/import, backup cũ, ID remap và từ chối backup có bookmark mồ côi/malformed mà không xóa dữ liệu đang có.
- `test_bookmark_navigation.mjs` kiểm tra valid/stale/degraded anchor và contract điều hướng: chờ `openBook()`/`loadChapter()`, tối ưu cùng chương, giữ TTS pointer/progress writer riêng, AutoScroll pause, Search lock và focus tạm.
- `test_bookmark_storage_errors.mjs` kiểm tra Dexie open/migration failure không làm service ném lỗi ra Reader và lần gọi sau có thể thử mở DB lại.
- `test_search.mjs` kiểm tra normalization (dấu/không dấu, `đ/d`, case, combining marks), offset Unicode, snippets, phrase/single-word, nhiều match và hủy query cũ.
- `test_search_index.mjs` kiểm tra Dexie schema v4 search index, backup không chứa derived index, add/delete/import/restore, dictionary invalidation, stale/corrupt entry, orphan cleanup, batching/progress, cancellation và query tránh đọc source của chapter không candidate.
- `test_search_navigation.mjs` kiểm tra Search result metadata → anchor, fallback theo context khi paragraph đổi, match không còn, safe snippet source contract và navigation/TTS/progress integration contracts.
- `test_reading_history.mjs` kiểm tra session start/end/recovery, idle grace, TTS/active metrics, local-day/DST aggregation, chapter completion, backup v5 compatibility/remapping, deletion cascade, checkpoint cadence, timer cleanup và indexed latest-N reads.
- `test_reading_history_integration.mjs` kiểm tra Reader/TTS/visibility/progress hooks cùng History UI/timeline contracts và giới hạn ghi theo checkpoint.
- `test_reading_analytics.mjs` kiểm tra lifetime/range totals, local-day boundaries, session snapshot dedup, midnight allocation, malformed rows và comparison zero/equal cases.
- `test_reading_insights.mjs` kiểm tra weighted consumption speed/filter, hourly overlap qua giờ và midnight, preferred window sample, weekday tie, Top Books, missing book và Best Day.
- `test_reading_analytics_trends.mjs` kiểm tra 365-day local heatmap, intensity thresholds, leap/year boundary, streak threshold/grace/gaps, zero-filled trends và period comparisons.
- `test_reading_analytics_dashboard.mjs` kiểm tra dashboard model, heatmap week/month layout, 7/30-day trends và contract chỉ tải sessions/snapshot/book catalog một lần.
- `test_parser.mjs` là regression suite cho parser, cleaner, saved highlights, TTS, auto-scroll, sleep timer, ambient audio và media session.

Browser-driven interaction tests chưa được thiết lập trong project; các contract UI được kiểm tra bằng targeted source assertions.
