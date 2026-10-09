import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReadingHistoryEngine,
  SESSION_EVENTS,
  SESSION_STATES,
  startSession,
  pauseSession,
  resumeSession,
  endSession,
  markActivity,
  markChapterCompleted,
  markTtsStart,
  markTtsPause,
  dispatchSessionEvent,
  getSessionState
} from './readingHistory.js';

function createMockStorage() {
  const sessions = new Map();
  return {
    async putReadingSession(session) {
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
      const rows = [...sessions.values()];
      if (bookId !== undefined && bookId !== null) {
        return rows.filter(r => Number(r.bookId) === Number(bookId));
      }
      return rows;
    },
    async getUnfinishedReadingSessions() {
      return [...sessions.values()].filter(r => r.endedAt === null);
    },
    async deleteReadingSession(id) {
      return sessions.delete(id);
    },
    async clearReadingHistory() {
      sessions.clear();
      return true;
    },
    _raw: sessions
  };
}

test('1. Start -> Reading -> Pause -> Resume -> End lifecycle', async () => {
  let now = 1_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  const sessionId = await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 1,
    chapterIndex: 0,
    timestamp: now
  });
  assert.ok(sessionId, 'session_start returns a valid sessionId');

  // Establish initial chapter position baseline at word 0
  await engine.dispatchSessionEvent(SESSION_EVENTS.READING, {
    timestamp: now,
    chapterIndex: 0,
    position: 0,
    totalWords: 100,
    explicitJump: true
  });

  let state = engine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.READING);
  assert.equal(state.activeDurationMs, 0);

  // Read for 2 seconds
  now += 2_000;
  const readRes = await engine.dispatchSessionEvent(SESSION_EVENTS.READING, {
    timestamp: now,
    chapterIndex: 0,
    position: 50,
    totalWords: 100
  });
  assert.ok(readRes, 'reading activity is recorded');

  // Pause session at T=2000
  const pauseRes = await engine.dispatchSessionEvent(SESSION_EVENTS.PAUSE, {
    timestamp: now,
    reason: 'user'
  });
  assert.equal(pauseRes, true, 'session pauses successfully');
  state = engine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.PAUSED);
  assert.equal(state.isPaused, true);
  assert.equal(state.activeDurationMs, 2_000);

  // 5 seconds pause gap
  now += 5_000;

  // Resume session at T=7000
  const resumeRes = await engine.dispatchSessionEvent(SESSION_EVENTS.RESUME, {
    timestamp: now,
    source: 'user'
  });
  assert.equal(resumeRes, true, 'session resumes successfully');
  state = engine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.READING);
  assert.equal(state.isPaused, false);
  assert.equal(state.activeDurationMs, 2_000, 'pause gap was not accrued');

  // Read for 4 more seconds
  now += 4_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.READING, {
    timestamp: now,
    chapterIndex: 0,
    position: 90,
    totalWords: 100
  });

  // End session at T=11000
  const endRes = await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, {
    timestamp: now
  });
  assert.equal(endRes, true, 'session ends successfully');
  state = engine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.IDLE);

  const stored = (await storage.getReadingSessions({ bookId: 1 }))[0];
  assert.equal(stored.id, sessionId);
  assert.equal(stored.activeDurationMs, 6_000, 'active time equals 2000 + 4000 ms, excluding 5000ms pause');
  assert.equal(stored.ttsDurationMs, 0);
  assert.equal(stored.wordsReadEstimate, 90);
  engine.destroy();
});

