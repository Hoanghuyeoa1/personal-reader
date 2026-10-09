import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TTSQueueScheduler,
  QUEUE_ENTRY_STATES,
  buildCacheKey,
  buildLegacyCacheKey,
  hashText,
  makeConfigFingerprint
} from './ttsQueueScheduler.js';
import { getCachedAudio, setCachedAudio, pruneAudioCache, _resetDbForTesting } from './storage.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Creates an in-memory mock of Dexie database for testing storage.js methods.
 */
function createMockDexie() {
  const store = new Map();

  const mockDb = {
    audioCache: {
      async get(key) {
        return store.get(key) || null;
      },
      async put(record) {
        store.set(record.key, { ...record });
        return record.key;
      },
      async delete(key) {
        return store.delete(key);
      },
      async clear() {
        store.clear();
        return true;
      },
      async count() {
        return store.size;
      },
      async bulkDelete(keys) {
        for (const k of keys) store.delete(k);
        return true;
      },
      orderBy(field) {
        return {
          limit(n) {
            return {
              async keys() {
                const items = Array.from(store.values());
                items.sort((a, b) => (a[field] || 0) - (b[field] || 0));
                return items.slice(0, n).map(i => i.key);
              }
            };
          }
        };
      }
    },
    books: { count: async () => 5 },
    chapters: { count: async () => 50 }
  };

  class DexieMock {
    constructor() {
      this.audioCache = mockDb.audioCache;
      this.books = mockDb.books;
      this.chapters = mockDb.chapters;
      this.versions = [];
    }
    version(version) {
      const record = { version, stores: null };
      this.versions.push(record);
      return { stores: schema => { record.stores = schema; return this; } };
    }
    async open() {
      return this;
    }
  }

  return {
    mockDb,
    store,
    DexieMock
  };
}

test('1. Cache Hit: Does NOT call Cloud API fetcher', async () => {
  const cache = new Map();
  let fetcherCallCount = 0;

  const sampleText = 'Đây là câu văn đã lưu trong bộ nhớ đệm.';
  const sampleBlob = new Blob(['cached-audio-bytes-1'], { type: 'audio/mp3' });
  const key = buildCacheKey({ text: sampleText, provider: 'fpt', voice: 'banmai', rate: 1.0 });

  // Pre-seed cache
  cache.set(key, sampleBlob);

  const scheduler = new TTSQueueScheduler({
    cacheLookup: async (k) => cache.get(k) || null,
    fetcher: async () => {
      fetcherCallCount++;
      return new Blob(['network-bytes']);
    }
  });

  const blob = await scheduler.requestChunk({
    chunkIndex: 0,
    text: sampleText,
    config: { provider: 'fpt', voice: 'banmai' },
    rate: 1.0
  });

  assert.equal(fetcherCallCount, 0, 'Fetcher must NOT be called on cache hit');
  assert.equal(blob, sampleBlob, 'Returned blob must be identical to cached blob');

  const entry = scheduler.getEntry(0);
  assert.equal(entry.state, QUEUE_ENTRY_STATES.READY);
  assert.equal(entry.isCacheHit, true, 'Entry must be marked isCacheHit = true');

  scheduler.dispose();
});

