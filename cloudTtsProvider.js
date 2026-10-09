/**
 * Cloud TTS Provider Adapter for VietReader (Phase 4)
 *
 * Implements robust, bounded, secure HTTP adapters for:
 * - FPT AI TTS (Text -> Async CDN URL -> Polling Download)
 * - OpenAI TTS (Text -> Binary Stream)
 * - Custom Endpoint (OpenAI-compatible, Remote URL, or Base64)
 *
 * Features:
 * - Strict non-retryable handling for 401/403/invalid key and quota exhausted
 * - Bounded retries with exponential backoff for transient 5xx & network glitches
 * - Immediate abort responsiveness via abortableSleep (zero lingering timers)
 * - Strict audio payload validation (catches empty blobs, XML/HTML error pages)
 * - Complete credential sanitization in logs and error messages
 */

export class CloudTtsError extends Error {
  constructor(message, { provider = 'cloud', statusCode = null, isRetryable = false, cause = null } = {}) {
    super(sanitizeErrorMessage(message));
    this.name = 'CloudTtsError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
    this.cause = cause;
  }
}

/**
 * Sanitizes sensitive tokens, API keys, and authorization headers from error messages.
 */
export function sanitizeErrorMessage(message) {
  if (!message || typeof message !== 'string') return '';
  return message
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{10,}/gi, 'Bearer [REDACTED]')
    .replace(/api-key[:\s=]+[a-zA-Z0-9_\-\.]{10,}/gi, 'api-key=[REDACTED]')
    .replace(/sk-[a-zA-Z0-9_\-\.]{20,}/gi, 'sk-[REDACTED]');
}

/**
 * Classifies an error into permanent (non-retryable) vs transient (retryable).
 */
export function classifyError(err, provider = 'cloud', statusCode = null, responseBody = '') {
  const status = statusCode || (err?.statusCode ?? null);
  const bodyText = typeof responseBody === 'string' ? responseBody.toLowerCase() : '';
  const msg = (err?.message || '').toLowerCase();

  // 1. Abort Error -> NEVER retry, intentional cancellation
  if (err?.name === 'AbortError' || /abort/i.test(msg)) {
    const abortErr = new Error('Yêu cầu đã bị hủy (Aborted).');
    abortErr.name = 'AbortError';
    return abortErr;
  }

  // 2. Authentication / Authorization (401, 403, invalid key) -> NEVER retry
  if (status === 401 || status === 403
    || bodyText.includes('invalid api key')
    || bodyText.includes('invalid_api_key')
    || bodyText.includes('unauthorized')
    || bodyText.includes('forbidden')
    || bodyText.includes('key không hợp lệ')
    || msg.includes('401') || msg.includes('403')) {
    return new CloudTtsError(`API Key của ${provider.toUpperCase()} không hợp lệ hoặc đã bị khóa (HTTP ${status || 401}).`, {
      provider,
      statusCode: status || 401,
      isRetryable: false,
      cause: err
    });
  }

  // 3. Quota Exhausted -> NEVER retry
  if ((status === 429 && (bodyText.includes('quota') || bodyText.includes('insufficient_quota')))
    || bodyText.includes('out of quota')
    || bodyText.includes('hết hạn ngạch')
    || bodyText.includes('exceeded your current quota')) {
    return new CloudTtsError(`Tài khoản ${provider.toUpperCase()} đã hết hạn ngạch gọi API (Quota Exceeded).`, {
      provider,
      statusCode: status || 429,
      isRetryable: false,
      cause: err
    });
  }

  // 4. Client Configuration Error (400, 404, 422) -> NEVER retry
  if (status === 400 || status === 404 || status === 422) {
    const detail = sanitizeErrorMessage(responseBody.slice(0, 100).trim());
    return new CloudTtsError(`Lỗi cấu hình yêu cầu ${provider.toUpperCase()} (HTTP ${status}): ${detail}`, {
      provider,
      statusCode: status,
      isRetryable: false,
      cause: err
    });
  }

  // 5. Temporary Rate Limit (429 without quota error) -> RETRYABLE with backoff
  if (status === 429) {
    return new CloudTtsError(`Tạm thời bị giới hạn tốc độ gọi API ${provider.toUpperCase()} (Rate Limit). Vui lòng thử lại sau giây lát.`, {
      provider,
      statusCode: 429,
      isRetryable: true,
      cause: err
    });
  }

  // 6. Server Errors (500, 502, 503, 504) -> RETRYABLE with backoff
  if (status >= 500 && status <= 599) {
    return new CloudTtsError(`Máy chủ ${provider.toUpperCase()} đang gặp sự cố tạm thời (HTTP ${status}).`, {
      provider,
      statusCode: status,
      isRetryable: true,
      cause: err
    });
  }

  // 7. Network / Fetch Failures (timeout, connection reset, offline) -> RETRYABLE
  if (/failed to fetch|network|timeout|econnreset|etimedout/i.test(msg) || !status) {
    return new CloudTtsError(`Lỗi kết nối mạng tới máy chủ ${provider.toUpperCase()}: ${err.message}`, {
      provider,
      statusCode: status,
      isRetryable: true,
      cause: err
    });
  }

  // Generic fallback
  return new CloudTtsError(err.message, { provider, statusCode: status, isRetryable: false, cause: err });
}

