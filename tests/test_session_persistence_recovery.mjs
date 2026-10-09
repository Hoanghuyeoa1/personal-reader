import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReadingHistoryEngine,
  READING_HISTORY_FLUSH_MS,
  READING_HISTORY_IDLE_MS
} from './readingHistory.js';

function createMockStorage() {
  const sessions = new Map();
  let putCount = 0;
  let failPut = false;
  let failGetUnfinished = false;

  return {
    async putReadingSession(session) {
      putCount++;
      if (failPut) throw new Error('QuotaExceededError: simulated storage full');
      sessions.set(session.id, {
        ...session,
        dailyBuckets: (session.dailyBuckets || []).map(b => ({ ...b })),
        hourlyBuckets: (session.hourlyBuckets || []).map(b => ({
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
      if (failGetUnfinished) throw new Error('DatabaseClosedError');
      return [...sessions.values()].filter(r => r.endedAt === null);
    },
    async deleteReadingSession(id) {
      return sessions.delete(id);
    },
    async clearReadingHistory() {
      sessions.clear();
      return true;
    },
    setFailPut(val) { failPut = val; },
    setFailGetUnfinished(val) { failGetUnfinished = val; },
    getPutCount() { return putCount; },
    resetPutCount() { putCount = 0; },
    _raw: sessions
  };
}

test('1. 15s checkpoint cadence', async () => {
  let now = 1_000_000;
  const timerCallbacks = new Map();
  let timerId = 0;
  const storage = createMockStorage();

  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true,
    setInterval: cb => { const id = ++timerId; timerCallbacks.set(id, cb); return id; },
    clearInterval: id => timerCallbacks.delete(id)
  });

  await engine.startSession({ bookId: 1, chapterIndex: 0, timestamp: now });
  storage.resetPutCount();

  // Advance 5s and 10s: timer has not fired yet
  now += 5_000;
  assert.equal(storage.getPutCount(), 0, 'no periodic write before 15s');

  now += 10_000; // now = 1_015_000 (15s elapsed)
  // Fire periodic timer callback
  for (const cb of timerCallbacks.values()) cb();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(storage.getPutCount(), 1, 'periodic flush fires at 15s cadence');
  const row = (await storage.getReadingSessions({ bookId: 1 }))[0];
  assert.equal(row.safeCheckpointAt, now, 'safeCheckpointAt advances to 15s mark');

  // Advance another 15s
  now += 15_000;
  for (const cb of timerCallbacks.values()) cb();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.getPutCount(), 2, 'second periodic flush fires at 30s mark');

  await engine.endSession(now);
  engine.destroy();
});

test('2. High-frequency activity with bounded writes', async () => {
  let now = 2_000_000;
  const timerCallbacks = new Map();
  let timerId = 0;
  const storage = createMockStorage();

  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true,
    setInterval: cb => { const id = ++timerId; timerCallbacks.set(id, cb); return id; },
    clearInterval: id => timerCallbacks.delete(id)
  });

  await engine.startSession({ bookId: 2, chapterIndex: 0, timestamp: now });
  storage.resetPutCount();

  // Establish baseline at position 0
  engine.recordChapterProgress({
    chapterIndex: 0,
    position: 0,
    totalWords: 2000,
    timestamp: now,
    explicitJump: true
  });

  // Simulate 100 high-frequency scroll and progress updates within 10s
  for (let i = 1; i <= 100; i++) {
    now += 100;
    engine.recordChapterProgress({
      chapterIndex: 0,
      position: i * 10,
      totalWords: 2000,
      timestamp: now
    });
  }

  // Before 15s timer fires, zero storage writes should occur
  assert.equal(storage.getPutCount(), 0, '100 high-frequency updates produce zero immediate writes');
  assert.equal(engine.getSessionState(now).wordsReadEstimate, 1000, 'in-memory estimate is accurate');

  await engine.endSession(now);
  assert.equal(storage.getPutCount(), 1, 'only session end writes to storage');
  const stored = (await storage.getReadingSessions({ bookId: 2 }))[0];
  assert.equal(stored.wordsReadEstimate, 1000);
  engine.destroy();
});

test('3. Recovery after crash', async () => {
  let now = 3_000_000;
  const storage = createMockStorage();

  // Seed an unfinished crashed session
  const crashStartedAt = now;
  const crashCheckpoint = now + 15_000;
  const crashLastActivity = now + 12_000;
  await storage.putReadingSession({
    id: 'crashed-session-1',
    bookId: 3,
    startedAt: crashStartedAt,
    endedAt: null,
    activeDurationMs: 15_000,
    ttsDurationMs: 0,
    startChapterIndex: 0,
    endChapterIndex: 0,
    wordsReadEstimate: 300,
    chaptersCompleted: 0,
    completedChapterIndexes: [],
    safeCheckpointAt: crashCheckpoint,
    lastActivityAt: crashLastActivity,
    dailyBuckets: [],
    hourlyBuckets: []
  });

  // App restarts 10 hours later
  now += 10 * 60 * 60 * 1000;
  const engine = new ReadingHistoryEngine({ storage, now: () => now });

  const recoveredCount = await engine.recoverUnfinishedSessions(now);
  assert.equal(recoveredCount, 1, 'recovers exactly 1 crashed session');

  const recoveredRow = (await storage.getReadingSessions({ bookId: 3 }))[0];
  assert.ok(recoveredRow.endedAt !== null, 'endedAt is finalized');
  assert.equal(recoveredRow.endedAt, Math.min(crashCheckpoint, crashLastActivity + READING_HISTORY_IDLE_MS));
  assert.ok(recoveredRow.endedAt < now, 'offline 10-hour gap is completely excluded');
  engine.destroy();
});

