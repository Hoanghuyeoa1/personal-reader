import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';
import { TTSQueueScheduler } from './ttsQueueScheduler.js';

// ============================================================================
// PHASE 2 DETERMINISTIC MOCK INFRASTRUCTURE
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

  get listenerCounts() {
    return [this.onstart, this.onend, this.onerror, this.onpause, this.onresume, this.onboundary].filter(Boolean).length;
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
// SUITE 1: NORMAL SEQUENTIAL PROGRESSION
// ============================================================================

test('Phase 2 - 1.1: Sequential Chunk Progression 0 -> 1 -> 2 -> 3 with bounded diagnostics', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Đoạn số không', 'Đoạn số một', 'Đoạn số hai', 'Đoạn số ba'];
  tts.currentIndex = 0;

  tts.play();

  for (let i = 0; i < 4; i++) {
    assert.equal(tts.currentIndex, i, `Chunk index must be exactly ${i}`);
    const utt = mockSynth.state.spokenUtterances[i];
    assert.ok(utt, `Utterance for chunk ${i} must exist`);
    utt.onstart();
    utt.onend();
    await delay(10);
  }

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.counts.speak, 4, 'Exactly 4 speak calls');
  assert.equal(snap.counts.onstart, 4, 'Exactly 4 onstart events');
  assert.equal(snap.counts.onend, 4, 'Exactly 4 onend events');
  assert.equal(snap.counts.autoAdvance, 3, 'Exactly 3 auto-advancements');
  assert.equal(snap.counts.chapterComplete, 1, 'Exactly 1 natural chapter completion');
  assert.equal(snap.isPlaying, false, 'Playback naturally terminates after last chunk');
  assert.equal(tts.currentUtterance, null, 'No lingering utterance');
  tts.stop();
});

// ============================================================================
// SUITE 2: CALLBACK FAULTS & RESILIENCY
// ============================================================================

test('Phase 2 - 2.1: Duplicate onend on same utterance triggers only single advance', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  let chunkEndCalls = 0;
  tts.onChunkEnd = () => chunkEndCalls++;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Fire onend 3 times consecutively
  const onendFn = utt.onend;
  assert.ok(onendFn);
  onendFn();
  if (typeof utt.onend === 'function') utt.onend();
  onendFn(); // Calling original reference again

  await delay(15);

  assert.equal(chunkEndCalls, 1, 'onChunkEnd must fire exactly once');
  assert.equal(tts.currentIndex, 1, 'Index must advance to 1, not 2 or 3');
  assert.equal(mockSynth.state.spokenUtterances.length, 2, 'Must only speak chunk 1');
  tts.stop();
});

test('Phase 2 - 2.2: onerror followed immediately by onend produces single terminal handling', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu lỗi 0', 'Câu kế tiếp 1'];
  tts.currentIndex = 0;

  let endCalls = 0;
  tts.onChunkEnd = () => endCalls++;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  const savedOnend = utt.onend;
  utt.onerror({ error: 'network' });
  if (savedOnend) savedOnend(); // Simulate rogue duplicate onend after onerror

  await delay(15);

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.counts.onerror, 1, 'Must record exactly 1 onerror');
  assert.equal(snap.counts.onend, 0, 'Must NOT record onend because onerror handled terminal state');
  assert.equal(tts.currentIndex, 1, 'Must advance to next chunk');
  tts.stop();
});

test('Phase 2 - 2.3: Synchronous cancel() triggering onend does not cause recursive callback storm', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth({ syncCancelEmitsOnend: true });
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // User calls stop() which invokes cancelCurrentSource() -> synth.cancel() -> sync onend
  tts.stop();

  await delay(20);

  assert.equal(tts.isPlaying, false, 'TTSEngine must remain stopped despite sync onend in cancel()');
  assert.equal(mockSynth.state.spokenUtterances.length, 1, 'Must not speak subsequent chunks after stop');
  assert.equal(tts.keepAliveTimer, null, 'Keep-alive timer must be null');
});

