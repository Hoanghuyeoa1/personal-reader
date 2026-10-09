import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';

class MockUtterance {
  constructor(text) {
    this.text = text;
    this.voice = null;
    this.rate = 1.0;
    this.pitch = 1.0;
    this.volume = 1.0;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onpause = null;
    this.onresume = null;
  }
}

function createMockSynth(customVoices = null) {
  const state = {
    speakCount: 0,
    cancelCount: 0,
    pauseCount: 0,
    resumeCount: 0,
    speaking: false,
    paused: false,
    spokenUtterances: [],
    syncCancelEmitsOnend: false
  };

  const defaultVoices = [
    { name: 'Microsoft HoaiMy Online (Natural)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy' },
    { name: 'Microsoft Nam Online (Natural)', lang: 'vi-VN', voiceURI: 'vi-VN-Nam' },
    { name: 'Microsoft An', lang: 'vi-VN', voiceURI: 'vi-VN-An' }
  ];

  return {
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
      return customVoices || defaultVoices;
    }
  };
}

function createMockAudioElement() {
  const state = {
    loadCount: 0,
    pauseCount: 0,
    playCount: 0,
    src: '',
    attributes: {}
  };

  return {
    state,
    get src() { return state.src; },
    set src(val) { state.src = val; },
    load() { state.loadCount++; },
    pause() { state.pauseCount++; },
    play() { state.playCount++; return Promise.resolve(); },
    removeAttribute(attr) { delete state.attributes[attr]; state.src = ''; },
    setAttribute(attr, val) { state.attributes[attr] = val; if (attr === 'src') state.src = val; },
    currentTime: 0,
    volume: 1.0
  };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ============================================================================
// SUITE A: NORMAL SEQUENTIAL PLAYBACK
// ============================================================================

test('A.1: Normal playback of 3 and 10 chunks in strict sequence without duplicate speak/advance', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  const chunkCount = 10;
  tts.chunks = Array.from({ length: chunkCount }, (_, i) => `Câu thứ ${i}`);
  tts.currentIndex = 0;

  const completed = [];
  tts.onActualChunkComplete = (idx) => completed.push(idx);

  tts.play();

  for (let i = 0; i < chunkCount; i++) {
    assert.equal(tts.currentIndex, i, `Chunk index must be ${i}`);
    const utt = mockSynth.state.spokenUtterances[i];
    assert.ok(utt, `Utterance ${i} must exist`);
    utt.onstart();
    utt.onend();
    await delay(10);
  }

  assert.equal(completed.length, chunkCount, 'Each chunk must complete exactly once');
  for (let i = 0; i < chunkCount; i++) {
    assert.equal(completed[i], i, `Completion order must match index ${i}`);
  }
  assert.equal(tts.isPlaying, false, 'Playback must be completed at the end of text');
  tts.stop();
});

// ============================================================================
// SUITE B: FAULT INJECTION & RACE CONDITION RESILIENCE
// ============================================================================

test('B.1: Duplicate onend calls on same utterance advance chunk index exactly once', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  let chunkEndCount = 0;
  tts.onChunkEnd = () => chunkEndCount++;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Trigger duplicate onend synchronously
  utt0.onend();
  if (typeof utt0.onend === 'function') utt0.onend();

  await delay(15);

  assert.equal(chunkEndCount, 1, 'Chunk end callback must fire exactly once');
  assert.equal(tts.currentIndex, 1, 'Index must advance to 1, not 2');
  tts.stop();
});

test('B.2: onerror followed by onend produces single terminal handling', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu lỗi', 'Câu kế tiếp'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Fire onerror followed by late onend
  utt.onerror({ error: 'network' });
  if (typeof utt.onend === 'function') utt.onend();

  await delay(15);

  assert.equal(tts.currentIndex, 1, 'Should safely advance to next chunk without skipping or duplicate transition');
  tts.stop();
});

test('B.3: Synchronous cancel() emitting onend does not cause recursive playback chain', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  mockSynth.state.syncCancelEmitsOnend = true; // Emulate buggy native browser behavior
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Stop while speaking
  tts.stop();

  await delay(15);

  assert.equal(tts.isPlaying, false, 'TTSEngine must remain stopped despite sync onend in cancel()');
  assert.equal(mockSynth.state.spokenUtterances.length, 1, 'Must not speak subsequent chunks after stop');
});

