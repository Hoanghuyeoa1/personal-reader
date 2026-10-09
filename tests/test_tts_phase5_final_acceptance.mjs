import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';
import { MediaSessionHelper } from './mediaSessionHelper.js';
import { AmbientSoundMixer } from './ambientSound.js';
import { SleepTimer } from './sleepTimer.js';
import { AutoScrollEngine } from './autoscroll.js';
import { TTSQueueScheduler, QUEUE_ENTRY_STATES } from './ttsQueueScheduler.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

// Mock Utterance
class MockUtterance {
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

// Mock SpeechSynthesis
function createMockSynth(customVoices = null) {
  const state = {
    speakCount: 0,
    cancelCount: 0,
    pauseCount: 0,
    resumeCount: 0,
    speaking: false,
    paused: false,
    spokenUtterances: [],
    syncCancelEmitsOnend: false
  };

  const defaultVoices = [
    { name: 'Microsoft HoaiMy Online (Natural)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy' },
    { name: 'Microsoft Nam Online (Natural)', lang: 'vi-VN', voiceURI: 'vi-VN-Nam' },
    { name: 'Microsoft An', lang: 'vi-VN', voiceURI: 'vi-VN-An' }
  ];

  return {
    state,
    get speaking() { return state.speaking; },
    get paused() { return state.paused; },
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
      return customVoices || defaultVoices;
    }
  };
}

// Mock Audio
class MockAudio {
  constructor() {
    this.src = '';
    this.loop = false;
    this.volume = 1.0;
    this.paused = true;
    this.currentTime = 0;
    this.loadCalls = 0;
    this.listeners = new Map();
  }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  removeEventListener(event, fn) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter(cb => cb !== fn));
  }
  emit(event, ...args) {
    const list = this.listeners.get(event) || [];
    list.forEach(fn => fn(...args));
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loadCalls++;
  }
  removeAttribute(attr) {
    if (attr === 'src') this.src = '';
  }
}

// Setup Environment Helper
function setupEnvironment(synthVoices = null) {
  const mockSynth = createMockSynth(synthVoices);
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  globalThis.Audio = MockAudio;
  globalThis.window = {
    speechSynthesis: mockSynth,
    SpeechSynthesisUtterance: MockUtterance,
    Audio: MockAudio,
    location: { protocol: 'http:' }
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      mediaSession: {
        playbackState: 'none',
        metadata: null,
        setActionHandler: () => {}
      }
    },
    configurable: true,
    writable: true
  });
  return mockSynth;
}

// ============================================================================
// 1. BOUNDED MOCK SOAK TEST: 30 CHUNKS PLAYBACK & MULTIPLE CYCLES
// ============================================================================

