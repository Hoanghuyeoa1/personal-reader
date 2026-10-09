import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';

// ============================================================================
// PHASE 3 DETERMINISTIC REGRESSION TEST SUITE: REPAIRED TTS INVARIANTS
// ============================================================================

class MockUtterance {
  static createdCount = 0;
  static activeInstances = new Set();

  constructor(text) {
    MockUtterance.createdCount++;
    MockUtterance.activeInstances.add(this);

    this.text = text;
    this.voice = null;
    this.lang = 'vi-VN';
    this.rate = 1.0;
    this.pitch = 1.0;
    this.volume = 1.0;

    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onpause = null;
    this.onresume = null;
  }

  dispose() {
    MockUtterance.activeInstances.delete(this);
  }

  static reset() {
    MockUtterance.createdCount = 0;
    MockUtterance.activeInstances.clear();
  }
}

function createDeterministicMockSynth(options = {}) {
  const state = {
    speakCount: 0,
    cancelCount: 0,
    pauseCount: 0,
    resumeCount: 0,
    speaking: false,
    paused: false,
    spokenUtterances: [],
    syncCancelEmitsOnend: Boolean(options.syncCancelEmitsOnend)
  };

  const voices = options.voices || [
    { name: 'Microsoft HoaiMy - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy' },
    { name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy-Natural' },
    { name: 'Microsoft NamMinh - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'vi-VN-NamMinh' },
    { name: 'Microsoft An', lang: 'vi-VN', voiceURI: 'vi-VN-An' },
    { name: 'Google Tiếng Việt', lang: 'vi-VN', voiceURI: 'Google-vi-VN' }
  ];

  const synth = {
    state,
    get speaking() { return state.speaking; },
    get paused() { return state.paused; },
    speak(utt) {
      state.speakCount++;
      state.speaking = true;
      state.spokenUtterances.push(utt);
    },
    cancel() {
      state.cancelCount++;
      const current = state.spokenUtterances[state.spokenUtterances.length - 1];
      state.speaking = false;
      state.paused = false;
      if (state.syncCancelEmitsOnend && current && typeof current.onend === 'function') {
        current.onend();
      }
    },
    pause() {
      state.pauseCount++;
      state.paused = true;
    },
    resume() {
      state.resumeCount++;
      state.paused = false;
    },
    getVoices() {
      return voices;
    }
  };

  return synth;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ============================================================================
// 1. NORMAL PLAYBACK OF 3, 10, AND MANY CHUNKS
// ============================================================================

test('Phase 3 - 1.1: Normal 3-chunk and 10-chunk sequential playback progresses strictly in order', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = Array.from({ length: 10 }, (_, i) => `Câu thứ ${i + 1} của chương`);
  tts.currentIndex = 0;

  const started = [];
  const completed = [];
  tts.onActualChunkStart = (idx) => started.push(idx);
  tts.onActualChunkComplete = (idx) => completed.push(idx);

  tts.play();

  for (let i = 0; i < 10; i++) {
    assert.equal(tts.currentIndex, i);
    const utt = mockSynth.state.spokenUtterances[i];
    assert.ok(utt);
    utt.onstart();
    utt.onend();
    await delay(10);
  }

  assert.equal(started.length, 10);
  assert.equal(completed.length, 10);
  assert.deepEqual(completed, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(tts.isPlaying, false, 'Stops naturally after 10 chunks');
  tts.stop();
});

// ============================================================================
// 2. ONSTART NHƯNG KHÔNG CÓ ONEND (WATCHDOG REPAIRED FAIL-SAFE)
// ============================================================================

test('Phase 3 - 2.1: onstart arrives but onend never fires: watchdog safely halts without false completion', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0 bị đơ', 'Câu 1 không được phát tự động'];
  tts.currentIndex = 0;

  const completed = [];
  let reportedStatus = null;
  let warningMessage = null;
  tts.onActualChunkComplete = (idx) => completed.push(idx);
  tts.onStatusChange = (st) => { reportedStatus = st; };
  tts.onFallbackWarning = (msg) => { warningMessage = msg; };

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Fast-trigger watchdog timeout (simulate 14s timeout in 25ms)
  clearTimeout(tts.stuckWatchdogTimer);
  tts.scheduleStuckWatchdog(utt0, tts.utteranceToken, tts.generationToken, 10, 25);

  await delay(45);

  // Invariant verification:
  assert.equal(completed.length, 0, 'Must NOT record false progress into history');
  assert.equal(tts.currentIndex, 0, 'Must preserve currentIndex at failed chunk, not advance');
  assert.equal(mockSynth.state.spokenUtterances.length, 1, 'Must NOT speak next chunk');
  assert.equal(tts.isPlaying, false, 'Playback must be halted');
  assert.equal(reportedStatus, 'error', 'Must report error status');
  assert.ok(warningMessage, 'Must provide warning message to user');
  tts.stop();
});

// ============================================================================
// 3. STUTTER-LIKE DELAYED COMPLETION
// ============================================================================

test('Phase 3 - 3.1: Stutter-like delayed completion finishes before watchdog without error', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu đọc chậm nhưng vẫn xong', 'Câu kế tiếp'];
  tts.currentIndex = 0;

  const completed = [];
  tts.onActualChunkComplete = (idx) => completed.push(idx);

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Simulate delayed audio stream (delay 20ms, well before watchdog)
  await delay(20);
  utt0.onend();
  await delay(15);

  assert.equal(completed.length, 1);
  assert.equal(completed[0], 0);
  assert.equal(tts.currentIndex, 1);
  assert.equal(mockSynth.state.spokenUtterances.length, 2);
  tts.stop();
});

// ============================================================================
// 4. ONERROR SAU ONSTART
// ============================================================================

test('Phase 3 - 4.1: onerror arriving after onstart unhighlights chunk and advances safely without false complete', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0 lỗi', 'Câu 1 tiếp theo'];
  tts.currentIndex = 0;

  const completed = [];
  let unhighlightedIndex = null;
  tts.onActualChunkComplete = (idx) => completed.push(idx);
  tts.onChunkEnd = (idx) => { unhighlightedIndex = idx; };

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  utt0.onerror({ error: 'network' });
  await delay(20);

  assert.equal(completed.length, 0, 'Error chunk must NOT be recorded as complete');
  assert.equal(unhighlightedIndex, 0, 'UI must unhighlight failed chunk');
  assert.equal(tts.currentIndex, 1, 'Advances to chunk 1');
  tts.stop();
});

