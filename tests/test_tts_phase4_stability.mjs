import assert from 'node:assert/strict';
import test from 'node:test';
import { TTSEngine } from './tts.js';

// Helper for yielding to macrotask event loop
const delay = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

// Mock Utterance
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

// Factory for Mock SpeechSynthesis
function createMockSynth({ onSpeak, onCancel } = {}) {
  const synth = {
    speaking: false,
    paused: false,
    cancelCount: 0,
    speakCount: 0,
    spokenUtterances: [],
    getVoices: () => [
      { name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'hoaimy' },
      { name: 'Microsoft Nam Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'nam' }
    ],
    speak(utt) {
      synth.speakCount++;
      synth.spokenUtterances.push(utt);
      synth.speaking = true;
      if (onSpeak) onSpeak(utt, synth);
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

// ==========================================
// GROUP A: NORMAL PLAYBACK TESTS
// ==========================================

test('2A.1: Normal sequential playback of 3 consecutive chunks', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 1', 'Đoạn 2', 'Đoạn 3'];
  tts.currentIndex = 0;

  const sequence = [];
  tts.onActualChunkStart = (idx) => sequence.push(`start_${idx}`);
  tts.onActualChunkComplete = (idx) => sequence.push(`end_${idx}`);

  let status = null;
  tts.onStatusChange = (st) => { status = st; };

  tts.play();
  assert.equal(mockSynth.spokenUtterances.length, 1);
  assert.equal(tts.currentIndex, 0);

  // Chunk 0
  mockSynth.spokenUtterances[0].onstart();
  mockSynth.spokenUtterances[0].onend();
  await delay(15);

  // Chunk 1
  assert.equal(mockSynth.spokenUtterances.length, 2);
  assert.equal(tts.currentIndex, 1);
  mockSynth.spokenUtterances[1].onstart();
  mockSynth.spokenUtterances[1].onend();
  await delay(15);

  // Chunk 2
  assert.equal(mockSynth.spokenUtterances.length, 3);
  assert.equal(tts.currentIndex, 2);
  mockSynth.spokenUtterances[2].onstart();
  mockSynth.spokenUtterances[2].onend();
  await delay(15);

  assert.equal(status, 'completed');
  assert.equal(tts.isPlaying, false);
  assert.deepEqual(sequence, ['start_0', 'end_0', 'start_1', 'end_1', 'start_2', 'end_2']);
  tts.stop();
});

test('2A.2: Normal sequential playback of 10 consecutive chunks with accurate index progression', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  const count = 10;
  tts.chunks = Array.from({ length: count }, (_, i) => `Câu thứ ${i + 1}`);
  tts.currentIndex = 0;

  let completedIndices = [];
  tts.onActualChunkComplete = (idx) => completedIndices.push(idx);

  tts.play();

  for (let i = 0; i < count; i++) {
    assert.equal(tts.currentIndex, i, `Index phải là ${i}`);
    assert.equal(mockSynth.spokenUtterances.length, i + 1, `Phải có ${i + 1} utterances được speak`);
    const utt = mockSynth.spokenUtterances[i];
    utt.onstart();
    utt.onend();
    await delay(10);
  }

  assert.equal(completedIndices.length, 10);
  assert.deepEqual(completedIndices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(tts.isPlaying, false);
  tts.stop();
});

test('2A.3: Playback of 25 chunks: no duplicate playback and no nested callback recursion', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  const count = 25;
  tts.chunks = Array.from({ length: count }, (_, i) => `Đoạn văn ${i + 1}`);
  tts.currentIndex = 0;

  let speakCounts = new Map();
  tts.onChunkStart = (idx) => {
    speakCounts.set(idx, (speakCounts.get(idx) || 0) + 1);
  };

  tts.play();

  for (let i = 0; i < count; i++) {
    const utt = mockSynth.spokenUtterances[i];
    utt.onstart();
    utt.onend();
    await delay(5);
  }

  // Verify each chunk was started exactly once
  for (let i = 0; i < count; i++) {
    assert.equal(speakCounts.get(i), 1, `Chunk ${i} chỉ được phát đúng 1 lần`);
  }
  assert.equal(mockSynth.spokenUtterances.length, 25);
  tts.stop();
});

// ==========================================
// GROUP B: LIFECYCLE RACES
// ==========================================

test('2B.1: Rapid Play/Pause/Resume transitions maintain state consistency', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  // Execute rapid cycles
  for (let i = 0; i < 15; i++) {
    tts.play();
    tts.pause();
    tts.resume();
  }

  assert.equal(tts.isPlaying, true);
  assert.equal(tts.isPaused, false);

  tts.stop();
  assert.equal(tts.isPlaying, false);
  assert.equal(tts.isPaused, false);
  assert.equal(tts.currentUtterance, null);
});

test('2B.2: Stop during onend cleanly aborts next chunk advance', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.onChunkEnd = () => {
    // User stops playback right on sentence end
    tts.stop();
  };

  tts.play();
  const utt = mockSynth.spokenUtterances[0];
  utt.onstart();
  utt.onend();

  await delay(20);

  // Next chunk must NOT be spoken
  assert.equal(mockSynth.spokenUtterances.length, 1, 'Không được phát thêm câu sau khi Stop');
  assert.equal(tts.isPlaying, false);
  assert.equal(tts.transitionTimer, null);
});

