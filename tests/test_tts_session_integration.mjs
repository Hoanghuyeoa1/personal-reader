import test from 'node:test';
import assert from 'node:assert/strict';
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
  errorCurrent(error = 'error') {
    if (!this.current) return;
    const cur = this.current;
    this.current = null;
    this.speaking = false;
    if (typeof cur.onerror === 'function') {
      try { cur.onerror({ error }); } catch {}
    }
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

test('1. Play -> Listening -> Pause -> Resume transitions and timing', async (t) => {
  let now = 1_000_000;
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
  ttsEngine.chunks = ['Đoạn một ngắn.', 'Đoạn hai tiếp theo.'];
  t.after(() => ttsEngine.stop());

  // Connect TTS to session engine
  ttsEngine.onPlaybackStateChange = (isPlaying, ts) => {
    if (isPlaying) void sessionEngine.markTtsStart(ts);
    else void sessionEngine.markTtsPause(ts);
  };

  await sessionEngine.startSession({ bookId: 10, chapterIndex: 0, timestamp: now });

  // Play chunk 0
  ttsEngine.play();
  await sessionEngine.flushSession(now);
  assert.equal(sessionEngine.getSessionState(now).status, SESSION_STATES.READING_AND_LISTENING);

  // Speak for 10s
  now += 10_000;
  fakeSynth.finishCurrent();
  await sessionEngine.flushSession(now);

  // Pause
  ttsEngine.pause();
  await sessionEngine.flushSession(now);
  assert.equal(sessionEngine.getSessionState(now).status, SESSION_STATES.READING, 'After TTS pause, session state remains READING if tab is visible');

  // Stay paused for 8s
  now += 8_000;
  await sessionEngine.flushSession(now);

  // Resume
  ttsEngine.resume();
  await sessionEngine.flushSession(now);
  assert.equal(sessionEngine.getSessionState(now).status, SESSION_STATES.READING_AND_LISTENING);

  // Play for 10s then finish
  now += 10_000;
  fakeSynth.finishCurrent();
  ttsEngine.stop();
  await sessionEngine.flushSession(now);

  const state = sessionEngine.getSessionState(now);
  // TTS duration should only be 10s + 10s = 20s (ignoring the 8s pause)
  assert.equal(state.ttsDurationMs, 20_000, 'TTS duration does not accrue during pause');
  assert.ok(state.activeDurationMs >= 28_000, 'Active duration includes active eye time');

  await sessionEngine.endSession(now);
});

test('2. Reading continues actively when TTS is paused', async (t) => {
  let now = 2_000_000;
  const storage = createMockStorage();
  const sessionEngine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => sessionEngine.destroy());

  await sessionEngine.startSession({ bookId: 11, chapterIndex: 0, timestamp: now });

  // TTS start then pause
  await sessionEngine.markTtsStart(now);
  now += 15_000;
  await sessionEngine.markTtsPause(now);

  // User reads by eye for another 20s
  sessionEngine.recordChapterProgress({ chapterIndex: 0, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 10_000;
  sessionEngine.recordChapterProgress({ chapterIndex: 0, position: 200, totalWords: 1000, timestamp: now });
  now += 10_000;
  sessionEngine.recordChapterProgress({ chapterIndex: 0, position: 400, totalWords: 1000, timestamp: now });

  const state = sessionEngine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.READING);
  assert.equal(state.ttsDurationMs, 15_000, 'TTS time remained capped at 15s');
  assert.equal(state.activeDurationMs, 35_000, 'Eye reading continued to accrue 20s active time');
  assert.equal(state.wordsReadEstimate, 400);

  await sessionEngine.endSession(now);
});

test('3. Background listening credits ttsDurationMs and activeDurationMs when tab is hidden', async (t) => {
  let now = 3_000_000;
  const storage = createMockStorage();
  const sessionEngine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => sessionEngine.destroy());

  await sessionEngine.startSession({ bookId: 12, chapterIndex: 0, timestamp: now });

  // TTS starts while tab is visible
  now += 5_000;
  await sessionEngine.markTtsStart(now);

  // User switches tab: visibilitychange -> hidden
  now += 5_000;
  await sessionEngine.setVisibility(false, now);

  // TTS continues playing in background for 60 seconds
  now += 60_000;

  // Tab becomes visible again
  await sessionEngine.setVisibility(true, now);
  now += 5_000;
  await sessionEngine.markTtsPause(now);

  const state = sessionEngine.getSessionState(now);
  // Total TTS time = 5s (visible) + 60s (background) + 5s (visible) = 70s
  assert.equal(state.ttsDurationMs, 70_000, 'Background listening is accurately credited');
  assert.ok(state.activeDurationMs >= 70_000, 'Active duration includes background listening');

  await sessionEngine.endSession(now);
});

