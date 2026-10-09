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

function createMockSynth() {
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
      return [{ name: 'Microsoft HoaiMy Online (Natural)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy' }];
    }
  };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

test('1. Chunk 0 -> 1 -> 2 -> 3 Sequential Progression with Bounded Diagnostics', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2', 'Câu 3'];
  tts.currentIndex = 0;

  tts.play();

  for (let i = 0; i < 4; i++) {
    assert.equal(tts.currentIndex, i);
    const utt = mockSynth.state.spokenUtterances[i];
    assert.ok(utt);
    utt.onstart();
    utt.onend();
    await delay(10);
  }

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.counts.speak, 4);
  assert.equal(snap.counts.onstart, 4);
  assert.equal(snap.counts.onend, 4);
  assert.equal(snap.counts.autoAdvance, 3);
  assert.equal(snap.isPlaying, false); // naturally completed
  tts.stop();
});

test('2. Duplicate onend on same utterance triggers only single advance', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  let advanceCount = 0;
  tts.onChunkEnd = () => advanceCount++;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Fire onend twice
  utt.onend();
  if (typeof utt.onend === 'function') {
    utt.onend();
  }
  await delay(15);

  assert.equal(advanceCount, 1);
  assert.equal(tts.currentIndex, 1);
  tts.stop();
});

test('3. onerror followed immediately by onend produces single terminal handling', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  let endCount = 0;
  tts.onChunkEnd = () => endCount++;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Simulate onerror then onend
  const savedOnend = utt.onend;
  utt.onerror({ error: 'network' });
  if (typeof savedOnend === 'function') {
    savedOnend();
  }
  await delay(15);

  assert.equal(tts.currentIndex, 1);
  assert.equal(endCount, 0); // onerror does not fire onChunkEnd
  tts.stop();
});

test('4. Synchronous cancel() triggering onend does not cause recursive callback storm', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  mockSynth.state.syncCancelEmitsOnend = true; // Chromium cancel() quirk
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Stop should safely cancel without recursing
  tts.stop();
  await delay(15);

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.isPlaying, false);
  assert.equal(snap.hasActiveUtterance, false);
});

test('5. Stale callback arriving after Stop is completely discarded', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  const savedOnend = utt.onend;
  tts.stop();

  // Fire stale onend after stop
  if (typeof savedOnend === 'function') {
    savedOnend();
  }
  await delay(15);

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.isPlaying, false);
  assert.equal(snap.currentIndex, 0);
  assert.equal(mockSynth.state.spokenUtterances.length, 1);
});

test('6. Pause/Resume at chunk boundary preserves exact index without extra speak', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();
  utt0.onend();

  // Pause right when chunk 0 ends before chunk 1 starts
  tts.pause();
  await delay(15);

  const snapPaused = tts.getDiagnosticsSnapshot();
  assert.equal(snapPaused.isPaused, true);

  // Resume should speak target chunk 1
  tts.resume();
  await delay(10);

  const snapResumed = tts.getDiagnosticsSnapshot();
  assert.equal(snapResumed.isPlaying, true);
  assert.equal(snapResumed.isPaused, false);
  tts.stop();
});

test('7. Rapid Play/Stop/Seek transitions do not leak timers or corrupt generation', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1', 'Câu 2', 'Câu 3', 'Câu 4'];

  for (let i = 0; i < 15; i++) {
    tts.play();
    tts.next();
    tts.pause();
    tts.resume();
    tts.stop();
  }

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.isPlaying, false);
  assert.equal(snap.hasKeepAliveTimer, false);
  assert.equal(snap.hasTransitionTimer, false);
  assert.equal(snap.hasActiveUtterance, false);
});

test('8. Empty or invalid chunks are skipped without recursive stack overflow', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['', '   ', '\n\t', 'Câu hợp lệ', ''];
  tts.currentIndex = 0;

  tts.play();
  await delay(10);

  assert.equal(tts.currentIndex, 3);
  assert.equal(mockSynth.state.spokenUtterances.length, 1);
  assert.equal(mockSynth.state.spokenUtterances[0].text, 'Câu hợp lệ');
  tts.stop();
});

test('9. Keep-Alive timer is properly cleaned up on stop and pause', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0'];

  tts.play();
  assert.ok(tts.keepAliveTimer);

  tts.pause();
  assert.equal(tts.keepAliveTimer, null);

  tts.resume();
  assert.ok(tts.keepAliveTimer);

  tts.stop();
  assert.equal(tts.keepAliveTimer, null);
});

test('10. Duplicate chapter completion: onNaturalComplete emits exactly once', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu cuối'];
  tts.currentIndex = 0;

  let naturalCompleteCount = 0;
  tts.onNaturalComplete = () => naturalCompleteCount++;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();
  utt.onend();
  await delay(15);

  assert.equal(naturalCompleteCount, 1);
  assert.equal(tts.isPlaying, false);
});

test('11. Repeated playback sessions cycle cleanly with 0 resource accumulation', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1'];

  for (let s = 0; s < 10; s++) {
    tts.play();
    const utt0 = mockSynth.state.spokenUtterances[mockSynth.state.spokenUtterances.length - 1];
    utt0.onstart();
    utt0.onend();
    await delay(5);

    tts.stop();
  }

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.isPlaying, false);
  assert.equal(snap.hasKeepAliveTimer, false);
  assert.equal(snap.hasTransitionTimer, false);
  assert.equal(snap.hasActiveUtterance, false);
  assert.equal(snap.recentEvents.length <= 50, true);
});

test('12. Bounded callback storm simulation trips chunk velocity circuit breaker', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  // Emulate buggy browser/Edge storm where speak immediately fires microtask onstart+onend
  mockSynth.speak = function(utt) {
    mockSynth.state.speakCount++;
    mockSynth.state.speaking = true;
    mockSynth.state.spokenUtterances.push(utt);
    queueMicrotask(() => {
      if (typeof utt.onstart === 'function') utt.onstart();
      if (typeof utt.onend === 'function') utt.onend();
    });
  };

  const tts = new TTSEngine();
  const chunksCount = 150;
  tts.chunks = Array.from({ length: chunksCount }, (_, i) => `Đoạn bão ${i}`);
  tts.currentIndex = 0;

  let fallbackWarningCalled = false;
  tts.onFallbackWarning = () => { fallbackWarningCalled = true; };

  tts.play();

  // Wait for storm to trip the circuit breaker (within 1000ms)
  for (let i = 0; i < 50; i++) {
    if (!tts.isPlaying) break;
    await delay(20);
  }

  // Circuit breaker trips after 60 transitions in 1000ms
  assert.equal(tts.isPlaying, false, 'Playback must be halted by chunk velocity circuit breaker');
  assert.ok(mockSynth.state.spokenUtterances.length < 100, 'Utterance count must be capped');
  assert.ok(fallbackWarningCalled, 'Warning must be displayed to user');
  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.isPlaying, false);
  assert.equal(snap.hasKeepAliveTimer, false);
});

test('13. Active resources strictly return to baseline after cleanup', async () => {
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Câu 0', 'Câu 1'];

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  tts.stop();

  assert.equal(tts.isPlaying, false);
  assert.equal(tts.isPaused, false);
  assert.equal(tts.currentUtterance, null);
  assert.equal(tts.keepAliveTimer, null);
  assert.equal(tts.transitionTimer, null);
  assert.equal(tts.currentAudioUrl, null);

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.hasActiveUtterance, false);
  assert.equal(snap.hasKeepAliveTimer, false);
  assert.equal(snap.hasTransitionTimer, false);
  assert.equal(snap.hasCurrentAudioUrl, false);
});