test('2B.3: Seek while playing cancels current and immediately speaks target chunk', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2', 'Câu 3', 'Câu 4', 'Câu 5'];
  tts.currentIndex = 0;

  tts.play();
  assert.equal(tts.currentIndex, 0);
  assert.equal(mockSynth.spokenUtterances[0].text, 'Câu 0');

  // User jumps to chunk 4 while playing
  tts.jumpToIndex(4, true);

  assert.equal(tts.currentIndex, 4);
  assert.equal(mockSynth.spokenUtterances.length, 2);
  assert.equal(mockSynth.spokenUtterances[1].text, 'Câu 4');

  // Old chunk 0 fires late onend
  mockSynth.spokenUtterances[0].onend?.();
  await delay(15);

  // Playback must remain at chunk 4 (not affected by old chunk 0 callback)
  assert.equal(tts.currentIndex, 4);
  tts.stop();
});

test('2B.4: Seek while paused updates index without speaking, then speaks target on resume', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.play();
  mockSynth.spokenUtterances[0].onstart();
  tts.pause();
  assert.equal(tts.isPaused, true);
  const speakCountWhilePaused = mockSynth.spokenUtterances.length;

  // Jump while paused (autoPlay = false)
  tts.jumpToIndex(2, false);
  assert.equal(tts.currentIndex, 2);
  assert.equal(mockSynth.spokenUtterances.length, speakCountWhilePaused, 'Không được phát utterance khi đang paused');

  // Next while paused
  tts.next();
  assert.equal(tts.currentIndex, 3);
  assert.equal(mockSynth.spokenUtterances.length, speakCountWhilePaused);

  // Resume
  tts.resume();
  assert.equal(tts.isPaused, false);
  assert.equal(tts.currentIndex, 3);
  assert.equal(mockSynth.spokenUtterances.length, speakCountWhilePaused + 1);
  assert.equal(mockSynth.spokenUtterances[speakCountWhilePaused].text, 'Câu 3');

  tts.stop();
});

test('2B.5: Old callback after new session is discarded without corrupting new session', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Session 1 Chunk', 'Session 1 Chunk 2'];
  tts.currentIndex = 0;

  tts.play();
  const session1Utt = mockSynth.spokenUtterances[0];
  const oldOnend = session1Utt.onend;

  tts.stop();

  // Start new session
  tts.chunks = ['Session 2 Chunk A', 'Session 2 Chunk B'];
  tts.currentIndex = 0;
  tts.play();

  // Old onend fires now
  if (oldOnend) oldOnend();
  await delay(15);

  // New session should still be on chunk 0
  assert.equal(tts.currentIndex, 0);
  assert.equal(tts.isPlaying, true);
  assert.equal(mockSynth.spokenUtterances[1].text, 'Session 2 Chunk A');
  tts.stop();
});

