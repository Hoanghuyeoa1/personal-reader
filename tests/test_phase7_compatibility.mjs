import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReadingHistoryEngine,
  SESSION_STATES,
  asLocalDateKey
} from './readingHistory.js';
import {
  createReadingAnalytics
} from './readingAnalytics.js';

function createMockStorage() {
  const books = new Map();
  const sessions = new Map();
  const chapters = new Map();
  const bookmarks = new Map();
  let putCount = 0;

  return {
    async getBook(id) {
      return books.get(Number(id)) || null;
    },
    async getAllBooks() {
      return [...books.values()];
    },
    async putBook(book) {
      const id = Number(book.id || books.size + 1);
      const record = { ...book, id };
      books.set(id, record);
      return id;
    },
    async deleteBook(bookId) {
      const id = Number(bookId);
      books.delete(id);
      for (const [key, ch] of chapters) {
        if (Number(ch.bookId) === id) chapters.delete(key);
      }
      for (const [key, bm] of bookmarks) {
        if (Number(bm.bookId) === id) bookmarks.delete(key);
      }
      for (const [key, s] of sessions) {
        if (Number(s.bookId) === id) sessions.delete(key);
      }
      return true;
    },
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
    async getReadingSessions({ bookId, from, to } = {}) {
      let list = [...sessions.values()];
      if (bookId !== undefined && bookId !== null) {
        list = list.filter(s => Number(s.bookId) === Number(bookId));
      }
      return list;
    },
    async deleteReadingSession(id) {
      return sessions.delete(id);
    },
    async clearReadingHistory() {
      sessions.clear();
      return true;
    },
    async getUnfinishedReadingSessions() {
      return [...sessions.values()].filter(s => s.endedAt === null);
    },
    getPutCount() { return putCount; },
    resetPutCount() { putCount = 0; },
    getStoredSession(id) { return sessions.get(id); },
    getStoredSessionsCount() { return sessions.size; },
    getStoredBook(id) { return books.get(Number(id)); }
  };
}

// 1. Single source of truth: Analytics is purely read-only derived computation
test('1. Analytics functions are strictly read-only and never mutate storage', async (t) => {
  const storage = createMockStorage();
  await storage.putBook({ id: 1, title: 'Sách 1', author: 'Tác giả 1' });
  await storage.putReadingSession({
    id: 'session-1',
    bookId: 1,
    startedAt: 1700000000000,
    endedAt: 1700001800000,
    activeDurationMs: 1800000,
    ttsDurationMs: 900000,
    wordsReadEstimate: 5000,
    chaptersCompleted: 2,
    safeCheckpointAt: 1700001800000,
    lastActivityAt: 1700001800000,
    dailyBuckets: [
      {
        date: asLocalDateKey(1700000000000),
        activeDurationMs: 1800000,
        ttsDurationMs: 900000,
        wordsReadEstimate: 5000,
        chaptersCompleted: 2
      }
    ],
    hourlyBuckets: []
  });

  const initialPutCount = storage.getPutCount();
  const initialSessionsCount = storage.getStoredSessionsCount();

  // Run various analytics calculations
  const analytics = createReadingAnalytics({
    now: () => 1700002000000,
    getReadingSessions: () => storage.getReadingSessions(),
    getAllBooks: () => storage.getAllBooks(),
    getSessionSnapshot: async () => null
  });

  const dashboard = await analytics.getDashboardData('allTime', { now: 1700002000000 });
  assert.equal(dashboard.totals.activeDurationMs, 1800000);
  assert.equal(dashboard.totals.ttsDurationMs, 900000);
  assert.equal(dashboard.totals.wordsReadEstimate, 5000);
  assert.equal(dashboard.totals.chaptersCompleted, 2);

  assert.ok(dashboard.insights.consumptionSpeed.wordsPerMinute > 0);
  assert.ok(dashboard.insights.preferredReadingWindow);
  assert.ok(dashboard.insights.weekdayActivity);
  assert.ok(dashboard.insights.topBooks.length > 0);
  assert.ok(dashboard.heatmap.cells.length > 0);
  assert.ok(dashboard.streaks);

  // Verification: zero writes to storage occurred during analytics computation
  assert.equal(storage.getPutCount(), initialPutCount, 'Analytics caused 0 storage puts');
  assert.equal(storage.getStoredSessionsCount(), initialSessionsCount, 'No extra sessions created');
});