test('2. Cache Miss: Enqueues, calls Cloud API, stores in cache, and subsequent request hits cache', async () => {
  const cache = new Map();
  let fetcherCallCount = 0;

  const sampleText = 'Đây là câu văn mới tinh chưa từng đọc.';
  const generatedBlob = new Blob(['fresh-network-audio'], { type: 'audio/mp3' });

  const scheduler = new TTSQueueScheduler({
    cacheLookup: async (k) => cache.get(k) || null,
    cacheStore: async (k, b) => { cache.set(k, b); },
    fetcher: async (text) => {
      fetcherCallCount++;
      return generatedBlob;
    }
  });

  // First request: Cache Miss
  const res1 = await scheduler.requestChunk({
    chunkIndex: 0,
    text: sampleText,
    config: { provider: 'fpt', voice: 'banmai' },
    rate: 1.0
  });

  assert.equal(fetcherCallCount, 1, 'Fetcher must be called on cache miss');
  assert.equal(res1, generatedBlob);
  assert.equal(scheduler.getEntry(0).isCacheHit, false);

  // Allow fire-and-forget cacheStore to settle
  await delay(10);
  const cacheKey = buildCacheKey({ text: sampleText, provider: 'fpt', voice: 'banmai', rate: 1.0 });
  assert.ok(cache.has(cacheKey), 'Audio must be stored in cache');

  // Second request: Cache Hit
  scheduler.markConsumed(0); // clear memory entry
  const res2 = await scheduler.requestChunk({
    chunkIndex: 0,
    text: sampleText,
    config: { provider: 'fpt', voice: 'banmai' },
    rate: 1.0
  });

  assert.equal(fetcherCallCount, 1, 'Fetcher must NOT be called on second request');
  assert.equal(res2, generatedBlob);
  assert.equal(scheduler.getEntry(0).isCacheHit, true);

  scheduler.dispose();
});

test('3. Concurrent lookup coalescing: Same chunk/config does not trigger duplicate lookup or request', async () => {
  let lookupCount = 0;
  let fetchCount = 0;
  const lookupDef = createDeferred();

  const scheduler = new TTSQueueScheduler({
    cacheLookup: async () => {
      lookupCount++;
      return lookupDef.promise;
    },
    fetcher: async () => {
      fetchCount++;
      return new Blob(['fetched']);
    }
  });

  const config = { provider: 'openai', voice: 'nova' };
  const req1 = scheduler.requestChunk({ chunkIndex: 0, text: 'Đoạn đồng thời', config });
  const req2 = scheduler.requestChunk({ chunkIndex: 0, text: 'Đoạn đồng thời', config });

  assert.equal(req1, req2, 'Both concurrent callers must share the exact same Promise instance');

  // Complete lookup as cache hit
  lookupDef.resolve(new Blob(['shared-cached-blob']));
  const [res1, res2] = await Promise.all([req1, req2]);

  assert.equal(res1, res2);
  assert.equal(lookupCount, 1, 'Only 1 cache lookup should have been performed');
  assert.equal(fetchCount, 0, 'No network fetch should be performed on cache hit');

  scheduler.dispose();
});

test('4. Different voice or provider does NOT collide in cache', async () => {
  const cache = new Map();
  const text = 'Xin chào độc giả VietReader.';

  const scheduler = new TTSQueueScheduler({
    cacheLookup: async (k) => cache.get(k) || null,
    cacheStore: async (k, b) => { cache.set(k, b); },
    fetcher: async (t, cfg) => new Blob([`audio-${cfg.provider}-${cfg.voice}`])
  });

  // 1. Fetch with FPT Ban Mai
  const blob1 = await scheduler.requestChunk({
    chunkIndex: 0,
    text,
    config: { provider: 'fpt', voice: 'banmai' },
    rate: 1.0
  });
  await delay(10);
  scheduler.markConsumed(0);

  // 2. Fetch with FPT Minh Quang (different voice)
  const blob2 = await scheduler.requestChunk({
    chunkIndex: 0,
    text,
    config: { provider: 'fpt', voice: 'minhquang' },
    rate: 1.0
  });
  await delay(10);
  scheduler.markConsumed(0);

  // 3. Fetch with OpenAI Nova (different provider & voice)
  const blob3 = await scheduler.requestChunk({
    chunkIndex: 0,
    text,
    config: { provider: 'openai', voice: 'nova' },
    rate: 1.0
  });
  await delay(10);

  const k1 = buildCacheKey({ text, provider: 'fpt', voice: 'banmai', rate: 1.0 });
  const k2 = buildCacheKey({ text, provider: 'fpt', voice: 'minhquang', rate: 1.0 });
  const k3 = buildCacheKey({ text, provider: 'openai', voice: 'nova', rate: 1.0 });

  assert.notEqual(k1, k2, 'Different voices must have distinct cache keys');
  assert.notEqual(k1, k3, 'Different providers must have distinct cache keys');
  assert.equal(cache.size, 3, 'Cache must store 3 separate audio entries');

  scheduler.dispose();
});

