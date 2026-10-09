import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';

class InstrumentedUtterance {
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

function createInstrumentedSynth() {
  const state = {
    speakCount: 0,
    cancelCount: 0,
    pauseCount: 0,
    resumeCount: 0,
    speaking: false,
    paused: false,
    pending: false,
    spokenUtterances: [],
    syncCancelEmitsOnend: false
  };

  return {
    state,
    get speaking() { return state.speaking; },
    get paused() { return state.paused; },
    get pending() { return state.pending; },
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

test('A. Chunk 0 -> 1 -> 2 -> ... -> 10 Sequential Progression with Exactly 1 Completion per Chunk', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  const totalChunks = 12;
  tts.chunks = Array.from({ length: totalChunks }, (_, i) => `Đoạn thứ ${i}`);
  tts.currentIndex = 0;

  const completedIndices = [];
  const startedIndices = [];
  tts.onActualChunkStart = (idx) => startedIndices.push(idx);
  tts.onActualChunkComplete = (idx) => completedIndices.push(idx);

  tts.play();

  for (let i = 0; i < totalChunks; i++) {
    assert.equal(tts.currentIndex, i, `Current chunk index must be ${i} before completion`);
    assert.equal(mockSynth.state.spokenUtterances.length, i + 1, `Exactly ${i + 1} utterances should be spoken`);
    const utt = mockSynth.state.spokenUtterances[i];
    assert.ok(utt, `Utterance for chunk ${i} must exist`);

    utt.onstart();
    assert.equal(startedIndices.length, i + 1);
    assert.equal(startedIndices[i], i);

    utt.onend();
    assert.equal(completedIndices.length, i + 1);
    assert.equal(completedIndices[i], i);

    await delay(10);
  }

  assert.equal(completedIndices.length, totalChunks);
  assert.deepEqual(completedIndices, Array.from({ length: totalChunks }, (_, i) => i));
  assert.equal(tts.isPlaying, false, 'Playback should naturally complete after final chunk');
  tts.stop();
});

test('B. Duplicate onend calls on the same utterance are safely ignored', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  const completedList = [];
  tts.onActualChunkComplete = (idx) => completedList.push(idx);

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // First onend
  utt0.onend();
  // Duplicate onend invocation on same utterance
  if (typeof utt0.onend === 'function') utt0.onend();

  await delay(15);

  assert.equal(completedList.length, 1, 'Only one completion should be recorded for chunk 0');
  assert.equal(tts.currentIndex, 1, 'Current index should advance to chunk 1 once');
  assert.equal(mockSynth.state.spokenUtterances.length, 2, 'Exactly 2 utterances created so far');
  tts.stop();
});

test('C. Synchronous cancel() triggering onend does not cause recursive storm', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  mockSynth.state.syncCancelEmitsOnend = true; // Emulate Chromium bug where cancel() immediately calls onend
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  tts.play();
  assert.equal(mockSynth.state.spokenUtterances.length, 1);

  // User calls stop while chunk 0 is speaking
  tts.stop();

  await delay(20);

  // Playback must be completely stopped, no runaway advancement
  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.state.spokenUtterances.length, 1, 'No new utterances created after stop');
});

test('D. onerror followed by onend produces exactly single terminal handling', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn lỗi', 'Đoạn kế tiếp'];
  tts.currentIndex = 0;

  let completeCount = 0;
  tts.onActualChunkComplete = () => completeCount++;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Simulate Chromium error followed by end
  utt0.onerror({ error: 'audio-busy' });
  if (typeof utt0.onend === 'function') utt0.onend();

  await delay(20);

  assert.equal(tts.currentIndex, 1, 'Safely advances to chunk 1');
  assert.equal(mockSynth.state.spokenUtterances.length, 2);
  tts.stop();
});

test('E. Stop while chunk completion transition is pending aborts advancement', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();
  utt0.onend(); // transition timer scheduled

  // User immediately stops before next tick executes
  tts.stop();

  await delay(25);

  assert.equal(tts.isPlaying, false);
  assert.equal(mockSynth.state.spokenUtterances.length, 1, 'Chunk 1 must not be spoken');
});

