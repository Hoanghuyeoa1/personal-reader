import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaSessionHelper } from './mediaSessionHelper.js';
import { AmbientSoundMixer } from './ambientSound.js';
import { SleepTimer } from './sleepTimer.js';
import { TTSEngine } from './tts.js';
import { AutoScrollEngine } from './autoscroll.js';
import { TTSQueueScheduler, QUEUE_ENTRY_STATES } from './ttsQueueScheduler.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

// ============================================================================
// 1. MEDIA SESSION & SILENT AUDIO LIFECYCLE TESTS
// ============================================================================

test('1.1: MediaSessionHelper handles rapid async play/pause/start without stale promise pausing new session', async () => {
  // Mock Audio element with simulated async play promise
  let playResolve;
  class MockAudio {
    constructor() {
      this.src = '';
      this.loop = true;
      this.volume = 0.001;
      this.paused = true;
      this.currentTime = 0;
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
    load() {}
  }

  globalThis.Audio = MockAudio;
  globalThis.window = { Audio: MockAudio };
  const mockNavigator = {
    mediaSession: {
      playbackState: 'none',
      metadata: null,
      setActionHandler: () => {}
    }
  };
  Object.defineProperty(globalThis, 'navigator', { value: mockNavigator, configurable: true, writable: true });

  const helper = new MediaSessionHelper();

  // 1. User starts session -> play() promise is in flight
  helper.startBackgroundSession();
  assert.equal(mockNavigator.mediaSession.playbackState, 'playing');

  // 2. User immediately pauses before promise resolves
  helper.pauseBackgroundSession();
  assert.equal(mockNavigator.mediaSession.playbackState, 'paused');

  // 3. User rapidly hits play again (new session token)
  helper.startBackgroundSession();
  assert.equal(mockNavigator.mediaSession.playbackState, 'playing');

  // 4. Stale promise from step 1 finally resolves
  if (playResolve) playResolve();
  await delay(10);

  // Assert that helper remains PLAYING because session token guarded against the stale pause
  assert.equal(helper.isSilentAudioPlaying, true, 'Silent audio must remain playing for current session');
  assert.equal(mockNavigator.mediaSession.playbackState, 'playing');

  // 5. Clean destroy
  helper.destroy();
  assert.equal(helper.silentAudio, null, 'Silent audio must be nulled on destroy');
});

test('1.2: MediaSessionHelper destroy removes action handlers and unloads audio', () => {
  const removedActions = [];
  const mockNavigator = {
    mediaSession: {
      playbackState: 'playing',
      metadata: null,
      setActionHandler: (action, handler) => {
        if (handler === null) removedActions.push(action);
      }
    }
  };
  Object.defineProperty(globalThis, 'navigator', { value: mockNavigator, configurable: true, writable: true });

  const helper = new MediaSessionHelper();
  helper.destroy();

  assert.ok(removedActions.includes('play'));
  assert.ok(removedActions.includes('pause'));
  assert.ok(removedActions.includes('stop'));
  assert.equal(helper.silentAudio, null);
});

// ============================================================================
// 2. AMBIENT SOUND MIXER RESOURCE LIFECYCLE TESTS
// ============================================================================

test('2.1: AmbientSoundMixer disconnects both sourceNode AND gainNode on stopSound', async () => {
  let sourceStopped = false;
  let sourceDisconnected = false;
  let gainDisconnected = false;

  class MockGainNode {
    constructor() {
      this.gain = {
        value: 1.0,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {}
      };
    }
    connect() {}
    disconnect() {
      gainDisconnected = true;
    }
  }

  class MockBufferSourceNode {
    constructor() {
      this.buffer = null;
      this.loop = true;
    }
    connect() {}
    start() {}
    stop() {
      sourceStopped = true;
    }
    disconnect() {
      sourceDisconnected = true;
    }
  }

  class MockAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.destination = {};
    }
    createGain() { return new MockGainNode(); }
    createBufferSource() { return new MockBufferSourceNode(); }
    createBuffer(channels, length, rate) {
      return {
        getChannelData: () => new Float32Array(length)
      };
    }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }

  globalThis.window = { AudioContext: MockAudioContext };

  const mixer = new AmbientSoundMixer();
  mixer.startSound('rain');

  const track = mixer.tracks.get('rain');
  assert.equal(track.isPlaying, true);
  assert.ok(track.sourceNode);
  assert.ok(track.gainNode);

  // Stop the sound
  mixer.stopSound('rain');

  assert.equal(track.isPlaying, false);
  assert.equal(track.sourceNode, null);
  assert.equal(track.gainNode, null);

  // Wait 60ms for smooth fade timeout cleanup
  await delay(70);

  assert.equal(sourceStopped, true, 'sourceNode must be stopped');
  assert.equal(sourceDisconnected, true, 'sourceNode must be disconnected');
  assert.equal(gainDisconnected, true, 'gainNode must be disconnected to avoid audio graph leak');

  // Test full destroy
  mixer.destroy();
  assert.equal(mixer.audioCtx, null, 'audioCtx must be closed and nulled on destroy');
});