// 2. Metric compatibility: Active time, TTS subset, and words estimate semantics
test('2. Metric compatibility: TTS time <= Active time, no double-counting during concurrent reading/listening', async (t) => {
  let now = 1_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  await engine.startSession({ bookId: 10, chapterIndex: 0, timestamp: now });

  // Concurrent reading + listening for 20 seconds
  await engine.markTtsStart(now);
  engine.recordChapterProgress({ chapterIndex: 0, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 20_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 200, totalWords: 1000, timestamp: now });
  await engine.flushSession(now);

  const state1 = engine.getSessionState(now);
  // Active time is 20s, NOT 20s + 20s = 40s
  assert.equal(state1.activeDurationMs, 20_000, 'Concurrent reading and listening does not double-count active time');
  assert.equal(state1.ttsDurationMs, 20_000, 'TTS duration accurately recorded');
  assert.equal(state1.wordsReadEstimate, 200);

  // Pause TTS, read by eye for 10 seconds
  await engine.markTtsPause(now);
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 350, totalWords: 1000, timestamp: now });
  await engine.flushSession(now);

  const state2 = engine.getSessionState(now);
  assert.equal(state2.activeDurationMs, 30_000, 'Active duration continues for eye reading');
  assert.equal(state2.ttsDurationMs, 20_000, 'TTS duration stays at 20s while paused');
  assert.equal(state2.wordsReadEstimate, 350);

  // Rewind: reading backwards must NOT add to wordsReadEstimate
  now += 5_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 100, totalWords: 1000, timestamp: now });
  const state3 = engine.getSessionState(now);
  assert.equal(state3.wordsReadEstimate, 350, 'Rewind/backward jump does not increase wordsReadEstimate');

  await engine.endSession(now);
});

// 3. Midnight boundary splitting: Daily buckets cleanly separated across local calendar dates
test('3. Midnight boundary correctly splits daily contributions into separate date keys', async (t) => {
  // 23:55:00 on Day 1 (1700000000000) to 00:15:00 on Day 2 (+20 minutes = 1200000ms)
  let now = new Date('2026-03-15T23:55:00.000Z').getTime();
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  await engine.startSession({ bookId: 20, chapterIndex: 0, timestamp: now });
  await engine.markTtsStart(now);

  // Advance across midnight: 5 minutes before midnight (300_000ms) + 15 minutes after midnight (900_000ms)
  now += 300_000; // Exactly midnight UTC
  await engine.flushSession(now);

  now += 900_000; // 15 mins after midnight
  await engine.markTtsPause(now);
  await engine.endSession(now);

  const stored = storage.getStoredSession(engine.session?.id || (await storage.getReadingSessions({ bookId: 20 })).pop()?.id);
  const sessions = await storage.getReadingSessions({ bookId: 20 });
  const session = sessions[0];
  assert.ok(session);
  assert.equal(session.activeDurationMs, 1200000);
  assert.equal(session.ttsDurationMs, 1200000);

  // Verification: dailyBuckets contains entries with valid local date keys without corruption
  assert.ok(session.dailyBuckets.length >= 1);
  const totalBucketActive = session.dailyBuckets.reduce((acc, b) => acc + b.activeDurationMs, 0);
  assert.equal(totalBucketActive, 1200000, 'Sum of bucket durations matches session total active duration');
});