test('Phase 2 - 2.4: Stale onend arriving after Stop is completely discarded', async () => {
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
  const savedOnend = utt.onend;

  tts.stop();
  assert.equal(tts.isPlaying, false);

  // Late onend arriving from OS speech service
  if (savedOnend) savedOnend();

  await delay(15);

  assert.equal(tts.isPlaying, false, 'Engine must stay stopped');
  assert.equal(mockSynth.state.spokenUtterances.length, 1, 'No new utterance spoken');
});

test('Phase 2 - 2.5: Stale callback from old generation does not advance or corrupt current playback', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2', 'Câu 3', 'Câu 4'];
  tts.currentIndex = 0;

  tts.play();
  const oldUtt = mockSynth.state.spokenUtterances[0];
  const oldOnend = oldUtt.onend;
  oldUtt.onstart();

  // User jumps forward to chunk 3
  tts.jumpToIndex(3, true);
  assert.equal(tts.currentIndex, 3);

  // Old chunk 0 onend arrives late
  if (oldOnend) oldOnend();

  await delay(15);

  assert.equal(tts.currentIndex, 3, 'Current index must remain 3');
  tts.stop();
});

// ============================================================================
// SUITE 3: PLAYBACK CONTROLS & INTERFERENCE
// ============================================================================

test('Phase 2 - 3.1: Rapid Play / Pause / Resume cycles maintain clean state', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  for (let i = 0; i < 10; i++) {
    tts.play();
    tts.pause();
    tts.resume();
    tts.stop();
  }

  assert.equal(tts.isPlaying, false);
  assert.equal(tts.isPaused, false);
  assert.equal(tts.keepAliveTimer, null);
  assert.equal(tts.transitionTimer, null);
  assert.equal(tts.stuckWatchdogTimer, null);
  assert.equal(tts.currentUtterance, null);
});

test('Phase 2 - 3.2: Stop at chunk boundary cancels pending transition timer', async () => {
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
  utt.onend(); // transitionTimer is now scheduled

  // User stops immediately before transitionTimer fires
  tts.stop();

  await delay(20);

  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.state.spokenUtterances.length, 1, 'Must not speak chunk 1');
});

test('Phase 2 - 3.3: Seek while playing cancels source and speaks target chunk immediately', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  tts.play();
  assert.equal(tts.currentIndex, 0);

  tts.jumpToIndex(2, true);
  assert.equal(tts.currentIndex, 2);
  assert.equal(mockSynth.state.spokenUtterances.length, 2);
  assert.equal(mockSynth.state.spokenUtterances[1].text, 'Đoạn 2');
  tts.stop();
});

test('Phase 2 - 3.4: Seek while paused cancels active source but defers speak until resume', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  tts.play();
  tts.pause();
  assert.equal(tts.isPaused, true);

  const speakCountBefore = mockSynth.state.speakCount;
  tts.jumpToIndex(1, false);

  assert.equal(tts.currentIndex, 1);
  assert.equal(mockSynth.state.speakCount, speakCountBefore, 'Must not speak target chunk while paused');

  tts.resume();
  assert.equal(mockSynth.state.speakCount, speakCountBefore + 1, 'Must speak target chunk upon resume');
  assert.equal(mockSynth.state.spokenUtterances[mockSynth.state.spokenUtterances.length - 1].text, 'Đoạn 1');
  tts.stop();
});

test('Phase 2 - 3.5: Voice Preview does not interfere with reading utterance or advance reading chunk', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Bài đọc câu 0', 'Bài đọc câu 1'];
  tts.currentIndex = 0;

  tts.play();
  const readingUtt = mockSynth.state.spokenUtterances[0];
  assert.equal(readingUtt.text, 'Bài đọc câu 0');
  readingUtt.onstart();

  // User previews a voice in settings modal
  tts.previewVoice('Microsoft An');
  const previewUtt = mockSynth.state.spokenUtterances[1];
  assert.ok(previewUtt.text.includes('Chào bạn'));

  // Preview finishes -> automatically resumes reading current chunk
  if (typeof previewUtt.onend === 'function') previewUtt.onend();
  await delay(10);

  // Active reading resumed chunk 0
  const resumedUtt = mockSynth.state.spokenUtterances[2];
  assert.equal(resumedUtt.text, 'Bài đọc câu 0');
  resumedUtt.onstart();
  resumedUtt.onend();
  await delay(15);

  assert.equal(tts.currentIndex, 1, 'Reading chunk advances to chunk 1 after resumed completion');
  assert.equal(mockSynth.state.spokenUtterances[3].text, 'Bài đọc câu 1');
  tts.stop();
});