/**
 * Abort-aware sleep promise that cancels immediately when signal triggers.
 */
export async function abortableSleep(ms, signal = null) {
  if (signal?.aborted) {
    const err = new Error('Yêu cầu đã bị hủy (Aborted).');
    err.name = 'AbortError';
    throw err;
  }
  if (ms <= 0) return;

  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      const err = new Error('Yêu cầu đã bị hủy (Aborted).');
      err.name = 'AbortError';
      reject(err);
    };

    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Validates that an audio Blob is non-empty and not an HTML/text error response.
 */
export function validateAudioBlob(blob, provider = 'cloud') {
  if (!blob) {
    throw new CloudTtsError(`Máy chủ ${provider.toUpperCase()} không trả về dữ liệu âm thanh (Empty response).`, {
      provider,
      isRetryable: false
    });
  }
  if (blob.type && (blob.type.includes('text/html') || blob.type.includes('text/plain') || blob.type.includes('application/json'))) {
    throw new CloudTtsError(`Máy chủ ${provider.toUpperCase()} trả về trang văn bản thay vì file âm thanh (${blob.type}).`, {
      provider,
      isRetryable: false
    });
  }
  if (typeof blob.size === 'number' && blob.size < 100) {
    throw new CloudTtsError(`Dữ liệu âm thanh từ ${provider.toUpperCase()} quá nhỏ hoặc bị hỏng (${blob.size} bytes).`, {
      provider,
      isRetryable: false
    });
  }
  return blob;
}

/**
 * Converts a base64 string to a Blob.
 */
function base64ToBlob(base64Data, contentType = 'audio/mpeg') {
  const binaryString = globalThis.atob ? globalThis.atob(base64Data) : Buffer.from(base64Data, 'base64').toString('binary');
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}

/**
 * Executes a network fetch with bounded retries and exponential backoff for transient errors.
 */
async function fetchWithBoundedRetry(url, options = {}, {
  provider = 'cloud',
  maxRetries = 2,
  initialDelayMs = 800,
  maxDelayMs = 3000,
  signal = null
} = {}) {
  let attempt = 0;

  while (true) {
    if (signal?.aborted) {
      const err = new Error('Yêu cầu đã bị hủy (Aborted).');
      err.name = 'AbortError';
      throw err;
    }

    try {
      const response = await fetch(url, { ...options, signal: signal || undefined });

      if (response.ok) {
        return response;
      }

      // Read response error body safely
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch (e) { /* ignore */ }

      const classified = classifyError(null, provider, response.status, errorBody);

      // If non-retryable (401, 403, 400, quota) or reached max retries, throw immediately
      if (!classified.isRetryable || attempt >= maxRetries) {
        throw classified;
      }

      // Transient error: wait with backoff
      attempt++;
      const delayMs = Math.min(initialDelayMs * Math.pow(1.5, attempt - 1), maxDelayMs);
      await abortableSleep(delayMs, signal);

    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw err;
      }

      const classified = (err instanceof CloudTtsError) ? err : classifyError(err, provider);

      if (!classified.isRetryable || attempt >= maxRetries) {
        throw classified;
      }

      attempt++;
      const delayMs = Math.min(initialDelayMs * Math.pow(1.5, attempt - 1), maxDelayMs);
      await abortableSleep(delayMs, signal);
    }
  }
}

