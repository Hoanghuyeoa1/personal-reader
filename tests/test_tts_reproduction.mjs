import assert from 'node:assert/strict';
import test from 'node:test';
import { TTSEngine } from './tts.js';

// Helper for yielding to event loop
const nextTick = () => new Promise(resolve => setTimeout(resolve, 10));

// Mock Utterance with event tracking
class MockUtterance {
  constructor(text) {
    this.text = text;
    this.lang = 'vi-VN';
    this.rate = 1.0;
    this.pitch = 1.0;
    this.volume = 1.0;
    this.voice = null;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onpause = null;
    this.onresume = null;
  }
}

// Factory for a controllable Mock SpeechSynthesis with strict safety limits
function createMockSynth({ onSpeak, onCancel } = {}) {
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    spokenUtterances: [],
    cancelCount: 0,
    speakCount: 0,
    getVoices: () => [
      { name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'hoaimy' }
    ],
    speak(utterance) {
      synth.speakCount++;
      synth.spokenUtterances.push(utterance);
      synth.speaking = true;
      if (onSpeak) onSpeak(utterance, synth);
    },
    cancel() {
      synth.cancelCount++;
      synth.speaking = false;
      if (onCancel) onCancel(synth);
    },
    pause() { synth.paused = true; },
    resume() { synth.paused = false; }
  };
  return synth;
}

test('Test 1: Normal single utterance completion', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu số 1'];
  tts.currentIndex = 0;

  let started = false;
  let ended = false;
  let status = null;

  tts.onChunkStart = () => { started = true; };
  tts.onChunkEnd = () => { ended = true; };
  tts.onStatusChange = (st) => { status = st; };

  tts.play();

  assert.equal(mockSynth.speakCount, 1, 'Phải gọi synth.speak 1 lần');
  const utt = mockSynth.spokenUtterances[0];
  assert.equal(utt.text, 'Câu số 1');

  utt.onstart();
  assert.equal(started, true);

  utt.onend();
  assert.equal(ended, true);
  assert.equal(status, 'completed');
  tts.stop();
});

test('Test 2: Automatic sentence 1 -> 2 -> 3 transition', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  const sequence = [];
  tts.onChunkStart = (idx) => { sequence.push(`start_${idx}`); };
  tts.onChunkEnd = (idx) => { sequence.push(`end_${idx}`); };

  tts.play();
  assert.equal(mockSynth.spokenUtterances.length, 1);

  // Câu 1 start + end
  mockSynth.spokenUtterances[0].onstart();
  mockSynth.spokenUtterances[0].onend();

  await nextTick();

  // Kiểm tra: Câu 2 được tạo và speak()
  assert.equal(mockSynth.spokenUtterances.length, 2);
  assert.equal(mockSynth.spokenUtterances[1].text, 'Câu 2');
  assert.equal(tts.currentIndex, 1);

  // Câu 2 start + end
  mockSynth.spokenUtterances[1].onstart();
  mockSynth.spokenUtterances[1].onend();

  await nextTick();

  // Kiểm tra: Câu 3 được tạo và speak()
  assert.equal(mockSynth.spokenUtterances.length, 3);
  assert.equal(mockSynth.spokenUtterances[2].text, 'Câu 3');
  assert.equal(tts.currentIndex, 2);

  let finalStatus = null;
  tts.onStatusChange = (st) => { finalStatus = st; };

  // Câu 3 start + end
  mockSynth.spokenUtterances[2].onstart();
  mockSynth.spokenUtterances[2].onend();

  assert.equal(finalStatus, 'completed');
  tts.stop();
});

test('Test 3: Single advance per sentence (No duplicate advance on repeated onend)', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.spokenUtterances[0];
  const originalOnend = utt.onend;

  // Bắn onend lần 1
  originalOnend();
  assert.equal(utt.onend, null, 'utterance.onend phải bị gán null sau lần gọi đầu tiên');

  // Thử gọi lại originalOnend trực tiếp
  originalOnend();

  await nextTick();
  // Index chỉ được tăng đúng 1 lần lên câu 2
  assert.equal(tts.currentIndex, 1, 'Index chỉ được advance đúng 1 lần');
  assert.equal(mockSynth.spokenUtterances.length, 2);
  tts.stop();
});

test('Test 4: Duplicate onend/onerror handling (Single terminal completion per utterance)', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.spokenUtterances[0];

  const handlerError = utt.onerror;
  const handlerEnd = utt.onend;

  // Giả lập browser bắn onerror ('synthesis-failed')
  handlerError({ error: 'synthesis-failed' });

  // Ngay sau đó browser lại bắn tiếp onend của cùng utterance đó
  if (typeof handlerEnd === 'function') {
    handlerEnd();
  }

  await nextTick();

  // Nhờ isTerminalCompleted guard, index chỉ được advance 1 lần sang index 1
  assert.equal(tts.currentIndex, 1, 'Utterance chỉ có đúng 1 lần terminal completion, không tăng 2 lần');
  tts.stop();
});