test('2. Start -> Listening -> Pause -> Resume -> End lifecycle', async () => {
  let now = 2_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  const sessionId = await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 2,
    chapterIndex: 0,
    timestamp: now
  });

  // Advance 1s and start TTS listening
  now += 1_000;
  const listenStart = await engine.dispatchSessionEvent(SESSION_EVENTS.LISTENING, {
    state: 'playing',
    timestamp: now
  });
  assert.equal(listenStart, true, 'listening starts');
  let state = engine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.READING_AND_LISTENING);
  assert.equal(state.isTtsPlaying, true);

  // Speak for 4 seconds
  now += 4_000;
  const listenPause = await engine.dispatchSessionEvent(SESSION_EVENTS.LISTENING, {
    state: 'paused',
    timestamp: now
  });
  assert.equal(listenPause, true, 'listening pauses');
  state = engine.getSessionState(now);
  assert.equal(state.isTtsPlaying, false);
  assert.equal(state.activeDurationMs, 5_000);
  assert.equal(state.ttsDurationMs, 4_000);

  // Pause session for 3s gap
  await engine.dispatchSessionEvent(SESSION_EVENTS.PAUSE, { timestamp: now, reason: 'user' });
  now += 3_000;

  // Resume session
  await engine.dispatchSessionEvent(SESSION_EVENTS.RESUME, { timestamp: now, source: 'user' });
  state = engine.getSessionState(now);
  assert.equal(state.isTtsPlaying, false, 'resume session does not auto-start TTS');

  // Resume TTS 2s later
  now += 2_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.LISTENING, { state: 'playing', timestamp: now });

  // Play for 3 seconds
  now += 3_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, { timestamp: now });

  const stored = (await storage.getReadingSessions({ bookId: 2 }))[0];
  assert.equal(stored.id, sessionId);
  assert.equal(stored.activeDurationMs, 10_000, 'active time accurately computed');
  assert.equal(stored.ttsDurationMs, 7_000, 'tts time accurately computed');
  assert.ok(stored.ttsDurationMs <= stored.activeDurationMs, 'TTS is a subset of active time');
  engine.destroy();
});

test('3. Reading + Listening concurrent activity', async () => {
  let now = 3_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 3,
    chapterIndex: 0,
    timestamp: now
  });

  // User reads from T=0 to T=2000
  now += 2_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.READING, { timestamp: now, chapterIndex: 0 });

  // TTS starts at T=2000
  await engine.dispatchSessionEvent(SESSION_EVENTS.LISTENING, { state: 'playing', timestamp: now });

  // User both reads and listens from T=2000 to T=6000 (4s)
  now += 4_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.LISTENING, { state: 'stopped', timestamp: now });

  // User reads alone from T=6000 to T=10000 (4s)
  now += 4_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.READING, { timestamp: now, chapterIndex: 0 });

  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, { timestamp: now });

  const stored = (await storage.getReadingSessions({ bookId: 3 }))[0];
  assert.equal(stored.activeDurationMs, 10_000, 'active time is union, not added twice (not 14000)');
  assert.equal(stored.ttsDurationMs, 4_000, 'tts duration accurately accounts for its interval');
  engine.destroy();
});

test('4. Pause TTS but Reading remains active', async () => {
  let now = 4_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 4,
    chapterIndex: 0,
    timestamp: now
  });

  // Start TTS at T=1000, speak until T=3000
  now += 1_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.LISTENING, { state: 'playing', timestamp: now });
  now += 2_000;

  // TTS pause signal received
  await engine.dispatchSessionEvent(SESSION_EVENTS.PAUSE, { reason: 'audio', timestamp: now });

  let state = engine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.READING, 'status is reading, not paused');
  assert.equal(state.isPaused, false, 'session is not manually paused');
  assert.equal(state.isTtsPlaying, false, 'TTS is stopped');

  // User reads with eye activity until T=6000
  now += 3_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.READING, { timestamp: now, chapterIndex: 0 });

  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, { timestamp: now });
  const stored = (await storage.getReadingSessions({ bookId: 4 }))[0];
  assert.equal(stored.activeDurationMs, 6_000, 'reading time continued after audio pause');
  assert.equal(stored.ttsDurationMs, 2_000);
  engine.destroy();
});