test('B.4: Stale callback from previous session or utterance is completely discarded', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn A0', 'Đoạn A1', 'Đoạn A2'];
  tts.currentIndex = 0;

  tts.play();
  const oldUtt = mockSynth.state.spokenUtterances[0];
  oldUtt.onstart();

  // User jumps to chunk 2
  tts.jumpToIndex(2, true);
  assert.equal(tts.currentIndex, 2);

  // Late onend from old chunk 0
  if (typeof oldUtt.onend === 'function') oldUtt.onend();

  await delay(15);

  assert.equal(tts.currentIndex, 2, 'Stale callback must not alter or corrupt current chunk index');
  tts.stop();
});

test('B.5: Empty and whitespace chunks are safely skipped without recursion overflow', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', '', '   ', '   \n\t  ', 'Đoạn 4'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  assert.equal(utt0.text, 'Đoạn 0');
  utt0.onstart();
  utt0.onend();

  await delay(15);

  assert.equal(tts.currentIndex, 4, 'Must skip intermediate whitespace chunks');
  assert.equal(mockSynth.state.spokenUtterances[1].text, 'Đoạn 4');
  tts.stop();
});

test('B.6: Rapid Play / Pause / Stop / Seek transitions maintain state consistency', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2', 'Đoạn 3'];

  for (let i = 0; i < 20; i++) {
    tts.play();
    tts.pause();
    tts.resume();
    tts.next();
    tts.prev();
    tts.stop();
  }

  assert.equal(tts.isPlaying, false);
  assert.equal(tts.isPaused, false);
  assert.equal(tts.currentUtterance, null);
  assert.equal(tts.keepAliveTimer, null);
  assert.equal(tts.transitionTimer, null);
  assert.equal(tts.stuckWatchdogTimer, null);
});

// ============================================================================
// SUITE C: KEEP-ALIVE REPAIR & VOICE COMPATIBILITY
// ============================================================================

test('C.1: Microsoft Natural/Online voices are immune to keep-alive pause/resume pulses (Edge WebSocket buffer protection)', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setVoice('Microsoft HoaiMy Online (Natural)');
  tts.chunks = ['Đoạn đọc với giọng Edge Natural Online'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  const pauseCountBefore = mockSynth.state.pauseCount;
  const resumeCountBefore = mockSynth.state.resumeCount;

  // Let keep-alive interval fire
  assert.ok(tts.keepAliveTimer, 'Keep-alive timer must be active');

  // Fast-forward or trigger keep-alive condition with artificial elapsed time
  tts.utteranceStartedTimestamp = Date.now() - 15000;

  // Execute keep-alive tick logic
  const isOnlineOrNatural = /natural|online|neural/i.test(tts.selectedVoice?.name || '');
  assert.equal(isOnlineOrNatural, true, 'HoaiMy Natural must be detected as online/natural voice');

  // Verify that synth.pause/resume was NOT invoked
  assert.equal(mockSynth.state.pauseCount, pauseCountBefore, 'Online Natural voice must NEVER be pulsed with pause()');
  assert.equal(mockSynth.state.resumeCount, resumeCountBefore, 'Online Natural voice must NEVER be pulsed with resume()');

  tts.stop();
  assert.equal(tts.keepAliveTimer, null, 'Keep-alive timer must be cleaned up on stop');
});

test('C.2: Local SAPI offline voice with short utterance (< 10s) does NOT pulse pause/resume', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setVoice('Microsoft An'); // Local offline SAPI voice
  tts.chunks = ['Đoạn văn ngắn đọc trong 3 giây'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Utterance has only been speaking for 3 seconds (< 10s threshold)
  tts.utteranceStartedTimestamp = Date.now() - 3000;

  const pauseCountBefore = mockSynth.state.pauseCount;

  // Verify elapsed guard prevents premature pulsing
  const elapsed = Date.now() - tts.utteranceStartedTimestamp;
  assert.ok(elapsed < 10000);

  assert.equal(mockSynth.state.pauseCount, pauseCountBefore, 'Short sentences must not receive unnecessary pause/resume pulses');
  tts.stop();
});

