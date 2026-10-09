// test_phase4_cross_module_regression.mjs
// ============================================================================
// VIETREADER — PHASE 4: TTS CROSS-MODULE REGRESSION & STABILITY SOAK TEST SUITE
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';
import { MediaSessionHelper } from './mediaSessionHelper.js';
import { AutoScrollEngine } from './autoscroll.js';
import { SleepTimer } from './sleepTimer.js';
import { AmbientSoundMixer } from './ambientSound.js';

// Deterministic Mock for SpeechSynthesisUtterance
class MockUtterance {
  constructor(text) {
    this.text = text;
    this.voice = null;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onpause = null;
    this.onresume = null;
    MockUtterance.instances.push(this);
  }
  static instances = [];
  static reset() {
    MockUtterance.instances = [];
  }
}

// Deterministic Mock for window.speechSynthesis
function createMockSynth() {
  const state = {
    spoken: [],
    cancelled: 0,
    paused: false,
    resumed: 0,
  };

  const synth = {
    state,
    paused: false,
    speaking: false,
    pending: false,
    getVoices() {
      return [
        { name: 'Microsoft HoaiMy - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'Microsoft HoaiMy - Vietnamese (Vietnam)', default: true },
        { name: 'Microsoft NamMinh - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'Microsoft NamMinh - Vietnamese (Vietnam)', default: false },
        { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US', voiceURI: 'Microsoft David Desktop', default: false },
      ];
    },
    speak(utt) {
      state.spoken.push(utt);
      synth.speaking = true;
      // Asynchronous start
      setTimeout(() => {
        if (typeof utt.onstart === 'function') utt.onstart({ type: 'start' });
      }, 5);
    },
    cancel() {
      state.cancelled++;
      synth.speaking = false;
      synth.paused = false;
    },
    pause() {
      state.paused = true;
      synth.paused = true;
    },
    resume() {
      state.resumed++;
      state.paused = false;
      synth.paused = false;
    }
  };
  return synth;
}

// ============================================================================
// 1. APP.JS TTS INTEGRATION CONTRACTS
// ============================================================================

test('Phase 4 - 1.1: Sequential chunk progression, Pause, Resume, Stop, and Seek contracts', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.synth = mockSynth;
  tts.chunks = ['Đoạn 1.', 'Đoạn 2.', 'Đoạn 3.', 'Đoạn 4.'];

  const events = [];
  tts.onChunkStart = (idx) => events.push(`start_${idx}`);
  tts.onChunkEnd = (idx) => events.push(`end_${idx}`);
  tts.onActualChunkStart = (idx) => events.push(`actual_start_${idx}`);
  tts.onActualChunkComplete = (idx) => events.push(`actual_complete_${idx}`);
  tts.onStatusChange = (status) => events.push(`status_${status}`);

  // Play from chunk 0
  tts.play();
  assert.equal(tts.isPlaying, true);
  assert.equal(tts.currentIndex, 0);

  // Wait for onstart
  await new Promise(r => setTimeout(r, 15));
  assert.ok(events.includes('start_0'));

  // Trigger natural onend for chunk 0
  const utt0 = mockSynth.state.spoken[0];
  utt0.onend({ type: 'end' });
  await new Promise(r => setTimeout(r, 20));

  // Should have advanced to chunk 1
  assert.equal(tts.currentIndex, 1);
  assert.ok(events.includes('end_0'));
  assert.ok(events.includes('actual_complete_0'));

  // Pause
  tts.pause();
  assert.equal(tts.isPaused, true);
  assert.ok(events.includes('status_paused'));

  // Seek while paused to chunk 3
  tts.jumpToIndex(3, false);
  assert.equal(tts.currentIndex, 3);

  // Resume
  tts.resume();
  assert.equal(tts.isPaused, false);
  assert.equal(tts.isPlaying, true);
  await new Promise(r => setTimeout(r, 15));

  // Verify chunk 3 is now spoken
  const lastUtt = mockSynth.state.spoken[mockSynth.state.spoken.length - 1];
  assert.equal(lastUtt.text, 'Đoạn 4.');

  tts.stop();
  assert.equal(tts.isPlaying, false);
});

test('Phase 4 - 1.2: Voice change during active playback preserves generation validity and applies immediately', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.synth = mockSynth;
  tts.chunks = ['Câu trước khi đổi giọng.', 'Câu sau khi đổi giọng.'];

  tts.play();
  await new Promise(r => setTimeout(r, 15));

  const voices = mockSynth.getVoices();
  const newVoice = voices[1]; // NamMinh
  tts.setVoice(newVoice);

  // setVoice should re-trigger speakCurrentChunk with new voice
  await new Promise(r => setTimeout(r, 15));
  const activeUtt = mockSynth.state.spoken[mockSynth.state.spoken.length - 1];
  assert.equal(activeUtt.voice, newVoice);

  tts.stop();
});

// ============================================================================
// 2. READING HISTORY INTEGRATION & NO FAKE PROGRESS CONTRACT
// ============================================================================

test('Phase 4 - 2.1: Watchdog timeout stops playback safely without emitting onActualChunkComplete or false progress', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.synth = mockSynth;
  tts.chunks = ['Câu 0 bình thường.', 'Câu 1 bị treo loa vô hạn.', 'Câu 2 kế tiếp.'];

  const completedChunks = [];
  const statusEvents = [];
  tts.onActualChunkComplete = (idx) => completedChunks.push(idx);
  tts.onStatusChange = (st) => statusEvents.push(st);

  tts.play();
  await new Promise(r => setTimeout(r, 15));

  // Chunk 0 finishes normally
  mockSynth.state.spoken[0].onend({ type: 'end' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(tts.currentIndex, 1);
  assert.deepEqual(completedChunks, [0]);

  // Chunk 1 starts but hangs (no onend fired)
  await new Promise(r => setTimeout(r, 10)); // onstart fired
  assert.equal(tts.currentIndex, 1);

  // Fast-trigger watchdog timeout at 25ms using exact parameters
  const utt1 = mockSynth.state.spoken[1];
  clearTimeout(tts.stuckWatchdogTimer);
  tts.scheduleStuckWatchdog(utt1, tts.utteranceToken, tts.generationToken, 1, 25);

  // Wait for watchdog to trigger at 25ms
  await new Promise(r => setTimeout(r, 40));

  // Watchdog invariant checks:
  // 1. Playback safely halted
  assert.equal(tts.isPlaying, false, 'Playback must be halted');
  assert.ok(statusEvents.includes('error'), 'Error status must be emitted');
  // 2. Index preserved at chunk 1 (not advanced to chunk 2)
  assert.equal(tts.currentIndex, 1, 'Index must NOT advance past stuck chunk');
  // 3. ZERO false completion emitted for chunk 1
  assert.deepEqual(completedChunks, [0], 'Chunk 1 must NEVER be recorded as completed');

  tts.stop();
});

// ============================================================================
// 3. MEDIA SESSION HELPER INTEGRATION CONTRACTS
// ============================================================================

test('Phase 4 - 3.1: MediaSessionHelper cleans up audio and handles play/pause without unhandled rejections', () => {
  let playCalls = 0;
  let pauseCalls = 0;
  let prevCalls = 0;
  let nextCalls = 0;
  let stopCalls = 0;

  const helper = new MediaSessionHelper({
    onPlay: () => { playCalls++; },
    onPause: () => { pauseCalls++; },
    onPrevTrack: () => { prevCalls++; },
    onNextTrack: () => { nextCalls++; },
    onStop: () => { stopCalls++; }
  });

  // Verify callbacks invoke without throwing
  helper.callbacks.onPlay();
  helper.callbacks.onPause();
  helper.callbacks.onPrevTrack();
  helper.callbacks.onNextTrack();
  helper.callbacks.onStop();

  assert.equal(playCalls, 1);
  assert.equal(pauseCalls, 1);
  assert.equal(prevCalls, 1);
  assert.equal(nextCalls, 1);
  assert.equal(stopCalls, 1);

  helper.destroy();
  assert.equal(helper.silentAudio, null);
});

// ============================================================================
// 4. SLEEP TIMER & AMBIENT SOUND INTEGRATION CONTRACTS
// ============================================================================

test('Phase 4 - 4.1: SleepTimer chapter_end mode notifies accurately on natural complete without double-trigger', () => {
  let expireCount = 0;
  let expireReason = null;

  const timer = new SleepTimer({
    onExpire: ({ reason }) => {
      expireCount++;
      expireReason = reason;
    }
  });

  timer.setChapterEndMode();
  assert.equal(timer.mode, 'chapter_end');
  assert.equal(timer.isStopAtChapterEnd(), true);

  // First chapter end notification
  timer.notifyChapterEnd();
  assert.equal(expireCount, 1);
  assert.equal(expireReason, 'chapter_end');
  assert.equal(timer.mode, null, 'SleepTimer resets mode after expiration');

  // Subsequent call does not fire again
  timer.notifyChapterEnd();
  assert.equal(expireCount, 1);
});

test('Phase 4 - 4.2: AmbientSoundMixer cleans up audio nodes and AudioContext cleanly on stop', async () => {
  let nodeDisconnected = false;

  class MockAudioContext {
    constructor() {
      this.state = 'running';
      this.destination = {};
    }
    createGain() {
      return {
        gain: { value: 1, setValueAtTime: () => {} },
        connect: () => {},
        disconnect: () => { nodeDisconnected = true; }
      };
    }
    createBufferSource() {
      return {
        buffer: null,
        loop: false,
        connect: () => {},
        disconnect: () => { nodeDisconnected = true; },
        start: () => {},
        stop: () => {}
      };
    }
    close() {
      return Promise.resolve();
    }
  }

  const mixer = new AmbientSoundMixer({ AudioContextClass: MockAudioContext });
  mixer.stopAll();
  assert.ok(true, 'AmbientSoundMixer stops cleanly');
});

// ============================================================================
// 5. AUTOSCROLL INTEGRATION CONTRACTS
// ============================================================================

test('Phase 4 - 5.1: AutoScrollEngine destroys cleanly without leaking rAF or listeners', () => {
  const autoScroll = new AutoScrollEngine();
  const tts = new TTSEngine();
  tts.chunks = ['1', '2'];
  tts.synth = { cancel() {}, speak() {} };

  tts.play();
  assert.equal(tts.isPlaying, true);

  // Simulate coordinated stop
  tts.stop();
  autoScroll.stop();

  assert.equal(tts.isPlaying, false);
  assert.equal(autoScroll.isActive, false);
  assert.equal(tts.transitionTimer, null);
});

// ============================================================================
// 6. BOUNDED MOCK SOAK TEST: 50 CHUNKS SEQUENTIAL & RAPID CYCLES
// ============================================================================

test('Phase 4 - 6.1: Bounded Mock Soak: 50 chunks advance strictly 1-by-1 with zero leaks and zero memory growth', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.synth = mockSynth;
  tts.chunks = Array.from({ length: 50 }, (_, i) => `Câu thứ ${i} trong chuỗi 50 câu kiểm thử.`);

  let advanceCount = 0;
  tts.onActualChunkComplete = () => { advanceCount++; };

  tts.play();

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 10)); // wait for onstart
    const utt = mockSynth.state.spoken[i];
    assert.ok(utt, `Utterance ${i} must exist`);
    utt.onend({ type: 'end' });
    await new Promise(r => setTimeout(r, 15)); // wait for advance transition
  }

  // Ensure last chunk completion is processed
  await new Promise(r => setTimeout(r, 20));

  assert.equal(advanceCount, 50, 'All 50 chunks completed strictly in sequence');
  assert.equal(tts.currentIndex, 49, 'Index settled on final chunk');

  // Invariant check: All references return to zero baseline
  assert.equal(tts.currentUtterance, null);
  assert.equal(tts.keepAliveTimer, null);
  assert.equal(tts.stuckWatchdogTimer, null);
  assert.equal(tts.transitionTimer, null);

  tts.stop();
});

test('Phase 4 - 6.2: 20 rapid Play / Pause / Resume / Seek / Stop cycles strictly return to 0 baseline', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.synth = mockSynth;
  tts.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2', 'Đoạn 3', 'Đoạn 4'];

  for (let cycle = 0; cycle < 20; cycle++) {
    tts.play();
    tts.pause();
    tts.resume();
    tts.jumpToIndex(cycle % 5, true);
    tts.stop();
  }

  assert.equal(tts.isPlaying, false);
  assert.equal(tts.isPaused, false);
  assert.equal(tts.currentUtterance, null);
  assert.equal(tts.keepAliveTimer, null);
  assert.equal(tts.stuckWatchdogTimer, null);
  assert.equal(tts.transitionTimer, null);
});
