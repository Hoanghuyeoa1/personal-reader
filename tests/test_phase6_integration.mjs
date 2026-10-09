import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoScrollEngine } from './autoscroll.js';
import { SleepTimer } from './sleepTimer.js';
import { MediaSessionHelper } from './mediaSessionHelper.js';
import { TTSEngine } from './tts.js';
import {
  ReadingHistoryEngine,
  SESSION_STATES
} from './readingHistory.js';

function createMockStorage() {
  const sessions = new Map();
  let putCount = 0;

  return {
    async putReadingSession(session) {
      putCount++;
      sessions.set(session.id, {
        ...session,
        dailyBuckets: session.dailyBuckets.map(b => ({ ...b })),
        hourlyBuckets: session.hourlyBuckets.map(b => ({
          date: b.date,
          activeDurationMs: [...b.activeDurationMs],
          ttsDurationMs: [...b.ttsDurationMs]
        }))
      });
      return session.id;
    },
    async getReadingSessions({ bookId } = {}) {
      const list = [...sessions.values()];
      if (bookId !== undefined) {
        return list.filter(s => Number(s.bookId) === Number(bookId));
      }
      return list;
    },
    async getUnfinishedReadingSessions() {
      return [...sessions.values()].filter(s => s.endedAt === null);
    },
    getPutCount() { return putCount; },
    getStoredSession(id) { return sessions.get(id); }
  };
}

class FakeSpeechSynthesis {
  constructor() {
    this.speaking = false;
    this.paused = false;
    this.pending = [];
    this.current = null;
  }
  speak(utterance) {
    this.pending.push(utterance);
    if (!this.speaking && !this.paused) {
      this._startNext();
    }
  }
  cancel() {
    const prev = this.current;
    this.speaking = false;
    this.current = null;
    this.pending = [];
    if (prev && typeof prev.onend === 'function') {
      try { prev.onend({ type: 'end' }); } catch {}
    }
  }
  pause() {
    this.paused = true;
    if (this.current && typeof this.current.onpause === 'function') {
      try { this.current.onpause({ type: 'pause' }); } catch {}
    }
  }
  resume() {
    this.paused = false;
    if (this.current && typeof this.current.onresume === 'function') {
      try { this.current.onresume({ type: 'resume' }); } catch {}
    } else if (!this.speaking) {
      this._startNext();
    }
  }
  _startNext() {
    if (this.pending.length === 0) return;
    this.current = this.pending.shift();
    this.speaking = true;
    if (typeof this.current.onstart === 'function') {
      try { this.current.onstart({ type: 'start' }); } catch {}
    }
  }
  finishCurrent() {
    if (!this.current) return;
    const cur = this.current;
    this.current = null;
    this.speaking = false;
    if (typeof cur.onend === 'function') {
      try { cur.onend({ type: 'end' }); } catch {}
    }
    if (!this.paused) this._startNext();
  }
  getVoices() { return [{ name: 'Vietnamese Voice', lang: 'vi-VN', voiceURI: 'vi-voice-1' }]; }
}

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.lang = 'vi-VN';
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onpause = null;
    this.onresume = null;
  }
}

// 1. AutoScroll continuous activity + pause/resume in session lifecycle
test('1. AutoScroll activity maintains reading session and handles pause/resume without ending session', async (t) => {
  let now = 1_000_000;
  const storage = createMockStorage();
  const sessionEngine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => sessionEngine.destroy());

  await sessionEngine.startSession({ bookId: 101, chapterIndex: 0, timestamp: now });
  assert.equal(sessionEngine.getSessionState(now).status, SESSION_STATES.READING);

  // AutoScroll starts: provides continuous reading activity
  await sessionEngine.setAutoScrollState({ isActive: true, isPaused: false, timestamp: now });
  now += 30_000;
  await sessionEngine.flushSession(now);

  const state1 = sessionEngine.getSessionState(now);
  assert.equal(state1.status, SESSION_STATES.READING);
  assert.equal(state1.activeDurationMs, 30_000, 'AutoScroll active continuous activity credited');

  // AutoScroll temporary pause (e.g. user touches screen)
  await sessionEngine.setAutoScrollState({ isActive: true, isPaused: true, timestamp: now });
  now += 5_000;
  await sessionEngine.flushSession(now);

  const state2 = sessionEngine.getSessionState(now);
  assert.equal(state2.status, SESSION_STATES.READING, 'Session remains READING during temporary pause');
  assert.equal(state2.isPaused, false, 'Session is not manually paused');

  // AutoScroll resumes
  await sessionEngine.setAutoScrollState({ isActive: true, isPaused: false, timestamp: now });
  now += 20_000;
  await sessionEngine.flushSession(now);

  const state3 = sessionEngine.getSessionState(now);
  assert.equal(state3.activeDurationMs, 55_000, '30s + 5s (idle grace) + 20s = 55s');

  // AutoScroll stops: Reading session stays alive
  await sessionEngine.setAutoScrollState({ isActive: false, isPaused: false, timestamp: now });
  await sessionEngine.flushSession(now);
  assert.equal(sessionEngine.getSessionState(now).status, SESSION_STATES.READING);
  assert.notEqual(sessionEngine.session, null, 'AutoScroll stop does NOT end session');

  await sessionEngine.endSession(now);
});