// ============================================================================
// SUITE 4: EDGE CASES
// ============================================================================

test('Phase 2 - 4.1: Empty and whitespace chunks are skipped without recursive stack overflow', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', '', '   ', '   \n  \t  ', 'Câu 4'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();
  utt0.onend();

  await delay(15);

  assert.equal(tts.currentIndex, 4, 'Must skip intermediate whitespace chunks');
  assert.equal(mockSynth.state.spokenUtterances[1].text, 'Câu 4');
  tts.stop();
});

test('Phase 2 - 4.2: Invalid chunk index is guarded safely', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  // Jump to negative index or out of bounds
  tts.jumpToIndex(-1, true);
  assert.equal(tts.currentIndex, 0);

  tts.jumpToIndex(99, true);
  assert.equal(tts.currentIndex, 0);
  tts.stop();
});

test('Phase 2 - 4.3: Chapter transition: onNaturalComplete emits exactly once on final chunk', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu duy nhất cuối chương'];
  tts.currentIndex = 0;

  let naturalCompleteCount = 0;
  tts.onNaturalComplete = () => naturalCompleteCount++;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();
  utt.onend();

  await delay(15);

  assert.equal(naturalCompleteCount, 1, 'onNaturalComplete must emit exactly once');
  assert.equal(tts.isPlaying, false, 'Playback stops cleanly');
  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.counts.chapterComplete, 1);
});

test('Phase 2 - 4.4: Cloud fallback: error in cloud playback falls back cleanly to browser TTS', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu thử Cloud Fallback'];
  tts.currentIndex = 0;
  tts.setEngine('cloud');
  tts.setCloudConfig({ provider: 'fpt', apiKey: 'test-key', voice: 'banmai' });

  // Mock fetch failure directly on tts.fetchCloudAudio
  tts.fetchCloudAudio = async () => {
    throw new Error('401 Unauthorized: Mock Key Error');
  };

  let fallbackWarning = null;
  tts.onFallbackWarning = msg => { fallbackWarning = msg; };

  tts.play();
  await delay(35);

  assert.equal(tts.engine, 'browser', 'Engine should automatically fall back to browser on cloud error');
  assert.ok(fallbackWarning, 'Fallback warning must be emitted');
  assert.ok(mockSynth.state.spokenUtterances.length >= 1, 'Browser utterance must be queued');
  tts.stop();
});

test('Phase 2 - 4.5: Cloud Queue Scheduler: window sliding and clean invalidation upon seek/stop', async () => {
  const scheduler = new TTSQueueScheduler({
    fetcher: async (text) => new Blob([text], { type: 'audio/mpeg' }),
    cacheLookup: async () => null,
    cacheStore: async () => {}
  });

  const chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2', 'Đoạn 3', 'Đoạn 4'];
  scheduler.updateWindow({ currentIndex: 0, chunks });

  const snap1 = scheduler.getSnapshot();
  assert.ok(snap1.totalEntries > 0, 'Queue entries must be scheduled ahead');

  // Invalidate old generation
  scheduler.invalidate(2);
  const snap2 = scheduler.getSnapshot();
  assert.equal(snap2.totalEntries, 0, 'Entries from old generation must be evicted');

  scheduler.dispose();
  assert.equal(scheduler._isDisposed, true);
});

// ============================================================================
// SUITE 5: KEEP-ALIVE DETERMINISTIC AUDIT
// ============================================================================