test('4. Duplicate onend / onerror does not double count or corrupt state', async (t) => {
  const fakeSynth = new FakeSpeechSynthesis();
  const origUtterance = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  t.after(() => {
    if (origUtterance) globalThis.SpeechSynthesisUtterance = origUtterance;
    else delete globalThis.SpeechSynthesisUtterance;
  });

  const ttsEngine = new TTSEngine();
  ttsEngine.synth = fakeSynth;
  ttsEngine.chunks = ['Câu 1.', 'Câu 2.'];
  t.after(() => ttsEngine.stop());

  let chunkCompleteCount = 0;
  ttsEngine.onActualChunkComplete = () => { chunkCompleteCount++; };

  ttsEngine.play();
  const currentUtterance = ttsEngine.currentUtterance;
  assert.ok(currentUtterance);

  // Simulate onend firing normally
  currentUtterance.onend();
  assert.equal(chunkCompleteCount, 1);

  // Simulate malicious duplicate onend call on the same utterance object
  if (typeof currentUtterance.onend === 'function') {
    currentUtterance.onend();
  }
  assert.equal(chunkCompleteCount, 1, 'Duplicate onend does not trigger second chunk completion');
});

test('5. Synchronous cancel during synth.cancel does not re-enter or advance', async (t) => {
  const fakeSynth = new FakeSpeechSynthesis();
  const origUtterance = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  t.after(() => {
    if (origUtterance) globalThis.SpeechSynthesisUtterance = origUtterance;
    else delete globalThis.SpeechSynthesisUtterance;
  });

  const ttsEngine = new TTSEngine();
  ttsEngine.synth = fakeSynth;
  ttsEngine.chunks = ['Câu A.', 'Câu B.'];
  t.after(() => ttsEngine.stop());

  ttsEngine.play();
  assert.equal(ttsEngine.currentIndex, 0);

  // Stop calls cancelCurrentSource() and synth.cancel()
  ttsEngine.stop();
  assert.equal(ttsEngine.isPlaying, false);
  assert.equal(ttsEngine.currentIndex, 0, 'Synchronous cancel does not skip or advance chunk');
});

test('6. Stale callback arriving after Stop or Session change is discarded', async (t) => {
  const fakeSynth = new FakeSpeechSynthesis();
  const origUtterance = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  t.after(() => {
    if (origUtterance) globalThis.SpeechSynthesisUtterance = origUtterance;
    else delete globalThis.SpeechSynthesisUtterance;
  });

  const ttsEngine = new TTSEngine();
  ttsEngine.synth = fakeSynth;
  ttsEngine.chunks = ['Đoạn cũ.'];
  t.after(() => ttsEngine.stop());

  let chunkCompleteCount = 0;
  ttsEngine.onActualChunkComplete = () => { chunkCompleteCount++; };

  ttsEngine.play();
  const staleUtterance = ttsEngine.currentUtterance;

  // User stops playback
  ttsEngine.stop();

  // Delayed callback from old utterance
  if (staleUtterance && typeof staleUtterance.onend === 'function') {
    staleUtterance.onend();
  }

  assert.equal(chunkCompleteCount, 0, 'Old utterance callback arriving after stop is discarded');
  assert.equal(ttsEngine.isPlaying, false);
});

test('7. Rapid Play / Pause / Resume / Stop maintains state consistency', async (t) => {
  const fakeSynth = new FakeSpeechSynthesis();
  const origUtterance = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  t.after(() => {
    if (origUtterance) globalThis.SpeechSynthesisUtterance = origUtterance;
    else delete globalThis.SpeechSynthesisUtterance;
  });

  const ttsEngine = new TTSEngine();
  ttsEngine.synth = fakeSynth;
  ttsEngine.chunks = ['Một', 'Hai', 'Ba'];
  t.after(() => ttsEngine.stop());

  ttsEngine.play();
  ttsEngine.pause();
  ttsEngine.resume();
  ttsEngine.pause();
  ttsEngine.stop();

  assert.equal(ttsEngine.isPlaying, false);
  assert.equal(ttsEngine.isPaused, false);
  assert.equal(ttsEngine.actualPlaybackActive, false);
});