// 2. Bottom of chapter completion deduplication
test('2. Bottom-of-chapter detection records chapter completion with deduplication', async (t) => {
  let now = 2_000_000;
  const storage = createMockStorage();
  const sessionEngine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => sessionEngine.destroy());

  await sessionEngine.startSession({ bookId: 102, chapterIndex: 0, timestamp: now });

  // Chapter 0 reaches bottom
  const complete1 = sessionEngine.markChapterCompleted(0, now);
  assert.equal(complete1, true);
  assert.equal(sessionEngine.session.chaptersCompleted, 1);

  // Duplicate reach bottom call within rapid scroll / rAF bounce
  const complete2 = sessionEngine.markChapterCompleted(0, now + 100);
  assert.equal(complete2, false, 'Duplicate bottom-reach event is safely discarded');
  assert.equal(sessionEngine.session.chaptersCompleted, 1);

  await sessionEngine.endSession(now);
});

// 3. Sleep Timer timed expiry stops audio but does NOT kill reading session if user still reading
test('3. Sleep Timer timed expiration stops TTS playback without destroying reading session', async (t) => {
  let now = 3_000_000;
  const storage = createMockStorage();
  const sessionEngine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => sessionEngine.destroy());

  const fakeSynth = new FakeSpeechSynthesis();
  const origUtterance = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  t.after(() => {
    if (origUtterance) globalThis.SpeechSynthesisUtterance = origUtterance;
    else delete globalThis.SpeechSynthesisUtterance;
  });

  const ttsEngine = new TTSEngine();
  ttsEngine.synth = fakeSynth;
  ttsEngine.now = () => now;
  ttsEngine.chunks = ['Đang nghe sách trước khi đi ngủ.'];
  t.after(() => ttsEngine.stop());

  ttsEngine.onPlaybackStateChange = (isPlaying, ts) => {
    if (isPlaying) void sessionEngine.markTtsStart(ts);
    else void sessionEngine.markTtsPause(ts);
  };

  await sessionEngine.startSession({ bookId: 103, chapterIndex: 0, timestamp: now });

  ttsEngine.play();
  await sessionEngine.flushSession(now);
  now += 15_000;
  await sessionEngine.flushSession(now);

  let sleepTimerExpired = false;
  const sleepTimer = new SleepTimer({
    onExpire: ({ reason }) => {
      sleepTimerExpired = true;
      // Normal behavior: Stop audio
      ttsEngine.stop();
    }
  });
  t.after(() => sleepTimer.cancel());

  // Simulate timer expiry
  sleepTimer.expire('timer');
  assert.equal(sleepTimerExpired, true);
  await sessionEngine.flushSession(now);

  // TTS stopped
  assert.equal(ttsEngine.isPlaying, false);
  assert.equal(ttsEngine.actualPlaybackActive, false);

  // Session remains active in READING state (user is still on page)
  const state = sessionEngine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.READING);
  assert.equal(state.ttsDurationMs, 15_000);
  assert.notEqual(sessionEngine.session, null, 'Reading session survives sleep timer audio stop');

  await sessionEngine.endSession(now);
});