test('5. Dictionary / Cleaner content change updates key and causes cache miss', async () => {
  const cache = new Map();
  let fetchCount = 0;

  const scheduler = new TTSQueueScheduler({
    cacheLookup: async (k) => cache.get(k) || null,
    cacheStore: async (k, b) => { cache.set(k, b); },
    fetcher: async (t) => {
      fetchCount++;
      return new Blob([`audio for ${t}`]);
    }
  });

  const originalText = 'Cô bé đi trong rừng.';
  const cleanedText = 'Nàng đi trong rừng.'; // replaced by dictionary rule

  // Original text fetch
  await scheduler.requestChunk({ chunkIndex: 0, text: originalText, config: { provider: 'fpt', voice: 'banmai' } });
  await delay(10);
  scheduler.markConsumed(0);
  assert.equal(fetchCount, 1);

  // Cleaned text fetch (different content -> different hash -> cache miss)
  await scheduler.requestChunk({ chunkIndex: 0, text: cleanedText, config: { provider: 'fpt', voice: 'banmai' } });
  await delay(10);
  scheduler.markConsumed(0);
  assert.equal(fetchCount, 2, 'Modified text must trigger cache miss and fetch new audio');

  // Reverting to original text -> Cache Hit!
  await scheduler.requestChunk({ chunkIndex: 0, text: originalText, config: { provider: 'fpt', voice: 'banmai' } });
  assert.equal(fetchCount, 2, 'Original text must hit from cache without re-fetching');

  scheduler.dispose();
});

test('6. Rate alters synthesis key; Pitch does NOT alter synthesis key', async () => {
  const text = 'Kiểm tra tốc độ và cao độ âm thanh.';

  // Rate affects Cloud TTS synthesis
  const keyRate10 = buildCacheKey({ text, provider: 'fpt', voice: 'banmai', rate: 1.0 });
  const keyRate15 = buildCacheKey({ text, provider: 'fpt', voice: 'banmai', rate: 1.5 });
  assert.notEqual(keyRate10, keyRate15, 'Different rates must yield different cache keys');

  // Pitch is client-side Web Speech only and does NOT alter Cloud TTS synthesis
  // buildCacheKey does not accept pitch, ensuring pitch slider changes do not invalidate audio cache
  const keyNoPitch = buildCacheKey({ text, provider: 'openai', voice: 'nova', rate: 1.0 });
  assert.ok(keyNoPitch.includes('r1.0'));
  assert.ok(!keyNoPitch.includes('pitch'));
});

test('7. Legacy cache records compatibility and safe validation', async () => {
  const cache = new Map();

  const text = 'Đoạn văn tương thích lịch sử.';
  const legacyBlob = new Blob(['legacy-fpt-audio']);
  const legacyKey = buildLegacyCacheKey({ text, provider: 'fpt', voice: 'banmai', rate: 1.0 });

  // Store legacy entry in cache
  cache.set(legacyKey, legacyBlob);

  const scheduler = new TTSQueueScheduler({
    cacheLookup: async (k) => cache.get(k) || null,
    fetcher: async () => new Blob(['new-fetch'])
  });

  // Requesting with standard FPT Ban Mai should hit legacy key!
  const res = await scheduler.requestChunk({
    chunkIndex: 0,
    text,
    config: { provider: 'fpt', voice: 'banmai' },
    rate: 1.0
  });

  assert.equal(res, legacyBlob, 'Must hit legacy cache entry for matching configuration');

  // OpenAI with specialized model ('tts-1-hd') should NOT hit legacy entry without model!
  const hdScheduler = new TTSQueueScheduler({
    cacheLookup: async (k) => cache.get(k) || null,
    fetcher: async () => new Blob(['hd-network-audio'])
  });

  const hdRes = await hdScheduler.requestChunk({
    chunkIndex: 0,
    text,
    config: { provider: 'openai', voice: 'nova', model: 'tts-1-hd' },
    rate: 1.0
  });

  assert.notEqual(hdRes, legacyBlob, 'Specialized model request must NOT accept legacy entry without model');

  scheduler.dispose();
  hdScheduler.dispose();
});