test('4. Double recovery is idempotent', async () => {
  let now = 4_000_000;
  const storage = createMockStorage();

  await storage.putReadingSession({
    id: 'crashed-session-2',
    bookId: 4,
    startedAt: now,
    endedAt: null,
    activeDurationMs: 5_000,
    ttsDurationMs: 0,
    startChapterIndex: 0,
    endChapterIndex: 0,
    wordsReadEstimate: 50,
    chaptersCompleted: 0,
    completedChapterIndexes: [],
    safeCheckpointAt: now + 5_000,
    lastActivityAt: now + 5_000,
    dailyBuckets: [],
    hourlyBuckets: []
  });

  const engine1 = new ReadingHistoryEngine({ storage, now: () => now });
  assert.equal(await engine1.recoverUnfinishedSessions(now), 1, 'first recovery succeeds');
  assert.equal(await engine1.recoverUnfinishedSessions(now), 0, 'second recovery on same instance returns 0');

  // A new engine instance checking storage
  const engine2 = new ReadingHistoryEngine({ storage, now: () => now + 1000 });
  assert.equal(await engine2.recoverUnfinishedSessions(now + 1000), 0, 'second instance finds 0 unfinished sessions');
  engine1.destroy();
  engine2.destroy();
});

test('5. Stale checkpoint ordering defense', async () => {
  let now = 5_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({ storage, now: () => now });

  await engine.startSession({ bookId: 5, chapterIndex: 0, timestamp: now });
  const sessionId = engine.session.id;

  // Snapshot A at T = 15_000
  now += 15_000;
  await engine.flushSession(now);
  const snapA = (await storage.getReadingSessions({ bookId: 5 }))[0];
  assert.equal(snapA.safeCheckpointAt, now);

  // Snapshot B at T = 30_000 (finalized endSession)
  now += 15_000;
  await engine.endSession(now);
  const snapB = (await storage.getReadingSessions({ bookId: 5 }))[0];
  assert.equal(snapB.safeCheckpointAt, now);
  assert.ok(snapB.endedAt !== null);

  // Simulate an out-of-order delayed write of Snapshot A attempting to overwrite after Snapshot B
  const staleWriteResult = await engine._writeSnapshot(snapA);
  assert.equal(staleWriteResult, false, 'stale unfinalized snapshot is rejected');

  const afterStale = (await storage.getReadingSessions({ bookId: 5 }))[0];
  assert.equal(afterStale.safeCheckpointAt, snapB.safeCheckpointAt, 'safeCheckpointAt was not rolled back');
  assert.equal(afterStale.endedAt, snapB.endedAt, 'finalized endedAt was not wiped');
  engine.destroy();
});

test('6. Reload with inactive gap', async () => {
  let now = 6_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({ storage, now: () => now });

  await engine.startSession({ bookId: 6, chapterIndex: 0, timestamp: now });
  now += 5_000;
  await engine.markActivity({ timestamp: now, chapterIndex: 0 });
  now += 10_000;
  await engine.flushSession(now);

  // Machine sleeps / browser closes for 6 hours
  now += 6 * 60 * 60 * 1000;
  const restartEngine = new ReadingHistoryEngine({ storage, now: () => now });
  await restartEngine.recoverUnfinishedSessions(now);

  const restored = (await storage.getReadingSessions({ bookId: 6 }))[0];
  assert.ok(restored.endedAt !== null);
  assert.ok(restored.activeDurationMs <= 15_000, 'active duration excludes 6-hour sleep gap');
  engine.destroy();
  restartEngine.destroy();
});