// 4. Chapter-End Sleep Timer mode prevents auto-next chapter
test('4. Chapter-end Sleep Timer marks completion and stops auto-chapter-switching', async (t) => {
  let now = 4_000_000;
  const storage = createMockStorage();
  const sessionEngine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => sessionEngine.destroy());

  const sleepTimer = new SleepTimer();
  t.after(() => sleepTimer.cancel());

  // User selects "Hết chương hiện tại"
  sleepTimer.setChapterEndMode();
  assert.equal(sleepTimer.isStopAtChapterEnd(), true);

  // When chapter finishes
  sleepTimer.notifyChapterEnd();
  assert.equal(sleepTimer.isStopAtChapterEnd(), true, 'isStopAtChapterEnd remains true on completion');

  // App checks and consumes trigger
  const shouldStopChapterSwitch = sleepTimer.isStopAtChapterEnd();
  assert.equal(shouldStopChapterSwitch, true);
  const consumed = sleepTimer.consumeChapterEndTrigger();
  assert.equal(consumed, true);
  assert.equal(sleepTimer.isStopAtChapterEnd(), false, 'Reset after consumption');
});

// 5. Sleep Timer fade-out and volume restoration
test('5. Sleep Timer volume fade-out and cancellation restores initial volume', async (t) => {
  let volumeChanges = [];
  const sleepTimer = new SleepTimer({
    onFade: (ratio) => { volumeChanges.push(ratio); }
  });
  t.after(() => sleepTimer.cancel());

  sleepTimer.start(1, 1.0, 0.8);
  sleepTimer.remainingSeconds = 15; // Within 30s fade window
  sleepTimer.tick();

  assert.ok(volumeChanges.length > 0);
  assert.ok(volumeChanges[volumeChanges.length - 1] < 1.0, 'Fade ratio dropped below 1.0');

  // Cancel restores volume to 1.0
  sleepTimer.cancel();
  assert.equal(volumeChanges[volumeChanges.length - 1], 1.0, 'Volume restored to 1.0 on cancel');
});

// 6. MediaSessionHelper action handlers control TTSEngine without duplicate controllers
test('6. MediaSessionHelper hardware buttons control TTSEngine safely', async (t) => {
  let now = 5_000_000;
  const fakeSynth = new FakeSpeechSynthesis();
  const origUtterance = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  t.after(() => {
    if (origUtterance) globalThis.SpeechSynthesisUtterance = origUtterance;
    else delete globalThis.SpeechSynthesisUtterance;
  });

  const ttsEngine = new TTSEngine();
  ttsEngine.synth = fakeSynth;
  ttsEngine.now = () => now;
  ttsEngine.chunks = ['Câu 1', 'Câu 2', 'Câu 3', 'Câu 4'];
  t.after(() => ttsEngine.stop());

  let playCount = 0;
  let pauseCount = 0;
  let nextCount = 0;
  let prevCount = 0;

  const helper = new MediaSessionHelper({
    onPlay: () => {
      playCount++;
      if (!ttsEngine.isPlaying) ttsEngine.play();
    },
    onPause: () => {
      pauseCount++;
      if (ttsEngine.isPlaying) ttsEngine.pause();
    },
    onNextTrack: () => {
      nextCount++;
      ttsEngine.next();
    },
    onPrevTrack: () => {
      prevCount++;
      ttsEngine.prev();
    }
  });
  t.after(() => helper.destroy());

  // Simulate Bluetooth headset Play button
  helper.callbacks.onPlay();
  assert.equal(playCount, 1);
  assert.equal(ttsEngine.isPlaying, true);
  assert.equal(ttsEngine.currentIndex, 0);

  // Next Track button
  helper.callbacks.onNextTrack();
  assert.equal(nextCount, 1);
  assert.equal(ttsEngine.currentIndex, 1);

  // Previous Track button
  helper.callbacks.onPrevTrack();
  assert.equal(prevCount, 1);
  assert.equal(ttsEngine.currentIndex, 0);

  // Pause button
  helper.callbacks.onPause();
  assert.equal(pauseCount, 1);
  assert.equal(ttsEngine.isPaused, true);
});