test('5. Duplicate start and end are idempotent', async () => {
  let now = 5_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  const id1 = await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 5,
    chapterIndex: 0,
    timestamp: now
  });
  now += 1_000;
  const id2 = await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 5,
    chapterIndex: 0,
    timestamp: now
  });
  assert.equal(id1, id2, 'subsequent start on same active book returns identical sessionId');
  assert.equal(storage._raw.size, 1, 'only one session record is created in storage');

  now += 2_000;
  const end1 = await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, { timestamp: now });
  assert.equal(end1, true, 'first end succeeds');

  const end2 = await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, { timestamp: now });
  assert.equal(end2, false, 'duplicate end safely returns false without error');
  engine.destroy();
});

test('6. Guard invalid and stale transitions', async () => {
  let now = 6_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  // Invalid start payloads
  assert.equal(await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, { bookId: null }), null);
  assert.equal(await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, { bookId: -3 }), null);
  assert.equal(await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, { bookId: 'not-id' }), null);

  // Calling pause when no session is active
  assert.equal(await engine.dispatchSessionEvent(SESSION_EVENTS.PAUSE, { timestamp: now }), false);

  // Calling chapter complete when no session is active
  assert.equal(await engine.dispatchSessionEvent(SESSION_EVENTS.CHAPTER_COMPLETE, { chapterIndex: 0 }), false);

  // Start a valid session
  const validId = await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 6,
    chapterIndex: 0,
    timestamp: now
  });

  // Stale sessionId guard
  const staleRes = await engine.dispatchSessionEvent(SESSION_EVENTS.READING, {
    sessionId: 'stale-wrong-id',
    timestamp: now + 1_000
  });
  assert.equal(staleRes, false, 'event with stale sessionId is rejected');

  // Stale bookId guard
  const staleBookRes = await engine.dispatchSessionEvent(SESSION_EVENTS.READING, {
    bookId: 999,
    timestamp: now + 1_000
  });
  assert.equal(staleBookRes, false, 'event with mismatched bookId is rejected');

  // Double pause idempotency
  now += 2_000;
  assert.equal(await engine.dispatchSessionEvent(SESSION_EVENTS.PAUSE, { timestamp: now }), true);
  assert.equal(await engine.dispatchSessionEvent(SESSION_EVENTS.PAUSE, { timestamp: now + 100 }), false);

  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, { timestamp: now + 500 });
  engine.destroy();
});

test('7. Multiple chapter completions within a single session', async () => {
  let now = 7_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 7,
    chapterIndex: 0,
    timestamp: now
  });

  // Complete chapter 0
  const c0 = await engine.dispatchSessionEvent(SESSION_EVENTS.CHAPTER_COMPLETE, {
    chapterIndex: 0,
    timestamp: now
  });
  assert.equal(c0, true, 'chapter 0 completes');
  assert.equal(engine.getSessionState(now).chaptersCompleted, 1);

  // Complete chapter 1
  now += 5_000;
  const c1 = await engine.dispatchSessionEvent(SESSION_EVENTS.CHAPTER_COMPLETE, {
    chapterIndex: 1,
    timestamp: now
  });
  assert.equal(c1, true, 'chapter 1 completes');
  assert.equal(engine.getSessionState(now).chaptersCompleted, 2);

  // Attempt duplicate completion of chapter 0
  now += 2_000;
  const c0Dup = await engine.dispatchSessionEvent(SESSION_EVENTS.CHAPTER_COMPLETE, {
    chapterIndex: 0,
    timestamp: now
  });
  assert.equal(c0Dup, false, 'duplicate chapter 0 completion is rejected');
  assert.equal(engine.getSessionState(now).chaptersCompleted, 2);

  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, { timestamp: now });
  const stored = (await storage.getReadingSessions({ bookId: 7 }))[0];
  assert.equal(stored.chaptersCompleted, 2);
  assert.deepEqual(stored.completedChapterIndexes, [0, 1]);
  engine.destroy();
});

