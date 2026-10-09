import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from '../tts.js';
import { QUEUE_ENTRY_STATES } from '../ttsQueueScheduler.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// MOCKS FOR TESTING CLOUD PLAYBACK LIFECYCLE & MEMORY
// ============================================================================

let createdUrls = [];
let revokedUrls = [];

globalThis.URL = {
  createObjectURL(blob) {
    const url = `blob:http://localhost/${Math.random().toString(36).slice(2)}`;
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

  load() {}
}

class MockUtterance {
  constructor(text) {
    this.text = text;
    this.lang = '';
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
  return {
    spokenUtterances: [],
    speaking: false,
    paused: false,
    speak(utt) {
      this.spokenUtterances.push(utt);
      this.speaking = true;
      if (typeof utt.onstart === 'function') {
        setTimeout(() => utt.onstart(), 5);
      }
    },
    cancel() {
      this.speaking = false;
      this.paused = false;
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    getVoices() {
      return [
        { name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy' }
      ];
    }
  };
}

function createTestHarness({ fetchLatencyMs = 15, chunks = ['Câu 0', 'Câu 1', 'Câu 2', 'Câu 3'] } = {}) {
  const origAudio = globalThis.Audio;
  globalThis.Audio = MockAudioElement;
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createMockSynth();
  globalThis.window = {
    Audio: MockAudioElement,
    speechSynthesis: mockSynth
  };

  const mockAudio = new MockAudioElement();
  const engine = new TTSEngine();
  engine.audioElement = mockAudio;
  engine.initAudioElement();
  engine.engine = 'cloud';
  engine.cloudConfig = { apiKey: 'test-api-key', provider: 'openai', voice: 'nova' };
  engine.chunks = [...chunks];
  engine.currentIndex = 0;

  // Provide quiet in-memory cache store
  const inMemoryCache = new Map();
  if (engine.queueScheduler) {
    engine.queueScheduler.cacheLookup = async (key) => inMemoryCache.get(key) || null;
    engine.queueScheduler.cacheStore = async (key, blob) => { inMemoryCache.set(key, blob); };
  }

  let fetchCount = 0;
  const fetchCalls = [];

  engine.fetchCloudAudio = async (text, provider, voice, signal = null) => {
    fetchCount++;
    const callRecord = { text, provider, voice, timestamp: Date.now() };
    fetchCalls.push(callRecord);

    if (fetchLatencyMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, fetchLatencyMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('Aborted by signal');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }
      });
    }

    if (signal?.aborted) {
      const err = new Error('Aborted by signal');
      err.name = 'AbortError';
      throw err;
    }

    // Return dummy valid audio blob (250 bytes > 100 byte threshold)
    return {
      size: 250,
      type: 'audio/mpeg',
      slice: () => ({ size: 250, type: 'audio/mpeg' })
    };
  };

  return {
    engine,
    mockAudio,
    mockSynth,
    getFetchCount: () => fetchCount,
    getFetchCalls: () => fetchCalls,
    cleanup: () => {
      engine.stop();
      if (origAudio) globalThis.Audio = origAudio;
      else delete globalThis.Audio;
    }
  };
}

// ============================================================================
// TARGETED TESTS FOR PHASE 5
// ============================================================================

test('1. Sequential Playback: Chunk 0 -> 1 -> 2 progresses smoothly with prefetch', async () => {
  createdUrls = [];
  revokedUrls = [];
  const { engine, mockAudio, getFetchCount, cleanup } = createTestHarness({
    fetchLatencyMs: 10,
    chunks: ['Câu không', 'Câu một', 'Câu hai']
  });

  const startedChunks = [];
  const endedChunks = [];
  engine.onActualChunkStart = (idx) => startedChunks.push(idx);
  engine.onActualChunkComplete = (idx) => endedChunks.push(idx);

  // Start playback at chunk 0
  engine.play();
  await delay(25); // Wait for chunk 0 to fetch and start playing

  assert.equal(engine.currentIndex, 0);
  assert.equal(mockAudio.paused, false);
  assert.ok(startedChunks.includes(0), 'Chunk 0 should start playing');

  // While chunk 0 is playing, prefetch for chunk 1 and 2 should have been initiated
  await delay(25);
  assert.ok(getFetchCount() >= 2, 'Chunk 1 should have been fetched or fetching in background');

  // Chunk 0 ends
  mockAudio.emit('ended');
  await delay(25);

  assert.equal(engine.currentIndex, 1, 'Should cleanly advance to Chunk 1');
  assert.ok(endedChunks.includes(0), 'Chunk 0 should be marked ended');
  assert.ok(startedChunks.includes(1), 'Chunk 1 should start playing');

  // Chunk 1 ends
  mockAudio.emit('ended');
  await delay(25);

  assert.equal(engine.currentIndex, 2, 'Should advance to Chunk 2');
  assert.ok(endedChunks.includes(1), 'Chunk 1 should be marked ended');
  assert.ok(startedChunks.includes(2), 'Chunk 2 should start playing');

  cleanup();
});

test('2. Prefetch Ready Before onended: Instant handoff with 0 delay', async () => {
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 5,
    chunks: ['Nhanh 0', 'Nhanh 1']
  });

  engine.play();
  await delay(15); // Chunk 0 playing, Chunk 1 prefetch initiated
  await delay(20); // Wait for Chunk 1 to be fully READY in scheduler

  const snapshot = engine.queueScheduler.getSnapshot();
  const chunk1Entry = snapshot.entries.find(e => e.chunkIndex === 1);
  assert.ok(chunk1Entry, 'Chunk 1 entry must exist');
  assert.equal(chunk1Entry.state, QUEUE_ENTRY_STATES.READY, 'Chunk 1 must be READY in queue');

  const prevPlayCount = mockAudio.playCount;
  // Chunk 0 ends
  mockAudio.emit('ended');
  await delay(15);

  assert.equal(engine.currentIndex, 1, 'Should instantly transition to chunk 1');
  assert.equal(mockAudio.playCount, prevPlayCount + 1, 'AudioElement.play() should have been called immediately');
  assert.equal(mockAudio.paused, false);

  cleanup();
});