test('2B.6: Voice change during playback applies immediately and to subsequent chunks safely', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  const voice1 = { name: 'Voice 1', lang: 'vi-VN' };
  const voice2 = { name: 'Voice 2', lang: 'vi-VN' };
  tts.voices = [voice1, voice2];
  tts.selectedVoice = voice1;

  tts.play();
  assert.equal(mockSynth.spokenUtterances[0].voice, voice1);

  // Change voice during playback: immediately re-speaks with new voice
  tts.setVoice(voice2);
  assert.equal(mockSynth.spokenUtterances.length, 2);
  assert.equal(mockSynth.spokenUtterances[1].voice, voice2);

  // Current chunk finishes with new voice
  mockSynth.spokenUtterances[1].onstart();
  mockSynth.spokenUtterances[1].onend();
  await delay(15);

  // Next chunk also has voice2
  assert.equal(mockSynth.spokenUtterances.length, 3);
  assert.equal(mockSynth.spokenUtterances[2].voice, voice2);
  tts.stop();
});

test('2B.7: Voice preview followed by resume cleanly continues reading session', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn đọc chính'];
  tts.currentIndex = 0;
  tts.voices = [{ name: 'Voice Preview', lang: 'vi-VN', voiceURI: 'test-v' }];

  tts.play();
  mockSynth.spokenUtterances[0].onstart();
  tts.pause();
  assert.equal(tts.isPaused, true);

  // Trigger preview
  const previewPromise = tts.previewVoice('test-v', 'browser');
  const previewUtt = mockSynth.spokenUtterances[mockSynth.spokenUtterances.length - 1];
  previewUtt.onend?.();
  await previewPromise;

  // After preview, user calls resume
  tts.resume();
  assert.equal(tts.isPlaying, true);
  assert.equal(tts.isPaused, false);
  tts.stop();
});

// ==========================================
// GROUP C: FAULT INJECTION TESTS
// ==========================================

test('2C.1: Duplicate onend calls trigger only a single advance', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.spokenUtterances[0];
  const capturedEnd = utt.onend;

  // Call onend twice
  capturedEnd();
  capturedEnd();

  await delay(15);

  assert.equal(tts.currentIndex, 1, 'Chỉ được tăng index đúng 1 lần');
  assert.equal(mockSynth.spokenUtterances.length, 2);
  tts.stop();
});

test('2C.2: onerror followed immediately by onend causes only single handling', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.spokenUtterances[0];
  const capturedErr = utt.onerror;
  const capturedEnd = utt.onend;

  capturedErr({ error: 'network' });
  if (capturedEnd) capturedEnd();

  await delay(15);

  assert.equal(tts.currentIndex, 1, 'Chỉ chuyển câu 1 lần sau lỗi');
  tts.stop();
});

test('2C.3: Synchronous onend during synth.cancel does not cause reentrant recursion', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  let activeUtt = null;
  const mockSynth = createMockSynth({
    onSpeak(utt) { activeUtt = utt; },
    onCancel() {
      // Simulate buggy browser triggering onend inside cancel()
      if (activeUtt && typeof activeUtt.onend === 'function') {
        activeUtt.onend();
      }
    }
  });
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  tts.play();
  // Call stop which calls cancelCurrentSource -> synth.cancel()
  tts.stop();

  await delay(15);

  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.spokenUtterances.length, 1, 'Không được phát thêm do onend bên trong cancel');
});

test('2C.4: Empty and whitespace chunks are safely skipped without freezing', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', '', '   ', '\t\n', 'Câu 4'];
  tts.currentIndex = 0;

  tts.play();
  assert.equal(mockSynth.spokenUtterances[0].text, 'Câu 0');

  // Complete chunk 0
  mockSynth.spokenUtterances[0].onend();
  await delay(15);

  assert.equal(tts.currentIndex, 4);
  assert.equal(mockSynth.spokenUtterances[1].text, 'Câu 4');
  tts.stop();
});

test('2C.5: Invalid chunk data (null, undefined, non-strings) handled gracefully', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = [null, undefined, '', 'Câu hợp lệ'];
  tts.currentIndex = 0;

  tts.play();
  await delay(10);

  // Should skip invalid chunks and speak valid text
  assert.equal(tts.currentIndex, 3);
  assert.equal(mockSynth.spokenUtterances[0].text, 'Câu hợp lệ');
  tts.stop();
});

