import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';
import { QUEUE_ENTRY_STATES } from './ttsQueueScheduler.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let createdUrls = [];
let revokedUrls = [];

globalThis.URL = {
  createObjectURL(blob) {
    const url = `blob:http://localhost/stress_${Math.random().toString(36).slice(2)}`;
    createdUrls.push(url);
    return url;
  },
  revokeObjectURL(url) {
    revokedUrls.push(url);
  }
};

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

function setupStressHarness({ chunkCount = 100, fetchLatencyMs = 2 } = {}) {
  const origAudio = globalThis.Audio;
  globalThis.Audio = MockAudioElement;
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  globalThis.window = {
    Audio: MockAudioElement,
    speechSynthesis: {
      speaking: false,
      paused: false,
      speak(u) { if (u.onstart) setTimeout(u.onstart, 1); },
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
  engine.cloudConfig = { apiKey: 'stress-key', provider: 'openai', voice: 'nova' };
  engine.chunks = Array.from({ length: chunkCount }, (_, i) => `Đoạn kiểm thử áp lực thứ ${i}`);
  engine.currentIndex = 0;

  const inMemoryCache = new Map();
  if (engine.queueScheduler) {
    engine.queueScheduler.cacheLookup = async (k) => inMemoryCache.get(k) || null;
    engine.queueScheduler.cacheStore = async (k, b) => { inMemoryCache.set(k, b); };
  }

  let networkFetches = 0;
  let activeFetches = 0;
  let maxConcurrentFetches = 0;
  let abortedFetches = 0;

  engine.fetchCloudAudio = async (text, p, v, signal) => {
    networkFetches++;
    activeFetches++;
    if (activeFetches > maxConcurrentFetches) {
      maxConcurrentFetches = activeFetches;
    }

    if (fetchLatencyMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, fetchLatencyMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            abortedFetches++;
            const err = new Error('Aborted by signal');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }
      });
    }

    activeFetches--;
    return { size: 300, type: 'audio/mpeg' };
  };

  return {
    engine,
    mockAudio,
    getNetworkFetches: () => networkFetches,
    getMaxConcurrentFetches: () => maxConcurrentFetches,
    getAbortedFetches: () => abortedFetches,
    cleanup: () => {
      engine.stop();
      if (origAudio) globalThis.Audio = origAudio;
      else delete globalThis.Audio;
    }
  };
}

// ============================================================================
// STRESS & SOAK TESTS (PHASE 7)
// ============================================================================

test('Stress 1: 50-chunk paced soak test verifies strictly bounded queue, memory, and natural completion', async () => {
  createdUrls = [];
  revokedUrls = [];

  const { engine, mockAudio, getMaxConcurrentFetches, cleanup } = setupStressHarness({
    chunkCount: 50,
    fetchLatencyMs: 2
  });

  engine.play();
  await delay(15);

  // Paced progression through chunks (below circuit breaker threshold)
  for (let i = 0; i < 49; i++) {
    mockAudio.emit('ended');
    await delay(20);

    const snapshot = engine.queueScheduler.getSnapshot();
    assert.ok(
      snapshot.totalEntries <= 4,
      `Total entries must stay <= 4 at chunk ${i} (was: ${snapshot.totalEntries})`
    );
    assert.ok(
      snapshot.activeFetchesCount <= 1,
      `Active fetches must not exceed maxConcurrency=1 (was: ${snapshot.activeFetchesCount})`
    );
  }

  // Final chunk finishes -> natural completion
  mockAudio.emit('ended');
  await delay(20);

  assert.equal(engine.isPlaying, false, 'Playback should finish naturally at final chunk');
  assert.equal(engine.queueScheduler.getSnapshot().totalEntries, 0, 'Queue must be empty after completion');

  // Verify memory safety & URL revocation
  assert.equal(
    createdUrls.length,
    revokedUrls.length,
    `Every created Object URL must be revoked! Created: ${createdUrls.length}, Revoked: ${revokedUrls.length}`
  );
  assert.ok(getMaxConcurrentFetches() <= 1, 'Max concurrent network fetches must never exceed 1');

  cleanup();
});

