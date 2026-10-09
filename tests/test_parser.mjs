import assert from 'node:assert/strict';
import { splitTextIntoChapters, isChapterHeading, countWords } from './parser.js';
import { TTSEngine } from './tts.js';

console.log('--- ĐANG KIỂM TRA BỘ BÓC TÁCH PARSER & CHIA CHƯƠNG ---');

// Test 1: Chapter heading regex detection
assert.equal(isChapterHeading('Chương 1: Khởi đầu'), true, 'Phải nhận diện Chương 1');
assert.equal(isChapterHeading('Chương 10 - Đại chiến'), true, 'Phải nhận diện Chương 10');
assert.equal(isChapterHeading('Hồi thứ nhất: Kết nghĩa đào viên'), true, 'Phải nhận diện Hồi thứ nhất');
assert.equal(isChapterHeading('Chapter 5: The Beginning'), true, 'Phải nhận diện Chapter 5');
assert.equal(isChapterHeading('Hôm nay trời rất đẹp và chúng tôi đi chơi.'), false, 'Câu bình thường không phải chapter heading');
console.log('✓ Test 1: Regex nhận diện tiêu đề chương PASS');

// Test 2: Smart chapter splitting on formatted text
const sampleText = `
Lời tựa: Đây là phần giới thiệu tác phẩm.

Chương 1: Buổi sáng mùa hạ
Trời trong xanh và mát mẻ. Những tia nắng đầu ngày chiếu qua kẽ lá.

Chương 2: Lên đường
Họ chuẩn bị hành trang và bắt đầu chuyến phiêu lưu.
`;

const chapters = splitTextIntoChapters(sampleText, 'Truyện Mẫu');
assert.equal(chapters.length, 3, 'Phải phân tách đúng 3 phần: Giới thiệu + Chương 1 + Chương 2');
assert.equal(chapters[0].title, 'Mở đầu / Giới thiệu');
assert.equal(chapters[1].title, 'Chương 1: Buổi sáng mùa hạ');
assert.equal(chapters[2].title, 'Chương 2: Lên đường');
console.log('✓ Test 2: Phân tách chương có tiêu đề PASS');

// Test 3: Fallback word chunking when no chapter headings are present
const hugeParagraph = ('Đây là một đoạn văn dài mô tả phong cảnh đất nước Việt Nam tuyệt đẹp. '.repeat(100) + '\n\n').repeat(35);
const fallbackChapters = splitTextIntoChapters(hugeParagraph, 'Văn Bản Thô');
assert.ok(fallbackChapters.length > 1, 'Phải tự động chia nhỏ thành nhiều phần khi văn bản dài không có tiêu đề');
console.log(`✓ Test 3: Fallback chia đều theo số lượng từ PASS (${fallbackChapters.length} phần)`);

// Test 4: TTS Sentence Chunking
// Stub window.speechSynthesis for Node test environment
globalThis.window = {
  speechSynthesis: {
    getVoices: () => [],
    onvoiceschanged: null,
    speak: () => {},
    cancel: () => {},
    pause: () => {},
    resume: () => {}
  }
};

const tts = new TTSEngine();
const textToChunk = 'Tôi tên là Dế Mèn! Cuộc đời tôi rất thú vị, bạn có muốn nghe không? Hãy cùng lắng nghe nhé.';
const ttsChunks = tts.splitIntoSmartChunks(textToChunk);
assert.equal(ttsChunks.length, 3, 'Phải tách đúng 3 câu kết thúc bằng !, ? và .');
console.log('✓ Test 4: TTS Smart Sentence Chunking PASS');

