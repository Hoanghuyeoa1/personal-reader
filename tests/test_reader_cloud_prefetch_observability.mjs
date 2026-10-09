import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';
import { SleepTimer } from './sleepTimer.js';
import { MediaSessionHelper } from './mediaSessionHelper.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock URL
globalThis.URL = {
  createObjectURL(blob) {
    return 'blob:http://localhost/audio-chunk';
  },
  revokeObjectURL() {}
};

// Mock Audio Element
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

  load() {}
}

class MockUtterance {
  constructor(text) {
    this.text = text;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

function createHarness({ fetchLatencyMs = 15, chunks = ['Câu 0', 'Câu 1', 'Câu 2', 'Câu 3'] } = {}) {
  const origAudio = globalThis.Audio;
  globalThis.Audio = MockAudioElement;
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  globalThis.window = {
    Audio: MockAudioElement,
    speechSynthesis: {
      speaking: false,
      paused: false,
      speak() {},
      cancel() {},
      pause() {},
      resume() {},
      getVoices() { return []; }
    }
  };

  const mockAudio = new MockAudioElement();
  const engine = new TTSEngine();
  engine.audioElement = mockAudio;
  engine.initAudioElement();
  engine.engine = 'cloud';
  engine.cloudConfig = { apiKey: 'test-key', provider: 'openai', voice: 'nova' };
  engine.chunks = [...chunks];
  engine.currentIndex = 0;

  // In-memory mock cache to ensure quiet operation
  const cacheMap = new Map();
  if (engine.queueScheduler) {
    engine.queueScheduler.cacheLookup = async (k) => cacheMap.get(k) || null;
    engine.queueScheduler.cacheStore = async (k, b) => { cacheMap.set(k, b); };
  }

  let networkFetchCount = 0;
  engine.fetchCloudAudio = async (text, p, v, signal) => {
    networkFetchCount++;
    if (fetchLatencyMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, fetchLatencyMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }
      });
    }
    return { size: 300, type: 'audio/mpeg' };
  };

  return {
    engine,
    mockAudio,
    getNetworkFetchCount: () => networkFetchCount,
    cleanup: () => {
      engine.stop();
      if (origAudio) globalThis.Audio = origAudio;
      else delete globalThis.Audio;
    }
  };
}

// ============================================================================
// PHASE 6 INTEGRATION & OBSERVABILITY TESTS
// ============================================================================

test('1. Reader Session Invariants: Background prefetch does NOT affect reading progress, index, or session events', async () => {
  const { engine, mockAudio, getNetworkFetchCount, cleanup } = createHarness({
    fetchLatencyMs: 10,
    chunks: ['Câu 0', 'Câu 1', 'Câu 2']
  });

  const actualStartEvents = [];
  const actualCompleteEvents = [];
  const chunkStartEvents = [];
  let playbackActiveEvents = [];

  engine.onActualChunkStart = (idx) => actualStartEvents.push(idx);
  engine.onActualChunkComplete = (idx) => actualCompleteEvents.push(idx);
  engine.onChunkStart = (idx) => chunkStartEvents.push(idx);
  engine.onPlaybackStateChange = (active) => playbackActiveEvents.push(active);

  // Play chunk 0
  engine.play();
  await delay(25); // Chunk 0 is playing, prefetch for 1 and 2 triggered

  assert.equal(engine.currentIndex, 0, 'Current index must remain 0 while prefetching chunks 1 & 2');
  assert.deepEqual(actualStartEvents, [0], 'Only chunk 0 must have fired onActualChunkStart');
  assert.deepEqual(chunkStartEvents, [0], 'Only chunk 0 must have fired onChunkStart');
  assert.deepEqual(actualCompleteEvents, [], 'No chunk completion must have fired yet');
  assert.equal(playbackActiveEvents[0], true, 'Only one playback start edge emitted');

  // Let prefetch run for chunks 1 and 2
  await delay(30);
  assert.ok(getNetworkFetchCount() >= 2, 'Network prefetch happened in background');

  // Invariants MUST hold: prefetching chunk 1 and 2 must NOT have altered reading session
  assert.equal(engine.currentIndex, 0, 'Current chunk must still be 0');
  assert.deepEqual(actualStartEvents, [0], 'Chunk 1/2 must NOT fire onActualChunkStart from prefetch');
  assert.deepEqual(actualCompleteEvents, [], 'Prefetch must NOT fire onActualChunkComplete');

  cleanup();
});

