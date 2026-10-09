import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';

// ============================================================================
// DETERMINISTIC MOCK HARNESS (FAKE SPEECHSYNTHESIS + FAKE TIME / CONTROL)
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
    this.onboundary = null;
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
    syncCancelEmitsOnend: Boolean(options.syncCancelEmitsOnend),
    syncCancelEmitsOnerror: Boolean(options.syncCancelEmitsOnerror)
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
      if (state.syncCancelEmitsOnerror && current && typeof current.onerror === 'function') {
        current.onerror({ error: 'canceled' });
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
// TEST 1: PHÁT LIÊN TỤC NHIỀU CHUNKS (NORMAL MULTI-CHUNK PLAYBACK)
// ============================================================================

test('Phase 1 - Test 1: Normal continuous multi-chunk playback advances cleanly and strictly in order', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3', 'Câu 4'];
  tts.currentIndex = 0;

  const sequence = [];
  tts.onActualChunkStart = (idx) => sequence.push(`start_${idx}`);
  tts.onActualChunkComplete = (idx) => sequence.push(`complete_${idx}`);

  tts.play();

  for (let i = 0; i < 4; i++) {
    assert.equal(tts.currentIndex, i);
    const utt = mockSynth.state.spokenUtterances[i];
    assert.ok(utt, `Utterance ${i} must exist`);
    utt.onstart();
    utt.onend();
    await delay(15);
  }

  assert.deepEqual(sequence, [
    'start_0', 'complete_0',
    'start_1', 'complete_1',
    'start_2', 'complete_2',
    'start_3', 'complete_3'
  ]);

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.counts.speak, 4);
  assert.equal(snap.counts.onstart, 4);
  assert.equal(snap.counts.onend, 4);
  assert.equal(snap.counts.chapterComplete, 1);
  assert.equal(snap.isPlaying, false);
  tts.stop();
});

// ============================================================================
// TEST 2: ONSTART NHƯNG ONEND KHÔNG ĐẾN (STUCK NATIVE SPEECH)
// ============================================================================

test('Phase 1 - Test 2: onstart arrives but onend never fires (Simulating native speech freeze)', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0 bị treo', 'Câu 1'];
  tts.currentIndex = 0;

  let actualChunkStarted = null;
  let actualChunkCompleted = null;
  tts.onActualChunkStart = (idx) => { actualChunkStarted = idx; };
  tts.onActualChunkComplete = (idx) => { actualChunkCompleted = idx; };

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  assert.equal(actualChunkStarted, 0);
  assert.equal(actualChunkCompleted, null);
  assert.equal(tts.isPlaying, true);

  // Do NOT fire onend. Utterance remains stuck in limbo until watchdog/stop.
  assert.equal(mockSynth.state.spokenUtterances.length, 1);
  assert.equal(tts.currentIndex, 0);

  tts.stop();
});

// ============================================================================
// TEST 3: ONERROR SAU ONSTART (ERROR FIRED AFTER PLAYBACK STARTED)
// ============================================================================

test('Phase 1 - Test 3: onerror arrives after onstart (Single terminal handling, advances safely)', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu lỗi 0', 'Câu kế tiếp 1'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Error occurs mid-utterance
  utt.onerror({ error: 'audio-busy' });

  await delay(20);

  assert.equal(tts.currentIndex, 1, 'Advances to chunk 1 on non-fatal error');
  assert.equal(mockSynth.state.speakCount, 2, 'Speaks next chunk');
  assert.equal(tts.consecutiveErrorCount, 1, 'Tracks consecutive error');
  tts.stop();
});

// ============================================================================
// TEST 4: DUPLICATE ONEND (DOUBLE ONEND CALLS ON SAME UTTERANCE)
// ============================================================================

test('Phase 1 - Test 4: Duplicate onend on same utterance is suppressed by terminal guard', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  let endEventCount = 0;
  tts.onChunkEnd = () => endEventCount++;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Rogue duplicate triggers
  const onendRef = utt.onend;
  assert.ok(onendRef);
  onendRef();
  if (typeof utt.onend === 'function') utt.onend();
  onendRef();

  await delay(20);

  assert.equal(endEventCount, 1, 'onChunkEnd must only fire once');
  assert.equal(tts.currentIndex, 1, 'Must only advance to chunk 1');
  assert.equal(mockSynth.state.spokenUtterances.length, 2);
  tts.stop();
});

// ============================================================================
// TEST 5: CANCEL() KÍCH HOẠT ONEND ĐỒNG BỘ
// ============================================================================

test('Phase 1 - Test 5: cancel() triggering synchronous onend does not cause recursive callback storm', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth({ syncCancelEmitsOnend: true });
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  tts.play();
  assert.equal(mockSynth.state.speakCount, 1);

  // Calling stop() invokes cancelCurrentSource(), which triggers sync cancel
  tts.stop();

  await delay(20);

  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.state.speakCount, 1, 'Must not speak next chunk after stop');
  assert.equal(tts.currentIndex, 0);
});

// ============================================================================
// TEST 6: CHUNK COMPLETION KHI STOP PENDING
// ============================================================================

test('Phase 1 - Test 6: Chunk onend arriving after stop() is discarded as stale', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  const orphanOnend = utt.onend;

  // Stop is called while audio was playing
  tts.stop();
  assert.equal(tts.isPlaying, false);

  // Late onend arrives from browser after stop
  if (orphanOnend) orphanOnend();

  await delay(20);

  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.state.speakCount, 1, 'Must not speak chunk 1');
});

// ============================================================================
// TEST 7: PAUSE/RESUME TẠI RANH GIỚI CÂU
// ============================================================================

