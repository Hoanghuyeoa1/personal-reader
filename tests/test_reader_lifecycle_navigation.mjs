import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReadingHistoryEngine,
  SESSION_EVENTS,
  SESSION_STATES
} from './readingHistory.js';

function createMockStorage() {
  const books = new Map();
  const sessions = new Map();
  let putCount = 0;

  return {
    async getBook(id) {
      return books.get(Number(id)) || null;
    },
    async updateProgress(bookId, chapterIndex, scrollProgress = 0, scrollY = 0, currentChunkIndex = 0) {
      putCount++;
      const id = Number(bookId);
      const existing = books.get(id) || { id };
      const updated = {
        ...existing,
        currentChapterIndex: Number(chapterIndex),
        currentChunkIndex: Math.max(0, Number(currentChunkIndex)),
        scrollProgress: Math.min(100, Math.max(0, Math.round(scrollProgress))),
        scrollY: Math.max(0, Math.round(scrollY)),
        lastReadAt: Date.now()
      };
      books.set(id, updated);
      return updated;
    },
    async putReadingSession(session) {
      putCount++;
      sessions.set(session.id, { ...session });
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
    resetPutCount() { putCount = 0; },
    getStoredBook(id) { return books.get(Number(id)); },
    getStoredSession(id) { return sessions.get(id); }
  };
}

test('1. Reading -> pause -> resume lifecycle integration', async (t) => {
  let now = 1_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  // Start session
  await engine.startSession({ bookId: 101, chapterIndex: 0, timestamp: now });
  assert.equal(engine.getSessionState(now).status, SESSION_STATES.READING);

  // Read forward
  now += 5_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 200, totalWords: 1000, timestamp: now });
  assert.equal(engine.getSessionState(now).wordsReadEstimate, 200);
  assert.equal(engine.getSessionState(now).status, SESSION_STATES.READING);

  // Pause session
  now += 5_000;
  await engine.pauseSession(now);
  assert.equal(engine.getSessionState(now).status, SESSION_STATES.PAUSED);

  // Resume session
  now += 10_000;
  await engine.resumeSession(now);
  assert.equal(engine.getSessionState(now).status, SESSION_STATES.READING);

  // Continue reading
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 400, totalWords: 1000, timestamp: now });
  assert.equal(engine.getSessionState(now).wordsReadEstimate, 400);

  await engine.endSession(now);
});

test('2. Open / reopen book is idempotent and does not create duplicate sessions', async (t) => {
  let now = 2_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  const sessionId1 = await engine.startSession({ bookId: 102, chapterIndex: 0, timestamp: now });
  now += 5_000;
  // Reopen the same book
  const sessionId2 = await engine.startSession({ bookId: 102, chapterIndex: 0, timestamp: now });
  assert.equal(sessionId1, sessionId2, 'Reopening active book returns same session ID');

  await engine.endSession(now);
});

test('3. scrollY and currentChunkIndex remain independent and do not overwrite each other', async () => {
  const storage = createMockStorage();

  // Initial progress: scrollY = 300, currentChunkIndex = 5
  await storage.updateProgress(103, 1, 30, 300, 5);
  let book = storage.getStoredBook(103);
  assert.equal(book.scrollY, 300);
  assert.equal(book.currentChunkIndex, 5);

  // Eye scrolling advances scrollY to 600, preserving currentChunkIndex = 5
  await storage.updateProgress(103, 1, 60, 600, book.currentChunkIndex);
  book = storage.getStoredBook(103);
  assert.equal(book.scrollY, 600);
  assert.equal(book.currentChunkIndex, 5);

  // TTS chunk advances to 12, preserving scrollY = 600
  await storage.updateProgress(103, 1, 65, book.scrollY, 12);
  book = storage.getStoredBook(103);
  assert.equal(book.scrollY, 600);
  assert.equal(book.currentChunkIndex, 12);
});

test('4. Book switching cleanly finalizes prior session and starts new book session', async (t) => {
  let now = 3_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  // Reading Book A
  const sessionA = await engine.startSession({ bookId: 201, chapterIndex: 0, timestamp: now });
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 15_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 300, totalWords: 1000, timestamp: now });
  await storage.updateProgress(201, 0, 30, 450, 0);

  // Switch to Book B: End Book A session first
  now += 5_000;
  await engine.endSession(now);
  const storedA = storage.getStoredSession(sessionA);
  assert.equal(storedA.endedAt, now, 'Book A session is cleanly finalized');
  assert.equal(storedA.wordsReadEstimate, 300);

  // Start Book B session
  now += 1_000;
  const sessionB = await engine.startSession({ bookId: 202, chapterIndex: 0, timestamp: now });
  assert.notEqual(sessionA, sessionB, 'Different books have distinct session IDs');
  assert.equal(engine.session.bookId, 202);

  await engine.endSession(now);
});

test('5. Chapter switching records transitions without completing chapter or splitting sessions', async (t) => {
  let now = 4_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  await engine.startSession({ bookId: 301, chapterIndex: 0, timestamp: now });
  now += 10_000;

  // Chapter 0 -> Chapter 1 transition
  engine.markChapterLeave(0, now);
  engine.markChapterEnter(1, now);

  assert.equal(engine.session.startChapterIndex, 0);
  assert.equal(engine.session.endChapterIndex, 1);
  assert.equal(engine.session.chaptersCompleted, 0, 'Entering chapter 1 does not mark it complete');

  // Passing null or undefined chapterIndex to markChapterLeave does not corrupt to 0
  engine.markChapterLeave(null, now + 1000);
  assert.equal(engine.session.endChapterIndex, 1, 'null chapter index is ignored');

  await engine.endSession(now + 2000);
});