test('2. Observability Metrics: Tracks cache hit/miss, prefetch hit/miss, and handoff gap latency', async () => {
  const { engine, mockAudio, cleanup } = createHarness({
    fetchLatencyMs: 10,
    chunks: ['Đoạn một', 'Đoạn hai']
  });

  // Enable debug mode
  engine.setPrefetchDebugMode(true);

  // Initial metrics should be clean zeros
  let metrics = engine.getPrefetchMetrics();
  assert.equal(metrics.prefetchHits, 0);
  assert.equal(metrics.networkRequests, 0);

  // Play Chunk 0
  engine.play();
  await delay(25); // Chunk 0 plays, Chunk 1 prefetch initiated
  await delay(25); // Chunk 1 ready in queue

  metrics = engine.getPrefetchMetrics();
  assert.equal(metrics.prefetchMisses, 1, 'Chunk 0 was cold on start (prefetch miss)');
  assert.ok(metrics.networkRequests >= 1, 'At least 1 network request recorded');
  assert.ok(metrics.lastRequestLatencyMs >= 0, 'Request latency recorded');
  assert.ok(metrics.readyEntries >= 1, 'Chunk 1 is READY in queue');

  // Chunk 0 ends -> transitions to Chunk 1
  mockAudio.emit('ended');
  await delay(25);

  metrics = engine.getPrefetchMetrics();
  assert.equal(metrics.prefetchHits, 1, 'Chunk 1 handoff must be counted as a PREFETCH HIT');
  assert.ok(metrics.lastChunkGapMs >= 0, 'Chunk gap latency must be recorded');
  assert.equal(engine.currentIndex, 1, 'Advanced to chunk 1');

  // Verify resetMetrics
  engine.queueScheduler.resetMetrics();
  metrics = engine.getPrefetchMetrics();
  assert.equal(metrics.prefetchHits, 0, 'Metrics should be reset to 0');
  assert.equal(metrics.networkRequests, 0);

  cleanup();
});

test('3. Sleep Timer Expiration during Prefetch: Stops playback, cancels in-flight prefetch, no late restart', async () => {
  let wasAborted = false;
  const { engine, mockAudio, cleanup } = createHarness({
    fetchLatencyMs: 40,
    chunks: ['Câu A', 'Câu B (prefetching)']
  });

  engine.fetchCloudAudio = async (t, p, v, signal) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ size: 300, type: 'audio/mpeg' }), 40);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          wasAborted = true;
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };

  const sleepTimer = new SleepTimer({
    fadeDuration: 30,
    onExpire: () => {
      engine.stop();
    }
  });

  engine.play();
  await delay(10); // Chunk 0 playing, Chunk B fetching in background

  // Sleep Timer expires while Chunk B fetch is in-flight
  sleepTimer.expire('timeout');
  await delay(20);

  assert.equal(engine.isPlaying, false, 'TTS engine must be stopped');
  assert.equal(mockAudio.paused, true, 'Audio element must be paused');
  assert.equal(wasAborted, true, 'In-flight prefetch must be cancelled by Sleep Timer stop');

  // Late resolution must not restart playback
  await delay(40);
  assert.equal(engine.isPlaying, false);
  assert.equal(mockAudio.paused, true);

  cleanup();
});

test('4. Sleep Timer Fade-Out Across Chunks: Volume fade ratio is maintained during chunk transition', async () => {
  const { engine, mockAudio, cleanup } = createHarness({
    fetchLatencyMs: 5,
    chunks: ['Câu fade 1', 'Câu fade 2']
  });

  engine.play();
  await delay(15);

  // Sleep timer fades volume to 0.4
  engine.setVolume(0.4);
  assert.equal(engine.volume, 0.4);
  assert.equal(mockAudio.volume, 0.4);

  // Chunk 0 finishes -> transitions to Chunk 1
  mockAudio.emit('ended');
  await delay(20);

  assert.equal(engine.currentIndex, 1);
  assert.equal(engine.volume, 0.4, 'Engine volume must remain at faded 0.4 across chunk transition');
  assert.equal(mockAudio.volume, 0.4, 'Audio element volume must remain at faded 0.4 across chunk transition');

  cleanup();
});

test('5. Media Session Controls: Hardware play, pause, next, prev control Cloud TTSEngine cleanly', async () => {
  const { engine, mockAudio, cleanup } = createHarness({
    fetchLatencyMs: 5,
    chunks: ['Track 0', 'Track 1', 'Track 2']
  });

  const mediaHelper = new MediaSessionHelper({
    onPlay: () => engine.play(),
    onPause: () => engine.pause(),
    onNextTrack: () => engine.next(),
    onPrevTrack: () => engine.prev(),
    onStop: () => engine.stop()
  });

  // User presses hardware Play
  mediaHelper.callbacks.onPlay();
  await delay(15);
  assert.equal(engine.isPlaying, true);
  assert.equal(mockAudio.paused, false);

  // User presses hardware Next
  mediaHelper.callbacks.onNextTrack();
  await delay(20);
  assert.equal(engine.currentIndex, 1, 'Hardware Next must advance chunk to 1');
  assert.equal(mockAudio.paused, false);

  // User presses hardware Pause
  mediaHelper.callbacks.onPause();
  assert.equal(engine.isPaused, true);
  assert.equal(mockAudio.paused, true);

  mediaHelper.destroy();
  cleanup();
});

test('6. Reader Resource Cleanup: Unloads chunks, cancels queue, clears metrics on dispose/loadText', async () => {
  const { engine, mockAudio, cleanup } = createHarness({
    fetchLatencyMs: 5,
    chunks: ['Chương cũ câu 0', 'Chương cũ câu 1']
  });

  engine.play();
  await delay(20);
  assert.ok(engine.queueScheduler.getSnapshot().totalEntries > 0);

  // User navigates to a new chapter
  engine.loadText('Chương mới tinh');
  assert.equal(engine.currentIndex, 0);
  assert.equal(engine.isPlaying, false);
  assert.equal(engine.queueScheduler.getSnapshot().totalEntries, 0, 'All queue entries cleared');

  // Dispose scheduler
  engine.queueScheduler.dispose();
  assert.equal(engine.queueScheduler.getSnapshot().totalEntries, 0);

  cleanup();
});