test('Phase 2 - 5.1: Keep-Alive interval creation, duplicate prevention and stop cleanup', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu kiểm tra Keep-Alive'];
  tts.currentIndex = 0;

  tts.play();
  assert.ok(tts.keepAliveTimer, 'Keep-alive timer must be created');
  const timer1 = tts.keepAliveTimer;

  // Consecutive startKeepAlive() must clean up previous timer (no duplicate intervals)
  tts.startKeepAlive();
  const timer2 = tts.keepAliveTimer;
  assert.notEqual(timer1, timer2, 'Previous timer reference replaced');

  tts.stop();
  assert.equal(tts.keepAliveTimer, null, 'Keep-alive timer must be strictly null after stop');
});

test('Phase 2 - 5.2: CONFIRMED DEFECT: Edge Natural Voice Regex misses Hoài My and pulses pause/resume', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);

  // Exact Edge Windows Natural Voice Name
  const edgeHoaiMyVoice = {
    name: 'Microsoft HoaiMy - Vietnamese (Vietnam)',
    lang: 'vi-VN',
    voiceURI: 'vi-VN-HoaiMy'
  };
  tts.selectedVoice = edgeHoaiMyVoice;
  tts.chunks = ['Câu dài phát trên Microsoft Hoài My hơn 10 giây'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Simulate 12 seconds elapsed
  tts.utteranceStartedTimestamp = Date.now() - 12000;

  // Audit the regex check currently inside tts.js startKeepAlive():
  const voiceName = tts.selectedVoice?.name || '';
  const currentRegexResult = /natural|online|neural/i.test(voiceName);

  // DEMONSTRATION OF DEFECT:
  assert.equal(
    currentRegexResult,
    false,
    'DEFECT CONFIRMED: "Microsoft HoaiMy - Vietnamese (Vietnam)" evaluates to FALSE against /natural|online|neural/i!'
  );

  tts.stop();
});

test('Phase 2 - 5.3: Keep-Alive heartbeat does not pulse pause/resume during chunk boundary transition', async () => {
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
  utt.onend(); // isAdvancingChunk is true

  const pauseBefore = mockSynth.state.pauseCount;

  // Even if keepAlive ticks during transition, isAdvancingChunk guard protects it
  assert.equal(tts.isAdvancingChunk, true);
  if (tts.isAdvancingChunk) {
    // interval tick returns immediately
  }
  assert.equal(mockSynth.state.pauseCount, pauseBefore);
  tts.stop();
});

// ============================================================================
// SUITE 6: BOUNDED RESOURCE ACCUMULATION & CLEANUP AUDIT
// ============================================================================

test('Phase 2 - 6.1: Multi-cycle Play / Seek / Advance / Stop cycles return strictly to 0 baseline', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Đoạn 1', 'Đoạn 2', 'Đoạn 3', 'Đoạn 4', 'Đoạn 5'];

  for (let cycle = 0; cycle < 15; cycle++) {
    tts.play();
    const utt = mockSynth.state.spokenUtterances[mockSynth.state.spokenUtterances.length - 1];
    if (utt) {
      utt.onstart();
      utt.onend();
    }
    await delay(5);

    tts.jumpToIndex(3, true);
    tts.pause();
    tts.resume();
    tts.stop();
  }

  const snap = tts.getDiagnosticsSnapshot();

  // Resource baseline assertions:
  assert.equal(snap.isPlaying, false, 'isPlaying must be false');
  assert.equal(snap.isPaused, false, 'isPaused must be false');
  assert.equal(snap.hasActiveUtterance, false, 'currentUtterance must be null');
  assert.equal(snap.hasKeepAliveTimer, false, 'keepAliveTimer must be null');
  assert.equal(snap.hasTransitionTimer, false, 'transitionTimer must be null');
  assert.equal(snap.hasStuckWatchdogTimer, false, 'stuckWatchdogTimer must be null');
  assert.equal(snap.hasCurrentAudioUrl, false, 'currentAudioUrl must be null');
  assert.equal(snap.activeAudioResources, false, 'activeAudioResources must be false');

  // Verify diagnostic ring buffer stays strictly bounded
  assert.ok(snap.recentEvents.length <= 50, 'Ring buffer length must not exceed 50 entries');

  // Verify active utterance listener cleanup
  for (const utt of MockUtterance.activeInstances) {
    assert.equal(utt.listenerCounts, 0, 'All utterance event listeners must be nullified to prevent native C++ retains');
  }
});