/**
 * Polls and downloads audio file from remote URL (e.g. FPT CDN) until ready.
 */
export async function downloadAudioWithRetry(url, maxRetries = 6, delayMs = 800, signal = null) {
  let attemptDelay = delayMs;

  for (let i = 0; i < maxRetries; i++) {
    if (signal?.aborted) {
      const err = new Error('Yêu cầu đã bị hủy (Aborted).');
      err.name = 'AbortError';
      throw err;
    }

    try {
      const res = await fetch(url, { signal: signal || undefined });
      if (res.ok && res.status === 200) {
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        const contentLength = Number(res.headers.get('content-length') || 0);

        if (contentType.includes('audio') || contentType.includes('octet-stream') || contentLength > 500) {
          const blob = await res.blob();
          return validateAudioBlob(blob, 'fpt');
        }
      }
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') {
        const err = new Error('Yêu cầu đã bị hủy (Aborted).');
        err.name = 'AbortError';
        throw err;
      }
      // CDN still transcoding; continue polling
    }

    if (signal?.aborted) {
      const err = new Error('Yêu cầu đã bị hủy (Aborted).');
      err.name = 'AbortError';
      throw err;
    }

    // Wait with gentle backoff before next CDN check
    await abortableSleep(attemptDelay, signal);
    attemptDelay = Math.min(attemptDelay + 200, 2000);
  }

  if (signal?.aborted) {
    const err = new Error('Yêu cầu đã bị hủy (Aborted).');
    err.name = 'AbortError';
    throw err;
  }

  // Final download attempt
  const finalRes = await fetch(url, { signal: signal || undefined });
  if (!finalRes.ok) {
    throw new CloudTtsError('Không thể tải file âm thanh từ FPT CDN sau nhiều lần thử.', {
      provider: 'fpt',
      statusCode: finalRes.status,
      isRetryable: false
    });
  }

  const finalBlob = await finalRes.blob();
  return validateAudioBlob(finalBlob, 'fpt');
}

/**
 * Fetches audio from OpenAI TTS or OpenAI-compatible custom endpoints.
 */
async function fetchOpenAIAudio({
  text,
  voice,
  config = {},
  rate = 1.0,
  signal = null
}) {
  const endpoint = config.endpoint || 'https://api.openai.com/v1/audio/speech';
  const apiKey = (config.apiKey || '').trim();

  if (!apiKey && !config.endpoint) {
    throw new CloudTtsError('Chưa cấu hình API Key cho OpenAI TTS.', {
      provider: 'openai',
      statusCode: 401,
      isRetryable: false
    });
  }

  const headers = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const cleanVoice = String(voice || 'nova').replace(/^openai:/, '').trim();
  const speed = Math.max(0.25, Math.min(4.0, Number(rate) || 1.0));

  const body = JSON.stringify({
    model: config.model || 'tts-1',
    input: text,
    voice: cleanVoice,
    speed
  });

  const response = await fetchWithBoundedRetry(endpoint, {
    method: 'POST',
    headers,
    body
  }, {
    provider: 'openai',
    maxRetries: 2,
    initialDelayMs: config.initialRetryDelayMs ?? 800,
    maxDelayMs: config.maxRetryDelayMs ?? 3000,
    signal
  });

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  // If response is JSON (some custom endpoints return { url: "..." } or { audio: "base64" })
  if (contentType.includes('application/json')) {
    const data = await response.json();
    if (data.url || data.async || data.audio_url || data.audioUrl) {
      const audioUrl = data.url || data.async || data.audio_url || data.audioUrl;
      return await downloadAudioWithRetry(audioUrl, 4, 600, signal);
    }
    if (data.audio_base64 || data.audioContent || data.audio) {
      const base64Data = data.audio_base64 || data.audioContent || data.audio;
      const blob = base64ToBlob(base64Data);
      return validateAudioBlob(blob, 'openai');
    }
  }

  // Standard OpenAI response: direct binary audio stream
  const blob = await response.blob();
  return validateAudioBlob(blob, 'openai');
}