// ============================================================================
// 3. SLEEP TIMER VOLUME RESTORATION TESTS
// ============================================================================

test('3.1: SleepTimer stores baseVolume and restores custom volume on cancel and expire', () => {
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

  // User cancels timer -> Must restore to customBaseVolume, NOT blindly 1.0!
  timer.cancel();
  assert.equal(currentTtsVolume, customBaseTtsVolume, 'TTS volume must restore to base volume');
  assert.equal(currentAmbientFactor, customBaseAmbientVolume, 'Ambient factor must restore to base factor');
});

// ============================================================================
// 4. AUTOSCROLL & TTS COORDINATION SAFETY
// ============================================================================

test('4.1: AutoScrollEngine stops on destroy without leaking rAF or listeners', () => {
  let cancelledRaf = null;
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => 1234,
    cancelAnimationFrame: (id) => { cancelledRaf = id; }
  };

  const autoScroll = new AutoScrollEngine({ speed: 50 });
  autoScroll.start();
  assert.equal(autoScroll.isActive, true);

  autoScroll.destroy();
  assert.equal(autoScroll.isActive, false);
  assert.equal(cancelledRaf, 1234, 'rAF must be cancelled on destroy');
});

// ============================================================================
// 5. CLOUD QUEUE PREFETCH & PLAYBACK CANCELLATION
// ============================================================================

test('5.1: TTSQueueScheduler invalidates entries and late network responses cannot resurrect cancelled items', async () => {
  let pendingNetworkAbort = false;

  const scheduler = new TTSQueueScheduler({
    fetcher: async (text, config, signal) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          pendingNetworkAbort = true;
          reject(new Error('Network aborted'));
        });
      });
    },
    cacheLookup: async () => null, // Cache miss
    cacheStore: async () => {}
  });

  // Request chunk 0 with generation 1
  const reqPromise = scheduler.requestChunk({
    chunkIndex: 0,
    text: 'Câu cần tải',
    generation: 1
  });

  await delay(10);
  assert.equal(scheduler.activeFetches.size, 1);

  // User changes chapter or stops TTS -> Generation advances to 2
  scheduler.invalidate(2);

  // Old request should reject with AbortError
  await assert.rejects(reqPromise, (err) => {
    return err.name === 'AbortError' || err.message.includes('Invalidated');
  });

  assert.equal(pendingNetworkAbort, true, 'In-flight fetcher must receive abort signal');
  assert.equal(scheduler.activeFetches.size, 0, 'Active fetches must be 0 after invalidation');
  scheduler.dispose();
});

test('5.2: TTSQueueScheduler memory cap: markConsumed releases audio blob bytes cleanly', () => {
  const scheduler = new TTSQueueScheduler();
  const mockBlob = { size: 1024 * 1024 }; // 1MB mock blob

  const entry = scheduler._getOrCreateEntry({
    chunkIndex: 0,
    text: 'Đoạn văn',
    generation: 1,
    fingerprint: 'fpt:banmai:r1.0',
    priority: 1
  });

  entry.resolve(mockBlob, false);
  scheduler._recalculateReadyBytes();

  assert.equal(scheduler.totalReadyBytes, 1024 * 1024);

  // Play and consume
  scheduler.markPlaying(0, 'fpt:banmai:r1.0');
  scheduler.markConsumed(0, 'fpt:banmai:r1.0');

  assert.equal(scheduler.totalReadyBytes, 0, 'Ready bytes must return to 0 after consumption');
  assert.equal(scheduler.entries.size, 0, 'Consumed entry must be removed from map');
  scheduler.dispose();
});
