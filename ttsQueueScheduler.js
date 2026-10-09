/**
 * Bounded Cloud TTS Queue Scheduler for VietReader (Phase 2 & Phase 3)
 *
 * Implements an event-driven, bounded queue scheduler for Cloud TTS prefetching:
 * - Cache-First Pipeline: Local IndexedDB lookup executes first without occupying network concurrency
 * - Cache Key Integrity: Cleaned text, provider, normalized voice, model, rate; zero sensitive credentials
 * - Legacy Compatibility: Safely falls back to legacy keys for default configurations
 * - Strict priorities: Priority 1 (Current chunk) > Priority 2 (N+1) > Priority 3 (N+2)
 * - Strict window limits: max 2 future chunks (N+1, N+2) in working window
 * - Concurrency control: max 1 network request at a time (configurable)
 * - Request coalescing: duplicate requests share the exact same in-flight Promise
 * - Generation validation: stale/old requests are aborted and results discarded
 * - Safe memory lifecycle: enforces max ready entries and max retained bytes
 * - 100% event-driven: zero setInterval polling, protected against duplicate loops
 */

export const QUEUE_ENTRY_STATES = Object.freeze({
  QUEUED: 'queued',
  CHECKING_CACHE: 'checking_cache',
  FETCHING: 'fetching',
  READY: 'ready',
  PLAYING: 'playing',
  CONSUMED: 'consumed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  maxConcurrency: 1,           // Tối đa 1 network request đồng thời
  maxWindowAhead: 2,           // Tối đa 2 chunks phía trước (N+1, N+2)
  maxReadyEntries: 3,          // Tối đa 3 ready entries giữ trong memory
  maxRetainedBytes: 15 * 1024 * 1024, // 15MB giới hạn dung lượng giữ trong memory
  requestTimeoutMs: 30000      // 30s timeout cho mỗi request
});

/**
 * Generates a deterministic hash string for text caching.
 */
