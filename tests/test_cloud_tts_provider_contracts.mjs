import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCloudAudio,
  downloadAudioWithRetry,
  classifyError,
  validateAudioBlob,
  abortableSleep,
  sanitizeErrorMessage,
  CloudTtsError
} from './cloudTtsProvider.js';
import {
  TTSQueueScheduler,
  QUEUE_ENTRY_STATES,
  buildCacheKey
} from './ttsQueueScheduler.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('1. OpenAI TTS: Successful binary stream audio response', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestHeaders = null;
  let requestBody = null;

  globalThis.fetch = async (url, options = {}) => {
    requestedUrl = url;
    requestHeaders = options.headers;
    requestBody = JSON.parse(options.body);

    const audioBytes = new Uint8Array(500).fill(65);
    return new Response(audioBytes, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '500' }
    });
  };

  try {
    const blob = await fetchCloudAudio({
      text: 'Chào bạn từ OpenAI',
      provider: 'openai',
      voice: 'nova',
      config: { apiKey: 'sk-test-secret-key-123456789' },
      rate: 1.2
    });

    assert.ok(blob instanceof Blob);
    assert.equal(blob.size, 500);
    assert.equal(requestedUrl, 'https://api.openai.com/v1/audio/speech');
    assert.equal(requestHeaders['Authorization'], 'Bearer sk-test-secret-key-123456789');
    assert.equal(requestBody.input, 'Chào bạn từ OpenAI');
    assert.equal(requestBody.voice, 'nova');
    assert.equal(requestBody.speed, 1.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2. FPT AI TTS: Successful async response with CDN polling', async () => {
  const originalFetch = globalThis.fetch;
  let fptApiCallCount = 0;
  let cdnPollCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('api.fpt.ai')) {
      fptApiCallCount++;
      return new Response(JSON.stringify({
        error: 0,
        async: 'https://cdn.fpt.ai/audio_mock_123.mp3',
        message: 'success'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.includes('cdn.fpt.ai')) {
      cdnPollCount++;
      if (cdnPollCount === 1) {
        // First CDN check: still transcoding (404)
        return new Response('Not ready yet', { status: 404 });
      }
      // Second CDN check: ready with valid audio
      const audioBytes = new Uint8Array(800).fill(70);
      return new Response(audioBytes, {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '800' }
      });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const blob = await fetchCloudAudio({
      text: 'Chào bạn từ FPT AI',
      provider: 'fpt',
      voice: 'banmai',
      config: { apiKey: 'fpt-mock-api-key-999', initialPollDelayMs: 15 },
      rate: 1.0
    });

    assert.ok(blob instanceof Blob);
    assert.equal(blob.size, 800);
    assert.equal(fptApiCallCount, 1);
    assert.equal(cdnPollCount, 2, 'Must have polled CDN twice until ready');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('3. Custom Endpoint: OpenAI-compatible endpoint and base64 fallback', async () => {
  const originalFetch = globalThis.fetch;

  // Test custom endpoint returning base64 audio in JSON
  const dummyBase64 = Buffer.from(new Uint8Array(200).fill(88)).toString('base64');
  globalThis.fetch = async (url, options = {}) => {
    return new Response(JSON.stringify({
      audio_base64: dummyBase64
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const blob = await fetchCloudAudio({
      text: 'Câu đọc custom endpoint',
      provider: 'custom',
      config: { endpoint: 'http://localhost:8000/v1/audio/speech' }
    });

    assert.ok(blob instanceof Blob);
    assert.equal(blob.size, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('4. Authentication Errors: 401 / Invalid API Key must NOT retry and must sanitize secrets', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  globalThis.fetch = async () => {
    fetchCallCount++;
    return new Response(JSON.stringify({
      error: { message: 'Incorrect API key provided: Bearer sk-secret-1234567890abcdef', code: 'invalid_api_key' }
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await assert.rejects(
      async () => {
        await fetchCloudAudio({
          text: 'Thử auth fail',
          provider: 'openai',
          config: { apiKey: 'sk-secret-1234567890abcdef' }
        });
      },
      (err) => {
        assert.equal(err.statusCode, 401);
        assert.equal(err.isRetryable, false, 'Auth error must be strictly non-retryable');
        assert.ok(!err.message.includes('sk-secret-1234567890abcdef'), 'Error message must NOT leak secret key');
        return true;
      }
    );

    assert.equal(fetchCallCount, 1, 'Must NOT retry on 401 error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('5. Quota Errors: 429 Insufficient Quota must NOT retry', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  globalThis.fetch = async () => {
    fetchCallCount++;
    return new Response(JSON.stringify({
      error: { message: 'You exceeded your current quota, please check your plan.', type: 'insufficient_quota' }
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await assert.rejects(
      async () => {
        await fetchCloudAudio({
          text: 'Thử quota fail',
          provider: 'openai',
          config: { apiKey: 'sk-quota-exhausted' }
        });
      },
      (err) => {
        assert.equal(err.statusCode, 429);
        assert.equal(err.isRetryable, false, 'Quota error must be strictly non-retryable');
        assert.ok(/quota/i.test(err.message));
        return true;
      }
    );

    assert.equal(fetchCallCount, 1, 'Must NOT retry on quota exhausted error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('6. Transient Server Errors (HTTP 500/503): Retries with backoff up to bounded limit', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  // Fail 2 times with 503, succeed on 3rd attempt
  globalThis.fetch = async () => {
    fetchCallCount++;
    if (fetchCallCount < 3) {
      return new Response('Service Unavailable', { status: 503 });
    }
    const audioBytes = new Uint8Array(400).fill(75);
    return new Response(audioBytes, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '400' }
    });
  };

  try {
    const blob = await fetchCloudAudio({
      text: 'Thử transient retry',
      provider: 'openai',
      config: { apiKey: 'sk-test', initialRetryDelayMs: 10 }
    });

    assert.ok(blob);
    assert.equal(fetchCallCount, 3, 'Must have retried twice and succeeded on 3rd attempt');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('7. Continuous Server Error: Bounded retry terminates and throws without infinite loop', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  // Always return 500
  globalThis.fetch = async () => {
    fetchCallCount++;
    return new Response('Internal Server Error', { status: 500 });
  };

  try {
    await assert.rejects(
      async () => {
        await fetchCloudAudio({
          text: 'Thử 500 liên tục',
          provider: 'openai',
          config: { apiKey: 'sk-test', initialRetryDelayMs: 10 }
        });
      },
      (err) => {
        assert.equal(err.statusCode, 500);
        return true;
      }
    );

    // Initial attempt + 2 retries = 3 attempts total
    assert.equal(fetchCallCount, 3, 'Must stop strictly at max retries (total 3 attempts)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('8. Timeout: Request exceeding timeout aborts immediately', async () => {
  const originalFetch = globalThis.fetch;

  // Hang forever
  globalThis.fetch = async (url, { signal }) => {
    return new Promise((resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };

  try {
    await assert.rejects(
      async () => {
        await fetchCloudAudio({
          text: 'Thử timeout',
          provider: 'openai',
          config: { apiKey: 'sk-test' },
          timeoutMs: 50 // 50ms timeout
        });
      },
      { name: 'AbortError' }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('9. Cancellation: AbortController cancels fetch and abortableSleep immediately', async () => {
  const controller = new AbortController();

  const start = Date.now();
  const sleepPromise = abortableSleep(1000, controller.signal);

  // Abort after 20ms
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(sleepPromise, { name: 'AbortError' });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `Sleep must cancel immediately on abort, took ${elapsed}ms`);
});

test('10. Empty & Malformed Audio: Detects invalid/HTML response and rejects', async () => {
  // Empty blob
  assert.throws(
    () => validateAudioBlob(new Blob([], { type: 'audio/mpeg' }), 'fpt'),
    /quá nhỏ hoặc bị hỏng/i
  );

  // HTML error page returned with 200
  assert.throws(
    () => validateAudioBlob(new Blob(['<html><body>Cloudflare Blocked</body></html>'], { type: 'text/html' }), 'openai'),
    /trang văn bản thay vì file âm thanh/i
  );
});

test('11. Queue Scheduler: Duplicate requests are coalesced into a single provider call', async () => {
  let providerCallCount = 0;
  const def = createDeferred();

  const scheduler = new TTSQueueScheduler({
    fetcher: async () => {
      providerCallCount++;
      return def.promise;
    }
  });

  const config = { provider: 'openai', voice: 'nova' };
  const req1 = scheduler.requestChunk({ chunkIndex: 0, text: 'Câu trùng', config });
  const req2 = scheduler.requestChunk({ chunkIndex: 0, text: 'Câu trùng', config });

  assert.equal(req1, req2, 'Must return the same Promise');
  assert.equal(providerCallCount, 1, 'Provider must only be called once');

  def.resolve(new Blob(['audio-data-500-bytes']));
  const [b1, b2] = await Promise.all([req1, req2]);
  assert.equal(b1, b2);

  scheduler.dispose();
});

test('12. Concurrency Limit: Enforces maxConcurrency = 1 across multiple queued chunks', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const deferreds = [];

  const scheduler = new TTSQueueScheduler({
    config: { maxConcurrency: 1, maxWindowAhead: 2 },
    fetcher: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const def = createDeferred();
      deferreds.push(def);
      return def.promise;
    }
  });

  scheduler.updateWindow({
    currentIndex: 0,
    chunks: ['Đoạn 0', 'Đoạn 1', 'Đoạn 2']
  });

  await delay(15);
  assert.equal(maxInFlight, 1, 'In-flight provider requests must strictly NOT exceed 1');

  // Resolve 1st -> 2nd starts
  inFlight--;
  deferreds[0].resolve(new Blob(['audio-0']));
  await delay(15);
  assert.equal(maxInFlight, 1);

  // Resolve 2nd -> 3rd starts
  inFlight--;
  deferreds[1].resolve(new Blob(['audio-1']));
  await delay(15);
  assert.equal(maxInFlight, 1);

  inFlight--;
  deferreds[2].resolve(new Blob(['audio-2']));
  await delay(15);
  assert.equal(inFlight, 0);

  scheduler.dispose();
});

test('13. Cache Integrity on Failure: Failed or aborted requests never write to cache', async () => {
  const cache = new Map();

  const scheduler = new TTSQueueScheduler({
    cacheLookup: async (k) => cache.get(k) || null,
    cacheStore: async (k, b) => { cache.set(k, b); },
    fetcher: async () => {
      const authErr = new Error('Invalid API Key');
      authErr.statusCode = 401;
      throw authErr;
    }
  });

  await assert.rejects(
    async () => {
      await scheduler.requestChunk({
        chunkIndex: 0,
        text: 'Thất bại không ghi cache',
        config: { provider: 'fpt', voice: 'banmai' }
      });
    }
  );

  await delay(15);
  assert.equal(cache.size, 0, 'Cache must remain completely empty after request failure');

  scheduler.dispose();
});