test('Stress 1b: 0ms callback storm immediately trips velocity circuit breaker safely', async () => {
  createdUrls = [];
  revokedUrls = [];

  const { engine, mockAudio, cleanup } = setupStressHarness({
    chunkCount: 100,
    fetchLatencyMs: 0
  });

  // Emulate 0ms storm where each play() immediately completes
  mockAudio.play = async function() {
    this.playCount++;
    this.paused = false;
    this.emit('playing');
    queueMicrotask(() => {
      this.emit('ended');
    });
    return Promise.resolve();
  };

  let circuitBreakerTripped = false;
  engine.onFallbackWarning = (msg) => {
    if (msg.includes('vòng lặp giọng đọc')) circuitBreakerTripped = true;
  };

  engine.play();

  // Wait for 60 chunks to trip the circuit breaker (up to 1000ms)
  for (let i = 0; i < 50; i++) {
    if (!engine.isPlaying) break;
    await delay(20);
  }

  assert.equal(engine.isPlaying, false, 'Engine must trip and stop on 0ms callback storm');
  assert.equal(circuitBreakerTripped, true, 'Circuit breaker warning must be emitted');

  cleanup();
});

test('Stress 2: Rapid Seek Storm (50 random seeks) does not crash, leak memory, or cause race conditions', async () => {
  const { engine, mockAudio, getAbortedFetches, cleanup } = setupStressHarness({
    chunkCount: 200,
    fetchLatencyMs: 15 // High latency so in-flight fetches are active during seek
  });

  engine.play();
  await delay(10);

  // Perform 50 rapid seeks across distant parts of the book
  for (let s = 0; s < 50; s++) {
    const target = (s * 37) % 200; // Pseudo-random jump
    engine.jumpToIndex(target, true);
    await delay(3);
  }

  // Let settle
  await delay(40);

  assert.ok(getAbortedFetches() > 0, 'Rapid seeks must trigger in-flight fetch abortions');
  assert.equal(mockAudio.paused, false, 'Audio must be playing target chunk');
  const snapshot = engine.queueScheduler.getSnapshot();
  assert.ok(snapshot.totalEntries <= 4, 'Queue size must remain strictly bounded');

  engine.stop();
  cleanup();
});

test('Stress 3: Repeated Sessions (30 Start/Stop cycles) cleanly cycles with zero resource accumulation', async () => {
  createdUrls = [];
  revokedUrls = [];

  const { engine, mockAudio, cleanup } = setupStressHarness({
    chunkCount: 10,
    fetchLatencyMs: 2
  });

  for (let cycle = 0; cycle < 30; cycle++) {
    engine.play();
    await delay(5);
    // Move 2 chunks forward
    mockAudio.emit('ended');
    await delay(5);
    mockAudio.emit('ended');
    await delay(5);
    engine.stop();
    await delay(5);

    assert.equal(engine.isPlaying, false);
    assert.equal(engine.queueScheduler.getSnapshot().totalEntries, 0);
  }

  // All URLs created across 30 sessions must be cleanly revoked
  assert.equal(createdUrls.length, revokedUrls.length, 'All Object URLs across 30 sessions must be revoked');

  cleanup();
});

test('Stress 4: Fault Injection & Fallback: Network 500 errors degrade cleanly without infinite loop', async () => {
  const { engine, mockAudio, cleanup } = setupStressHarness({
    chunkCount: 10,
    fetchLatencyMs: 0
  });

  let failCount = 0;
  engine.fetchCloudAudio = async () => {
    failCount++;
    throw new Error('500 Internal Server Error: Gateway timeout');
  };

  let fallbackCount = 0;
  engine.onFallbackWarning = () => { fallbackCount++; };

  engine.play();
  await delay(20);

  assert.equal(engine.engine, 'browser', 'Engine must switch to browser upon cloud failure');
  assert.equal(fallbackCount, 1, 'Fallback warning emitted exactly once');

  // Next chunk advances in browser mode without touching cloud fetch
  const fetchesBefore = failCount;
  engine.next();
  await delay(15);
  assert.equal(failCount, fetchesBefore, 'Browser mode must NOT attempt cloud fetch');

  cleanup();
});

test('Stress 5: Out-of-Order Cache vs Network: Fast cache response for N+1 while N is slow finishes safely', async () => {
  const { engine, mockAudio, cleanup } = setupStressHarness({
    chunkCount: 5,
    fetchLatencyMs: 20
  });

  // Pre-seed cache for chunk 1
  if (engine.queueScheduler && engine.queueScheduler.cacheStore) {
    await engine.queueScheduler.cacheStore('cloud_openai_nova_r1.0_stub', { size: 400, type: 'audio/mpeg' });
  }

  engine.play();
  await delay(10); // Chunk 0 is fetching from network (slow)

  // Chunk 0 finishes and ends
  await delay(25);
  mockAudio.emit('ended');
  await delay(15);

  assert.equal(engine.currentIndex, 1, 'Handoff to chunk 1 must succeed cleanly');
  assert.equal(mockAudio.paused, false);

  cleanup();
});
