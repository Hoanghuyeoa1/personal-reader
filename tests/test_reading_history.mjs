import assert from 'node:assert/strict';
import {
  getLocalCalendarRange,
  markChapterCompleted as markReadingHistoryChapterCompleted,
  READING_HISTORY_FLUSH_MS,
  ReadingHistoryEngine
} from '../readingHistory.js';
import { TTSEngine } from '../tts.js';

assert.equal(markReadingHistoryChapterCompleted(0), false, 'singleton wrapper is exported and safely ignores completion without a session');

class FakeDexie {
  constructor(name) {
    this.name = name;
    this.versions = [];
    this.rows = {};
  }
  version(version) {
    const record = { version, stores: null };
    this.versions.push(record);
    return { stores: schema => { record.stores = schema; return this; } };
  }
  async open() { return this; }
  async transaction(...args) { return args.at(-1)(); }
}

function attachTables(database) {
  const names = ['books', 'chapters', 'settings', 'audioCache', 'customRules', 'highlights', 'searchIndex', 'bookmarks', 'readingSessions'];
  database.readingSessionReads = { full: 0, indexed: 0 };
  for (const name of names) {
    database.rows[name] ||= [];
    let autoId = 1;
    const table = {
      async toArray() {
        if (name === 'readingSessions') database.readingSessionReads.full++;
        return database.rows[name].map(row => ({ ...row }));
      },
      orderBy(field) {
        let rows = database.rows[name].slice().sort((a, b) => Number(a[field]) - Number(b[field]));
        const collection = {
          reverse() { rows.reverse(); return collection; },
          limit(count) { rows = rows.slice(0, count); return collection; },
          async toArray() {
            if (name === 'readingSessions') database.readingSessionReads.indexed++;
            return rows.map(row => ({ ...row }));
          }
        };
        return collection;
      },
      async get(key) { return database.rows[name].find(row => row.id === key || row.key === key); },
      async add(row) {
        const value = { ...row };
        if (value.id === undefined && !['settings', 'audioCache', 'searchIndex'].includes(name)) value.id = autoId++;
        database.rows[name].push(value);
        return value.id;
      },
      async bulkAdd(rows) { for (const row of rows) await this.add(row); },
      async bulkPut(rows) { for (const row of rows) await this.put(row); },
      async put(row) {
        const field = name === 'settings' ? 'key' : name === 'audioCache' ? 'key' : 'id';
        const index = database.rows[name].findIndex(item => item[field] === row[field]);
        if (index < 0) database.rows[name].push({ ...row });
        else database.rows[name][index] = { ...row };
        return row[field];
      },
      async update(id, changes) {
        const row = database.rows[name].find(item => item.id === id);
        if (!row) return 0;
        Object.assign(row, changes);
        return 1;
      },
      async delete(id) {
        const length = database.rows[name].length;
        database.rows[name] = database.rows[name].filter(row => row.id !== id);
        return length !== database.rows[name].length;
      },
      async clear() { database.rows[name] = []; },
      where(field) {
        return { equals: value => ({
          async toArray() { return database.rows[name].filter(row => row[field] === value).map(row => ({ ...row })); },
          async delete() {
            const before = database.rows[name].length;
            database.rows[name] = database.rows[name].filter(row => row[field] !== value);
            return before - database.rows[name].length;
          }
        }) };
      }
    };
    database[name] = table;
  }
}

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
globalThis.BroadcastChannel = undefined;
globalThis.window = { Dexie: FakeDexie };