// 7. MediaSessionHelper destroy unregisters action handlers cleanly
test('7. MediaSessionHelper.destroy unregisters action handlers and stops background track', async () => {
  const unsetActions = [];
  const fakeMediaSession = {
    setActionHandler(action, handler) {
      if (handler === null) unsetActions.push(action);
    },
    metadata: null,
    playbackState: 'none'
  };

  const origMediaSession = globalThis.navigator?.mediaSession;
  Object.defineProperty(globalThis.navigator, 'mediaSession', {
    value: fakeMediaSession,
    configurable: true,
    writable: true
  });

  try {
    const helper = new MediaSessionHelper();
    helper.destroy();
    assert.ok(unsetActions.includes('play'));
    assert.ok(unsetActions.includes('pause'));
    assert.ok(unsetActions.includes('nexttrack'));
    assert.ok(unsetActions.includes('stop'));
  } finally {
    if (origMediaSession !== undefined) {
      Object.defineProperty(globalThis.navigator, 'mediaSession', {
        value: origMediaSession,
        configurable: true,
        writable: true
      });
    } else {
      delete globalThis.navigator.mediaSession;
    }
  }
});

// 8. AutoScrollEngine.destroy cleans up rAF and timeout
test('8. AutoScrollEngine.destroy cleans up requestAnimationFrame and timeout', async () => {
  let cancelledRaf = null;
  const origCancel = globalThis.window?.cancelAnimationFrame;
  if (!globalThis.window) globalThis.window = {};
  globalThis.window.cancelAnimationFrame = (id) => { cancelledRaf = id; };

  try {
    const engine = new AutoScrollEngine();
    engine.isActive = true;
    engine.rafId = 12345;
    engine.resumeTimeout = setTimeout(() => {}, 10000);

    engine.destroy();

    assert.equal(cancelledRaf, 12345);
    assert.equal(engine.isActive, false);
    assert.equal(engine.rafId, null);
    assert.equal(engine.resumeTimeout, null);
  } finally {
    if (origCancel) globalThis.window.cancelAnimationFrame = origCancel;
  }
});

// 9. TTS Pause while AutoScroll is active: activeDurationMs continues, ttsDurationMs stops
test('9. TTS Pause while AutoScroll is active: activeDurationMs continues, ttsDurationMs stops', async (t) => {
  let now = 6_000_000;
  const storage = createMockStorage();
  const sessionEngine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => sessionEngine.destroy());

  await sessionEngine.startSession({ bookId: 104, chapterIndex: 0, timestamp: now });

  // TTS playing + AutoScroll active
  await sessionEngine.markTtsStart(now);
  await sessionEngine.setAutoScrollState({ isActive: true, isPaused: false, timestamp: now });

  now += 10_000;
  await sessionEngine.flushSession(now);

  const state1 = sessionEngine.getSessionState(now);
  assert.equal(state1.activeDurationMs, 10_000);
  assert.equal(state1.ttsDurationMs, 10_000);

  // User pauses TTS, but AutoScroll keeps going
  await sessionEngine.markTtsPause(now);

  now += 15_000;
  await sessionEngine.flushSession(now);

  const state2 = sessionEngine.getSessionState(now);
  assert.equal(state2.status, SESSION_STATES.READING);
  assert.equal(state2.activeDurationMs, 25_000, 'Reading continues because AutoScroll is active');
  assert.equal(state2.ttsDurationMs, 10_000, 'TTS duration does not increase while TTS is paused');

  await sessionEngine.endSession(now);
});

// 10. AutoScroll reach bottom honors Chapter-End Sleep Timer
test('10. AutoScroll reach bottom honors Chapter-End Sleep Timer and prevents auto-next', async (t) => {
  const sleepTimer = new SleepTimer();
  t.after(() => sleepTimer.cancel());

  sleepTimer.setChapterEndMode();
  assert.equal(sleepTimer.isStopAtChapterEnd(), true);

  let chapterSwitched = false;
  let autoScrollNextTimer = null;

  const onReachBottom = () => {
    if (sleepTimer.isStopAtChapterEnd()) {
      sleepTimer.notifyChapterEnd();
      sleepTimer.consumeChapterEndTrigger();
      return; // Stop here, do not advance
    }
    autoScrollNextTimer = setTimeout(() => {
      chapterSwitched = true;
    }, 1500);
  };

  onReachBottom();

  assert.equal(autoScrollNextTimer, null, 'No next chapter timer was scheduled');
  assert.equal(chapterSwitched, false);
  assert.equal(sleepTimer.isStopAtChapterEnd(), false, 'Chapter end trigger consumed');
});