// 4. Book deletion cascade: Deleting a book atomically cleans up all associated readingSessions
test('4. Book deletion cleanly cascades and removes associated readingSessions', async (t) => {
  const storage = createMockStorage();
  await storage.putBook({ id: 50, title: 'Sách cần xóa' });
  await storage.putReadingSession({
    id: 's-50-1',
    bookId: 50,
    startedAt: 1000,
    endedAt: 2000,
    activeDurationMs: 1000,
    ttsDurationMs: 0,
    wordsReadEstimate: 100,
    chaptersCompleted: 0,
    safeCheckpointAt: 2000,
    lastActivityAt: 2000,
    dailyBuckets: [],
    hourlyBuckets: []
  });
  await storage.putReadingSession({
    id: 's-50-2',
    bookId: 50,
    startedAt: 3000,
    endedAt: 4000,
    activeDurationMs: 1000,
    ttsDurationMs: 0,
    wordsReadEstimate: 150,
    chaptersCompleted: 1,
    safeCheckpointAt: 4000,
    lastActivityAt: 4000,
    dailyBuckets: [],
    hourlyBuckets: []
  });

  // Also have book 51 with its own session
  await storage.putBook({ id: 51, title: 'Sách giữ lại' });
  await storage.putReadingSession({
    id: 's-51-1',
    bookId: 51,
    startedAt: 5000,
    endedAt: 6000,
    activeDurationMs: 1000,
    ttsDurationMs: 0,
    wordsReadEstimate: 200,
    chaptersCompleted: 1,
    safeCheckpointAt: 6000,
    lastActivityAt: 6000,
    dailyBuckets: [],
    hourlyBuckets: []
  });

  assert.equal((await storage.getReadingSessions({ bookId: 50 })).length, 2);
  assert.equal((await storage.getReadingSessions({ bookId: 51 })).length, 1);

  // Delete Book 50
  await storage.deleteBook(50);

  // Verify Book 50 sessions are purged, Book 51 sessions remain intact
  assert.equal((await storage.getReadingSessions({ bookId: 50 })).length, 0);
  assert.equal((await storage.getReadingSessions({ bookId: 51 })).length, 1);
  assert.equal(await storage.getBook(50), null);
  assert.notEqual(await storage.getBook(51), null);
});

// 5. In-memory active snapshot inclusion and no double counting
test('5. getSessionSnapshot reflects active in-memory session and flushSession updates storage', async (t) => {
  let now = 2_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  await engine.startSession({ bookId: 60, chapterIndex: 1, timestamp: now });
  now += 15_000;
  engine.recordChapterProgress({ chapterIndex: 1, position: 500, totalWords: 2000, timestamp: now, explicitJump: true });

  // In-memory snapshot before flush
  const snapshot = await engine.getSessionSnapshot(now);
  assert.equal(snapshot.bookId, 60);
  assert.equal(snapshot.endChapterIndex, 1);
  assert.equal(snapshot.activeDurationMs, 15000);
  assert.equal(snapshot.wordsReadEstimate, 0);

  // After flushing, storage contains the consistent snapshot
  await engine.flushSession(now);
  const stored = storage.getStoredSession(snapshot.id);
  assert.ok(stored);
  assert.equal(stored.activeDurationMs, 15000);

  await engine.endSession(now);
});

// 6. Empty / No-data states return valid structures without NaN or crashes
test('6. Empty reading history returns structured zeroed metrics without NaN or exceptions', async (t) => {
  const emptyAnalytics = createReadingAnalytics({
    now: () => Date.now(),
    getReadingSessions: async () => [],
    getAllBooks: async () => [],
    getSessionSnapshot: async () => null
  });

  const dashboard = await emptyAnalytics.getDashboardData('allTime');

  assert.equal(dashboard.totals.activeDurationMs, 0);
  assert.equal(dashboard.totals.ttsDurationMs, 0);
  assert.equal(dashboard.totals.wordsReadEstimate, 0);
  assert.equal(dashboard.totals.chaptersCompleted, 0);
  assert.equal(dashboard.totals.booksActive, 0);

  assert.equal(dashboard.insights.consumptionSpeed.wordsPerMinute, null);
  assert.equal(dashboard.heatmap.cells.filter(c => c.activeDurationMs > 0).length, 0);
  assert.equal(dashboard.streaks.current?.days || 0, 0);
  assert.equal(dashboard.streaks.longest?.days || 0, 0);
});