try {
  const storage = await import('../storage.js');
  const database = await storage.initDB();
  attachTables(database);

  assert.deepEqual(database.versions.map(item => item.version), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(database.versions[5].stores, { readingSessions: 'id, bookId, startedAt' });

  let now = 1_700_000_000_000;
  const timerCallbacks = new Map();
  let timerId = 0;
  const engine = new ReadingHistoryEngine({
    storage: {
      putReadingSession: storage.putReadingSession,
      getReadingSessions: storage.getReadingSessions,
      getUnfinishedReadingSessions: storage.getUnfinishedReadingSessions
    },
    now: () => now,
    setInterval: callback => { const id = ++timerId; timerCallbacks.set(id, callback); return id; },
    clearInterval: id => timerCallbacks.delete(id)
  });

  const idA = await engine.startSession({ bookId: 1, chapterIndex: 0, timestamp: now });
  now += 1_000;
  assert.equal(await engine.startSession({ bookId: 1, chapterIndex: 0, timestamp: now }), idA, 'double start for a book is idempotent');
  now += 2_000;
  assert.equal(await engine.pauseSession(now), true);
  assert.equal(await engine.pauseSession(now + 100), false, 'double pause is safe');
  now += 5_000;
  assert.equal(await engine.resumeSession(now), true);
  now += 3_000;
  const requestedEndAt = now - 10;
  assert.equal(await engine.endSession(requestedEndAt), true);
  const endedA = await storage.getReadingSessions({ bookId: 1 });
  assert.equal(endedA.length, 1);
  assert.equal(endedA[0].endedAt, requestedEndAt);
  assert.equal(endedA[0].activeDurationMs, 5_990, 'pause gap is excluded and elapsed deltas are accumulated once');
  assert.ok(Number.isFinite(endedA[0].activeDurationMs));
  assert.ok(endedA[0].ttsDurationMs <= endedA[0].activeDurationMs);

  const idTts = await engine.startSession({ bookId: 3, chapterIndex: 0, timestamp: now });
  now += 1_000;
  assert.equal(await engine.markTtsStart(now), true);
  now += 4_000;
  assert.equal(await engine.markTtsPause(now), true);
  assert.equal(engine.markChapterCompleted(0, now), true);
  assert.equal(engine.markChapterCompleted(0, now), false, 'a chapter is counted at most once per session');
  now += 1_000;
  await engine.endSession(now);
  const ttsSession = (await storage.getReadingSessions({ bookId: 3 }))[0];
  assert.equal(ttsSession.id, idTts);
  assert.equal(ttsSession.activeDurationMs, 6_000, 'overlapping TTS is part of active time, not added twice');
  assert.equal(ttsSession.ttsDurationMs, 4_000, 'TTS is retained as its own subset metric');
  assert.equal(ttsSession.chaptersCompleted, 1);

  now += 1_000;
  await engine.startSession({ bookId: 5, chapterIndex: 0, timestamp: now });
  now += 1_000;
  await engine.endSession(now - 10_000);
  const backwardSession = (await storage.getReadingSessions({ bookId: 5 }))[0];
  assert.equal(backwardSession.endedAt, backwardSession.startedAt, 'backward wall timestamp cannot create a negative duration');
  assert.equal(backwardSession.activeDurationMs, 0);

  const localDate = new Date(now);
  const nextMidnight = new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate() + 1).getTime();
  const normalIdleMs = engine.idleMs;
  const normalSplitMs = engine.sessionSplitMs;
  engine.idleMs = 40 * 60_000;
  engine.sessionSplitMs = 40 * 60_000;
  now = nextMidnight - 10 * 60_000;
  await engine.startSession({ bookId: 9, chapterIndex: 0, timestamp: now });
  now += 5 * 60_000;
  await engine.markTtsStart(now);
  now += 15 * 60_000;
  await engine.markTtsPause(now);
  now += 10 * 60_000;
  await engine.endSession(now);
  const midnightSession = (await storage.getReadingSessions({ bookId: 9 }))[0];
  assert.equal(midnightSession.dailyBuckets.length, 2, 'one session splits its contribution at local midnight');
  assert.deepEqual(midnightSession.dailyBuckets.map(bucket => bucket.activeDurationMs), [10 * 60_000, 20 * 60_000],
    '23:50 to 00:20 splits active time into ten and twenty minutes');
  assert.deepEqual(midnightSession.dailyBuckets.map(bucket => bucket.ttsDurationMs), [5 * 60_000, 10 * 60_000],
    'TTS time is split at the same local midnight and remains a subset');
  engine.idleMs = normalIdleMs;
  engine.sessionSplitMs = normalSplitMs;
  assert.equal((await engine.getDailyStats({ bookId: 9 })).length, 2);
  assert.equal(typeof (await engine.getDailyStats(midnightSession.dailyBuckets[0].date)).activeDurationMs, 'number',
    'single-day stats accept a local date key');

  // Activity after a long idle closes the old record at the idle boundary and starts a fresh one.
  now += 1_000;
  const idleId = await engine.startSession({ bookId: 4, chapterIndex: 0, timestamp: now });
  const lastActiveAt = now;
  now += 31 * 60_000;
  assert.equal(await engine.markActivity({ timestamp: now, chapterIndex: 1 }), true);
  const idleRows = await storage.getReadingSessions({ bookId: 4 });
  assert.equal(idleRows.length, 2);
  assert.equal(idleRows.find(row => row.id === idleId).endedAt, lastActiveAt + 60_000);
  assert.equal(idleRows.filter(row => row.endedAt === null).length, 1);

  const idSwitchA = await engine.startSession({ bookId: 1, chapterIndex: 0, timestamp: now });
  now += 2_000;
  const idB = await engine.startSession({ bookId: 2, chapterIndex: 3, timestamp: now });
  assert.notEqual(idSwitchA, idB);
  const afterSwitch = await storage.getReadingSessions();
  assert.equal(afterSwitch.filter(row => row.endedAt === null).length, 1, 'book switch ends A before opening B');
  assert.equal(afterSwitch.find(row => row.id === idSwitchA).endedAt, now);

  now += READING_HISTORY_FLUSH_MS + 1;
  for (const callback of timerCallbacks.values()) callback();
  await new Promise(resolve => setImmediate(resolve));
  const checkpointB = (await storage.getReadingSessions({ bookId: 2 }))[0];
  assert.equal(checkpointB.safeCheckpointAt, now, 'periodic flush advances safe checkpoint');

  now += 500;
  engine.markChapterLeave(3, now);
  await engine.flushSession(now);
  const chapterFlush = (await storage.getReadingSessions({ bookId: 2 }))[0];
  assert.equal(chapterFlush.endChapterIndex, 3, 'chapter boundary flush persists chapter range');

  // Simulate a process death after the last persisted checkpoint and an overnight gap.
  const crashCheckpoint = chapterFlush.safeCheckpointAt;
  const crashActivity = chapterFlush.lastActivityAt;
  now += 12 * 60 * 60 * 1000;
  const recoveredEngine = new ReadingHistoryEngine({
    storage: {
      putReadingSession: storage.putReadingSession,
      getReadingSessions: storage.getReadingSessions,
      getUnfinishedReadingSessions: storage.getUnfinishedReadingSessions
    }, now: () => now, setInterval: () => 99, clearInterval: () => {}
  });
  assert.equal(await recoveredEngine.recoverUnfinishedSessions(now), 1);
  const recovered = (await storage.getReadingSessions({ bookId: 2 }))[0];
  assert.equal(recovered.endedAt, Math.min(crashCheckpoint, crashActivity + 60_000), 'recovery closes at safe activity time, never at reopen');
  assert.ok(recovered.endedAt < now, 'overnight/offline gap is not counted');
  await database.readingSessions.put({ id: 'bad-unfinished', bookId: 'invalid', startedAt: 'not-a-time', endedAt: null });
  const malformedRecovery = new ReadingHistoryEngine({
    storage: { putReadingSession: storage.putReadingSession, getReadingSessions: storage.getReadingSessions,
      getUnfinishedReadingSessions: storage.getUnfinishedReadingSessions },
    now: () => now, setInterval: () => 100, clearInterval: () => {}
  });
  assert.equal(await malformedRecovery.recoverUnfinishedSessions(now), 0, 'malformed unfinished rows are skipped safely');
  assert.equal((await database.readingSessions.get('bad-unfinished')).endedAt, null);
  malformedRecovery.destroy();

  // Write failures remain contained, retain an in-memory snapshot, and can retry.
  let shouldFail = true;
  const memoryRows = new Map();
  const resilient = new ReadingHistoryEngine({
    storage: {
      async putReadingSession(row) { if (shouldFail) throw new Error('simulated quota failure'); memoryRows.set(row.id, { ...row }); },
      async getReadingSessions() { return [...memoryRows.values()]; },
      async getUnfinishedReadingSessions() { return [...memoryRows.values()].filter(row => row.endedAt === null); }
    }, now: () => now, setInterval: () => 100, clearInterval: () => {}
  });
  const failId = await resilient.startSession({ bookId: 7, chapterIndex: 0, timestamp: now });
  assert.ok(failId, 'start returns while storage is unavailable');
  assert.equal(resilient.session.bookId, 7, 'in-memory state survives storage failure');
  shouldFail = false;
  await resilient.flushSession(now + 10);
  assert.equal(memoryRows.size, 1, 'a later checkpoint retries the same stable session ID');
  assert.ok(warnings.some(args => String(args[0]).includes('storage write')));

  // Backup old-file compatibility, replace, append ID remapping, and book cleanup.
  await database.books.bulkAdd([{ id: 1, title: 'Book one' }, { id: 2, title: 'Book two' }]);
  await database.chapters.bulkAdd([{ id: 1, bookId: 1, chapterIndex: 0 }, { id: 2, bookId: 2, chapterIndex: 3 }]);
  const backupOld = { version: 4, books: [{ id: 10, title: 'Old' }], chapters: [{ id: 10, bookId: 10, chapterIndex: 0, content: 'Old chapter' }] };
  await storage.importDatabase(backupOld, true);
  assert.equal((await database.readingSessions.toArray()).length, 0, 'old backups without history import successfully');

  const exportNow = await storage.exportDatabase();
  assert.equal(exportNow.version, 5);
  assert.ok(Array.isArray(exportNow.readingSessions));
  const fixtureHourlyActive = Array(24).fill(0);
  const fixtureHourlyTts = Array(24).fill(0);
  fixtureHourlyActive[9] = 100;
  fixtureHourlyTts[9] = 40;
  const sessionFixture = {
    id: 'backup-session-1', bookId: 10, startedAt: 100, endedAt: 200,
    activeDurationMs: 100, ttsDurationMs: 40, startChapterIndex: 0,
    endChapterIndex: 0, wordsReadEstimate: 12, chaptersCompleted: 0, completedChapterIndexes: [],
    safeCheckpointAt: 200, lastActivityAt: 200,
    dailyBuckets: [{ date: '1970-01-01', activeDurationMs: 100, ttsDurationMs: 40, wordsReadEstimate: 12, chaptersCompleted: 0 }],
    hourlyBuckets: [{ date: '1970-01-01', activeDurationMs: fixtureHourlyActive, ttsDurationMs: fixtureHourlyTts }]
  };
  const fullBackup = { ...backupOld, readingSessions: [sessionFixture] };
  await storage.importDatabase(fullBackup, true);
  assert.deepEqual(await database.readingSessions.toArray(), [sessionFixture]);
  database.readingSessionReads = { full: 0, indexed: 0 };
  assert.equal((await storage.getReadingSessions({ limit: 1 })).length, 1);
  assert.deepEqual(database.readingSessionReads, { full: 0, indexed: 1 },
    'small newest-session queries use the startedAt index instead of reading the whole store');
  const booksBeforeOrphanSession = await database.books.toArray();
  await assert.rejects(storage.importDatabase({ ...fullBackup, readingSessions: [{ ...sessionFixture, bookId: 999 }] }, false), /book|sách/i);
  assert.deepEqual(await database.books.toArray(), booksBeforeOrphanSession, 'orphan history rejects before importing books');
  await assert.rejects(storage.importDatabase({ ...fullBackup, readingSessions: [{ ...sessionFixture, activeDurationMs: -1 }] }, false), /thời lượng|duration/i);
  assert.deepEqual(await database.books.toArray(), booksBeforeOrphanSession, 'malformed history rejects before mutating backup data');
  await storage.importDatabase(fullBackup, false);
  const appended = await database.readingSessions.toArray();
  assert.equal(appended.length, 2);
  assert.notEqual(appended[1].id, sessionFixture.id, 'append assigns a new session ID');
  assert.notEqual(appended[1].bookId, 10, 'append remaps session bookId');
  assert.ok((await database.books.toArray()).some(book => book.id === appended[1].bookId));

  await storage.deleteBook(appended[1].bookId);
  assert.equal((await database.readingSessions.toArray()).some(row => row.bookId === appended[1].bookId), false,
    'deleting a book cascades its reading sessions');
  assert.equal(await storage.deleteReadingSession('backup-session-1'), true);
  assert.equal(await storage.deleteReadingSession('backup-session-1'), false, 'deleting an absent session is a no-op');
  await storage.putReadingSession({ ...sessionFixture, id: 'clear-test-session' });
  await database.books.update(10, { currentChapterIndex: 0, currentChunkIndex: 4, scrollY: 200 });
  await database.bookmarks.add({ bookId: 10, chapterIndex: 0, paragraphIndex: 0 });
  await database.highlights.add({ bookId: 10, chapterIndex: 0, paragraphIndex: 0, text: 'keep me' });
  await database.settings.put({ key: 'ttsEnabled', value: true });
  assert.equal(await storage.clearReadingHistory(), true);
  assert.equal((await database.readingSessions.toArray()).length, 0);
  assert.equal((await database.books.get(10)).currentChunkIndex, 4);
  assert.equal((await database.bookmarks.toArray()).length, 1);
  assert.equal((await database.highlights.toArray()).length, 1);
  assert.equal((await database.settings.get('ttsEnabled')).value, true);

  // Query ranges use local calendar dates (inclusive), and aggregation never adds TTS to active time.
  const calendarNow = new Date(2026, 2, 2, 12, 0, 0).getTime();
  const calendarKey = offset => {
    const date = new Date(calendarNow);
    date.setDate(date.getDate() + offset);
    return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  assert.deepEqual(getLocalCalendarRange('today', calendarNow), { from: calendarKey(0), to: calendarKey(0) });
  assert.deepEqual(getLocalCalendarRange('7days', calendarNow), { from: calendarKey(-6), to: calendarKey(0) });
  assert.deepEqual(getLocalCalendarRange('30days', calendarNow), { from: calendarKey(-29), to: calendarKey(0) });
  const metricRows = [
    { id: 'a', bookId: 10, startedAt: calendarNow, activeDurationMs: 300, dailyBuckets: [
      { date: calendarKey(0), activeDurationMs: 300, ttsDurationMs: 250, wordsReadEstimate: 30, chaptersCompleted: 1 },
      { date: calendarKey(-1), activeDurationMs: 100, ttsDurationMs: 50, wordsReadEstimate: 10, chaptersCompleted: 0 }
    ] },
    { id: 'b', bookId: 11, startedAt: calendarNow - 10, activeDurationMs: 400, dailyBuckets: [
      { date: calendarKey(0), activeDurationMs: 400, ttsDurationMs: 100, wordsReadEstimate: 20, chaptersCompleted: 2 }
    ] },
    { id: 'c', bookId: 12, startedAt: calendarNow - 8 * 86_400_000, activeDurationMs: 50, dailyBuckets: [
      { date: calendarKey(-7), activeDurationMs: 50, ttsDurationMs: 50, wordsReadEstimate: 5, chaptersCompleted: 1 }
    ] },
    { id: 'd', bookId: 13, startedAt: calendarNow - 29 * 86_400_000, activeDurationMs: 60, dailyBuckets: [
      { date: calendarKey(-29), activeDurationMs: 60, ttsDurationMs: 60, wordsReadEstimate: 6, chaptersCompleted: 1 }
    ] },
    { id: 'malformed', bookId: 14, startedAt: calendarNow + 10, activeDurationMs: 100, dailyBuckets: [
      { date: '2026-99-99', activeDurationMs: 'broken', ttsDurationMs: 900, wordsReadEstimate: -1, chaptersCompleted: NaN }
    ] }
  ];
  const protectedData = { books: [{ id: 1 }], progress: [{ bookId: 1, currentChapterIndex: 4 }],
    bookmarks: [{ id: 1, bookId: 1 }], highlights: [{ id: 1, bookId: 1 }], settings: [{ key: 'tts', value: true }] };
  const metricStore = {
    async getReadingSessions({ bookId } = {}) { return metricRows.filter(row => bookId === undefined || row.bookId === bookId).map(row => ({ ...row })); },
    async getUnfinishedReadingSessions() { return metricRows.filter(row => row.endedAt === null); },
    async putReadingSession(row) { const index = metricRows.findIndex(item => item.id === row.id); if (index < 0) metricRows.push({ ...row }); else metricRows[index] = { ...row }; },
    async deleteReadingSession(id) { const index = metricRows.findIndex(row => row.id === id); if (index < 0) return false; metricRows.splice(index, 1); return true; },
    async clearReadingHistory() { metricRows.splice(0); }
  };
  const metricEngine = new ReadingHistoryEngine({ storage: metricStore, now: () => calendarNow });
  const todayStats = await metricEngine.getRangeStats({ period: 'today' });
  assert.equal(todayStats.activeDurationMs, 700);
  assert.equal(todayStats.ttsDurationMs, 350);
  assert.equal(todayStats.wordsReadEstimate, 50);
  assert.equal(todayStats.chaptersCompleted, 3);
  assert.equal(todayStats.distinctBooks, 2);
  assert.equal((await metricEngine.getRangeStats({ period: '7days' })).distinctBooks, 2,
    '7-day range excludes the session on day eight');
  assert.equal((await metricEngine.getRangeStats({ period: '30days' })).distinctBooks, 4,
    '30-day range includes its first local calendar day');
  assert.equal((await metricEngine.getDailyStats(calendarKey(0))).activeDurationMs, 700);
  const groups = await metricEngine.getTimelineGroups();
  assert.equal(groups[0].label, 'Hôm nay');
  assert.deepEqual(groups[0].sessions.map(row => row.id), ['a', 'b'], 'timeline is newest day and newest session first');
  assert.deepEqual((await metricEngine.getBookHistory(11)).map(row => row.id), ['b']);
  assert.equal(await metricEngine.deleteHistorySession('b'), true);
  assert.equal(metricRows.some(row => row.id === 'b'), false, 'delete-one removes just the chosen history row');
  const protectedBeforeClear = JSON.parse(JSON.stringify(protectedData));
  await metricEngine.clearReadingHistory();
  assert.equal(metricRows.length, 0, 'clear-history removes all session data');
  assert.deepEqual(protectedData, protectedBeforeClear, 'clear-history leaves books, progress, bookmarks, highlights and settings untouched');
  await metricEngine.startSession({ bookId: 14, timestamp: calendarNow });
  await metricEngine.clearReadingHistory();
  assert.equal(await metricEngine.markActivity({ timestamp: calendarNow + 1_000 }), false,
    'clearing an active record prevents later activity from recreating it');
  assert.equal(metricRows.length, 0);
  metricEngine.destroy();

  // A long continuous session retains compact daily state and uses one 15s timer, not per-scroll writes.
  let perfNow = new Date(2026, 0, 1, 10).getTime();
  let perfWrites = 0;
  let perfTimers = 0;
  const perfRows = new Map();
  const perfEngine = new ReadingHistoryEngine({
    storage: {
      async putReadingSession(row) { perfWrites++; perfRows.set(row.id, { ...row }); },
      async getReadingSessions() { return [...perfRows.values()]; },
      async getUnfinishedReadingSessions() { return [...perfRows.values()].filter(row => row.endedAt === null); },
      async deleteReadingSession(id) { return perfRows.delete(id); },
      async clearReadingHistory() { perfRows.clear(); }
    },
    now: () => perfNow,
    setInterval: () => { perfTimers++; return perfTimers; },
    clearInterval: () => { perfTimers--; }
  });
  await perfEngine.startSession({ bookId: 20, timestamp: perfNow });
  assert.equal(perfWrites, 1, 'session start writes one checkpoint');
  assert.equal(perfTimers, 1, 'one flush timer is active for the engine');
  await perfEngine.markActivity({ timestamp: perfNow + 100 });
  assert.equal(perfWrites, 1, 'activity signal does not write to IndexedDB per interaction');
  await perfEngine.markTtsStart(perfNow + 100);
  perfNow += READING_HISTORY_FLUSH_MS;
  await perfEngine.flushSession(perfNow);
  assert.equal(perfWrites, 2, 'checkpoint writes follow the 15 second cadence');
  perfNow += 31 * 24 * 60 * 60_000;
  await perfEngine.flushSession(perfNow);
  assert.ok(perfEngine.session.dailyBuckets.length <= 32, 'month-long session keeps one bucket per local day');
  assert.ok(Buffer.byteLength(JSON.stringify(perfEngine.session), 'utf8') < 20_000,
    'month-long session snapshot remains compact');
  await perfEngine.endSession(perfNow);
  assert.equal(perfTimers, 0, 'ending the session cleans up its periodic timer');
  assert.equal(perfWrites, 4, 'writes are limited to start, scheduled checkpoints, and end');
  perfEngine.destroy();

  const failureStorage = new ReadingHistoryEngine({
    storage: {
      async putReadingSession() { throw new Error('offline'); },
      async getReadingSessions() { throw new Error('offline'); },
      async getUnfinishedReadingSessions() { throw new Error('offline'); }
    }, now: () => now, setInterval: () => 101, clearInterval: () => {}
  });
  assert.equal(await failureStorage.recoverUnfinishedSessions(), 0, 'recovery read failure is graceful');
  assert.deepEqual(await failureStorage.getHistory(), [], 'query failure is graceful');

  const signalRows = new Map();
  let signalNow = 2_000_000_000_000;
  let signalTimerId = 0;
  let activeSignalTimers = 0;
  const signalEngine = new ReadingHistoryEngine({
    storage: {
      async putReadingSession(row) { signalRows.set(row.id, { ...row }); },
      async getReadingSessions() { return [...signalRows.values()]; },
      async getUnfinishedReadingSessions() { return [...signalRows.values()].filter(row => row.endedAt === null); }
    },
    now: () => signalNow,
    idleMs: 1_000,
    sessionSplitMs: 5_000,
    setInterval: () => { activeSignalTimers++; return ++signalTimerId; },
    clearInterval: () => { activeSignalTimers--; }
  });
  await signalEngine.startSession({ bookId: 31, chapterIndex: 0, timestamp: signalNow });
  signalNow += 500;
  await signalEngine.markActivity({ timestamp: signalNow, chapterIndex: 0 });
  signalNow += 500;
  await signalEngine.flushSession(signalNow);
  assert.equal(signalEngine.session.activeDurationMs, 1_000, 'active Reader time accrues before idle grace expires');
  signalNow += 1_500;
  await signalEngine.flushSession(signalNow);
  assert.equal(signalEngine.session.activeDurationMs, 1_500, 'idle time stops accruing after the grace threshold');
  signalNow += 4_000;
  await signalEngine.markActivity({ timestamp: signalNow, chapterIndex: 1 });
  const longIdleRows = [...signalRows.values()].filter(row => row.bookId === 31);
  assert.equal(longIdleRows.length, 2, 'activity after long idle closes the old session and starts a new one');
  assert.ok(longIdleRows[0].endedAt !== null);
  assert.equal(longIdleRows[1].endedAt, null);

  await signalEngine.endSession(signalNow);
  assert.equal(activeSignalTimers, 0, 'flush timer is cleaned up when Reader closes');
  signalNow += 10_000;
  await signalEngine.startSession({ bookId: 32, chapterIndex: 0, timestamp: signalNow });
  signalNow += 100;
  await signalEngine.setAutoScrollState({ isActive: true, isPaused: false, timestamp: signalNow });
  signalNow += 30 * 60_000;
  await signalEngine.markTtsStart(signalNow);
  signalNow += 30 * 60_000;
  await signalEngine.markTtsPause(signalNow);
  await signalEngine.flushSession(signalNow);
  assert.equal(signalEngine.session.activeDurationMs, 60 * 60_000 + 100, '60 minutes of foreground AutoScroll with 30 minutes of TTS does not double-count');
  assert.equal(signalEngine.session.ttsDurationMs, 30 * 60_000, 'TTS duration is a subset of active time');
  await signalEngine.setVisibility(false, signalNow);
  signalNow += 10_000;
  await signalEngine.flushSession(signalNow);
  const beforeBackgroundTts = [...signalRows.values()].filter(row => row.bookId === 32).at(-1);
  assert.equal(beforeBackgroundTts.activeDurationMs, 60 * 60_000 + 100, 'hidden AutoScroll does not add eye-reading time');
  assert.equal(signalEngine.session, null, 'long hidden idle ends the session at its idle boundary');
  assert.equal(activeSignalTimers, 0, 'flush timer is cleaned up when long idle ends a session');
  await signalEngine.markTtsStart(signalNow);
  signalNow += 3_000;
  await signalEngine.flushSession(signalNow);
  assert.equal(signalEngine.session.activeDurationMs, 3_000, 'actual TTS starts a fresh session and remains active while hidden');
  assert.equal(signalEngine.session.ttsDurationMs, 3_000);
  await signalEngine.markTtsPause(signalNow);
  signalNow += 2_000;
  await signalEngine.flushSession(signalNow);
  assert.equal(signalEngine.session.activeDurationMs, 3_000, 'hidden eye-reading remains stopped after TTS pauses');

  await signalEngine.endSession(signalNow);
  assert.equal(activeSignalTimers, 0, 'new-session flush timer is cleaned up on Reader close');

  const progressRows = new Map();
  let progressWriteCount = 0;
  const progressEngine = new ReadingHistoryEngine({
    storage: {
      async putReadingSession(row) { progressWriteCount++; progressRows.set(row.id, { ...row }); },
      async getReadingSessions() { return [...progressRows.values()]; },
      async getUnfinishedReadingSessions() { return []; }
    },
    now: () => signalNow,
    setInterval: () => 303,
    clearInterval: () => {}
  });
  await progressEngine.startSession({ bookId: 33, chapterIndex: 0, timestamp: signalNow });
  const initialProgressWriteCount = progressWriteCount;
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 0, position: 1_000, totalWords: 10_000, explicitJump: true }).creditedWords, 0);
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 0, position: 6_000, totalWords: 10_000 }).creditedWords, 5_000,
    'forward movement estimates only the newly covered words');
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 0, position: 3_000, totalWords: 10_000 }).creditedWords, 0,
    'backward movement never subtracts words');
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 0, position: 6_000, totalWords: 10_000 }).creditedWords, 0,
    'revisiting covered content does not inflate the estimate');
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 0, position: 8_000, totalWords: 10_000 }).creditedWords, 2_000);
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 0, position: 9_500, totalWords: 10_000, explicitJump: true }).creditedWords, 0,
    'explicit Search/Bookmark jumps rebase without crediting skipped words');
  progressEngine.recordChapterProgress({ chapterIndex: 0, position: 9_600, totalWords: 10_000 });
  assert.equal(progressEngine.isChapterNearEnd(0), false, 'a tiny move after a jump alone is not near-end evidence');
  progressEngine.recordChapterProgress({ chapterIndex: 0, position: 9_800, totalWords: 10_000 });
  assert.equal(progressEngine.isChapterNearEnd(0), true, 'continuous progress through the final part marks near-end');
  assert.equal(progressEngine.markChapterCompleted(0, signalNow), true, 'near-end followed by Next can count completion');
  assert.equal(progressEngine.markChapterCompleted(0, signalNow), false, 'TTS/AutoScroll/Next completion signals deduplicate per chapter');
  assert.equal(progressEngine.session.chaptersCompleted, 1);
  assert.equal(progressWriteCount, initialProgressWriteCount, 'scroll/TTS progress and completion update memory without writing IndexedDB per signal');

  progressEngine.recordChapterProgress({ chapterIndex: 5, position: 1_000, totalWords: 10_000, explicitJump: true });
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 5, position: 1_100, totalWords: 10_000 }).creditedWords, 100);
  progressEngine.recordChapterProgress({ chapterIndex: 5, position: 5_000, totalWords: 10_000, explicitJump: true });
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 5, position: 5_050, totalWords: 10_000 }).creditedWords, 50,
    'TTS seek forward credits only the chunk range actually completed');
  progressEngine.recordChapterProgress({ chapterIndex: 5, position: 1_000, totalWords: 10_000, explicitJump: true });
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 5, position: 1_100, totalWords: 10_000 }).creditedWords, 0,
    'TTS seek backward and replay do not count the already covered range again');

  progressEngine.markChapterEnter(3, signalNow);
  progressEngine.markChapterEnter(1, signalNow);
  assert.equal(progressEngine.session.startChapterIndex, 0);
  assert.equal(progressEngine.session.endChapterIndex, 1, 'chapter range records its first chapter and latest chapter after backward navigation');
  assert.ok(Number.isFinite(progressEngine.session.wordsReadEstimate) && progressEngine.session.wordsReadEstimate >= 0);
  assert.ok(progressEngine.session.dailyBuckets.every(bucket => Number.isFinite(bucket.wordsReadEstimate) && bucket.wordsReadEstimate >= 0));
  assert.equal(progressEngine.isChapterNearEnd(1), false, 'opening another chapter does not mark it complete');
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 1, position: NaN, totalWords: 100 }), false);
  assert.equal(progressEngine.recordChapterProgress({ chapterIndex: 1, position: 10, totalWords: Infinity }), false);
  assert.equal(progressEngine.markChapterCompleted(1, signalNow), true, 'natural final TTS/AutoScroll evidence may complete a chapter without near-end navigation');
  await progressEngine.endSession(signalNow);
  progressEngine.destroy();

  let utterance;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const tts = new TTSEngine();
  tts.synth = { cancel() {}, speak(value) { utterance = value; } };
  tts.chunks = ['actual audio'];
  tts.isPlaying = true;
  const actualPlayback = [];
  const actualChunks = [];
  const naturalCompletions = [];
  tts.onPlaybackStateChange = (playing, timestamp) => actualPlayback.push([playing, Number.isFinite(timestamp)]);
  tts.onActualChunkStart = index => actualChunks.push(['start', index]);
  tts.onActualChunkComplete = index => actualChunks.push(['complete', index]);
  tts.onNaturalComplete = index => naturalCompletions.push(index);
  tts.speakBrowserChunk('actual audio');
  assert.deepEqual(actualPlayback, [], 'Web Speech does not count queued utterances as playback');
  utterance.onstart();
  utterance.onpause();
  tts.isPaused = false;
  utterance.onresume();
  utterance.onend();
  assert.deepEqual(actualPlayback.map(item => item[0]), [true, false, true, false], 'Web Speech reports actual start, pause, resume, and end edges');
  assert.deepEqual(actualChunks, [['start', 0], ['complete', 0]], 'natural utterance completion reports only the actually played chunk');
  assert.deepEqual(naturalCompletions, [0], 'natural final-chunk completion is distinct from error/stop status');
  assert.ok(actualPlayback.every(item => item[1]));
  assert.equal(utterance.onstart, null, 'utterance callbacks still clean up after completion');
  actualPlayback.length = 0;
  tts.currentIndex = 0;
  tts.isPlaying = true;
  tts.speakBrowserChunk('error path');
  utterance.onstart();
  utterance.onerror({ error: 'network' });
  assert.deepEqual(actualPlayback.map(item => item[0]), [true, false], 'Web Speech errors close the actual playback segment');
  assert.deepEqual(actualChunks, [['start', 0], ['complete', 0], ['start', 0]], 'errored chunks are not credited as completed');
  assert.deepEqual(naturalCompletions, [0], 'error cannot emit natural chapter completion');
  actualPlayback.length = 0;
  tts.currentIndex = 0;
  tts.isPlaying = true;
  tts.speakBrowserChunk('stop path');
  utterance.onstart();
  tts.stop();
  assert.deepEqual(actualPlayback.map(item => item[0]), [true, false], 'explicit stop closes the actual playback segment');
  assert.equal(actualChunks.at(-1)?.[0], 'start');
  assert.deepEqual(naturalCompletions, [0], 'stop cannot emit natural chapter completion');

  actualPlayback.length = 0;
  actualChunks.length = 0;
  naturalCompletions.length = 0;
  tts.chunks = ['first', 'second'];
  tts.currentIndex = 0;
  tts.isPlaying = true;
  tts.isPaused = false;
  tts.speakBrowserChunk('first');
  const firstUtterance = utterance;
  firstUtterance.onstart();
  firstUtterance.onend();
  assert.deepEqual(actualPlayback.map(item => item[0]), [true], 'sequential chunk transition keeps a continuous actual-playback segment');
  assert.deepEqual(actualChunks, [['start', 0], ['complete', 0]]);
  assert.deepEqual(naturalCompletions, []);
  await new Promise(resolve => setTimeout(resolve, 10));
  const secondUtterance = utterance;
  secondUtterance.onstart();
  assert.deepEqual(actualChunks, [['start', 0], ['complete', 0], ['start', 1]]);
  secondUtterance.onend();
  assert.deepEqual(actualPlayback.map(item => item[0]), [true, false]);
  assert.deepEqual(naturalCompletions, [1], 'only the natural final chunk completes the chapter');
  tts.stop();
  signalEngine.destroy();
  progressEngine.destroy();

  for (const instance of [engine, recoveredEngine, resilient, failureStorage]) instance.destroy();
  console.log('test_reading_history.mjs: session engine, activity/idle, TTS overlap, visibility, word coverage, jumps/seeks, chapter completion/range, and cleanup PASS');
} finally {
  console.warn = originalWarn;
}