test('Phase 5 - 1.1: Bounded Mock Soak: 30 consecutive chunks advance strictly 1-by-1 with zero leaks', async () => {
  const mockSynth = setupEnvironment();
  const engine = new TTSEngine();
  engine.setEngine('browser');

  const chunkCount = 30;
  engine.chunks = Array.from({ length: chunkCount }, (_, i) => `Câu thứ ${i + 1} của bản thử nghiệm soak test.`);
  engine.currentIndex = 0;

  const completedChunks = [];
  const startedChunks = [];

  engine.onActualChunkStart = (idx) => {
    startedChunks.push(idx);
  };

  engine.onActualChunkComplete = (idx) => {
    completedChunks.push(idx);
  };

  let chapterCompleted = false;
  engine.onNaturalComplete = () => {
    chapterCompleted = true;
  };

  engine.play();

  // Progress through each chunk sequentially with realistic pacing (20ms) to respect circuit breaker
  for (let i = 0; i < chunkCount; i++) {
    const utt = mockSynth.state.spokenUtterances[i];
    assert.ok(utt, `Utterance ${i} must exist in synth`);
    utt.onstart();
    utt.onend();
    await delay(20);
  }

  assert.equal(chapterCompleted, true, 'Chapter should complete naturally after all chunks finish');
  assert.equal(completedChunks.length, chunkCount, `All ${chunkCount} chunks must complete exactly once`);
  assert.equal(startedChunks.length, chunkCount, `All ${chunkCount} chunks must start exactly once`);

  // Verify strict ordering
  for (let i = 0; i < chunkCount; i++) {
    assert.equal(completedChunks[i], i, `Chunk ${i} must complete in exact sequential order`);
    assert.equal(startedChunks[i], i, `Chunk ${i} must start in exact sequential order`);
  }

  // Diagnostics check: ring buffer must remain bounded <= 50
  const diag = engine.getDiagnosticsSnapshot();
  assert.ok(diag.recentEvents.length <= 50, 'Diagnostics ring buffer must remain bounded <= 50');
  assert.equal(diag.counts.onend, chunkCount, `Diagnostics onend count must be exactly ${chunkCount}`);

  // Resource cleanup verification
  engine.stop();
  assert.equal(engine.currentUtterance, null);
  assert.equal(engine.keepAliveTimer, null);
  assert.equal(engine.stuckWatchdogTimer, null);
  assert.equal(engine.isAdvancingChunk, false);
});

test('Phase 5 - 1.2: Repeated Play / Pause / Resume / Seek / Stop across 20 cycles leaves 0 retained timers or resources', async () => {
  const mockSynth = setupEnvironment();
  const engine = new TTSEngine();
  engine.setEngine('browser');

  engine.chunks = ['Đoạn 1', 'Đoạn 2', 'Đoạn 3', 'Đoạn 4', 'Đoạn 5', 'Đoạn 6'];

  for (let cycle = 0; cycle < 20; cycle++) {
    engine.currentIndex = 0;

    // 1. Play
    engine.play();
    assert.equal(engine.isPlaying, true);

    // 2. Pause
    engine.pause();
    assert.equal(engine.isPaused, true);
    assert.equal(engine.keepAliveTimer, null, 'KeepAlive must be null on pause');
    assert.equal(engine.stuckWatchdogTimer, null, 'Watchdog must be null on pause');

    // 3. Resume
    engine.resume();
    assert.equal(engine.isPlaying, true);
    assert.equal(engine.isPaused, false);

    // 4. Seek forward
    engine.next();
    assert.equal(engine.currentIndex, 1);

    // 5. Seek backward
    engine.prev();
    assert.equal(engine.currentIndex, 0);

    // 6. Direct jump
    engine.currentIndex = 3;
    engine.play();
    assert.equal(engine.currentIndex, 3);

    // 7. Stop
    engine.stop();
    assert.equal(engine.isPlaying, false);
    assert.equal(engine.isPaused, false);
    assert.equal(engine.keepAliveTimer, null, 'KeepAlive must be null on stop');
    assert.equal(engine.stuckWatchdogTimer, null, 'Watchdog must be null on stop');
    assert.equal(engine.currentUtterance, null);
  }

  // Diagnostics verification
  const snap = engine.getDiagnosticsSnapshot();
  assert.equal(snap.hasKeepAliveTimer, false);
  assert.equal(snap.hasStuckWatchdogTimer, false);
  assert.ok(snap.recentEvents.length <= 50, 'Ring buffer bounded <= 50');
});

// ============================================================================
// 2. TERMINAL SAFETY, RACE CONDITIONS & CIRCUIT BREAKER
// ============================================================================