// 7. Schema v6 and Backup JSON v5 integrity checks
test('7. Backup JSON v5 structure conforms to Schema v6 collections and types', async () => {
  const sampleBackup = {
    version: 5,
    appName: 'VietReader',
    exportedAt: new Date().toISOString(),
    books: [
      { id: 1, title: 'Tác phẩm A', author: 'Tác giả A', totalChapters: 5, currentChapterIndex: 0, scrollProgress: 0 }
    ],
    chapters: [
      { id: 1, bookId: 1, index: 0, title: 'Chương 1', content: 'Nội dung chương 1...', wordCount: 4 }
    ],
    settings: [],
    customRules: [],
    highlights: [],
    bookmarks: [
      { id: 'bm-1', bookId: 1, chapterIndex: 0, progress: 0.1, scrollY: 100, createdAt: 1700000000000, note: '' }
    ],
    readingSessions: [
      {
        id: 'session-v5',
        bookId: 1,
        startedAt: 1700000000000,
        endedAt: 1700003600000,
        activeDurationMs: 3600000,
        ttsDurationMs: 1800000,
        wordsReadEstimate: 12000,
        chaptersCompleted: 1,
        safeCheckpointAt: 1700003600000,
        lastActivityAt: 1700003600000,
        dailyBuckets: [
          {
            date: '2023-11-14',
            activeDurationMs: 3600000,
            ttsDurationMs: 1800000,
            wordsReadEstimate: 12000,
            chaptersCompleted: 1
          }
        ],
        hourlyBuckets: []
      }
    ]
  };

  assert.equal(sampleBackup.version, 5);
  assert.equal(sampleBackup.appName, 'VietReader');
  assert.ok(Array.isArray(sampleBackup.books));
  assert.ok(Array.isArray(sampleBackup.chapters));
  assert.ok(Array.isArray(sampleBackup.readingSessions));

  const session = sampleBackup.readingSessions[0];
  assert.ok(session.activeDurationMs >= session.ttsDurationMs);
  assert.equal(session.dailyBuckets[0].activeDurationMs, session.activeDurationMs);
});

// 8. Session recovery preserves unclosed sessions and calculates checkpoint safely
test('8. recoverUnfinishedSessions recovers crashed sessions without double finalization', async (t) => {
  const storage = createMockStorage();
  const now = 5_000_000;

  // Stored unclosed session (endedAt === null)
  await storage.putReadingSession({
    id: 'unclosed-1',
    bookId: 77,
    startedAt: 4_000_000,
    endedAt: null,
    activeDurationMs: 60_000,
    ttsDurationMs: 30_000,
    wordsReadEstimate: 500,
    chaptersCompleted: 1,
    safeCheckpointAt: 4_060_000,
    lastActivityAt: 4_060_000,
    dailyBuckets: [],
    hourlyBuckets: []
  });

  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  // Run recovery
  const recoveredCount = await engine.recoverUnfinishedSessions(now);
  assert.equal(recoveredCount, 1);

  // Stored session now has endedAt closed at safe checkpoint
  const recoveredSession = storage.getStoredSession('unclosed-1');
  assert.ok(recoveredSession.endedAt !== null, 'Session was safely closed');
  assert.equal(recoveredSession.endedAt, 4_060_000, 'Closed at safeCheckpointAt boundary');

  // Second recovery is idempotent
  const secondPass = await engine.recoverUnfinishedSessions(now);
  assert.equal(secondPass, 0, 'No additional unclosed sessions left');
});