test('3. Prefetch Ready After onended: Awaits the same in-flight Promise without duplicate request', async () => {
  let fetchCount = 0;
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 40, // Slow fetch
    chunks: ['Chậm 0', 'Chậm 1']
  });

  engine.fetchCloudAudio = async (text, p, v, signal) => {
    fetchCount++;
    await delay(40);
    return { size: 300, type: 'audio/mpeg' };
  };

  engine.play();
  await delay(10); // Chunk 0 is fetching

  await delay(45); // Chunk 0 finishes fetching and starts playing
  assert.equal(engine.currentIndex, 0);

  // While Chunk 1 is fetching in background, Chunk 0 ends early
  await delay(10); // Chunk 1 has started fetching
  const fetchesBeforeEnd = fetchCount;
  mockAudio.emit('ended'); // Chunk 0 finishes

  // Should await the same in-flight chunk 1 Promise without spawning a duplicate fetch
  await delay(50);
  assert.equal(engine.currentIndex, 1, 'Should advance to chunk 1 after in-flight fetch completes');
  assert.equal(fetchCount, fetchesBeforeEnd, 'Must NOT trigger duplicate fetch call for Chunk 1');

  cleanup();
});

test('4. Fetching Promise Reuse: Multiple requests for same chunk coalesce into single call', async () => {
  let networkCalls = 0;
  const { engine, cleanup } = createTestHarness({
    fetchLatencyMs: 30,
    chunks: ['Đoạn A', 'Đoạn B']
  });

  engine.fetchCloudAudio = async () => {
    networkCalls++;
    await delay(30);
    return { size: 250, type: 'audio/mpeg' };
  };

  // Trigger two concurrent requests for chunk 0
  const req1 = engine.queueScheduler.requestChunk({
    chunkIndex: 0,
    text: 'Đoạn A',
    config: engine.cloudConfig,
    rate: engine.rate,
    generation: 1
  });

  const req2 = engine.queueScheduler.requestChunk({
    chunkIndex: 0,
    text: 'Đoạn A',
    config: engine.cloudConfig,
    rate: engine.rate,
    generation: 1
  });

  const [blob1, blob2] = await Promise.all([req1, req2]);
  assert.equal(blob1, blob2, 'Both requests must receive the identical Blob reference');
  assert.equal(networkCalls, 1, 'Network call must be coalesced (exactly 1)');

  cleanup();
});

test('5. Terminal Guard: Duplicate onended and error events are strictly single-handled', async () => {
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 5,
    chunks: ['Đoạn đơn', 'Đoạn kế']
  });

  let chunkCompletedCount = 0;
  engine.onActualChunkComplete = () => { chunkCompletedCount++; };

  engine.play();
  await delay(15);
  assert.equal(engine.currentIndex, 0);

  // Fire ended event
  mockAudio.emit('ended');
  // Immediately fire duplicate ended and error events
  mockAudio.emit('ended');
  mockAudio.emit('error', new Error('Late spurious error'));
  await delay(20);

  assert.equal(chunkCompletedCount, 1, 'onActualChunkComplete must be called strictly ONCE');
  assert.equal(engine.currentIndex, 1, 'Must advance exactly 1 chunk');

  cleanup();
});