test('7. Hidden/background audio tracking', async () => {
  let now = 7_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({ storage, now: () => now, visible: true });

  await engine.startSession({ bookId: 7, chapterIndex: 0, timestamp: now });

  // Start TTS
  now += 1_000;
  await engine.markTtsStart(now);

  // User hides tab (screen lock / background)
  now += 1_000;
  await engine.setVisibility(false, now);

  // Audio continues playing in background for 10s
  now += 10_000;
  await engine.flushSession(now);
  let snap = (await storage.getReadingSessions({ bookId: 7 }))[0];
  assert.equal(snap.ttsDurationMs, 11_000, 'background audio accumulates TTS duration');
  assert.equal(snap.activeDurationMs, 12_000, 'active duration encompasses background audio');

  // Audio stops in background
  now += 1_000;
  await engine.markTtsPause(now);

  // Time elapses while background is silent (should NOT accumulate)
  now += 5_000;
  await engine.flushSession(now);
  snap = (await storage.getReadingSessions({ bookId: 7 }))[0];
  assert.equal(snap.ttsDurationMs, 12_000, 'silent background does not accrue TTS duration');
  assert.equal(snap.activeDurationMs, 13_000, 'silent background does not accrue active reading duration');

  await engine.endSession(now);
  engine.destroy();
});

test('8. OS sleep and wall-clock change (backwards clock protection)', async () => {
  let now = 8_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({ storage, now: () => now });

  await engine.startSession({ bookId: 8, chapterIndex: 0, timestamp: now });
  now += 5_000;
  await engine.markActivity({ timestamp: now, chapterIndex: 0 });

  // NTP / Clock rolls back 20 seconds
  const rollbackTime = now - 20_000;
  await engine.markActivity({ timestamp: rollbackTime, chapterIndex: 0 });
  await engine.endSession(rollbackTime);

  const row = (await storage.getReadingSessions({ bookId: 8 }))[0];
  assert.ok(row.activeDurationMs >= 0, 'activeDurationMs cannot be negative');
  assert.ok(row.ttsDurationMs >= 0, 'ttsDurationMs cannot be negative');
  assert.ok(row.endedAt >= row.startedAt, 'endedAt is not before startedAt');
  engine.destroy();
});

test('9. Storage rejection and quota error handling', async () => {
  let now = 9_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({ storage, now: () => now });

  await engine.startSession({ bookId: 9, chapterIndex: 0, timestamp: now });

  // Enable storage write failure (simulated quota error)
  storage.setFailPut(true);
  now += 15_000;
  const flushFail = await engine.flushSession(now);
  assert.equal(flushFail, false, 'flush returns false on storage failure without throwing');
  assert.equal(engine.pendingWrites.size, 1, 'failed snapshot is safely queued in pendingWrites');

  // Reader activity continues unaffected
  now += 5_000;
  assert.equal(await engine.markActivity({ timestamp: now, chapterIndex: 0 }), true, 'Reader remains active');

  // Storage recovers
  storage.setFailPut(false);
  now += 15_000;
  const flushRecover = await engine.flushSession(now);
  assert.equal(flushRecover, true, 'flush succeeds once storage recovers');
  assert.equal(engine.pendingWrites.size, 0, 'pendingWrites are drained');

  const stored = (await storage.getReadingSessions({ bookId: 9 }))[0];
  assert.ok(stored, 'data is safely persisted');
  assert.equal(stored.safeCheckpointAt, now);
  engine.destroy();
});

test('10. Session end persistence', async () => {
  let now = 10_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({ storage, now: () => now });

  await engine.startSession({ bookId: 10, chapterIndex: 0, timestamp: now });
  now += 8_000;
  const end1 = await engine.endSession(now);
  assert.equal(end1, true, 'first endSession succeeds');

  const row = (await storage.getReadingSessions({ bookId: 10 }))[0];
  assert.equal(row.endedAt, now, 'endedAt is persisted');

  const end2 = await engine.endSession(now + 100);
  assert.equal(end2, false, 'duplicate endSession returns false without modifying storage');
  engine.destroy();
});

test('11. Schema v6 compatibility check', async () => {
  let now = 11_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({ storage, now: () => now });

  await engine.startSession({ bookId: 11, chapterIndex: 2, timestamp: now });
  now += 15_000;
  await engine.markTtsStart(now);
  now += 5_000;
  await engine.markChapterCompleted(2, now);
  await engine.endSession(now);

  const row = (await storage.getReadingSessions({ bookId: 11 }))[0];
  // Verify Dexie schema v6 primary & indexed keys: 'id, bookId, startedAt'
  assert.ok(typeof row.id === 'string' && row.id.length > 0, 'id key exists and valid');
  assert.ok(Number.isSafeInteger(row.bookId) && row.bookId > 0, 'bookId indexed key valid');
  assert.ok(Number.isSafeInteger(row.startedAt) && row.startedAt > 0, 'startedAt indexed key valid');

  // Verify backup JSON v5 structure expectations
  assert.ok(Number.isFinite(row.activeDurationMs) && row.activeDurationMs >= 0);
  assert.ok(Number.isFinite(row.ttsDurationMs) && row.ttsDurationMs >= 0);
  assert.ok(row.ttsDurationMs <= row.activeDurationMs);
  assert.ok(Array.isArray(row.dailyBuckets));
  assert.ok(Array.isArray(row.hourlyBuckets));
  assert.ok(Array.isArray(row.completedChapterIndexes));
  assert.equal(row.chaptersCompleted, 1);
  engine.destroy();
});