test('Test 5: Natural sentence transition does NOT call redundant synth.cancel()', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  tts.play();
  // Ở câu 1: play() từ trạng thái dừng có thể cancel preemption
  const initialCancelCount = mockSynth.cancelCount;

  // Câu 1 kết thúc tự nhiên
  mockSynth.spokenUtterances[0].onstart();
  mockSynth.spokenUtterances[0].onend();

  await nextTick();

  // Khi chuyển từ Câu 1 sang Câu 2, synth.cancel() KHÔNG ĐƯỢC gọi thêm lần nào
  assert.equal(mockSynth.cancelCount, initialCancelCount, 'Không được gọi redundant synth.cancel() khi chuyển câu tự nhiên');
  assert.equal(mockSynth.spokenUtterances.length, 2, 'Câu 2 được phát tự nhiên');
  tts.stop();
});

test('Test 6: Stale callback arriving after Stop or Session change is rejected', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  // Phiên đọc 1
  tts.play();
  const session1Utt = mockSynth.spokenUtterances[0];
  const session1Onend = session1Utt.onend;

  // Dừng phiên 1
  tts.stop();
  assert.equal(tts.isPlaying, false);

  // Bắt đầu Phiên đọc 2 từ Câu 1
  tts.jumpToIndex(0, true);
  assert.equal(tts.isPlaying, true);
  assert.equal(tts.currentIndex, 0);

  // Callback rớt lại từ Phiên 1 kích hoạt
  if (typeof session1Onend === 'function') {
    session1Onend();
  }

  await nextTick();

  // Nhờ requestId và currentUtterance validation, callback cũ bị loại bỏ hoàn toàn
  assert.equal(tts.currentIndex, 0, 'Stale callback từ phiên cũ không được cướp quyền điều khiển phiên mới');
  tts.stop();
});

test('Test 7: Pause/Stop race cancels pending transition timer', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.play();
  mockSynth.spokenUtterances[0].onstart();
  mockSynth.spokenUtterances[0].onend();

  // Trước khi transitionTimer 0ms kích hoạt, người dùng bấm Stop
  tts.stop();
  assert.equal(tts.transitionTimer, null, 'transitionTimer phải bị hủy ngay khi Stop');

  await nextTick();

  // Không có câu 2 nào được phát sau khi Stop
  assert.equal(mockSynth.spokenUtterances.length, 1, 'Không phát thêm utterance sau khi Stop');
  assert.equal(tts.isPlaying, false);
});

test('Test 8: Empty / malformed chunks bounded iterative handling', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  // Chunks xen kẽ rỗng và khoảng trắng
  tts.chunks = ['Câu 1', '', '   ', 'Câu 4'];
  tts.currentIndex = 0;

  tts.play();
  assert.equal(mockSynth.spokenUtterances[0].text, 'Câu 1');

  // Câu 1 kết thúc -> câu 2 và 3 rỗng -> tự động nhảy tới câu 4
  mockSynth.spokenUtterances[0].onend();

  await nextTick();

  assert.equal(tts.currentIndex, 3, 'Phải bỏ qua các chunk rỗng an toàn và nhảy tới index 3');
  assert.equal(mockSynth.spokenUtterances[1].text, 'Câu 4');
  tts.stop();
});

test('Test 9: Rapid Play / Pause / Stop sequence remains consistent', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  // Spam 20 lần
  for (let i = 0; i < 20; i++) {
    tts.play();
    tts.pause();
    tts.resume();
    tts.stop();
  }

  assert.equal(tts.isPlaying, false);
  assert.equal(tts.isPaused, false);
  assert.equal(tts.currentUtterance, null);
  assert.equal(tts.transitionTimer, null);
});

test('Test 10: Circuit Breaker safe shutdown on continuous errors (Anti-cascade storm)', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;

  let errorCount = 0;
  let statusEmitted = null;

  const mockSynth = createMockSynth({
    onSpeak(utt, s) {
      if (s.speakCount === 1) return; // Câu 1 phát bình thường

      // Từ câu 2 trở đi, giả lập Edge liên tục ném lỗi synthesis-failed
      errorCount++;
      if (typeof utt.onerror === 'function') {
        utt.onerror({ error: 'synthesis-failed' });
      }
    }
  });
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = Array.from({ length: 50 }, (_, i) => `Câu thứ ${i + 1}`);
  tts.currentIndex = 0;
  tts.onStatusChange = (st) => { statusEmitted = st; };

  tts.play();

  // Câu 1 kết thúc
  mockSynth.spokenUtterances[0].onstart();
  mockSynth.spokenUtterances[0].onend();

  await nextTick();
  await nextTick();
  await nextTick();
  await nextTick();

  // BẰNG CHỨNG BẢO VỆ: Circuit breaker chặn đứng cascade storm tại đúng 3 lỗi liên tiếp!
  assert.equal(statusEmitted, 'error', 'Trạng thái chuyển sang error an toàn');
  assert.equal(tts.isPlaying, false, 'Playback đã bị ngắt an toàn, không quét qua 50 câu');
  assert.equal(mockSynth.spokenUtterances.length, 4, 'Chỉ phát đúng câu 1 và 3 lần retry bị lỗi, không tạo hàng chục/trăm utterance');
  tts.stop();
});
