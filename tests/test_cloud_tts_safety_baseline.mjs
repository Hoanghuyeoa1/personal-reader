import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';

class MockAudioElement {
  constructor() {
    this.src = '';
    this.paused = true;
    this.currentTime = 0;
    this.playbackRate = 1.0;
    this.volume = 1.0;
    this._listeners = {};
    this.playCount = 0;
    this.pauseCount = 0;
    this.shouldRejectPlay = false;
  }

  addEventListener(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  removeEventListener(event, handler) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(h => h !== handler);
  }

  emit(event, ...args) {
    const list = this._listeners[event] || [];
    for (const h of list) {
      h(...args);
    }
    const prop = this[`on${event}`];
    if (typeof prop === 'function') {
      prop(...args);
    }
  }

  async play() {
    this.playCount++;
    if (this.shouldRejectPlay) {
      this.emit('error', new Error('Play rejected by user gesture policy'));
      return Promise.reject(new Error('Play rejected by user gesture policy'));
    }
    this.paused = false;
    this.emit('playing');
    return Promise.resolve();
  }

  pause() {
    this.pauseCount++;
    this.paused = true;
    this.emit('pause');
  }

  removeAttribute(attr) {
    if (attr === 'src') this.src = '';
  }
}

// Polyfill URL.createObjectURL & URL.revokeObjectURL for Node.js
if (!URL.createObjectURL) {
  URL.createObjectURL = () => `blob:mock-url-${Math.random()}`;
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = () => {};
}

const delay = ms => new Promise(r => setTimeout(r, ms));

function createEngineWithMockAudio() {
  const mockAudio = new MockAudioElement();
  const engine = new TTSEngine();
  engine.audioElement = mockAudio;
  engine.initAudioElement(); // Re-bind listeners to mockAudio
  engine.engine = 'cloud';
  engine.cloudConfig = { apiKey: 'dummy-key', provider: 'fpt', voice: 'banmai' };
  engine.fetchCloudAudio = async () => new Blob(['dummy audio']);
  return { engine, mockAudio };
}

test('Cloud TTS Safety 1: Sequential Cloud chunk 0 -> 1 -> 2 progression', async () => {
  const { engine, mockAudio } = createEngineWithMockAudio();
  engine.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  engine.currentIndex = 0;

  const startedChunks = [];
  const completedChunks = [];
  engine.onActualChunkStart = (idx) => startedChunks.push(idx);
  engine.onActualChunkComplete = (idx) => completedChunks.push(idx);

  engine.play();
  await delay(15);

  assert.equal(engine.currentIndex, 0);
  assert.equal(startedChunks.length, 1);
  assert.equal(startedChunks[0], 0);

  // End chunk 0
  mockAudio.emit('ended');
  await delay(15);

  assert.equal(completedChunks.length, 1);
  assert.equal(completedChunks[0], 0);
  assert.equal(engine.currentIndex, 1);

  // Chunk 1 starts playing on audio element
  await delay(15);
  assert.equal(startedChunks.length, 2);
  assert.equal(startedChunks[1], 1);

  // End chunk 1
  mockAudio.emit('ended');
  await delay(15);

  assert.equal(completedChunks.length, 2);
  assert.equal(completedChunks[1], 1);
  assert.equal(engine.currentIndex, 2);

  // Chunk 2 starts playing on audio element
  await delay(15);
  assert.equal(startedChunks.length, 3);
  assert.equal(startedChunks[2], 2);

  // End chunk 2 (last chunk)
  mockAudio.emit('ended');
  await delay(15);

  assert.equal(completedChunks.length, 3);
  assert.equal(completedChunks[2], 2);
  assert.equal(engine.isPlaying, false);

  engine.stop();
});

test('Cloud TTS Safety 2: Duplicate ended event on audioElement must not cause double advance', async () => {
  const { engine, mockAudio } = createEngineWithMockAudio();
  engine.chunks = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2'];
  engine.currentIndex = 0;

  const completedChunks = [];
  engine.onActualChunkComplete = (idx) => completedChunks.push(idx);

  engine.play();
  await delay(15);
  assert.equal(engine.currentIndex, 0);

  // Emit ended TWICE in quick succession for chunk 0
  mockAudio.emit('ended');
  mockAudio.emit('ended');
  await delay(20);

  assert.equal(completedChunks.length, 1, 'Completed callback should only fire ONCE for chunk 0');
  assert.equal(engine.currentIndex, 1, 'Should advance to chunk 1, not skip to chunk 2');

  engine.stop();
});

test('Cloud TTS Safety 3: Error event firing after ended must not trigger fallback', async () => {
  const { engine, mockAudio } = createEngineWithMockAudio();
  engine.chunks = ['Đoạn 0', 'Đoạn 1'];
  engine.currentIndex = 0;

  let fallbackCalled = false;
  engine.onFallbackWarning = () => { fallbackCalled = true; };
  let browserSpoken = 0;
  engine.speakBrowserChunk = () => { browserSpoken++; };

  engine.play();
  await delay(15);

  // Chunk 0 ends
  mockAudio.emit('ended');

  // Immediately error event fires (e.g. from revoked blob URL)
  mockAudio.emit('error', new Error('SRC_NOT_SUPPORTED'));
  await delay(20);

  assert.equal(fallbackCalled, false, 'Stale error after ended must NOT trigger fallback');
  assert.equal(browserSpoken, 0, 'Browser fallback must NOT speak when ended already processed');

  engine.stop();
});

test('Cloud TTS Safety 4: audioElement.play() rejection must trigger fallback exactly ONCE', async () => {
  const { engine, mockAudio } = createEngineWithMockAudio();
  mockAudio.shouldRejectPlay = true;
  engine.chunks = ['Đoạn lỗi audio'];
  engine.currentIndex = 0;

  let fallbackCount = 0;
  engine.onFallbackWarning = () => { fallbackCount++; };
  let browserSpoken = 0;
  engine.speakBrowserChunk = () => { browserSpoken++; };

  engine.play();
  await delay(30);

  assert.equal(fallbackCount, 1, 'Fallback warning should be emitted exactly ONCE');
  assert.equal(browserSpoken, 1, 'Browser fallback should be invoked exactly ONCE');

  engine.stop();
});

test('Cloud TTS Safety 5: Cloud voice preview while playback is active must pause book and restore on preview end', async () => {
  const origAudio = globalThis.Audio;
  globalThis.Audio = MockAudioElement;
  try {
    const { engine, mockAudio } = createEngineWithMockAudio();
    engine.chunks = ['Đoạn sách đang đọc'];
    engine.currentIndex = 0;

    engine.play();
    await delay(15);
    assert.equal(engine.isPlaying, true);
    assert.equal(engine.isPaused, false);
    assert.equal(mockAudio.paused, false);

    // User previews a cloud voice
    const previewPromise = engine.previewVoice('fpt:banmai', 'cloud');
    await delay(15);

    // Book playback MUST be paused during preview!
    assert.equal(mockAudio.paused, true, 'Active book audio must be paused during preview');
    assert.equal(engine.isPaused, true, 'Engine isPaused must be true during preview');

    // Preview finishes
    if (engine.previewAudio) {
      engine.previewAudio.emit('ended');
    }
    await previewPromise;
    await delay(15);

    // Book playback resumes
    assert.equal(engine.isPlaying, true);
    assert.equal(engine.isPaused, false);

    engine.stop();
  } finally {
    globalThis.Audio = origAudio;
  }
});
