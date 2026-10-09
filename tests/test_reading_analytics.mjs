import assert from 'node:assert/strict';
import { createReadingAnalytics } from './readingAnalytics.js';
import { ReadingHistoryEngine } from './readingHistory.js';

const now = new Date(2026, 2, 2, 12, 0, 0).getTime();
const dayKey = offset => {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const bucket = (date, active, tts, words, chapters) => ({
  date, activeDurationMs: active, ttsDurationMs: tts,
  wordsReadEstimate: words, chaptersCompleted: chapters
});

const persisted = [
  { id: 'same', bookId: 1, startedAt: now - 1000, endedAt: now, dailyBuckets: [bucket(dayKey(0), 999, 900, 90, 9)] },
  { id: 'today-b', bookId: 2, startedAt: now - 2000, endedAt: now, dailyBuckets: [bucket(dayKey(0), 30, 15, 5, 1)] },
  { id: 'week-edge', bookId: 3, startedAt: now - 3_000, endedAt: now, dailyBuckets: [bucket(dayKey(-6), 70, 40, 7, 2)] },
  { id: 'outside-week', bookId: 4, startedAt: now - 4_000, endedAt: now, dailyBuckets: [bucket(dayKey(-7), 80, 10, 8, 1)] },
  { id: 'month-edge', bookId: 5, startedAt: now - 5_000, endedAt: now, dailyBuckets: [bucket(dayKey(-29), 90, 20, 9, 1)] },
  { id: 'outside-month', bookId: 6, startedAt: now - 6_000, endedAt: now, dailyBuckets: [bucket(dayKey(-30), 100, 10, 10, 1)] },
  { id: 'bad-time', bookId: 7, startedAt: NaN, endedAt: now, dailyBuckets: [bucket(dayKey(0), 1_000, 0, 1, 0)] },
  { id: 'bad-order', bookId: 8, startedAt: now, endedAt: now - 1, dailyBuckets: [bucket(dayKey(0), 1_000, 0, 1, 0)] },
  { id: 'bad-book', bookId: -2, startedAt: now, endedAt: now, dailyBuckets: [bucket(dayKey(0), 1_000, 0, 1, 0)] },
  { id: 'bad-session-duration', bookId: 12, startedAt: now, endedAt: now, activeDurationMs: -1,
    dailyBuckets: [bucket(dayKey(0), 1_000, 0, 1, 0)] },
  { id: 'bad-metrics', bookId: 9, startedAt: now, endedAt: now, dailyBuckets: [
    bucket(dayKey(0), -1, Infinity, NaN, -4),
    bucket('2026-99-99', 100, 10, 10, 1)
  ] }
];

let sessionQueries = 0;
let snapshotQueries = 0;
let currentSnapshot = {
  id: 'same', bookId: 1, startedAt: now - 1000, endedAt: null,
  dailyBuckets: [bucket(dayKey(0), 100, 40, 10, 1)]
};
const analytics = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { sessionQueries++; return persisted; },
  async getSessionSnapshot() { snapshotQueries++; return currentSnapshot; }
});

const today = await analytics.getStatsForRange('today');
assert.deepEqual(today.range, { preset: 'today', from: dayKey(0), to: dayKey(0), allTime: false });
assert.deepEqual(today.totals, {
  activeDurationMs: 130, ttsDurationMs: 55, wordsReadEstimate: 15,
  chaptersCompleted: 2, booksActive: 2
});
assert.equal(today.dailyActivity.length, 1);
assert.deepEqual(today.dailyActivity[0], {
  date: dayKey(0), activeDurationMs: 130, ttsDurationMs: 55,
  wordsReadEstimate: 15, chaptersCompleted: 2, booksActive: 2
});
assert.equal(sessionQueries, 1, 'all current-range KPIs use one persisted-session query');
assert.equal(snapshotQueries, 1, 'active session is added from one safe memory snapshot');