// 11. Rapid Media Session buttons do not trigger race conditions or unhandled rejections
test('11. Rapid Media Session buttons execute idempotently without unhandled rejections', async (t) => {
  let playCalls = 0;
  let pauseCalls = 0;
  const mockAudio = {
    play: async () => { playCalls++; return Promise.resolve(); },
    pause: () => { pauseCalls++; },
    currentTime: 0,
    volume: 1,
    loop: false
  };

  const origAudio = globalThis.Audio;
  globalThis.Audio = function() { return mockAudio; };
  t.after(() => {
    if (origAudio) globalThis.Audio = origAudio;
    else delete globalThis.Audio;
  });

  const helper = new MediaSessionHelper();
  t.after(() => helper.destroy());

  // Rapidly start, pause, start, stop
  helper.startBackgroundSession();
  helper.pauseBackgroundSession();
  helper.startBackgroundSession();
  helper.stopBackgroundSession();

  await new Promise(r => setTimeout(r, 10));

  assert.ok(playCalls >= 1);
  assert.ok(pauseCalls >= 1);
  assert.equal(helper.isSilentAudioPlaying, false);
});

// 12. Hidden tab + background audio accumulates Listening, but not Reading
test('12. Hidden tab accumulates ttsDurationMs while AutoScroll does not add reading time', async (t) => {
  let now = 7_000_000;
  const storage = createMockStorage();
  const sessionEngine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => sessionEngine.destroy());

  await sessionEngine.startSession({ bookId: 105, chapterIndex: 0, timestamp: now });

  // Tab hidden, but TTS playing in background
  await sessionEngine.setVisibility(false, now);
  await sessionEngine.markTtsStart(now);
  // AutoScroll running in background
  await sessionEngine.setAutoScrollState({ isActive: true, isPaused: false, timestamp: now });

  now += 30_000;
  await sessionEngine.flushSession(now);

  const state = sessionEngine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.LISTENING);
  assert.equal(state.ttsDurationMs, 30_000, 'Background listening time credited');
  assert.equal(state.activeDurationMs, 30_000, 'Active duration equals ttsDuration (no extra reading time credited)');

  await sessionEngine.endSession(now);
});

// 13. Sleep timer sentence progress restores volume on reverse seek
test('13. Sleep timer restores volume if seeking backwards away from chapter end', async (t) => {
  let volume = 1.0;
  const sleepTimer = new SleepTimer({
    onFade: (vol) => { volume = vol; }
  });
  t.after(() => sleepTimer.cancel());

  sleepTimer.setChapterEndMode();
  // Near end (total = 10, current = 8 -> 1 chunk left)
  sleepTimer.notifySentenceProgress(8, 10);
  assert.equal(sleepTimer.isFading, true);
  assert.equal(volume, 0.5);

  // User seeks back to chunk 2 (total = 10, current = 2 -> 7 chunks left)
  sleepTimer.notifySentenceProgress(2, 10);
  assert.equal(sleepTimer.isFading, false);
  assert.equal(volume, 1.0, 'Volume restored to 1.0 after seeking backwards');
});

// 14. MediaSessionHelper destroy unloads silent audio and nulls instance safely
test('14. MediaSessionHelper destroy unloads silent audio and nulls instance safely', async () => {
  let loaded = false;
  const mockAudio = {
    src: 'fake-src',
    play: async () => {},
    pause: () => {},
    load: () => { loaded = true; },
    currentTime: 0,
    volume: 1,
    loop: false
  };

  const origAudio = globalThis.Audio;
  globalThis.Audio = function() { return mockAudio; };
  try {
    const helper = new MediaSessionHelper();
    assert.notEqual(helper.silentAudio, null);
    helper.destroy();
    assert.equal(helper.silentAudio, null);
    assert.equal(loaded, true);
  } finally {
    if (origAudio) globalThis.Audio = origAudio;
    else delete globalThis.Audio;
  }
});