test('8. Corrupt / Empty Cache Handling: Treats as miss and cleans up corrupt entry', async () => {
  _resetDbForTesting();
  const mock = createMockDexie();
  globalThis.Dexie = mock.DexieMock;

  const key = 'cloud_fpt_banmai_r1.0_corrupt1';
  // Seed corrupt 0-byte blob in IndexedDB
  await mock.mockDb.audioCache.put({
    key,
    blob: new Blob([], { type: 'audio/mp3' }), // 0 bytes
    provider: 'fpt',
    voice: 'banmai',
    createdAt: Date.now()
  });

  // getCachedAudio must detect 0-byte corrupt blob, delete it, and return null
  const result = await getCachedAudio(key);
  assert.equal(result, null, 'Corrupt blob must return null');
  assert.equal(await mock.mockDb.audioCache.count(), 0, 'Corrupt entry must be deleted from store');

  delete globalThis.Dexie;
  _resetDbForTesting();
});

test('9. Storage Failures: IndexedDB read error and QuotaExceededError do NOT hang TTS', async () => {
  let fetchCallCount = 0;

  const scheduler = new TTSQueueScheduler({
    cacheLookup: async () => {
      // Simulate fatal IndexedDB read failure
      throw new Error('IndexedDB TransactionInactiveError: Connection closed');
    },
    cacheStore: async () => {
      // Simulate QuotaExceededError on write
      const quotaErr = new Error('The quota has been exceeded.');
      quotaErr.name = 'QuotaExceededError';
      throw quotaErr;
    },
    fetcher: async () => {
      fetchCallCount++;
      return new Blob(['network-audio-despite-storage-failure']);
    }
  });

  // requestChunk must resolve smoothly despite both read and write errors!
  const audio = await scheduler.requestChunk({
    chunkIndex: 0,
    text: 'Không bị treo khi storage lỗi',
    config: { provider: 'fpt', voice: 'banmai' }
  });

  assert.ok(audio);
  assert.equal(fetchCallCount, 1);
  assert.equal(scheduler.getEntry(0).state, QUEUE_ENTRY_STATES.READY);

  scheduler.dispose();
});