test('8. Rapid event ordering and transition safety', async () => {
  let now = 8_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  const events = [
    { type: SESSION_EVENTS.SESSION_START, payload: { bookId: 8, chapterIndex: 0, timestamp: now } },
    { type: SESSION_EVENTS.READING, payload: { chapterIndex: 0, position: 10, totalWords: 100, timestamp: now + 1 } },
    { type: SESSION_EVENTS.LISTENING, payload: { state: 'playing', timestamp: now + 2 } },
    { type: SESSION_EVENTS.LISTENING, payload: { state: 'paused', timestamp: now + 3 } },
    { type: SESSION_EVENTS.READING, payload: { chapterIndex: 0, position: 20, totalWords: 100, timestamp: now + 4 } },
    { type: SESSION_EVENTS.CHAPTER_COMPLETE, payload: { chapterIndex: 0, timestamp: now + 5 } },
    { type: SESSION_EVENTS.SESSION_END, payload: { timestamp: now + 6 } }
  ];

  for (const { type, payload } of events) {
    const res = await engine.dispatchSessionEvent(type, payload);
    assert.notEqual(res, false, `rapid transition ${type} succeeds`);
  }

  const finalState = engine.getSessionState(now + 10);
  assert.equal(finalState.status, SESSION_STATES.IDLE);
  const stored = (await storage.getReadingSessions({ bookId: 8 }))[0];
  assert.ok(stored, 'session was finalized and stored');
  assert.equal(stored.chaptersCompleted, 1);
  engine.destroy();
});

test('9. No double counting or negative durations under backwards timestamps', async () => {
  let now = 9_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_START, {
    bookId: 9,
    chapterIndex: 0,
    timestamp: now
  });

  // Backward timestamp attempt
  now += 5_000;
  await engine.dispatchSessionEvent(SESSION_EVENTS.READING, { timestamp: now - 10_000 });
  await engine.dispatchSessionEvent(SESSION_EVENTS.SESSION_END, { timestamp: now - 20_000 });

  const stored = (await storage.getReadingSessions({ bookId: 9 }))[0];
  assert.ok(stored.activeDurationMs >= 0, 'activeDurationMs cannot be negative');
  assert.ok(stored.ttsDurationMs >= 0, 'ttsDurationMs cannot be negative');
  assert.ok(stored.ttsDurationMs <= stored.activeDurationMs, 'TTS is bounded by active duration');
  engine.destroy();
});

test('10. Compatibility of legacy public APIs', async () => {
  let now = 10_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });

  // Legacy direct methods on engine
  const id = await engine.startSession({ bookId: 10, chapterIndex: 0, timestamp: now });
  assert.ok(id);
  now += 2_000;
  assert.equal(await engine.markTtsStart(now), true);
  now += 3_000;
  assert.equal(await engine.markTtsPause(now), true);
  assert.equal(engine.markChapterCompleted(0, now), true);
  assert.equal(engine.markChapterCompleted(0, now), false);
  now += 1_000;
  assert.equal(await engine.endSession(now), true);

  const stored = (await storage.getReadingSessions({ bookId: 10 }))[0];
  assert.equal(stored.id, id);
  assert.equal(stored.chaptersCompleted, 1);
  assert.equal(stored.activeDurationMs, 6_000);
  assert.equal(stored.ttsDurationMs, 3_000);

  // Module exported wrapper functions
  assert.equal(typeof startSession, 'function');
  assert.equal(typeof pauseSession, 'function');
  assert.equal(typeof resumeSession, 'function');
  assert.equal(typeof endSession, 'function');
  assert.equal(typeof markActivity, 'function');
  assert.equal(typeof markChapterCompleted, 'function');
  assert.equal(typeof markTtsStart, 'function');
  assert.equal(typeof markTtsPause, 'function');
  assert.equal(typeof dispatchSessionEvent, 'function');
  assert.equal(typeof getSessionState, 'function');

  engine.destroy();
});