const sevenDays = await analytics.getStatsForRange('7days');
assert.equal(sevenDays.dailyActivity.length, 7, '7-day range contains today and six prior local dates');
assert.equal(sevenDays.dailyActivity[0].date, dayKey(-6));
assert.equal(sevenDays.dailyActivity.at(-1).date, dayKey(0));
assert.equal(sevenDays.totals.activeDurationMs, 200);
assert.equal(sevenDays.totals.booksActive, 3);

const thirtyDays = await analytics.getStatsForRange('30days');
assert.equal(thirtyDays.dailyActivity.length, 30, '30-day range contains today and 29 prior local dates');
assert.equal(thirtyDays.dailyActivity[0].date, dayKey(-29));
assert.equal(thirtyDays.totals.activeDurationMs, 370);
assert.equal(thirtyDays.totals.booksActive, 5);

const lifetime = await analytics.getLifetimeStats();
assert.equal(lifetime.range.preset, 'alltime');
assert.equal(lifetime.range.from, dayKey(-30));
assert.equal(lifetime.totals.activeDurationMs, 470);
assert.equal(lifetime.totals.ttsDurationMs, 135);
assert.equal(lifetime.totals.wordsReadEstimate, 49);
assert.equal(lifetime.totals.chaptersCompleted, 7);
assert.equal(lifetime.totals.booksActive, 6);

const emptyAnalytics = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { return []; },
  async getSessionSnapshot() { return null; }
});
const empty = await emptyAnalytics.getLifetimeStats();
assert.deepEqual(empty.totals, {
  activeDurationMs: 0, ttsDurationMs: 0, wordsReadEstimate: 0,
  chaptersCompleted: 0, booksActive: 0
});
assert.deepEqual(empty.dailyActivity, []);

const previousRows = [
  { id: 'previous', bookId: 10, startedAt: now - 10_000, endedAt: now - 9_000,
    dailyBuckets: [bucket(dayKey(-7), 100, 20, 10, 1)] }
];
const comparisonAnalytics = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { return [...persisted, ...previousRows]; },
  async getSessionSnapshot() { return currentSnapshot; }
});
const comparison = await comparisonAnalytics.comparePeriods('7days');
assert.equal(comparison.comparison.previousRange.from, dayKey(-13));
assert.equal(comparison.comparison.previousRange.to, dayKey(-7));
assert.equal(comparison.comparison.metrics.activeDurationMs.current, 200);
assert.equal(comparison.comparison.metrics.activeDurationMs.previous, 180);
assert.equal(comparison.comparison.metrics.activeDurationMs.direction, 'increase');
assert.equal(comparison.comparison.metrics.activeDurationMs.percentChange, (20 / 180) * 100);
assert.equal(comparison.comparison.metrics.ttsDurationMs.direction, 'increase');
assert.equal(comparison.comparison.metrics.booksActive.direction, 'increase');

const zeroBaselineRows = [
  { id: 'current-only', bookId: 11, startedAt: now, endedAt: now,
    dailyBuckets: [bucket(dayKey(0), 12, 2, 3, 1)] }
];
const zeroBaseline = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { return zeroBaselineRows; },
  async getSessionSnapshot() { return null; }
});
const fromZero = await zeroBaseline.comparePeriods('7days');
assert.equal(fromZero.comparison.metrics.activeDurationMs.previous, 0);
assert.equal(fromZero.comparison.metrics.activeDurationMs.direction, 'increase');
assert.equal(fromZero.comparison.metrics.activeDurationMs.percentChange, null);
assert.equal(fromZero.comparison.metrics.activeDurationMs.baseline, 'zero');
assert.ok(!JSON.stringify(fromZero).includes('Infinity'));
assert.ok(!JSON.stringify(fromZero).includes('NaN'));