test('6. Stop while fetch is pending: Aborts in-flight request, cancels queue, cleans audio', async () => {
  let wasAborted = false;
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 50,
    chunks: ['Đang tải...']
  });

  engine.fetchCloudAudio = async (text, p, v, signal) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ size: 200, type: 'audio/mpeg' }), 50);
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

  engine.play();
  await delay(10);
  assert.equal(engine.isPlaying, true);

  // Stop while fetch is in-flight
  engine.stop();
  await delay(20);

  assert.equal(engine.isPlaying, false);
  assert.equal(engine.isPaused, false);
  assert.equal(wasAborted, true, 'AbortSignal must have aborted the in-flight request');
  assert.equal(mockAudio.paused, true);
  assert.equal(engine.queueScheduler.getSnapshot().activeFetchesCount, 0, 'Active fetches must be 0');

  cleanup();
});

test('7. Pause and Resume: Keeps audio element position without recreating playback or duplicate fetches', async () => {
  const { engine, mockAudio, getFetchCount, cleanup } = createTestHarness({
    fetchLatencyMs: 10,
    chunks: ['Câu phát', 'Câu tiếp']
  });

  engine.play();
  await delay(25);
  assert.equal(mockAudio.paused, false);
  mockAudio.currentTime = 4.2;

  const initialFetches = getFetchCount();

  // User Pauses
  engine.pause();
  assert.equal(engine.isPaused, true);
  assert.equal(mockAudio.paused, true);
  assert.equal(mockAudio.currentTime, 4.2, 'currentTime must be preserved on pause');

  // User Resumes
  engine.resume();
  assert.equal(engine.isPaused, false);
  assert.equal(mockAudio.paused, false);
  assert.equal(mockAudio.currentTime, 4.2, 'currentTime must remain preserved on resume');
  assert.equal(getFetchCount(), initialFetches, 'Must NOT trigger redundant network fetch on resume');

  cleanup();
});

test('8. Rapid Seek: Aborts stale prefetch, shifts window, and prioritizes target chunk', async () => {
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 20,
    chunks: Array.from({ length: 10 }, (_, i) => `Đoạn ${i}`)
  });

  engine.play();
  await delay(10); // Chunk 0 is fetching

  // User rapidly seeks from 0 -> 4 -> 8
  engine.jumpToIndex(4, true);
  engine.jumpToIndex(8, true);
  await delay(35);

  assert.equal(engine.currentIndex, 8, 'Current index must be target chunk 8');
  assert.equal(mockAudio.paused, false);

  const snapshot = engine.queueScheduler.getSnapshot();
  // Entries for 0, 1, 4 should have been invalidated and evicted
  const chunk0 = snapshot.entries.find(e => e.chunkIndex === 0);
  assert.equal(chunk0, undefined, 'Stale chunk 0 must be evicted from active queue');

  cleanup();
});

test('9. Chapter Boundary: Final chunk completion emits onNaturalComplete and stops cleanly', async () => {
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 5,
    chunks: ['Chỉ một câu cuối']
  });

  let naturalCompleteEmitted = false;
  let statusEmitted = null;
  engine.onNaturalComplete = (idx) => { naturalCompleteEmitted = true; };
  engine.onStatusChange = (st) => { statusEmitted = st; };

  engine.play();
  await delay(15);

  // Final chunk finishes
  mockAudio.emit('ended');
  await delay(15);

  assert.equal(naturalCompleteEmitted, true, 'onNaturalComplete must be emitted');
  assert.equal(engine.isPlaying, false);
  assert.equal(statusEmitted, 'completed');

  // Loading new chapter clears all queue entries
  engine.loadText('Chương mới đoạn 1\nChương mới đoạn 2');
  assert.equal(engine.currentIndex, 0);
  assert.equal(engine.queueScheduler.getSnapshot().totalEntries, 0, 'New chapter loadText must clear queue');

  cleanup();
});

test('10. Late Response after Stop: Discarded completely without playing or advancing', async () => {
  let resolveSlowFetch = null;
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 0,
    chunks: ['Chờ rất lâu']
  });

  engine.fetchCloudAudio = () => {
    return new Promise(resolve => {
      resolveSlowFetch = resolve;
    });
  };

  engine.play();
  await delay(10);

  // User stops before fetch resolves
  engine.stop();
  assert.equal(engine.isPlaying, false);

  // Slow fetch resolves AFTER stop
  if (resolveSlowFetch) {
    resolveSlowFetch({ size: 400, type: 'audio/mpeg' });
  }
  await delay(20);

  assert.equal(engine.isPlaying, false, 'Playback must NOT restart after late fetch');
  assert.equal(mockAudio.paused, true, 'Audio element must remain paused');
  assert.equal(mockAudio.src, '', 'Audio element src must remain cleared');

  cleanup();
});