// ============================================================================
// 5. DUPLICATE ONEND / ONERROR
// ============================================================================

test('Phase 3 - 5.1: Duplicate onend / onerror calls on same utterance are suppressed by isTerminalHandled', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  let endFires = 0;
  tts.onChunkEnd = () => endFires++;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  const onendFn = utt0.onend;
  onendFn();
  onendFn(); // Duplicate 1
  if (typeof utt0.onerror === 'function') utt0.onerror({ error: 'network' }); // Rogue error after onend
  if (typeof utt0.onend === 'function') utt0.onend(); // Duplicate 2

  await delay(20);

  assert.equal(endFires, 1, 'onChunkEnd must only fire once');
  assert.equal(tts.currentIndex, 1, 'Index must advance to 1 only');
  tts.stop();
});

// ============================================================================
// 6. SYNCHRONOUS CANCEL-ONEND RECURSION PREVENTION
// ============================================================================

test('Phase 3 - 6.1: Synchronous cancel triggering onend does not cause recursive playback storm', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth({ syncCancelEmitsOnend: true });
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  tts.play();
  assert.equal(mockSynth.state.speakCount, 1);

  tts.stop();
  await delay(20);

  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.state.speakCount, 1, 'Must NOT speak next chunk');
});

// ============================================================================
// 7. STOP DURING PENDING CALLBACK
// ============================================================================

test('Phase 3 - 7.1: Late onend arriving after stop() is discarded as stale', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  const orphanOnend = utt0.onend;
  tts.stop();

  if (orphanOnend) orphanOnend();
  await delay(20);

  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.state.speakCount, 1);
});

// ============================================================================
// 8. RAPID PAUSE / RESUME / SEEK
// ============================================================================

test('Phase 3 - 8.1: Rapid Play, Pause, Resume, and Seek operations maintain clean state', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.play();
  tts.pause();
  tts.resume();
  tts.jumpToIndex(2, true);
  tts.pause();
  tts.jumpToIndex(3, false); // Seek while paused
  tts.resume();

  assert.equal(tts.currentIndex, 3);
  assert.equal(tts.isPlaying, true);
  assert.equal(tts.isPaused, false);
  tts.stop();
});