/**
 * Fetches audio from FPT AI TTS.
 */
async function fetchFptAudio({
  text,
  voice,
  config = {},
  rate = 1.0,
  signal = null
}) {
  const endpoint = config.endpoint || 'https://api.fpt.ai/h2/tts';
  const apiKey = (config.apiKey || '').trim();

  if (!apiKey) {
    throw new CloudTtsError('Chưa cấu hình API Key cho FPT AI TTS.', {
      provider: 'fpt',
      statusCode: 401,
      isRetryable: false
    });
  }

  const voiceCode = String(voice || 'banmai').replace(/^fpt:/, '').trim();

  // Map rate (0.7 - 2.2) to FPT speed offset (-3 to 3)
  let speedOffset = 0;
  if (rate > 1.3) speedOffset = 1;
  if (rate > 1.7) speedOffset = 2;
  if (rate < 0.9) speedOffset = -1;

  const response = await fetchWithBoundedRetry(endpoint, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'voice': voiceCode,
      'speed': String(speedOffset)
    },
    body: text
  }, {
    provider: 'fpt',
    maxRetries: 2,
    signal
  });

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  // If FPT returns direct binary audio
  if (contentType.includes('audio') || contentType.includes('octet-stream')) {
    const blob = await response.blob();
    return validateAudioBlob(blob, 'fpt');
  }

  // Standard FPT response: JSON with async or url
  const data = await response.json();
  if (data.error !== 0 && data.message) {
    throw classifyError(new Error(data.message), 'fpt', null, data.message);
  }

  const audioUrl = data.async || data.url;
  if (!audioUrl) {
    throw new CloudTtsError('FPT AI không trả về đường dẫn file âm thanh hợp lệ.', {
      provider: 'fpt',
      isRetryable: false
    });
  }

  return await downloadAudioWithRetry(audioUrl, 6, config.initialPollDelayMs ?? 800, signal);
}

/**
 * Main unified Cloud TTS fetcher function.
 * Routes to OpenAI, FPT AI, or Custom Endpoint with timeout protection and retry bounds.
 */
export async function fetchCloudAudio({
  text,
  provider = 'fpt',
  voice = 'banmai',
  config = {},
  rate = 1.0,
  signal = null,
  timeoutMs = 25000
} = {}) {
  const normProvider = String(provider || config.provider || 'fpt').toLowerCase().trim();

  // Create internal abort controller for timeout safeguard
  const internalController = new AbortController();
  let timeoutId = null;

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      internalController.abort(new Error(`Yêu cầu Cloud TTS quá thời gian chờ (${timeoutMs}ms).`));
    }, timeoutMs);
    if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
  }

  // Chain external signal if provided
  const onExternalAbort = () => {
    internalController.abort(new Error('Yêu cầu đã bị hủy (Aborted).'));
  };
  if (signal) {
    if (signal.aborted) {
      if (timeoutId) clearTimeout(timeoutId);
      const err = new Error('Yêu cầu đã bị hủy (Aborted).');
      err.name = 'AbortError';
      throw err;
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    if (normProvider === 'openai') {
      return await fetchOpenAIAudio({
        text,
        voice,
        config,
        rate,
        signal: internalController.signal
      });
    }

    if (normProvider === 'custom') {
      // Custom endpoint defaults to OpenAI-compatible interface
      return await fetchOpenAIAudio({
        text,
        voice,
        config,
        rate,
        signal: internalController.signal
      });
    }

    // Default: FPT AI
    return await fetchFptAudio({
      text,
      voice,
      config,
      rate,
      signal: internalController.signal
    });

  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
