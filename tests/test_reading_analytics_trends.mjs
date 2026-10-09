import assert from 'node:assert/strict';
import { createReadingAnalytics, HEATMAP_INTENSITY_THRESHOLDS_MS, STREAK_ACTIVE_DAY_THRESHOLD_MS } from './readingAnalytics.js';
import { ReadingHistoryEngine, localDateKey, shiftLocalDateKey } from './readingHistory.js';

const now = new Date(2024, 2, 1, 12, 0, 0).getTime();
const today = localDateKey(now);
const dayAt = offset => shiftLocalDateKey(today, offset);
const activity = (date, activeDurationMs, extras = {}) => ({
  date, activeDurationMs, ttsDurationMs: 0, wordsReadEstimate: 0,
  chaptersCompleted: 0, booksActive: 0, ...extras
});
const noStoreAnalytics = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { throw new Error('preaggregated data should not query sessions'); },
  async getSessionSnapshot() { return null; }
});

const heatmapDays = [
  activity('2024-02-29', 10 * 60_000, { wordsReadEstimate: 120, ttsDurationMs: 3 * 60_000, chaptersCompleted: 1, booksActive: 1 }),
  activity('2024-01-01', HEATMAP_INTENSITY_THRESHOLDS_MS.level2),
  activity('2023-12-31', HEATMAP_INTENSITY_THRESHOLDS_MS.level3),
  activity('2024-02-28', HEATMAP_INTENSITY_THRESHOLDS_MS.level4)
];
let sessionQueryCount = 0;
const heatmapAnalytics = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { sessionQueryCount++; return []; },
  async getSessionSnapshot() { return null; }
});
const heatmap = await heatmapAnalytics.getHeatmapData({ now, dailyActivity: heatmapDays });
assert.equal(sessionQueryCount, 0, 'precomputed dailyActivity avoids a second session query');
assert.equal(heatmap.cells.length, 365);
assert.equal(heatmap.cells[0].date, dayAt(-364));
assert.equal(heatmap.cells.at(-1).date, today);
assert.ok(heatmap.cells.some(cell => cell.date === '2024-02-29'), 'the default 365-day local range includes leap day');
assert.ok(heatmap.cells.some(cell => cell.date === '2023-12-31'), 'range crosses the year boundary');
const leapHeatmap = await heatmapAnalytics.getHeatmapData({ now, days: 366, dailyActivity: heatmapDays });
assert.equal(leapHeatmap.cells.length, 366);
assert.ok(leapHeatmap.cells.some(cell => cell.date === '2024-02-29'), 'expanded local range includes the leap day');
const intensityByDate = new Map(leapHeatmap.cells.map(cell => [cell.date, cell]));
assert.equal(intensityByDate.get(dayAt(-10)).intensity, 0, 'an empty local day has intensity zero');
assert.equal(intensityByDate.get('2024-02-29').intensity, 1);
assert.equal(intensityByDate.get('2024-01-01').intensity, 2, 'exactly 15 minutes enters level two');
assert.equal(intensityByDate.get('2023-12-31').intensity, 3, 'exactly 30 minutes enters level three');
assert.equal(intensityByDate.get('2024-02-28').intensity, 4, 'exactly 60 minutes enters level four');
assert.deepEqual(
  ['date', 'activeDurationMs', 'wordsReadEstimate', 'ttsDurationMs', 'chaptersCompleted', 'booksActive', 'intensity'],
  Object.keys(intensityByDate.get('2024-02-29'))
);
assert.equal(intensityByDate.get('2024-02-29').wordsReadEstimate, 120, 'cell retains tooltip/accessibility metrics');