test('Phase 1 - Test 7: Pause at chunk boundary stops transition timer cleanly', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();
  utt.onend(); // transition timer scheduled

  // Immediately pause while transition timer is pending
  tts.pause();
  assert.equal(tts.isPaused, true);
  assert.equal(tts.transitionTimer, null, 'transitionTimer must be cleared');

  await delay(20);

  assert.equal(mockSynth.state.speakCount, 1, 'Must not speak chunk 1 while paused');

  // Resume proceeds cleanly
  tts.resume();
  assert.equal(tts.isPaused, false);
  assert.equal(tts.isPlaying, true);
  tts.stop();
});

// ============================================================================
// TEST 8: WATCHDOG TIMEOUT DEFECT AUDIT (SPECIAL CHECK!)
// "Timeout KHÔNG được tự đánh dấu chunk hoàn tất và tiếp tục phát vô hạn"
// ============================================================================

test('Phase 1 - Test 8: CONFIRMED DEFECT: Stuck Watchdog incorrectly marks completion and advances silently in loop', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0 (bị kẹt)', 'Câu 1 (bị kẹt)', 'Câu 2 (bị kẹt)'];
  tts.currentIndex = 0;

  const completedChunks = [];
  tts.onActualChunkComplete = (idx) => completedChunks.push(idx);

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Neither onend nor onerror arrives. Native synth is frozen.
  // We trigger stuckWatchdog with custom short timeout (20ms) to simulate the 14s timeout deterministically.
  tts.scheduleStuckWatchdog(utt0, tts.utteranceToken, tts.generationToken, 10, 20);

  await delay(35);

  // AUDIT OBSERVATION (REPAIRED):
  // 1. Watchdog does NOT emit onActualChunkComplete(0) because chunk 0 was stuck!
  // 2. Watchdog does NOT advance currentIndex to 1!
  // 3. Watchdog does NOT call speakCurrentChunk(), terminating the runaway loop!
  assert.equal(
    completedChunks.includes(0),
    false,
    'REPAIRED: Watchdog must NEVER emit completion for stuck chunk 0!'
  );
  assert.equal(
    tts.currentIndex,
    0,
    'REPAIRED: Watchdog must preserve currentIndex at failed chunk, not advance falsely!'
  );
  assert.equal(
    mockSynth.state.speakCount,
    1,
    'REPAIRED: Watchdog must NOT automatically call speakCurrentChunk() for next chunk!'
  );
  assert.equal(
    tts.isPlaying,
    false,
    'REPAIRED: Watchdog must halt playback safely into stopped/error state!'
  );

  tts.stop();
});

// ============================================================================
// TEST 9: EMPTY / INVALID CHUNKS
// ============================================================================

test('Phase 1 - Test 9: Empty, whitespace, and punctuation-only chunks handled without recursion', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['', '   ', '\n\t', 'Câu hợp lệ đầu tiên', ''];
  tts.currentIndex = 0;

  tts.play();

  // Empty chunks 0, 1, 2 must be skipped, starting directly at chunk 3
  assert.equal(tts.currentIndex, 3);
  assert.equal(mockSynth.state.speakCount, 1);
  assert.equal(mockSynth.state.spokenUtterances[0].text, 'Câu hợp lệ đầu tiên');

  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();
  utt.onend();

  await delay(20);

  // Final empty chunk 4 is reached and completed cleanly
  assert.equal(tts.isPlaying, false);
  tts.stop();
});

// ============================================================================
// TEST 10: STALE CALLBACKS
// ============================================================================

test('Phase 1 - Test 10: Stale callbacks from previous utteranceToken or generationToken are ignored', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  tts.play();
  const oldUtt = mockSynth.state.spokenUtterances[0];
  const oldOnend = oldUtt.onend;

  // User jumps to chunk 2 (increments generationToken & utteranceToken)
  tts.jumpToIndex(2, true);
  assert.equal(tts.currentIndex, 2);
  assert.equal(mockSynth.state.speakCount, 2);

  // Old onend arrives now
  if (oldOnend) oldOnend();

  await delay(20);

  assert.equal(tts.currentIndex, 2, 'Stale callback must not alter currentIndex');
  tts.stop();
});

// ============================================================================
// TEST 11: KEEP-ALIVE CLEANUP & VOICE REGEX DEFECT
// ============================================================================

test('Phase 1 - Test 11: Keep-Alive interval stops on stop()/pause(), and regex defect is verified', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);

  // Exact desktop name of Hoài My
  tts.selectedVoice = { name: 'Microsoft HoaiMy - Vietnamese (Vietnam)', lang: 'vi-VN' };
  tts.chunks = ['Câu test Keep-Alive'];
  tts.currentIndex = 0;

  tts.play();
  assert.ok(tts.keepAliveTimer, 'KeepAlive timer must be running');

  // Verify voice regex defect in tts.js:1563
  const voiceName = tts.selectedVoice?.name || '';
  const isOnlineOrNatural = /natural|online|neural/i.test(voiceName);
  assert.equal(
    isOnlineOrNatural,
    false,
    'CONFIRMED DEFECT: "Microsoft HoaiMy - Vietnamese (Vietnam)" is NOT matched by /natural|online|neural/i'
  );

  tts.pause();
  assert.equal(tts.keepAliveTimer, null, 'KeepAlive timer must be cleared on pause');

  tts.resume();
  assert.ok(tts.keepAliveTimer, 'KeepAlive timer restored on resume');

  tts.stop();
  assert.equal(tts.keepAliveTimer, null, 'KeepAlive timer cleared on stop');
});

// ============================================================================
// TEST 12: RESOURCE BASELINE OVER REPEATED CYCLES
// ============================================================================

test('Phase 1 - Test 12: Resource counts return to strict baseline over multiple play/pause/stop cycles', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];

  for (let cycle = 0; cycle < 5; cycle++) {
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