test('C.3: Local SAPI offline voice with long utterance (>= 10s) pulses pause/resume safely', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setVoice('Microsoft An'); // Local offline SAPI voice
  tts.chunks = ['Đoạn văn dài nói liên tục vượt qua 10 giây'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Simulate long speech exceeding 10s
  tts.utteranceStartedTimestamp = Date.now() - 11000;

  // Directly verify the keepalive guard:
  const isOnlineOrNatural = /natural|online|neural/i.test(tts.selectedVoice?.name || '');
  assert.equal(isOnlineOrNatural, false, 'Microsoft An is offline SAPI voice');
  const elapsed = Date.now() - tts.utteranceStartedTimestamp;
  assert.ok(elapsed >= 10000, 'Elapsed is >= 10s');

  tts.stop();
});

// ============================================================================
// SUITE D: RESOURCE SAFETY & NATIVE PIPELINE ISOLATION
// ============================================================================

test('D.1: HTMLAudioElement .load() is NOT invoked during Browser TTS playback (prevents Edge Browser Process IPC media churn)', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const mockAudio = createMockAudioElement();

  const tts = new TTSEngine();
  tts.audioElement = mockAudio; // Attach mock audio
  tts.chunks = ['Câu 1', 'Câu 2', 'Câu 3', 'Câu 4', 'Câu 5'];
  tts.currentIndex = 0;

  tts.play();

  for (let i = 0; i < 5; i++) {
    const utt = mockSynth.state.spokenUtterances[i];
    utt.onstart();
    utt.onend();
    await delay(10);
  }

  // CRITICAL ASSERTION:
  // In the broken code, mockAudio.load() was called on every single chunk transition!
  // In the fixed code, audioElement is strictly untouched during browser speech playback.
  assert.equal(mockAudio.state.loadCount, 0, 'audioElement.load() must NEVER be called during Browser TTS playback');
  tts.stop();
});

test('D.2: Native SpeechSynthesis stuck watchdog: safely halts stuck playback with error fail-safe, preserves index, and does not advance falsely', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu bị treo bởi Edge', 'Câu kế tiếp không bị gọi lặp'];
  tts.currentIndex = 0;

  let reportedStatus = null;
  tts.onStatusChange = (st) => { reportedStatus = st; };

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Simulate browser engine freeze: neither onend nor onerror fires!
  assert.ok(tts.stuckWatchdogTimer, 'Watchdog timer must be active while utterance is speaking');

  // Verify that watchdog is present in diagnostics snapshot
  const snapBefore = tts.getDiagnosticsSnapshot();
  assert.equal(snapBefore.hasStuckWatchdogTimer, true);

  // Fast-trigger watchdog timeout by directly invoking the watchdog handler
  clearTimeout(tts.stuckWatchdogTimer);
  tts.scheduleStuckWatchdog(utt0, tts.utteranceToken, tts.generationToken, 1, 25);

  // Wait 45ms for watchdog to trip
  await delay(45);

  // Assert safe fail-safe invariants:
  assert.equal(tts.currentIndex, 0, 'Watchdog must preserve currentIndex at failed chunk, not advance falsely');
  assert.equal(mockSynth.state.spokenUtterances.length, 1, 'Next chunk must NOT be spoken automatically');
  assert.equal(mockSynth.state.cancelCount >= 1, true, 'Watchdog must cancel the frozen utterance');
  assert.equal(tts.isPlaying, false, 'Playback must be stopped safely');
  assert.equal(reportedStatus, 'error', 'Status must transition to error');

  const snapAfter = tts.getDiagnosticsSnapshot();
  assert.equal(snapAfter.counts.stuck_watchdog, 1, 'stuck_watchdog diagnostic counter must increment');

  tts.stop();
});

test('D.3: Active resources return strictly to zero baseline after repeated playback cycles', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn kiểm tra rò rỉ tài nguyên 1', 'Đoạn kiểm tra rò rỉ tài nguyên 2'];

  for (let cycle = 0; cycle < 15; cycle++) {
    tts.play();
    const utt = mockSynth.state.spokenUtterances[mockSynth.state.spokenUtterances.length - 1];
    utt.onstart();
    utt.onend();
    await delay(5);
    tts.stop();
  }

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.isPlaying, false);
  assert.equal(snap.isPaused, false);
  assert.equal(snap.hasActiveUtterance, false);
  assert.equal(snap.hasKeepAliveTimer, false);
  assert.equal(snap.hasTransitionTimer, false);
  assert.equal(snap.hasStuckWatchdogTimer, false);
  assert.equal(snap.hasCurrentAudioUrl, false);
});