test('2C.6: Cloud failure triggers fallback warning and degrades to Browser TTS', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.engine = 'cloud';
  tts.cloudConfig = { apiKey: 'dummy-key', provider: 'fpt', voice: 'banmai' };
  tts.chunks = ['Câu Cloud Fallback'];
  tts.currentIndex = 0;

  let warningEmitted = null;
  tts.onFallbackWarning = (msg) => { warningEmitted = msg; };

  // Simulate Cloud fetch failure
  tts.fetchCloudAudio = async () => {
    throw new Error('Connection refused by Cloud Server');
  };

  tts.play();
  await delay(30);

  assert.ok(warningEmitted && warningEmitted.includes('Cloud AI (fpt) lỗi'));
  assert.equal(mockSynth.spokenUtterances.length, 1);
  assert.equal(mockSynth.spokenUtterances[0].text, 'Câu Cloud Fallback');
  tts.stop();
});

test('2C.7: Repeated automatic completion and restarts cleanly cycle', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Chương 1 duy nhất'];

  for (let run = 0; run < 3; run++) {
    tts.jumpToIndex(0, true);
    assert.equal(tts.isPlaying, true);
    const utt = mockSynth.spokenUtterances[mockSynth.spokenUtterances.length - 1];
    utt.onstart();
    utt.onend();
    await delay(15);
    assert.equal(tts.isPlaying, false);
  }
});

// ==========================================
// GROUP D: RESOURCE SAFETY & SOAK TESTS
// ==========================================

test('2D.1: Bounded mock soak test across 50 chunks: all handlers cleaned, zero leaks', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  const totalChunks = 50;
  tts.chunks = Array.from({ length: totalChunks }, (_, i) => `Đoạn thứ ${i}`);
  tts.currentIndex = 0;

  tts.play();

  for (let i = 0; i < totalChunks; i++) {
    const utt = mockSynth.spokenUtterances[i];
    utt.onstart();
    utt.onend();
    await delay(2);

    // Verify utterance event listeners were stripped
    assert.equal(utt.onend, null, `utt ${i} onend must be null`);
    assert.equal(utt.onerror, null, `utt ${i} onerror must be null`);
    assert.equal(utt.onstart, null, `utt ${i} onstart must be null`);
  }

  assert.equal(tts.isPlaying, false);
  assert.equal(tts.currentUtterance, null);
  assert.equal(tts.transitionTimer, null);
  assert.equal(tts.consecutiveErrorCount, 0);
  tts.stop();
});

test('2D.2: Active listeners and keep-alive timer cleared on stop', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  tts.play();
  assert.ok(tts.keepAliveTimer !== null, 'keepAliveTimer phải được kích hoạt');

  tts.stop();
  assert.equal(tts.keepAliveTimer, null, 'keepAliveTimer phải bị hủy sau stop');
  assert.equal(tts.transitionTimer, null, 'transitionTimer phải là null');
  assert.equal(tts.currentUtterance, null, 'currentUtterance phải là null');
});

test('2D.3: Utterance references are bounded: exactly 1 active during play, 0 on stop', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['1', '2', '3'];

  tts.play();
  assert.ok(tts.currentUtterance !== null, 'Đang play thì có 1 active utterance');

  tts.stop();
  assert.equal(tts.currentUtterance, null, 'Sau stop thì có 0 active utterance');
});

test('2D.4: 20 sequential playback sessions do not accumulate listeners or dangling state', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Kiểm tra phiên'];

  for (let s = 0; s < 20; s++) {
    tts.play();
    assert.equal(tts.isPlaying, true);
    tts.stop();
    assert.equal(tts.isPlaying, false);
    assert.equal(tts.currentUtterance, null);
    assert.equal(tts.transitionTimer, null);
  }

  assert.equal(tts.consecutiveErrorCount, 0);
});

test('2D.5: Circuit Breaker safely stops playback after 3 consecutive errors', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth({
    onSpeak(utt) {
      if (typeof utt.onerror === 'function') {
        utt.onerror({ error: 'not-allowed' });
      }
    }
  });
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = Array.from({ length: 20 }, (_, i) => `Câu ${i}`);
  tts.currentIndex = 0;

  let errorStatusEmitted = false;
  tts.onStatusChange = (st) => {
    if (st === 'error') errorStatusEmitted = true;
  };

  tts.play();

  await delay(30);

  // Circuit breaker should trip at 3 errors and stop
  assert.equal(errorStatusEmitted, true);
  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.spokenUtterances.length, 3, 'Chỉ thử tối đa 3 lần rồi dừng hẳn');
  assert.equal(tts.keepAliveTimer, null);
});