test('6. Duplicate chapter completion safeguards (Auto-next + manual next deduplication)', async (t) => {
  let now = 5_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  await engine.startSession({ bookId: 401, chapterIndex: 0, timestamp: now });

  // Read chapter 0 to near-end (>= 90% and moved >= 2%)
  engine.recordChapterProgress({ chapterIndex: 0, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 950, totalWords: 1000, timestamp: now });
  assert.equal(engine.isChapterNearEnd(0), true);

  // Auto-next or natural TTS completes chapter 0
  const firstComplete = engine.markChapterCompleted(0, now);
  assert.equal(firstComplete, true, 'First completion succeeds');
  assert.equal(engine.session.chaptersCompleted, 1);

  // User manual Next simultaneously fires for chapter 0
  const secondComplete = engine.markChapterCompleted(0, now + 100);
  assert.equal(secondComplete, false, 'Duplicate completion for same chapter is rejected');
  assert.equal(engine.session.chaptersCompleted, 1, 'Total completed chapters remains 1');

  // Chapter 1 is opened without reading
  engine.markChapterEnter(1, now + 200);
  assert.equal(engine.isChapterNearEnd(1), false, 'Newly entered chapter is not near-end');

  // User clicks manual next on chapter 1 without near-end: guarded by caller checking isChapterNearEnd
  assert.equal(engine.isChapterNearEnd(1), false);

  await engine.endSession(now + 500);
});

test('7. Search & Bookmark navigation credits zero words and never marks completion', async (t) => {
  let now = 6_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  await engine.startSession({ bookId: 501, chapterIndex: 0, timestamp: now });

  // Baseline at position 0
  engine.recordChapterProgress({ chapterIndex: 0, position: 0, totalWords: 2000, timestamp: now, explicitJump: true });

  // Bookmark / Search jumps directly to word 1500
  const jumpResult = engine.recordChapterProgress({
    chapterIndex: 0,
    position: 1500,
    totalWords: 2000,
    timestamp: now + 5000,
    explicitJump: true
  });

  assert.equal(jumpResult.creditedWords, 0, 'Jumping via bookmark/search credits 0 words');
  assert.equal(engine.getSessionState(now + 5000).wordsReadEstimate, 0, 'No false word count added');
  assert.equal(engine.isChapterNearEnd(0), false, 'Jump does not trigger near-end');
  assert.equal(engine.session.chaptersCompleted, 0, 'No completion recorded');

  // Normal reading resumes from word 1500 to 1600
  const readResult = engine.recordChapterProgress({
    chapterIndex: 0,
    position: 1600,
    totalWords: 2000,
    timestamp: now + 10000
  });
  assert.equal(readResult.creditedWords, 100, 'Only actual forward reading from jump baseline is credited');
  assert.equal(engine.getSessionState(now + 10000).wordsReadEstimate, 100);

  await engine.endSession(now + 15000);
});

test('8. Multiple chapters completed in a single extended session', async (t) => {
  let now = 7_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  await engine.startSession({ bookId: 601, chapterIndex: 0, timestamp: now });

  // Chapter 0: read & complete
  engine.recordChapterProgress({ chapterIndex: 0, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 950, totalWords: 1000, timestamp: now });
  assert.equal(engine.markChapterCompleted(0, now), true);
  engine.markChapterLeave(0, now);

  // Chapter 1: enter, read & complete
  engine.markChapterEnter(1, now);
  engine.recordChapterProgress({ chapterIndex: 1, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 1, position: 960, totalWords: 1000, timestamp: now });
  assert.equal(engine.markChapterCompleted(1, now), true);
  engine.markChapterLeave(1, now);

  // Chapter 2: enter, read & complete
  engine.markChapterEnter(2, now);
  engine.recordChapterProgress({ chapterIndex: 2, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 2, position: 980, totalWords: 1000, timestamp: now });
  assert.equal(engine.markChapterCompleted(2, now), true);

  assert.equal(engine.session.chaptersCompleted, 3, 'Single session tracks 3 completed chapters');
  assert.deepEqual(engine.session.completedChapterIndexes, [0, 1, 2]);

  await engine.endSession(now);
});

test('9. Pause TTS keeps eye reading active when visible', async (t) => {
  let now = 8_000_000;
  const storage = createMockStorage();
  const engine = new ReadingHistoryEngine({
    storage,
    now: () => now,
    visible: true
  });
  t.after(() => engine.destroy());

  await engine.startSession({ bookId: 701, chapterIndex: 0, timestamp: now });

  // TTS playing
  now += 10_000;
  await engine.markTtsStart(now);
  now += 20_000;

  // TTS paused
  await engine.markTtsPause(now);

  // Eye reading continues while visible
  now += 15_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 0, totalWords: 1000, timestamp: now, explicitJump: true });
  now += 10_000;
  engine.recordChapterProgress({ chapterIndex: 0, position: 200, totalWords: 1000, timestamp: now });

  const state = engine.getSessionState(now);
  assert.equal(state.status, SESSION_STATES.READING, 'Session state remains READING after TTS paused');
  assert.ok(state.activeDurationMs >= 45_000, 'Eye reading continues accruing active time');
  assert.equal(state.ttsDurationMs, 20_000, 'TTS duration stays at 20s');

  await engine.endSession(now);
});