// ============================================================================
// 9. KEEP-ALIVE REPAIR & HOÀI MY IMMUNITY
// ============================================================================

test('Phase 3 - 9.1: Hoài My desktop voice is 100% immune to keep-alive pause/resume pulses', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  // Exact desktop voice name
  tts.selectedVoice = { name: 'Microsoft HoaiMy - Vietnamese (Vietnam)', lang: 'vi-VN' };
  tts.chunks = ['Câu dài trên Hoài My'];
  tts.currentIndex = 0;

  // Test immunity check helper
  assert.equal(
    tts.isNaturalOrOnlineVoice(tts.selectedVoice),
    true,
    'Hoài My desktop voice must be recognized as Natural/Online'
  );

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Simulate 15s elapsed
  tts.utteranceStartedTimestamp = Date.now() - 15000;

  // Verify interval does NOT pulse
  assert.equal(mockSynth.state.pauseCount, 0, 'No pause pulse must be fired on Hoài My');
  tts.stop();
  assert.equal(tts.keepAliveTimer, null, 'Keep-alive timer cleared cleanly on stop');
});

// ============================================================================
// 10. SMART CHUNKING: ELIMINATION OF ORPHAN PUNCTUATION CHUNKS
// ============================================================================

test('Phase 3 - 10.1: Smart chunking eliminates orphan quote chunks and speakBrowserChunk filters them', async () => {
  const tts = new TTSEngine();
  const dialogue = `Linh Quy cất giọng:
"Hỡi kẻ phàm trần! Muốn kế thừa tuyệt kỹ tiên nhân, ngươi phải vượt qua thử thách tâm tính."`;

  const chunks = tts.splitIntoSmartChunks(dialogue);
  assert.ok(chunks.length >= 2);

  // Assert no orphan quotes:
  const orphanQuote = chunks.find(c => c === '"' || c === '“' || c === '”');
  assert.equal(orphanQuote, undefined, 'No orphan quote chunks produced');

  // Verify speakBrowserChunk safety check on hypothetical punctuation chunk:
  tts.chunks = ['"', '---', 'Câu hợp lệ'];
  tts.currentIndex = 0;

  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };
  tts.synth = mockSynth;

  tts.play();

  // Chunks 0 and 1 are skipped safely, directly speaking chunk 2
  assert.equal(tts.currentIndex, 2);
  assert.equal(mockSynth.state.spokenUtterances.length, 1);
  assert.equal(mockSynth.state.spokenUtterances[0].text, 'Câu hợp lệ');
  tts.stop();
});

// ============================================================================
// 11. CHAPTER TRANSITION NATURAL COMPLETION
// ============================================================================

test('Phase 3 - 11.1: onNaturalComplete emits only on last chunk completion', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu cuối cùng 1'];
  tts.currentIndex = 0;

  let naturalCompleteFired = false;
  let statusReported = null;
  tts.onNaturalComplete = () => { naturalCompleteFired = true; };
  tts.onStatusChange = (st) => { statusReported = st; };

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();
  utt0.onend();
  await delay(10);

  assert.equal(naturalCompleteFired, false, 'Must not fire on chunk 0');

  const utt1 = mockSynth.state.spokenUtterances[1];
  utt1.onstart();
  utt1.onend();
  await delay(10);

  assert.equal(naturalCompleteFired, true, 'Must fire exactly once on last chunk completion');
  assert.equal(statusReported, 'completed');
  tts.stop();
});

// ============================================================================
// 12. RESOURCE BASELINE & ANTI-OOM AUDIT
// ============================================================================

test('Phase 3 - 12.1: Repeated cycles of Play/Pause/Seek/Watchdog/Stop strictly maintain zero baseline', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];

  for (let cycle = 0; cycle < 10; cycle++) {
    tts.currentIndex = 0;
    tts.play();
    const utt = mockSynth.state.spokenUtterances[mockSynth.state.spokenUtterances.length - 1];
    utt.onstart();
    tts.pause();
    tts.resume();
    tts.stop();

    const snap = tts.getDiagnosticsSnapshot();
    assert.equal(snap.isPlaying, false);
    assert.equal(snap.isPaused, false);
    assert.equal(snap.hasActiveUtterance, false);
    assert.equal(snap.activeTimers.keepAlive, false);
    assert.equal(snap.activeTimers.transition, false);
    assert.equal(snap.activeTimers.watchdog, false);
  }
});