test('8. Voice preview does NOT accrue reading or listening time for book session', async (t) => {
  let now = 4_000_000;
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
  ttsEngine.chunks = ['Nội dung sách chương một.', 'Nội dung sách tiếp theo.'];
  t.after(() => ttsEngine.stop());

  ttsEngine.onPlaybackStateChange = (isPlaying, ts) => {
    if (isPlaying) void sessionEngine.markTtsStart(ts);
    else void sessionEngine.markTtsPause(ts);
  };

  await sessionEngine.startSession({ bookId: 13, chapterIndex: 0, timestamp: now });

  // Read book with TTS for 10s
  ttsEngine.play();
  await sessionEngine.flushSession(now);
  now += 10_000;
  fakeSynth.finishCurrent();
  await sessionEngine.flushSession(now);

  // User opens settings and previews a voice
  await ttsEngine.previewVoice('vi-voice-1', 'browser');
  await sessionEngine.flushSession(now);
  assert.equal(ttsEngine.actualPlaybackActive, false, 'Preview sets actualPlayback to false');

  // Preview plays for 5s
  now += 5_000;
  fakeSynth.finishCurrent();
  await sessionEngine.flushSession(now);

  // After preview, reading resumes
  ttsEngine.resume();
  await sessionEngine.flushSession(now);
  now += 10_000;
  fakeSynth.finishCurrent();
  ttsEngine.stop();
  await sessionEngine.flushSession(now);

  const state = sessionEngine.getSessionState(now);
  // TTS book listening time should be 10s + 10s = 20s, excluding the 5s preview
  assert.equal(state.ttsDurationMs, 20_000, 'Preview time is isolated and excluded from book session');
  assert.equal(state.wordsReadEstimate, 0, 'Preview does not credit book words');

  await sessionEngine.endSession(now);
});

test('9. Chapter completion naturally finishes TTS without ending reading session', async (t) => {
  let now = 5_000_000;
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
  ttsEngine.chunks = ['Câu kết của chương.'];
  t.after(() => ttsEngine.stop());

  let chapterCompleted = false;
  ttsEngine.onNaturalComplete = () => {
    chapterCompleted = true;
    sessionEngine.markChapterCompleted(0, now);
  };
  ttsEngine.onPlaybackStateChange = (isPlaying, ts) => {
    if (isPlaying) void sessionEngine.markTtsStart(ts);
    else void sessionEngine.markTtsPause(ts);
  };

  await sessionEngine.startSession({ bookId: 14, chapterIndex: 0, timestamp: now });

  ttsEngine.play();
  await sessionEngine.flushSession(now);
  now += 10_000;
  fakeSynth.finishCurrent();
  await sessionEngine.flushSession(now);

  assert.equal(chapterCompleted, true, 'Natural complete fired at chapter end');
  assert.equal(sessionEngine.session.chaptersCompleted, 1, 'Chapter 0 completed');
  assert.equal(sessionEngine.session.endedAt, null, 'Session is still alive, not ended');

  await sessionEngine.endSession(now);
  assert.equal(sessionEngine.session, null, 'Active in-memory session cleared on end');
  const history = await storage.getReadingSessions({ bookId: 14 });
  assert.equal(history.length, 1);
  assert.notEqual(history[0].endedAt, null);
});

test('10. Audio Object URL memory lifecycle cleanup', async (t) => {
  const ttsEngine = new TTSEngine();
  t.after(() => ttsEngine.stop());

  let revokedUrls = [];
  const origRevoke = globalThis.URL?.revokeObjectURL;
  if (!globalThis.URL) globalThis.URL = {};
  globalThis.URL.revokeObjectURL = (url) => { revokedUrls.push(url); };
  t.after(() => {
    if (origRevoke) globalThis.URL.revokeObjectURL = origRevoke;
  });

  ttsEngine.currentAudioUrl = 'blob:test-audio-1';
  ttsEngine.cleanupCurrentAudioUrl();
  assert.deepEqual(revokedUrls, ['blob:test-audio-1']);
  assert.equal(ttsEngine.currentAudioUrl, null);

  ttsEngine.previewAudioUrl = 'blob:test-preview-1';
  ttsEngine.cleanupPreviewAudio();
  assert.ok(revokedUrls.includes('blob:test-preview-1'));
  assert.equal(ttsEngine.previewAudioUrl, null);
});