// Test 5: Voice label formatting & Neural Voice identification
import { formatBrowserVoiceLabel, VIETNAMESE_VOICE_CATALOG } from './tts.js';
const hoaiMyLabel = formatBrowserVoiceLabel({ name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)' });
assert.ok(hoaiMyLabel.includes('Hoài My'), 'Phải nhận diện Microsoft HoaiMy');
assert.ok(hoaiMyLabel.includes('Bắc'), 'Phải gắn nhãn giọng Bắc');

const namLabel = formatBrowserVoiceLabel({ name: 'Microsoft Nam Online (Natural) - Vietnamese (Vietnam)' });
assert.ok(namLabel.includes('Nam'), 'Phải nhận diện Microsoft Nam');

const googleLabel = formatBrowserVoiceLabel({ name: 'Google tiếng Việt' });
assert.ok(googleLabel.includes('Google'), 'Phải nhận diện Google Tiếng Việt');
console.log('✓ Test 5: Voice Label Formatting & Neural Voice Detection PASS');

// Test 6: Multi-Voice Engine Pitch & Rate limits
tts.setPitch(2.0);
assert.equal(tts.pitch, 1.5, 'Pitch không được vượt quá 1.5');
tts.setPitch(0.2);
assert.equal(tts.pitch, 0.5, 'Pitch không được thấp hơn 0.5');
tts.setPitch(1.1);
assert.equal(tts.pitch, 1.1, 'Pitch 1.1 hợp lệ');

tts.setRate(3.0);
assert.equal(tts.rate, 2.2, 'Rate không được vượt quá 2.2');
tts.setRate(0.3);
assert.equal(tts.rate, 0.7, 'Rate không được thấp hơn 0.7');
console.log('✓ Test 6: Voice Tuning (Pitch & Rate clamp) PASS');

// Test 7: Cloud AI Catalog & BYOK Configuration
assert.ok(VIETNAMESE_VOICE_CATALOG.cloud.length >= 8, 'Catalog phải có ít nhất 8 giọng Cloud AI');
const fptBanMai = VIETNAMESE_VOICE_CATALOG.cloud.find(v => v.id === 'fpt:banmai');
assert.ok(fptBanMai, 'Phải có giọng FPT Ban Mai');
assert.equal(fptBanMai.region, 'Bắc');

tts.setEngine('cloud');
assert.equal(tts.engine, 'cloud');
tts.setCloudConfig({ provider: 'fpt', apiKey: 'test-key', voice: 'banmai' });
assert.equal(tts.cloudConfig.apiKey, 'test-key');
assert.equal(tts.cloudConfig.voice, 'banmai');
console.log('✓ Test 7: Cloud AI BYOK Catalog & Engine Configuration PASS');

// Test 8: Playback Speed Selector Synchronization Logic
const testRateSync = (rate, options) => {
  const numRate = parseFloat(rate) || 1.0;
  let selectedIdx = -1;
  for (let i = 0; i < options.length; i++) {
    if (Math.abs(parseFloat(options[i].value) - numRate) < 0.04) {
      selectedIdx = i;
      break;
    }
  }
  return selectedIdx;
};

const standardSpeedOptions = [
  { value: '0.75', text: '0.75x' },
  { value: '0.9', text: '0.9x' },
  { value: '1.0', text: '1.0x (Chuẩn)' },
  { value: '1.1', text: '1.1x' },
  { value: '1.25', text: '1.25x' },
  { value: '1.5', text: '1.5x' },
  { value: '1.75', text: '1.75x' },
  { value: '2.0', text: '2.0x' }
];

// Test 8: Playback Speed Selector Synchronization Logic
assert.equal(testRateSync(1, standardSpeedOptions), 2, 'Số 1 phải khớp với option 1.0 (index 2)');
assert.equal(testRateSync(1.0, standardSpeedOptions), 2, 'Số 1.0 phải khớp với option 1.0 (index 2)');
assert.equal(testRateSync('1.0', standardSpeedOptions), 2, 'Chuỗi "1.0" phải khớp index 2');
assert.equal(testRateSync(1.25, standardSpeedOptions), 4, '1.25 phải khớp index 4');
assert.equal(testRateSync(0.75, standardSpeedOptions), 0, '0.75 phải khớp index 0');
assert.equal(testRateSync(2.0, standardSpeedOptions), 7, '2.0 phải khớp index 7');
console.log('✓ Test 8: Playback Speed Selector Sync & Matching PASS');

// --- TEXT ENGINE PRO MODULE TESTS ---
console.log('\n--- ĐANG KIỂM TRA MODULE TEXT ENGINE PRO ---');

// Test 9: Text Filter & Replacement Engine (cleaner.js)
import { cleanGarbageText, applyCustomRules, cleanChapterText, validateRules } from './cleaner.js';

const rawJunkText = `
Chương 1: Bắt đầu
Được đăng tải tại https://truyenhay.vn/chuong-1
Ủng hộ converter: Momo 0987654321, Donate để đọc chương sớm nhất!
Truyện truyenfull.com rất hay.




Hắn ta là đệ tử ngoại môn của Huyền Thiên Tông.
`;

const cleanedGarbage = cleanGarbageText(rawJunkText);
assert.ok(!cleanedGarbage.includes('https://truyenhay.vn'), 'Phải xóa URL web');
assert.ok(!cleanedGarbage.includes('Momo 0987654321'), 'Phải xóa thông tin donate');
assert.ok(!cleanedGarbage.includes('truyenfull.com'), 'Phải xóa tên miền cào truyện');
assert.ok(!cleanedGarbage.includes('\n\n\n'), 'Phải gộp các dòng trống liên tiếp');
assert.ok(cleanedGarbage.includes('Hắn ta là đệ tử'), 'Phải bảo tồn nội dung chính');

// Test Custom Rules in cleaner
const sampleStoryText = 'Lão tử không phục! Ta muốn tu luyện thành tiên.';
const rules = [
  { findText: 'Lão tử', replaceText: 'Tôi', isCaseSensitive: true, isRegex: false, isEnabled: true },
  { findText: 'Ta', replaceText: 'mình', isCaseSensitive: false, isRegex: false, isEnabled: true },
  { findText: 'không phục', replaceText: 'đồng ý', isEnabled: false } // Disabled rule
];
const replaced = applyCustomRules(sampleStoryText, rules);
assert.equal(replaced, 'Tôi không phục! mình muốn tu luyện thành tiên.', 'Phải thay thế đúng quy tắc và bỏ qua quy tắc tắt');

// Test validateRules
const validList = validateRules([{ findText: 'ngươi', replaceText: 'bạn' }]);
assert.equal(validList.length, 1);
assert.equal(validList[0].findText, 'ngươi');
console.log('✓ Test 9: Text Filter & Custom Dictionary Engine PASS');

// Test 10: Auto-Scroll Engine (autoscroll.js)
import { AutoScrollEngine } from './autoscroll.js';

// Setup minimal fake window for node test environment if needed
if (!globalThis.window.requestAnimationFrame) {
  globalThis.window.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  globalThis.window.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.window.scrollBy = () => {};
}

const autoScroll = new AutoScrollEngine({ speed: 45 });
assert.equal(autoScroll.speed, 45, 'Tốc độ ban đầu phải là 45px/s');

// Clamping limits
autoScroll.setSpeed(250);
assert.equal(autoScroll.speed, 150, 'Tốc độ không được vượt quá 150px/s');
autoScroll.setSpeed(5);
assert.equal(autoScroll.speed, 10, 'Tốc độ không được nhỏ hơn 10px/s');

autoScroll.increaseSpeed(15);
assert.equal(autoScroll.speed, 25, 'Tăng tốc độ +15 phải ra 25px/s');
autoScroll.decreaseSpeed(10);
assert.equal(autoScroll.speed, 15, 'Giảm tốc độ -10 phải ra 15px/s');

autoScroll.start();
assert.equal(autoScroll.isActive, true, 'Engine phải ở trạng thái active');
autoScroll.pauseTemporary(500);
assert.equal(autoScroll.isPaused, true, 'Smart pause phải kích hoạt trạng thái isPaused = true');
autoScroll.stop();
assert.equal(autoScroll.isActive, false, 'Dừng engine phải chuyển isActive = false');
console.log('✓ Test 10: Hands-Free Auto-Scroll Engine & Smart Pause PASS');

// Test 11: Text Highlight & Quote Formatter (highlight.js)
import { formatQuoteForClipboard, exportHighlightsToMarkdown, HIGHLIGHT_COLORS } from './highlight.js';

assert.ok(HIGHLIGHT_COLORS.yellow && HIGHLIGHT_COLORS.green && HIGHLIGHT_COLORS.blue && HIGHLIGHT_COLORS.orange, 'Bảng màu phải có đủ 4 màu');

const sampleQuote = 'Có công mài sắt có ngày nên kim.';
const clipboardText = formatQuoteForClipboard(sampleQuote, 'Dế Mèn', 'Chương 1: Mở Đầu');
assert.ok(clipboardText.includes('> "Có công mài sắt có ngày nên kim."'), 'Trích dẫn phải bọc trong blockquote');
assert.ok(clipboardText.includes('— Trích: Dế Mèn | Chương 1: Mở Đầu'), 'Phải có nguồn trích chuẩn định dạng');

const highlightsData = [
  { id: 1, chapterIndex: 0, selectedText: 'Đoạn trích thứ nhất', noteText: 'Ý kiến cá nhân 1', color: 'yellow', createdAt: 1700000000000 }
];
const markdownOutput = exportHighlightsToMarkdown('Dế Mèn', 'Tô Hoài', highlightsData, [{ chapterIndex: 0, title: 'Chương 1' }]);
assert.ok(markdownOutput.includes('# 📖 Trích Dẫn & Ghi Chú: Dế Mèn'), 'Markdown phải có tiêu đề sách');
assert.ok(markdownOutput.includes('Tô Hoài'), 'Markdown phải có tác giả');
assert.ok(markdownOutput.includes('Ý kiến cá nhân 1'), 'Markdown phải chứa ghi chú cá nhân');
console.log('✓ Test 11: Text Highlight & Quote Formatter (Markdown / Obsidian) PASS');

// --- AUDIOBOOK & SLEEP SUITE TESTS ---
console.log('\n--- ĐANG KIỂM TRA MODULE AUDIOBOOK & SLEEP SUITE ---');

// Test 12: Sleep Timer & 30s Fade-out Engine (sleepTimer.js)
import { SleepTimer, SLEEP_TIMER_PRESETS } from './sleepTimer.js';

assert.equal(SLEEP_TIMER_PRESETS.length, 5, 'Phải có 5 tùy chọn hẹn giờ preset');
const timer = new SleepTimer({ fadeDuration: 30 });

// Test minute countdown formatting
timer.start(15);
assert.equal(timer.mode, 'time');
assert.equal(timer.remainingSeconds, 900);
assert.equal(timer.getFormattedTime(), '15:00');

// Test 30-second fade calculation
timer.remainingSeconds = 25;
let reportedFade = -1;
timer.onFade = (ratio) => { reportedFade = ratio; };
timer.tick();
assert.equal(timer.isFading, true, 'isFading phải là true khi <= 30s');
assert.ok(reportedFade > 0 && reportedFade <= 1.0, 'Fade ratio phải nằm trong khoảng (0, 1]');
assert.equal(Math.round(reportedFade * 100), Math.round((24 / 30) * 100), 'Tỷ lệ fade phải giảm đúng 24/30');

// Test Chapter-end mode
let chapterEndExpired = false;
timer.onExpire = ({ reason }) => { if (reason === 'chapter_end') chapterEndExpired = true; };
timer.setChapterEndMode();
assert.equal(timer.mode, 'chapter_end');
assert.equal(timer.getFormattedTime(), 'Hết chương');
timer.notifyChapterEnd();
assert.equal(chapterEndExpired, true, 'notifyChapterEnd phải kết thúc hẹn giờ thành công');

// Test Cancel
timer.start(30);
timer.cancel();
assert.equal(timer.mode, null);
assert.equal(timer.remainingSeconds, 0);
console.log('✓ Test 12: Sleep Timer & 30s Fade-out Engine PASS');

// Test 13: Ambient White Noise Mixer (ambientSound.js)
import { AmbientSoundMixer, AMBIENT_SOUND_PRESETS } from './ambientSound.js';

assert.equal(AMBIENT_SOUND_PRESETS.length, 4, 'Phải có đủ 4 nguồn âm thanh môi trường');
assert.ok(AMBIENT_SOUND_PRESETS.some(p => p.id === 'rain'), 'Phải có tiếng mưa');
assert.ok(AMBIENT_SOUND_PRESETS.some(p => p.id === 'stream'), 'Phải có tiếng suối');
assert.ok(AMBIENT_SOUND_PRESETS.some(p => p.id === 'bamboo'), 'Phải có tiếng rừng trúc');
assert.ok(AMBIENT_SOUND_PRESETS.some(p => p.id === 'campfire'), 'Phải có tiếng lửa trại');

const mixer = new AmbientSoundMixer({ masterVolume: 0.8 });
assert.equal(mixer.masterVolume, 0.8);

// Test track volume adjustments and clamping
mixer.setSoundVolume('rain', 0.25);
assert.equal(mixer.tracks.get('rain').volume, 0.25);
mixer.setSoundVolume('rain', 1.8);
assert.equal(mixer.tracks.get('rain').volume, 1.0, 'Volume không được vượt quá 1.0');
mixer.setSoundVolume('rain', -0.5);
assert.equal(mixer.tracks.get('rain').volume, 0.0, 'Volume không được nhỏ hơn 0.0');

// Test FadeFactor calculation
mixer.setFadeFactor(0.5);
assert.equal(mixer.fadeFactor, 0.5);

// Test State Serialization & Loading
const savedState = mixer.getState();
assert.ok(savedState.sounds && savedState.sounds.rain, 'Phải serialize được track states');
mixer.loadState({ masterVolume: 0.9, sounds: { rain: { volume: 0.35 } } });
assert.equal(mixer.masterVolume, 0.9);
assert.equal(mixer.tracks.get('rain').volume, 0.35);
console.log('✓ Test 13: Ambient White Noise Mixer PASS');

// Test 14: MediaSession Helper & Background Audio (mediaSessionHelper.js)
import { MediaSessionHelper } from './mediaSessionHelper.js';

const mediaHelper = new MediaSessionHelper();
assert.ok(mediaHelper, 'MediaSessionHelper phải khởi tạo thành công');

// Test vector cover SVG generation
const svgDataUrl = mediaHelper.generateDefaultCoverSvg('Dế Mèn Phiêu Lưu Ký');
assert.ok(svgDataUrl.startsWith('data:image/svg+xml;'), 'Phải tạo SVG data URL hợp lệ');
assert.ok(svgDataUrl.includes('VietReader'), 'Data URL phải chứa tên app');

// Test TTS volume control integration
tts.setVolume(0.5);
assert.equal(tts.volume, 0.5, 'TTS Engine phải hỗ trợ setVolume');
tts.setVolume(1.5);
assert.equal(tts.volume, 1.0, 'Volume tối đa là 1.0');
tts.setVolume(-0.2);
assert.equal(tts.volume, 0.0, 'Volume tối thiểu là 0.0');
console.log('✓ Test 14: MediaSession API & TTS Volume Control PASS');

// Test 15: Safe Utterance Lifecycle & Empty Chunk Defense (tts.js)
const testTts = new TTSEngine();
let completedCalled = false;
testTts.onStatusChange = (status) => {
  if (status === 'completed') completedCalled = true;
};

// 1. Chặn mảng chunks rỗng: không được bắn completed
testTts.chunks = [];
testTts.currentIndex = 0;
testTts.speakBrowserChunk('');
assert.equal(completedCalled, false, 'Không được phát status completed khi mảng chunks rỗng');

// 2. Kiểm tra gỡ bỏ callback của currentUtterance khi gọi stop()
const fakeUtterance = { onend: () => {}, onerror: () => {}, onstart: () => {} };
testTts.currentUtterance = fakeUtterance;
testTts.stop();
assert.equal(fakeUtterance.onend, null, 'stop() phải gỡ bỏ callback onend của currentUtterance');
assert.equal(fakeUtterance.onerror, null, 'stop() phải gỡ bỏ callback onerror của currentUtterance');
assert.equal(fakeUtterance.onstart, null, 'stop() phải gỡ bỏ callback onstart của currentUtterance');
assert.equal(testTts.currentUtterance, null, 'testTts.currentUtterance phải được reset về null');
console.log('✓ Test 15: Safe Utterance Cleanup & Empty Chunk Defense PASS');

console.log('\n========================================');
console.log('TẤT CẢ 15 BÀI KIỂM THỬ ĐÃ ĐẠT 100%!');
console.log('========================================');