test('Phase 5 - 2.1: Stale callback rejection: utterance from replaced generation cannot advance or corrupt new playback', async () => {
  const mockSynth = setupEnvironment();
  const engine = new TTSEngine();
  engine.setEngine('browser');

  engine.chunks = ['Chunk 0', 'Chunk 1', 'Chunk 2'];
  engine.currentIndex = 0;

  engine.play();
  const oldUtt = mockSynth.state.spokenUtterances[0];
  const oldGeneration = engine.generationToken;

  // User abruptly calls stop() and starts a brand new playback at Chunk 2
  engine.stop();
  engine.currentIndex = 2;
  engine.play();
  const newUtt = mockSynth.state.spokenUtterances[1];

  // Stale callback from old utterance fires late
  if (oldUtt && typeof oldUtt.onend === 'function') {
    oldUtt.onend();
  }

  await delay(10);

  // Playback must remain at Chunk 2 of the new generation
  assert.equal(engine.currentIndex, 2, 'Stale callback must NOT alter current index');
  assert.ok(engine.generationToken > oldGeneration, 'Generation token must be advanced');
  assert.equal(engine.currentUtterance, newUtt);

  engine.stop();
});

test('Phase 5 - 2.2: Native Edge stuck watchdog cancels cleanly when utterance ends normally without double advance', async () => {
  const mockSynth = setupEnvironment();
  const engine = new TTSEngine();
  engine.setEngine('browser');

  engine.chunks = ['Câu ngắn bình thường.', 'Câu tiếp theo.'];
  engine.currentIndex = 0;

  let chunkAdvanced = 0;
  engine.onChunkStart = (idx) => {
    chunkAdvanced++;
  };

  engine.play();
  assert.ok(engine.stuckWatchdogTimer !== null, 'Watchdog timer must be active during playback');

  // Utterance 0 finishes normally
  const utt0 = mockSynth.state.spokenUtterances[0];
  utt0.onstart();
  utt0.onend();

  await delay(15);

  // Chunk 1 has advanced
  assert.equal(engine.currentIndex, 1);
  const utt1 = mockSynth.state.spokenUtterances[1];
  assert.ok(utt1, 'Utterance 1 must exist');
  utt1.onstart();
  assert.equal(chunkAdvanced, 2);

  // Verify watchdog did NOT trigger a duplicate advance
  const snap = engine.getDiagnosticsSnapshot();
  assert.equal(snap.counts.stuck_watchdog, 0, 'Watchdog should not have fired since onend completed naturally');

  engine.stop();
});

test('Phase 5 - 2.3: Keep-Alive heartbeat is strictly immune on Microsoft Edge Natural voices and short SAPI utterances', () => {
  const mockSynth = setupEnvironment([
    { name: 'Microsoft HoaiMy Online (Natural)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy' },
    { name: 'Microsoft An', lang: 'vi-VN', voiceURI: 'vi-VN-An' }
  ]);

  const engine = new TTSEngine();
  engine.setEngine('browser');
  engine.setVoice('Microsoft HoaiMy Online (Natural)'); // Edge Natural voice

  engine.chunks = ['Đoạn văn ngắn tiếng Việt.'];
  engine.currentIndex = 0;
  engine.play();

  // Trigger keepalive pulse check
  engine.startKeepAlive();
  const snap1 = engine.getDiagnosticsSnapshot();
  assert.equal(snap1.counts.keepalive_pulse, 0, 'Edge Natural voice must never pulse keepalive');

  // Switch to local SAPI voice with short utterance (< 10s)
  engine.stop();
  engine.setVoice('Microsoft An');
  engine.chunks = ['Đoạn văn ngắn tiếng Việt 2.'];
  engine.currentIndex = 0;
  engine.play();
  engine.utteranceStartedTimestamp = Date.now() - 5000; // 5 seconds elapsed (< 10s)
  
  // Force keepalive interval handler execution
  engine.startKeepAlive();
  const snap2 = engine.getDiagnosticsSnapshot();
  assert.equal(snap2.counts.keepalive_pulse, 0, 'Local SAPI voice with < 10s duration must not pulse');

  engine.stop();
});

// ============================================================================
// 3. CROSS-MODULE SAFETY & RESOURCE CLEANUP
// ============================================================================