export function hashText(str) {
  let hash = 0;
  const text = String(str || '').trim();
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Builds the canonical cache key for an audio chunk.
 * Reflects: provider, voice, model (if specialized), rate (affects synthesis), and text hash.
 * Never includes API keys, endpoints, or sensitive secrets.
 */
export function buildCacheKey({
  text,
  provider = 'fpt',
  voice = 'banmai',
  model = '',
  rate = 1.0
}) {
  const normProvider = String(provider || 'fpt').toLowerCase().trim();
  const normVoice = String(voice || 'banmai').toLowerCase().replace(/^(fpt|openai):/, '').trim();
  const rateVal = typeof rate === 'number' ? rate : (parseFloat(rate) || 1.0);
  const rateStr = (Number.isFinite(rateVal) ? rateVal : 1.0).toFixed(1);
  const textHash = hashText(text);

  let modelPart = '';
  if (normProvider === 'openai' && model && model.trim().toLowerCase() !== 'tts-1') {
    modelPart = `_${model.trim().toLowerCase()}`;
  }

  return `cloud_${normProvider}_${normVoice}${modelPart}_r${rateStr}_${textHash}`;
}

/**
 * Builds the legacy cache key (used in VietReader schema v2/Phase 1).
 */
export function buildLegacyCacheKey({
  text,
  provider = 'fpt',
  voice = 'banmai',
  rate = 1.0
}) {
  const normProvider = String(provider || 'fpt').toLowerCase().trim();
  const normVoice = String(voice || 'banmai').toLowerCase().replace(/^(fpt|openai):/, '').trim();
  const rateVal = typeof rate === 'number' ? rate : (parseFloat(rate) || 1.0);
  const rateStr = (Number.isFinite(rateVal) ? rateVal : 1.0).toFixed(1);
  const textHash = hashText(text);
  return `cloud_${normProvider}_${normVoice}_r${rateStr}_${textHash}`;
}

/**
 * Builds a deterministic fingerprint string for the audio configuration.
 */
export function makeConfigFingerprint(config = {}, rate = 1.0) {
  const provider = (config.provider || 'fpt').toLowerCase().trim();
  const voice = (config.voice || 'banmai').toLowerCase().replace(/^(fpt|openai):/, '').trim();
  const model = (config.model || '').toLowerCase().trim();
  const r = typeof rate === 'number' ? rate.toFixed(1) : (parseFloat(rate) || 1.0).toFixed(1);
  return `${provider}:${voice}:r${r}${model ? `:${model}` : ''}`;
}

/**
 * Represents a single task entry in the TTS Queue Scheduler.
 */
export class QueueEntry {
  constructor({
    chunkIndex,
    text,
    generation,
    fingerprint,
    priority = 2,
    chapterIndex = 0,
    bookId = null
  }) {
    this.key = `${generation}:${chunkIndex}:${fingerprint}`;
    this.chunkIndex = chunkIndex;
    this.text = text;
    this.generation = generation;
    this.fingerprint = fingerprint;
    this.priority = priority; // 1: current, 2: N+1, 3: N+2
    this.chapterIndex = chapterIndex;
    this.bookId = bookId;

    this.state = QUEUE_ENTRY_STATES.QUEUED;
    this.promise = null;        // Coalesced Promise<Blob>
    this._resolve = null;
    this._reject = null;
    this.abortController = null;
    this.result = null;         // Blob
    this.resultBytes = 0;
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.isCacheHit = false;

    // Cache-First tracking
    this._cacheChecked = false;
    this._isCheckingCache = false;

    // Deferred promise so multiple callers can await the same task
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    // Suppress unhandled rejection crashes when un-awaited prefetch tasks are cancelled
    this.promise.catch(() => {});
  }

  resolve(result, fromCache = false) {
    this.result = result;
    this.resultBytes = (result && typeof result.size === 'number') ? result.size : 0;
    this.isCacheHit = fromCache;
    this.completedAt = Date.now();
    this.state = QUEUE_ENTRY_STATES.READY;
    if (this._resolve) {
      this._resolve(result);
    }
  }

  reject(err) {
    this.error = err;
    this.completedAt = Date.now();
    this.state = QUEUE_ENTRY_STATES.FAILED;
    if (this._reject) {
      this._reject(err);
    }
  }

  cancel(reason = 'Cancelled by scheduler') {
    if (this.state === QUEUE_ENTRY_STATES.CANCELLED
      || this.state === QUEUE_ENTRY_STATES.CONSUMED) return;

    this.state = QUEUE_ENTRY_STATES.CANCELLED;
    this._isCheckingCache = false;
    if (this.abortController) {
      try { this.abortController.abort(); } catch (e) { /* ignore */ }
      this.abortController = null;
    }
    this.result = null;
    this.resultBytes = 0;
    if (this._reject) {
      const abortErr = new Error(reason);
      abortErr.name = 'AbortError';
      this._reject(abortErr);
    }
  }
}

/**
 * Event-Driven Bounded TTS Queue Scheduler
 */
export class TTSQueueScheduler {
  constructor(options = {}) {
    this.config = {
      ...DEFAULT_SCHEDULER_CONFIG,
      ...(options.config || {})
    };

    // External fetcher and cache hooks
    this.fetcher = options.fetcher || null;        // async (text, config, signal) => Blob
    this.cacheLookup = options.cacheLookup || null; // async (cacheKey, metadata) => Blob | null
    this.cacheStore = options.cacheStore || null;   // async (cacheKey, blob, provider, voice, metadata) => void

    this.currentGeneration = options.initialGeneration ?? 0;
    this.entries = new Map(); // entryKey -> QueueEntry
    this.activeFetches = new Set(); // Set of QueueEntry currently fetching via network
    this.totalReadyBytes = 0;

    // Loop concurrency protection
    this._isPumping = false;
    this._scheduledPump = false;
    this._isDisposed = false;

    // Observers / metrics for testing
    this.onTaskStateChange = options.onTaskStateChange || null;
    this.pumpCount = 0;

    // Lightweight bounded metrics (O(1) memory, zero secret exposure)
    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      prefetchHits: 0,
      prefetchMisses: 0,
      networkRequests: 0,
      networkFailures: 0,
      cancelledRequests: 0,
      lastRequestLatencyMs: 0,
      totalRequestLatencyMs: 0,
      lastChunkGapMs: 0
    };
    this.debugMode = Boolean(options.debugMode);
  }

  /**
   * Sets current generation. Any entries from older generations are invalidated.
   */
  setGeneration(generation) {
    if (generation === this.currentGeneration) return;
    this.invalidate(generation);
  }

  /**
   * Invalidates all entries from past generations and aborts pending network fetches.
   */
  invalidate(newGeneration = null) {
    const nextGen = newGeneration !== null ? newGeneration : this.currentGeneration + 1;
    this.currentGeneration = nextGen;

    for (const [key, entry] of this.entries.entries()) {
      if (entry.generation < this.currentGeneration) {
        entry.cancel(`Invalidated by generation ${this.currentGeneration}`);
        this.entries.delete(key);
      }
    }

    this.activeFetches.clear();
    this._recalculateReadyBytes();
    this._triggerPump();
  }

  /**
   * Cancels all queued and in-flight entries within the current generation.
   */
  cancelAll() {
    for (const entry of this.entries.values()) {
      entry.cancel('Cancelled all');
    }
    this.entries.clear();
    this.activeFetches.clear();
    this._recalculateReadyBytes();
  }

  /**
   * Updates the working prefetch window [currentIndex, currentIndex + maxWindowAhead].
   * - Sets Priority 1 for currentIndex
   * - Sets Priority 2 for currentIndex + 1
   * - Sets Priority 3 for currentIndex + 2
   * - Cancels & evicts tasks outside this window
   */
  updateWindow({
    currentIndex,
    chunks = [],
    config = {},
    rate = 1.0,
    generation = this.currentGeneration,
    chapterIndex = 0,
    bookId = null
  }) {
    if (this._isDisposed || !chunks || chunks.length === 0) return;
    if (generation < this.currentGeneration) return;
    this.currentGeneration = generation;

    const fingerprint = makeConfigFingerprint(config, rate);
    const maxAhead = this.config.maxWindowAhead;
    const windowMin = currentIndex;
    const windowMax = Math.min(chunks.length - 1, currentIndex + maxAhead);

    // 1. Evict any entries outside the window for this generation
    for (const [key, entry] of this.entries.entries()) {
      if (entry.generation === this.currentGeneration) {
        if (entry.chunkIndex < windowMin || entry.chunkIndex > windowMax || entry.fingerprint !== fingerprint) {
          entry.cancel(`Evicted outside window [${windowMin}, ${windowMax}]`);
          this.entries.delete(key);
          this.activeFetches.delete(entry);
        }
      }
    }

    // 2. Enqueue or update priority for chunks inside the window
    for (let idx = windowMin; idx <= windowMax; idx++) {
      const text = chunks[idx];
      if (!text || !text.trim()) continue;

      const priority = (idx === currentIndex) ? 1 : (idx === currentIndex + 1 ? 2 : 3);
      this._getOrCreateEntry({
        chunkIndex: idx,
        text,
        generation: this.currentGeneration,
        fingerprint,
        priority,
        chapterIndex,
        bookId,
        config,
        rate
      });
    }

    this._recalculateReadyBytes();
    this._triggerPump();
  }

  /**
   * Requests a specific chunk with Priority 1 (Current playback chunk).
   * Returns a Promise<Blob> that resolves with the audio data.
   * If the chunk is already fetching (e.g. from prefetch), the existing Promise is reused (Coalesced)!
   */
  requestChunk({
    chunkIndex,
    text,
    config = {},
    rate = 1.0,
    generation = this.currentGeneration,
    chapterIndex = 0,
    bookId = null
  }) {
    if (this._isDisposed) {
      return Promise.reject(new Error('TTSQueueScheduler has been disposed'));
    }
    if (generation < this.currentGeneration) {
      return Promise.reject(new Error(`Stale generation ${generation} (current: ${this.currentGeneration})`));
    }
    this.currentGeneration = generation;

    const fingerprint = makeConfigFingerprint(config, rate);
    const entry = this._getOrCreateEntry({
      chunkIndex,
      text,
      generation: this.currentGeneration,
      fingerprint,
      priority: 1, // Boost to priority 1
      chapterIndex,
      bookId,
      config,
      rate
    });

    // If entry was queued or fetching with lower priority, boost it
    entry.priority = 1;

    // If already ready, return result immediately (Prefetch Hit)
    if (entry.state === QUEUE_ENTRY_STATES.READY && entry.result) {
      this.metrics.prefetchHits++;
      if (this.debugMode) {
        console.log(`[TTSQueueScheduler] Prefetch HIT for chunk ${chunkIndex} (0ms handoff)`);
      }
      return Promise.resolve(entry.result);
    }

    this.metrics.prefetchMisses++;
    this._triggerPump();
    return entry.promise;
  }

  /**
   * Records chunk handoff gap latency in milliseconds.
   */
  recordChunkGap(gapMs) {
    if (typeof gapMs === 'number' && Number.isFinite(gapMs)) {
      this.metrics.lastChunkGapMs = Math.round(gapMs);
      if (this.debugMode) {
        console.log(`[TTSQueueScheduler] Chunk gap latency: ${this.metrics.lastChunkGapMs}ms`);
      }
    }
  }

  /**
   * Returns an immutable snapshot of lightweight performance metrics.
   */
  getMetrics() {
    const readyEntries = Array.from(this.entries.values()).filter(e => e.state === QUEUE_ENTRY_STATES.READY).length;
    const completedFetches = Math.max(0, this.metrics.networkRequests - this.metrics.networkFailures - this.metrics.cancelledRequests);
    const avgLatency = completedFetches > 0
      ? Math.round(this.metrics.totalRequestLatencyMs / completedFetches)
      : 0;

    return {
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
      prefetchHits: this.metrics.prefetchHits,
      prefetchMisses: this.metrics.prefetchMisses,
      networkRequests: this.metrics.networkRequests,
      networkFailures: this.metrics.networkFailures,
      cancelledRequests: this.metrics.cancelledRequests,
      lastRequestLatencyMs: this.metrics.lastRequestLatencyMs,
      averageRequestLatencyMs: avgLatency,
      lastChunkGapMs: this.metrics.lastChunkGapMs,
      queueSize: this.entries.size,
      activeRequests: this.activeFetches.size,
      readyEntries,
      estimatedRetainedBytes: this.totalReadyBytes,
      debugMode: this.debugMode
    };
  }

  /**
   * Resets all metric counters.
   */
  resetMetrics() {
    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      prefetchHits: 0,
      prefetchMisses: 0,
      networkRequests: 0,
      networkFailures: 0,
      cancelledRequests: 0,
      lastRequestLatencyMs: 0,
      totalRequestLatencyMs: 0,
      lastChunkGapMs: 0
    };
  }

  /**
   * Enables or disables debug console logging.
   */
  setDebugMode(enabled) {
    this.debugMode = Boolean(enabled);
  }

  /**
   * Marks a ready chunk as actively playing.
   */
  markPlaying(chunkIndex, fingerprint = null) {
    const entry = this._findEntry(this.currentGeneration, chunkIndex, fingerprint);
    if (entry && entry.state === QUEUE_ENTRY_STATES.READY) {
      entry.state = QUEUE_ENTRY_STATES.PLAYING;
      this._notifyStateChange(entry);
    }
  }

  /**
   * Marks a playing or ready chunk as consumed. Releases retained audio blob memory.
   */
  markConsumed(chunkIndex, fingerprint = null) {
    const entry = this._findEntry(this.currentGeneration, chunkIndex, fingerprint);
    if (entry) {
      entry.state = QUEUE_ENTRY_STATES.CONSUMED;
      entry.result = null;
      entry.resultBytes = 0;
      this.entries.delete(entry.key);
      this.activeFetches.delete(entry);
      this._recalculateReadyBytes();
      this._notifyStateChange(entry);
    }
  }

  /**
   * Returns an entry if already present in memory.
   */
  getEntry(chunkIndex, fingerprint = null, generation = this.currentGeneration) {
    return this._findEntry(generation, chunkIndex, fingerprint);
  }

  /**
   * Disposes the scheduler and aborts all active requests (Idempotent).
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    for (const entry of this.entries.values()) {
      entry.cancel('Scheduler disposed');
    }
    this.entries.clear();
    this.activeFetches.clear();
    this.totalReadyBytes = 0;
  }

  /**
   * Returns a snapshot of queue state for inspection and metrics.
   */
  getSnapshot() {
    const list = Array.from(this.entries.values()).map(e => ({
      chunkIndex: e.chunkIndex,
      priority: e.priority,
      state: e.state,
      generation: e.generation,
      isCacheHit: e.isCacheHit,
      resultBytes: e.resultBytes
    }));

    return {
      currentGeneration: this.currentGeneration,
      totalEntries: this.entries.size,
      activeFetchesCount: this.activeFetches.size,
      totalReadyBytes: this.totalReadyBytes,
      metrics: this.getMetrics(),
      entries: list
    };
  }

  // ==========================================================================
  // INTERNAL SCHEDULER LOGIC
  // ==========================================================================

  _getOrCreateEntry({
    chunkIndex,
    text,
    generation,
    fingerprint,
    priority,
    chapterIndex,
    bookId,
    config,
    rate
  }) {
    const key = `${generation}:${chunkIndex}:${fingerprint}`;
    let entry = this.entries.get(key);

    if (entry) {
      // Coalescing: update priority if higher (1 is higher than 2 or 3)
      if (priority < entry.priority) {
        entry.priority = priority;
      }
      return entry;
    }

    // Check if an existing valid entry with same chunkIndex and fingerprint exists in another generation (e.g. from pause/resume)
    for (const [k, existing] of this.entries.entries()) {
      if (
        existing.chunkIndex === chunkIndex &&
        existing.fingerprint === fingerprint &&
        existing.state !== QUEUE_ENTRY_STATES.CANCELLED &&
        existing.state !== QUEUE_ENTRY_STATES.FAILED &&
        existing.state !== QUEUE_ENTRY_STATES.CONSUMED
      ) {
        // Migrate entry to current generation
        this.entries.delete(k);
        existing.generation = generation;
        existing.key = key;
        if (priority < existing.priority) {
          existing.priority = priority;
        }
        this.entries.set(key, existing);
        return existing;
      }
    }

    entry = new QueueEntry({
      chunkIndex,
      text,
      generation,
      fingerprint,
      priority,
      chapterIndex,
      bookId
    });
    entry._config = config;
    entry._rate = rate;

    this.entries.set(key, entry);
    this._notifyStateChange(entry);
    return entry;
  }

  _findEntry(generation, chunkIndex, fingerprint) {
    if (fingerprint) {
      const direct = this.entries.get(`${generation}:${chunkIndex}:${fingerprint}`);
      if (direct) return direct;
      for (const entry of this.entries.values()) {
        if (
          entry.chunkIndex === chunkIndex &&
          entry.fingerprint === fingerprint &&
          entry.state !== QUEUE_ENTRY_STATES.CANCELLED
        ) {
          return entry;
        }
      }
      return null;
    }
    for (const entry of this.entries.values()) {
      if (entry.generation === generation && entry.chunkIndex === chunkIndex) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Event-driven pump mechanism protected against re-entrant duplicate loops.
   */
  _triggerPump() {
    if (this._isDisposed) return;
    if (this._isPumping) {
      this._scheduledPump = true;
      return;
    }

    this._isPumping = true;
    this.pumpCount++;

    try {
      this._processQueue();
    } finally {
      this._isPumping = false;
      if (this._scheduledPump && !this._isDisposed) {
        this._scheduledPump = false;
        // Schedule next turn via microtask to avoid recursive stack overflow
        queueMicrotask(() => this._triggerPump());
      }
    }
  }

  _processQueue() {
    if (this._isDisposed) return;

    // 1. Enforce memory retention limits (evict oldest / lowest priority ready blobs if over limit)
    this._enforceMemoryLimits();

    // 2. STEP A: CACHE-FIRST PIPELINE
    // Look up local cache for any queued entry that hasn't checked cache yet.
    // Cache lookups do NOT consume network concurrency slots.
    const uninspectedCandidates = Array.from(this.entries.values()).filter(e =>
      e.generation === this.currentGeneration &&
      e.state === QUEUE_ENTRY_STATES.QUEUED &&
      !e._cacheChecked &&
      !e._isCheckingCache
    );

    if (typeof this.cacheLookup === 'function') {
      uninspectedCandidates.sort((a, b) => a.priority - b.priority || a.chunkIndex - b.chunkIndex);
      for (const entry of uninspectedCandidates) {
        this._executeCacheLookup(entry);
      }
    } else {
      // If no cacheLookup hook is provided, mark as checked immediately to allow network fetch
      for (const entry of uninspectedCandidates) {
        entry._cacheChecked = true;
      }
    }

    // 3. STEP B: BOUNDED NETWORK FETCH PIPELINE
    // Count active network fetches
    const activeNetworkFetches = Array.from(this.activeFetches).filter(e =>
      e.generation === this.currentGeneration &&
      e.state === QUEUE_ENTRY_STATES.FETCHING
    );

    if (activeNetworkFetches.length >= this.config.maxConcurrency) {
      return; // Network concurrency limit reached
    }

    // Find candidates whose cache lookup missed and are ready for network
    const networkCandidates = Array.from(this.entries.values()).filter(e =>
      e.generation === this.currentGeneration &&
      e.state === QUEUE_ENTRY_STATES.QUEUED &&
      e._cacheChecked
    );

    if (networkCandidates.length === 0) return;

    // Sort strictly by Priority (1 > 2 > 3), then chunkIndex ascending
    networkCandidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.chunkIndex - b.chunkIndex;
    });

    // Select the top candidate
    const candidate = networkCandidates[0];
    this._executeNetworkFetch(candidate);

    // If concurrency allows more, schedule another check
    if (this.config.maxConcurrency > 1) {
      this._scheduledPump = true;
    }
  }

  /**
   * Executes local Cache-First lookup for a queued entry.
   * Does NOT consume network concurrency.
   */
  async _executeCacheLookup(entry) {
    if (entry._isCheckingCache || entry.state !== QUEUE_ENTRY_STATES.QUEUED) return;
    entry._isCheckingCache = true;
    entry.state = QUEUE_ENTRY_STATES.CHECKING_CACHE;
    this._notifyStateChange(entry);

    const provider = (entry._config && entry._config.provider) || 'fpt';
    const voice = (entry._config && entry._config.voice) || 'banmai';
    const model = (entry._config && entry._config.model) || '';
    const rate = entry._rate || 1.0;

    const cacheKey = buildCacheKey({ text: entry.text, provider, voice, model, rate });
    const legacyKey = buildLegacyCacheKey({ text: entry.text, provider, voice, rate });
    const metadata = { provider, voice, model, rate, textHash: hashText(entry.text) };

    let cachedBlob = null;
    try {
      if (typeof this.cacheLookup === 'function') {
        // 1. Primary canonical cache key
        cachedBlob = await this.cacheLookup(cacheKey, metadata);

        // 2. Legacy cache key fallback if canonical missed and model allows safe compatibility
        if (!cachedBlob && legacyKey !== cacheKey && (!model || model === 'tts-1')) {
          cachedBlob = await this.cacheLookup(legacyKey, metadata);
        }
      }
    } catch (err) {
      // Storage error must not fail queue; fall back to network fetch
      cachedBlob = null;
    } finally {
      entry._isCheckingCache = false;
    }

    // Check if invalidated during async cache lookup
    if (this._isEntryInvalidated(entry)) {
      return;
    }

    // Verify blob integrity (not null, size > 0)
    const isValidBlob = cachedBlob && (typeof cachedBlob.size !== 'number' || cachedBlob.size > 0);

    if (isValidBlob) {
      // CACHE HIT: Complete immediately without occupying network concurrency
      this.metrics.cacheHits++;
      if (this.debugMode) {
        console.log(`[TTSQueueScheduler] Cache HIT for chunk ${entry.chunkIndex}`);
      }
      entry.resolve(cachedBlob, true);
      this._recalculateReadyBytes();
      this._notifyStateChange(entry);
      this._triggerPump();
    } else {
      // CACHE MISS: Mark ready for bounded network scheduling
      this.metrics.cacheMisses++;
      entry._cacheChecked = true;
      entry.state = QUEUE_ENTRY_STATES.QUEUED;
      this._notifyStateChange(entry);
      this._triggerPump();
    }
  }

  /**
   * Executes network fetch for a candidate after cache miss.
   * Strictly bounded by maxConcurrency.
   */
  async _executeNetworkFetch(entry) {
    if (entry.state !== QUEUE_ENTRY_STATES.QUEUED || !entry._cacheChecked) return;
    if (entry.generation !== this.currentGeneration) {
      entry.cancel('Skipped stale generation entry');
      return;
    }

    entry.state = QUEUE_ENTRY_STATES.FETCHING;
    entry.startedAt = Date.now();
    this.activeFetches.add(entry);
    this._notifyStateChange(entry);
    this.metrics.networkRequests++;

    const abortController = new AbortController();
    entry.abortController = abortController;

    // Set timeout safeguard
    let timeoutId = null;
    if (this.config.requestTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (entry.state === QUEUE_ENTRY_STATES.FETCHING) {
          abortController.abort(new Error(`Request timeout after ${this.config.requestTimeoutMs}ms`));
        }
      }, this.config.requestTimeoutMs);
      if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
    }

    const provider = (entry._config && entry._config.provider) || 'fpt';
    const voice = (entry._config && entry._config.voice) || 'banmai';
    const model = (entry._config && entry._config.model) || '';
    const rate = entry._rate || 1.0;
    const cacheKey = buildCacheKey({ text: entry.text, provider, voice, model, rate });
    const metadata = { provider, voice, model, rate, textHash: hashText(entry.text) };

    const fetchStartTime = Date.now();

    try {
      if (typeof this.fetcher !== 'function') {
        throw new Error('No fetcher provided to TTSQueueScheduler');
      }

      const audioBlob = await this.fetcher(entry.text, entry._config || {}, abortController.signal);

      if (timeoutId) clearTimeout(timeoutId);

      // Verify generation validity before affecting runtime state
      if (this._isEntryInvalidated(entry)) {
        return;
      }

      if (!audioBlob || (typeof audioBlob.size === 'number' && audioBlob.size <= 0)) {
        throw new Error('Fetcher returned empty audio data');
      }

      const latencyMs = Date.now() - fetchStartTime;
      this.metrics.lastRequestLatencyMs = latencyMs;
      this.metrics.totalRequestLatencyMs += latencyMs;
      if (this.debugMode) {
        console.log(`[TTSQueueScheduler] Network fetch OK for chunk ${entry.chunkIndex} (${latencyMs}ms)`);
      }

      // Save to cache asynchronously (fire-and-forget, with storage error protection)
      if (typeof this.cacheStore === 'function') {
        try {
          this.cacheStore(cacheKey, audioBlob, provider, voice, metadata).catch(() => {});
        } catch (e) {
          // ignore cache write error
        }
      }

      this.activeFetches.delete(entry);
      entry.abortController = null;
      entry.resolve(audioBlob, false);
      this._recalculateReadyBytes();
      this._notifyStateChange(entry);

    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      this.activeFetches.delete(entry);
      entry.abortController = null;

      if (this._isEntryInvalidated(entry)) {
        return;
      }

      const isAborted = abortController.signal.aborted
        || err?.name === 'AbortError'
        || /abort/i.test(err?.message || '');

      if (isAborted) {
        this.metrics.cancelledRequests++;
        entry.cancel('Request aborted');
      } else {
        this.metrics.networkFailures++;
        entry.reject(err);
      }
      this._notifyStateChange(entry);
    } finally {
      this._triggerPump();
    }
  }

  _isEntryInvalidated(entry) {
    if (this._isDisposed) {
      entry.cancel('Scheduler disposed');
      return true;
    }
    if (entry.generation !== this.currentGeneration || entry.state === QUEUE_ENTRY_STATES.CANCELLED) {
      entry.cancel('Generation mismatch');
      return true;
    }
    return false;
  }

  _enforceMemoryLimits() {
    const readyEntries = Array.from(this.entries.values()).filter(e =>
      e.generation === this.currentGeneration && e.state === QUEUE_ENTRY_STATES.READY
    );

    // Sort ready entries by priority descending (lower priority entries get evicted first)
    readyEntries.sort((a, b) => b.priority - a.priority || b.chunkIndex - a.chunkIndex);

    // Limit by count
    while (readyEntries.length > this.config.maxReadyEntries) {
      const toEvict = readyEntries.shift();
      if (toEvict && toEvict.priority > 1) { // Never evict Priority 1 (Current chunk)
        toEvict.cancel('Evicted by maxReadyEntries limit');
        this.entries.delete(toEvict.key);
      } else {
        break;
      }
    }

    // Limit by bytes
    this._recalculateReadyBytes();
    while (this.totalReadyBytes > this.config.maxRetainedBytes && readyEntries.length > 1) {
      const toEvict = readyEntries.shift();
      if (toEvict && toEvict.priority > 1) {
        toEvict.cancel('Evicted by maxRetainedBytes limit');
        this.entries.delete(toEvict.key);
        this._recalculateReadyBytes();
      } else {
        break;
      }
    }
  }

  _recalculateReadyBytes() {
    let bytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === QUEUE_ENTRY_STATES.READY && entry.result) {
        bytes += entry.resultBytes;
      }
    }
    this.totalReadyBytes = bytes;
  }

  _notifyStateChange(entry) {
    if (typeof this.onTaskStateChange === 'function') {
      try {
        this.onTaskStateChange(entry.chunkIndex, entry.state, entry.priority);
      } catch (e) {
        // observer failure ignored
      }
    }
  }
}