const equalComparison = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() {
    return [
      { id: 'equal-current', bookId: 21, startedAt: now, endedAt: now, dailyBuckets: [bucket(dayKey(0), 5, 1, 2, 0)] },
      { id: 'equal-previous', bookId: 21, startedAt: now, endedAt: now, dailyBuckets: [bucket(dayKey(-7), 5, 1, 2, 0)] }
    ];
  },
  async getSessionSnapshot() { return null; }
});
const equal = await equalComparison.comparePeriods('7days');
assert.equal(equal.comparison.metrics.activeDurationMs.direction, 'equal');
assert.equal(equal.comparison.metrics.activeDurationMs.percentChange, 0);
assert.equal(equal.comparison.metrics.chaptersCompleted.direction, 'equal', 'a zero-to-zero metric compares as neutral/equal');
assert.equal(equal.comparison.metrics.chaptersCompleted.percentChange, null);

const decreasedComparison = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() {
    return [
      { id: 'decrease-current', bookId: 22, startedAt: now, endedAt: now, dailyBuckets: [bucket(dayKey(0), 5, 0, 0, 0)] },
      { id: 'decrease-previous', bookId: 22, startedAt: now, endedAt: now, dailyBuckets: [bucket(dayKey(-7), 10, 0, 0, 0)] }
    ];
  },
  async getSessionSnapshot() { return null; }
});
const decreased = await decreasedComparison.comparePeriods('7days');
assert.equal(decreased.comparison.metrics.activeDurationMs.direction, 'decrease');
assert.equal(decreased.comparison.metrics.activeDurationMs.percentChange, -50);

const midnightRows = new Map();
const engine = new ReadingHistoryEngine({
  storage: {
    async putReadingSession(row) { midnightRows.set(row.id, { ...row }); },
    async getReadingSessions() { return [...midnightRows.values()]; },
    async getUnfinishedReadingSessions() { return []; }
  },
  now: () => now,
  setInterval: () => 1,
  clearInterval() {}
});
const midnight = new Date(now);
const midnightAt = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate()).getTime();
const startAt = midnightAt - 15 * 60_000;
await engine.startSession({ bookId: 20, chapterIndex: 0, timestamp: startAt });
await engine.markTtsStart(startAt);
await engine.endSession(midnightAt + 30 * 60_000);
const midnightAnalytics = createReadingAnalytics({
  now: () => now,
  getReadingSessions: async () => [...midnightRows.values()],
  async getSessionSnapshot() { return null; }
});
const midnightDays = await midnightAnalytics.getDailyActivity('allTime');
assert.deepEqual(midnightDays.map(day => day.activeDurationMs), [15 * 60_000, 30 * 60_000]);
assert.deepEqual(midnightDays.map(day => day.ttsDurationMs), [15 * 60_000, 30 * 60_000]);
assert.equal(midnightDays[0].date, dayKey(-1));
assert.equal(midnightDays[1].date, dayKey(0));
engine.destroy();

let snapshotWrites = 0;
const snapshotStore = new Map();
const snapshotEngine = new ReadingHistoryEngine({
  storage: {
    async putReadingSession(row) { snapshotWrites++; snapshotStore.set(row.id, { ...row }); },
    async getReadingSessions() { return [...snapshotStore.values()]; },
    async getUnfinishedReadingSessions() { return []; }
  },
  now: () => now,
  setInterval: () => 2,
  clearInterval() {}
});
await snapshotEngine.startSession({ bookId: 30, chapterIndex: 0, timestamp: now });
const beforeSnapshotWrites = snapshotWrites;
const sessionSnapshot = await snapshotEngine.getSessionSnapshot(now + 120_000);
assert.equal(sessionSnapshot.activeDurationMs, 60_000, 'the in-memory snapshot respects the Reading History idle grace');
assert.equal(snapshotWrites, beforeSnapshotWrites, 'snapshot reads do not write IndexedDB');
snapshotEngine.destroy();

console.log('test_reading_analytics.mjs: core totals, ranges, sanitation, active snapshot, midnight buckets, and comparisons PASS');