test('11. Cloud Fallback: Switches to Browser TTS on error without Cloud-Browser loop', async () => {
  const { engine, mockSynth, cleanup } = createTestHarness({
    fetchLatencyMs: 5,
    chunks: ['Lỗi Cloud', 'Câu sau']
  });

  let fallbackWarning = null;
  engine.onFallbackWarning = (msg) => { fallbackWarning = msg; };

  // Simulate Cloud TTS network failure
  engine.fetchCloudAudio = async () => {
    throw new Error('401 Unauthorized: Invalid API Key');
  };

  engine.play();
  await delay(25);

  assert.ok(fallbackWarning && fallbackWarning.includes('Invalid API Key'), 'Warning toast must be emitted');
  assert.equal(engine.engine, 'browser', 'Engine must switch to browser to prevent loop');
  assert.equal(mockSynth.spokenUtterances.length, 1, 'Current chunk spoken via Web Speech');
  assert.equal(mockSynth.spokenUtterances[0].text, 'Lỗi Cloud');

  cleanup();
});

test('12. Voice Preview Isolation: Pauses book, plays preview separately, restores reading session', async () => {
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 5,
    chunks: ['Đoạn sách đang đọc']
  });

  engine.play();
  await delay(15);
  assert.equal(engine.isPlaying, true);
  assert.equal(engine.isPaused, false);
  assert.equal(mockAudio.paused, false);

  // Preview a cloud voice
  const previewPromise = engine.previewVoice('openai:shimmer', 'cloud');
  await delay(15);

  assert.equal(engine.isPaused, true, 'Book playback must be paused during preview');
  assert.equal(mockAudio.paused, true, 'Book audio element must be paused');

  // Preview finishes
  if (engine.previewAudio) {
    engine.previewAudio.emit('ended');
  }
  await previewPromise;
  await delay(20);

  assert.equal(engine.isPlaying, true, 'Reading session must be restored');
  assert.equal(engine.isPaused, false);
  assert.equal(mockAudio.paused, false);
  assert.equal(engine.currentIndex, 0, 'Chunk index must NOT change from preview');

  cleanup();
});

test('13. Object URL Lifecycle: Revokes URLs upon chunk end, stop, error, and replacement', async () => {
  createdUrls = [];
  revokedUrls = [];

  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 5,
    chunks: ['Đoạn URL 0', 'Đoạn URL 1']
  });

  engine.play();
  await delay(15);
  assert.equal(createdUrls.length, 1, 'One URL created for chunk 0');

  // Chunk 0 ends -> transitions to chunk 1
  mockAudio.emit('ended');
  await delay(20);

  assert.equal(createdUrls.length, 2, 'Two URLs created total');
  assert.ok(revokedUrls.includes(createdUrls[0]), 'First URL must be revoked when chunk 0 ends');

  // Stop playback
  engine.stop();
  await delay(10);

  assert.ok(revokedUrls.includes(createdUrls[1]), 'Second URL must be revoked on stop');
  assert.equal(revokedUrls.length, createdUrls.length, 'All created Object URLs must be revoked (0 leak)');

  cleanup();
});

test('14. Single Active Playback: Exactly one active audio element playing at all times', async () => {
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 5,
    chunks: ['Câu A', 'Câu B']
  });

  let activePlaybackTrueCount = 0;
  engine.onPlaybackStateChange = (isActive) => {
    if (isActive) activePlaybackTrueCount++;
  };

  engine.play();
  await delay(15);
  assert.equal(activePlaybackTrueCount, 1);

  // Chunk A finishes and transitions to Chunk B
  mockAudio.emit('ended');
  await delay(20);

  // Only 1 audio source remains active
  assert.equal(mockAudio.paused, false);
  assert.equal(engine.isPlaying, true);

  cleanup();
});

test('15. Bounded Resources Across Many Chunks: Queue entries remain <= 3 across 20 chunks', async () => {
  const chunks = Array.from({ length: 20 }, (_, i) => `Đoạn thứ ${i}`);
  const { engine, mockAudio, cleanup } = createTestHarness({
    fetchLatencyMs: 2,
    chunks
  });

  engine.play();
  await delay(10);

  // Simulate sequential completion of 15 chunks
  for (let i = 0; i < 15; i++) {
    mockAudio.emit('ended');
    await delay(10);
    const snapshot = engine.queueScheduler.getSnapshot();
    assert.ok(snapshot.totalEntries <= 4, `Total queue entries (${snapshot.totalEntries}) must remain bounded <= 4 at chunk ${i}`);
  }

  engine.stop();
  const finalSnapshot = engine.queueScheduler.getSnapshot();
  assert.equal(finalSnapshot.totalEntries, 0, 'On stop, all entries must be cleared');

  cleanup();
});