test('Phase 5 - 3.1: MediaSessionHelper background session token prevents race condition in rapid play/pause', async () => {
  let playResolve;
  class AsyncMockAudio {
    constructor() {
      this.src = '';
      this.loop = true;
      this.volume = 0.001;
      this.paused = true;
    }
    play() {
      this.paused = false;
      return new Promise((resolve) => {
        playResolve = resolve;
      });
    }
    pause() {
      this.paused = true;
    }
  }

  globalThis.Audio = AsyncMockAudio;
  globalThis.window = { Audio: AsyncMockAudio };
  const mockNavigator = {
    mediaSession: {
      playbackState: 'none',
      metadata: null,
      setActionHandler: () => {}
    }
  };
  Object.defineProperty(globalThis, 'navigator', { value: mockNavigator, configurable: true, writable: true });

  const helper = new MediaSessionHelper();

  helper.startBackgroundSession();
  assert.equal(mockNavigator.mediaSession.playbackState, 'playing');

  helper.pauseBackgroundSession();
  assert.equal(mockNavigator.mediaSession.playbackState, 'paused');

  helper.startBackgroundSession();
  assert.equal(mockNavigator.mediaSession.playbackState, 'playing');

  if (playResolve) playResolve();
  await delay(10);

  assert.equal(helper.isSilentAudioPlaying, true, 'Silent audio remains playing for active session');
  assert.equal(mockNavigator.mediaSession.playbackState, 'playing');

  helper.destroy();
  assert.equal(helper.silentAudio, null);
});

test('Phase 5 - 3.2: SleepTimer stores baseVolume and cleanly restores upon cancel and expire', () => {
  const customBaseTtsVolume = 0.65;
  const customBaseAmbientVolume = 0.40;
  let currentTtsVolume = customBaseTtsVolume;
  let currentAmbientFactor = customBaseAmbientVolume;

  const timer = new SleepTimer({
    fadeDuration: 30,
    onFade: (ratio) => {
      currentTtsVolume = customBaseTtsVolume * ratio;
      currentAmbientFactor = customBaseAmbientVolume * ratio;
    },
    onCancel: () => {
      currentTtsVolume = timer.baseTtsVolume;
      currentAmbientFactor = timer.baseAmbientVolume;
    },
    onExpire: () => {
      currentTtsVolume = timer.baseTtsVolume;
      currentAmbientFactor = timer.baseAmbientVolume;
    }
  });

  // Start 15m timer with custom volumes
  timer.start(15, customBaseTtsVolume, customBaseAmbientVolume);
  assert.equal(timer.baseTtsVolume, customBaseTtsVolume);
  assert.equal(timer.baseAmbientVolume, customBaseAmbientVolume);

  // Simulate entering fade-out window (ratio 0.5)
  timer.remainingSeconds = 15;
  timer.tick();
  assert.ok(currentTtsVolume < customBaseTtsVolume);
  assert.ok(currentAmbientFactor < customBaseAmbientVolume);

  // User cancels timer -> Must restore to customBaseVolume, NOT default 1.0
  timer.cancel();
  assert.equal(currentTtsVolume, customBaseTtsVolume, 'TTS volume must restore to base volume');
  assert.equal(currentAmbientFactor, customBaseAmbientVolume, 'Ambient factor must restore to base factor');
});