test('10. QuotaExceededError in setCachedAudio triggers safe LRU eviction of audioCache', async () => {
  _resetDbForTesting();
  const mock = createMockDexie();
  globalThis.Dexie = mock.DexieMock;

  // Pre-seed 35 entries
  for (let i = 0; i < 35; i++) {
    await mock.mockDb.audioCache.put({
      key: `audio_${i}`,
      blob: new Blob([`audio-${i}`]),
      provider: 'fpt',
      voice: 'banmai',
      createdAt: 1000 + i
    });
  }
  assert.equal(await mock.mockDb.audioCache.count(), 35);

  // Monkey-patch put to throw QuotaExceededError on first attempt, then succeed after eviction
  let putAttempts = 0;
  const originalPut = mock.mockDb.audioCache.put.bind(mock.mockDb.audioCache);
  mock.mockDb.audioCache.put = async function (record) {
    putAttempts++;
    if (putAttempts === 1) {
      const err = new Error('Quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return originalPut(record);
  };

  const newBlob = new Blob(['new-audio']);
  await setCachedAudio('new_key', newBlob, 'fpt', 'banmai');

  // Must have evicted 30 oldest entries and added new_key (35 - 30 + 1 = 6)
  assert.equal(await mock.mockDb.audioCache.count(), 6);
  assert.ok(await mock.mockDb.audioCache.get('new_key'));

  delete globalThis.Dexie;
  _resetDbForTesting();
});

test('11. Stale generation cannot mutate state or leak to current generation', async () => {
  const slowLookupDef = createDeferred();
  const slowFetchDef = createDeferred();

  const scheduler = new TTSQueueScheduler({
    initialGeneration: 1,
    cacheLookup: async () => slowLookupDef.promise,
    fetcher: async () => slowFetchDef.promise
  });

  // Start request in Generation 1
  const reqGen1 = scheduler.requestChunk({
    chunkIndex: 0,
    text: 'Đoạn 0 Gen 1',
    generation: 1
  });

  await delay(10);

  // Invalidate to Generation 2 (user seeks or stops)
  scheduler.invalidate(2);

  // Late results arrive from Generation 1
  slowLookupDef.resolve(null);
  slowFetchDef.resolve(new Blob(['late-audio']));
  await delay(10);

  // Gen 1 promise must have been aborted/rejected
  await assert.rejects(reqGen1, { name: 'AbortError' });

  // Generation 2 state must be completely clean
  const snapshot = scheduler.getSnapshot();
  assert.equal(snapshot.currentGeneration, 2);
  assert.equal(snapshot.totalEntries, 0);

  scheduler.dispose();
});

test('12. Memory retention limits: Evicts lower priority ready blobs when exceeding bounds', async () => {
  const scheduler = new TTSQueueScheduler({
    config: {
      maxConcurrency: 1,
      maxWindowAhead: 3,
      maxReadyEntries: 2, // bound to at most 2 ready entries
      maxRetainedBytes: 1000
    },
    cacheLookup: async () => new Blob(['cached-blob-data']) // Instant cache hit
  });

  const chunks = ['Đoạn 0 (Current)', 'Đoạn 1 (N+1)', 'Đoạn 2 (N+2)'];
  scheduler.updateWindow({
    currentIndex: 0,
    chunks
  });

  await delay(25);

  const snapshot = scheduler.getSnapshot();
  const readyEntries = snapshot.entries.filter(e => e.state === QUEUE_ENTRY_STATES.READY);

  // Must not exceed maxReadyEntries = 2
  assert.ok(readyEntries.length <= 2, `Ready entries (${readyEntries.length}) must be <= 2`);

  // Priority 1 (Current chunk: Đoạn 0) must NEVER be evicted
  const entry0 = scheduler.getEntry(0);
  assert.ok(entry0, 'Current chunk must remain present');
  assert.equal(entry0.priority, 1);
  assert.equal(entry0.state, QUEUE_ENTRY_STATES.READY);

  scheduler.dispose();
});

test('13. pruneAudioCache safely removes oldest entries without touching user data', async () => {
  _resetDbForTesting();
  const mock = createMockDexie();
  globalThis.Dexie = mock.DexieMock;

  // Populate 10 entries in audioCache
  for (let i = 0; i < 10; i++) {
    await mock.mockDb.audioCache.put({
      key: `chunk_${i}`,
      blob: new Blob([`audio-${i}`]),
      createdAt: 1000 + i
    });
  }

  assert.equal(await mock.mockDb.audioCache.count(), 10);
  assert.equal(await mock.mockDb.books.count(), 5);

  // Prune down to 4 entries
  const evictedCount = await pruneAudioCache(4);
  assert.equal(evictedCount, 6, 'Should evict 6 oldest entries');
  assert.equal(await mock.mockDb.audioCache.count(), 4, 'Should keep 4 newest entries');

  // Verify user books are untouched
  assert.equal(await mock.mockDb.books.count(), 5, 'User books table must remain untouched');

  delete globalThis.Dexie;
  _resetDbForTesting();
});