const streakRows = [
  activity(dayAt(-5), STREAK_ACTIVE_DAY_THRESHOLD_MS),
  activity(dayAt(-4), STREAK_ACTIVE_DAY_THRESHOLD_MS - 1),
  activity(dayAt(-3), STREAK_ACTIVE_DAY_THRESHOLD_MS),
  activity(dayAt(-2), STREAK_ACTIVE_DAY_THRESHOLD_MS),
  activity(dayAt(-1), STREAK_ACTIVE_DAY_THRESHOLD_MS),
  activity(today, 0)
];
const streakAnalytics = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { return []; },
  async getSessionSnapshot() { return null; }
});
const streaks = await streakAnalytics.getStreaks({ now, dailyActivity: streakRows });
assert.equal(streaks.activeDayThresholdMs, 5 * 60_000);
assert.equal(streaks.current.days, 3, 'inactive today preserves yesterday-ending streak through today');
assert.equal(streaks.current.endDate, dayAt(-1));
assert.equal(streaks.current.countsTodayAsGrace, true);
assert.equal(streaks.longest.days, 3, 'a sub-threshold day creates a streak gap');
assert.equal(streaks.longest.startDate, dayAt(-3));
assert.equal(streaks.longest.endDate, dayAt(-1));
const todayActive = await streakAnalytics.getStreaks({
  now,
  dailyActivity: [...streakRows, activity(today, STREAK_ACTIVE_DAY_THRESHOLD_MS)]
});
assert.equal(todayActive.current.days, 4);
assert.equal(todayActive.current.endDate, today);
assert.equal(todayActive.current.countsTodayAsGrace, false);
const noCurrentStreak = await streakAnalytics.getStreaks({
  now,
  dailyActivity: [activity(dayAt(-2), STREAK_ACTIVE_DAY_THRESHOLD_MS), activity(today, 0)]
});
assert.equal(noCurrentStreak.current.days, 0, 'a gap yesterday ends the current streak');

const trendRows = [activity(dayAt(-2), 90), activity(today, 120)];
const trend = await noStoreAnalytics.getTrendData('7days', { now, dailyActivity: trendRows });
assert.equal(trend.dailyActivity.length, 7);
assert.equal(trend.dailyActivity[0].date, dayAt(-6));
assert.deepEqual(trend.dailyActivity.map(row => row.duration), [0, 0, 0, 0, 90, 0, 120]);
const monthTrend = await noStoreAnalytics.getTrendData('30days', { now, dailyActivity: trendRows });
assert.equal(monthTrend.dailyActivity.length, 30);
assert.equal(monthTrend.dailyActivity[0].date, dayAt(-29));
assert.equal(monthTrend.dailyActivity.find(row => row.date === dayAt(-2)).duration, 90);

let storedRows = [
  { id: 'mutable', bookId: 7, startedAt: now, endedAt: now,
    dailyBuckets: [{ date: today, activeDurationMs: 10 * 60_000, ttsDurationMs: 0, wordsReadEstimate: 1, chaptersCompleted: 0 }],
    hourlyBuckets: [] }
];
const mutableAnalytics = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { return storedRows; },
  async getSessionSnapshot() { return null; },
  async getAllBooks() { return []; }
});
const beforeDelete = await mutableAnalytics.getHeatmapData({ now });
assert.equal(beforeDelete.cells.at(-1).activeDurationMs, 10 * 60_000);
storedRows = [];
const afterClear = await mutableAnalytics.getHeatmapData({ now });
assert.equal(afterClear.cells.at(-1).activeDurationMs, 0, 'fresh reads observe clear/delete without an analytics cache');

const restoredRows = new Map();
const engine = new ReadingHistoryEngine({
  storage: {
    async putReadingSession(row) { restoredRows.set(row.id, structuredClone(row)); },
    async getReadingSessions() { return [...restoredRows.values()]; },
    async getUnfinishedReadingSessions() { return []; }
  },
  now: () => now,
  setInterval: () => 1,
  clearInterval() {}
});
await engine.startSession({ bookId: 50, chapterIndex: 0, timestamp: now });
assert.ok(await engine.getSessionSnapshot(now + 1000));
await engine.resetAfterRestore();
assert.equal(await engine.getSessionSnapshot(now + 2000), null, 'replace restore drops the pre-restore in-memory session');
engine.destroy();

console.log('test_reading_analytics_trends.mjs: 365-day heatmap, local calendar, streaks, trends, and invalidation PASS');