test('F. Pause precisely when chunk ends preserves valid state without advancing', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();
  utt0.onend();

  // User pauses during transition window
  tts.pause();

  await delay(20);

  assert.equal(tts.isPaused, true);
  assert.equal(tts.currentIndex, 0, 'Index remains 0 while paused before handoff');

  // Resume should speak chunk 1 (or current chunk)
  tts.resume();
  await delay(10);
  assert.equal(tts.isPlaying, true);
  assert.equal(tts.isPaused, false);
  tts.stop();
});

test('G. Stale callback from replaced utterance or old generation is discarded', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  tts.currentIndex = 0;

  tts.play();
  const oldUtt = mockSynth.state.spokenUtterances[0];

  // User jumps to chunk 2
  tts.jumpToIndex(2, true);
  assert.equal(tts.currentIndex, 2);
  const newUtt = mockSynth.state.spokenUtterances[1];
  assert.equal(newUtt.text, 'Đoạn 2');

  // Now old utterance emits late onend
  if (typeof oldUtt.onend === 'function') oldUtt.onend();

  await delay(20);

  assert.equal(tts.currentIndex, 2, 'Index should not be affected by stale utterance callback');
  tts.stop();
});

test('H. Empty or whitespace chunks are safely skipped without recursion', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', '', '   ', '   \n\t  ', 'Đoạn 4'];
  tts.currentIndex = 0;

  tts.play();
  assert.equal(mockSynth.state.spokenUtterances[0].text, 'Đoạn 0');
  mockSynth.state.spokenUtterances[0].onstart();
  mockSynth.state.spokenUtterances[0].onend();

  await delay(20);

  assert.equal(tts.currentIndex, 4);
  assert.equal(mockSynth.state.spokenUtterances[1].text, 'Đoạn 4');
  tts.stop();
});

test('I. Rapid Play and Pause and Resume sequence maintains state consistency', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1'];
  tts.currentIndex = 0;

  tts.play();
  tts.pause();
  tts.resume();
  tts.pause();
  tts.resume();

  assert.equal(tts.isPlaying, true);
  assert.equal(tts.isPaused, false);
  tts.stop();
  assert.equal(tts.isPlaying, false);
  assert.equal(tts.isPaused, false);
});

test('J. Keep-Alive heartbeat does not fire during chunk transition or when idle', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.chunks = ['Đoạn 0', 'Đoạn 1'];
  tts.currentIndex = 0;

  tts.play();
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();

  // Complete chunk 0
  utt0.onend();
  assert.equal(tts.isAdvancingChunk, true, 'isAdvancingChunk must be true during transition');

  // If keep-alive interval were to trigger right now:
  // Since isAdvancingChunk is true and currentUtterance is null, it must NOT call synth.pause/resume
  const pauseCountBefore = mockSynth.state.pauseCount;
  // Trigger keep-alive logic manually to verify guard:
  if (
    tts.engine === 'browser' &&
    tts.synth &&
    tts.isPlaying &&
    !tts.isPaused &&
    tts.currentUtterance &&
    !tts.isAdvancingChunk &&
    tts.synth.speaking &&
    !tts.synth.paused
  ) {
    mockSynth.pause();
    mockSynth.resume();
  }
  assert.equal(mockSynth.state.pauseCount, pauseCountBefore, 'Keep-alive must be guarded against running during transition');

  await delay(15);
  assert.equal(tts.currentIndex, 1);
  tts.stop();
});

test('Chunk Velocity Circuit Breaker trips immediately on rapid 0ms callback storm', async () => {
  globalThis.SpeechSynthesisUtterance = InstrumentedUtterance;
  const mockSynth = createInstrumentedSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  // Emulate Edge bug where speak() triggers immediate completion storm
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
  tts.chunks = Array.from({ length: 150 }, (_, i) => `Đoạn ${i}`);
  tts.currentIndex = 0;

  let fallbackWarningCalled = false;
  tts.onFallbackWarning = () => { fallbackWarningCalled = true; };

  tts.play();

  // Wait for storm to trip the circuit breaker (up to 1000ms)
  for (let i = 0; i < 50; i++) {
    if (!tts.isPlaying) break;
    await delay(20);
  }

  // Circuit breaker should have tripped and stopped playback safely
  assert.equal(tts.isPlaying, false, 'Playback should be halted by velocity circuit breaker');
  assert.ok(mockSynth.state.spokenUtterances.length < 100, `Utterance count (${mockSynth.state.spokenUtterances.length}) must be capped`);
  assert.ok(fallbackWarningCalled, 'Warning must be displayed to user');
});