test('Phase 5 - 3.3: AmbientSoundMixer disconnects both sourceNode and gainNode and closes AudioContext on destroy', async () => {
  let contextClosed = false;
  let gainDisconnected = false;
  let sourceDisconnected = false;
  let sourceStopped = false;

  class MockAudioNode {
    disconnect() {
      if (this.isGain) gainDisconnected = true;
      if (this.isSource) sourceDisconnected = true;
    }
  }

  class MockGainNode extends MockAudioNode {
    constructor() {
      super();
      this.isGain = true;
      this.gain = {
        value: 1.0,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {}
      };
    }
    connect() {}
  }

  class MockSourceNode extends MockAudioNode {
    constructor() {
      super();
      this.isSource = true;
      this.loop = true;
    }
    connect() {}
    start() {}
    stop() {
      sourceStopped = true;
    }
  }

  class MockAudioContext {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.destination = {};
    }
    createGain() { return new MockGainNode(); }
    createBufferSource() { return new MockSourceNode(); }
    createBuffer(channels, length, rate) {
      return {
        getChannelData: () => new Float32Array(length)
      };
    }
    close() {
      contextClosed = true;
      return Promise.resolve();
    }
  }

  globalThis.AudioContext = MockAudioContext;
  globalThis.window = { AudioContext: MockAudioContext };

  const mixer = new AmbientSoundMixer();
  mixer.startSound('rain');
  const track = mixer.tracks.get('rain');
  assert.equal(track.isPlaying, true);

  // Stop track
  mixer.stopSound('rain');
  await delay(80); // Wait for the 50ms fade-out timeout

  assert.equal(sourceStopped, true, 'sourceNode must be stopped');
  assert.equal(sourceDisconnected, true, 'sourceNode must be disconnected');
  assert.equal(gainDisconnected, true, 'gainNode must be disconnected');

  // Destroy mixer
  mixer.destroy();
  assert.equal(contextClosed, true, 'AudioContext must be closed on destroy');
  assert.equal(mixer.audioCtx, null);
  assert.equal(mixer.bufferCache.size, 0);
});

test('Phase 5 - 3.4: AutoScroll bottom collision does not trigger duplicate chapter transition when TTS is playing', () => {
  let autoScrollTransitions = 0;
  let ttsTransitions = 0;
  let isChapterSwitching = false;

  const mockTts = { isPlaying: true };

  // Simulated onReachBottom handler from app.js
  const handleReachBottom = () => {
    if (mockTts.isPlaying || isChapterSwitching) {
      // Abort AutoScroll auto-next to yield full coordination to TTS
      return;
    }
    autoScrollTransitions++;
  };

  // When TTS is active, AutoScroll reaching bottom is safely ignored
  handleReachBottom();
  assert.equal(autoScrollTransitions, 0, 'AutoScroll transition must NOT fire while TTS is playing');

  // When TTS completes chapter
  isChapterSwitching = true;
  ttsTransitions++;

  // AutoScroll reaching bottom while isChapterSwitching = true is also safely ignored
  handleReachBottom();
  assert.equal(autoScrollTransitions, 0, 'AutoScroll transition must NOT fire while chapter is switching');
  assert.equal(ttsTransitions, 1, 'TTS transition must fire exactly once');
});

// ============================================================================
// 4. CLOUD TTS FALLBACK & AUDIO URL MEMORY LIFECYCLE
// ============================================================================

test('Phase 5 - 4.1: Cloud TTS fallback to Web Speech does not duplicate playback or leak AudioElement', async () => {
  const mockSynth = setupEnvironment();
  const engine = new TTSEngine();

  let fallbackWarningReceived = false;
  engine.onFallbackWarning = () => {
    fallbackWarningReceived = true;
  };

  // Configure cloud mode
  engine.setEngine('cloud');
  engine.setCloudConfig({
    provider: 'openai',
    apiKey: 'invalid-key-test',
    voice: 'alloy'
  });

  engine.chunks = ['Đoạn văn kiểm tra fallback sang Browser TTS.'];
  engine.currentIndex = 0;

  // Mock fetch failure
  engine.fetchCloudAudio = async () => {
    throw new Error('401 Unauthorized: Invalid API Key');
  };

  engine.play();
  await delay(25);

  // Verify engine switched to browser
  assert.equal(engine.engine, 'browser', 'Engine should automatically fall back to browser on cloud error');
  assert.equal(fallbackWarningReceived, true, 'Fallback warning event must be emitted');

  // Verify AudioElement is cleaned up
  assert.equal(engine.currentAudioUrl, null);

  engine.stop();
});
