import assert from 'node:assert/strict';
import { createReadingAnalytics } from './readingAnalytics.js';
import { localDateKey } from './readingHistory.js';

const now = new Date(2026, 9, 7, 12, 0, 0).getTime();
const date = localDateKey(now);
let sessionQueries = 0;
let snapshotQueries = 0;
let bookQueries = 0;
const bucket = { date, activeDurationMs: 45 * 60_000, ttsDurationMs: 10 * 60_000, wordsReadEstimate: 2500, chaptersCompleted: 2 };
const analytics = createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { sessionQueries++; return [{ id: 1, bookId: 4, startedAt: now - 45 * 60_000, endedAt: now, dailyBuckets: [bucket], hourlyBuckets: [] }]; },
  async getSessionSnapshot() { snapshotQueries++; return null; },
  async getAllBooks() { bookQueries++; return [{ id: 4, title: 'Truyện dài' }]; }
});
const result = await analytics.getDashboardData('7days', { now });
assert.equal(sessionQueries, 1, 'dashboard loads persisted sessions once');
assert.equal(snapshotQueries, 1, 'dashboard reads the in-memory snapshot once');
assert.equal(bookQueries, 1, 'dashboard resolves book titles once');
assert.equal(result.totals.activeDurationMs, 45 * 60_000);
assert.equal(result.totals.ttsDurationMs, 10 * 60_000);
assert.equal(result.totals.booksActive, 1);
assert.equal(result.lifetime.totals.wordsReadEstimate, 2500);
assert.equal(result.comparison.metrics.activeDurationMs.current, 45 * 60_000);
assert.equal(result.comparisons.sevenDay.metrics.activeDurationMs.current, 45 * 60_000);
assert.equal(result.comparisons.thirtyDay.metrics.activeDurationMs.current, 45 * 60_000);
assert.equal(result.heatmap.cells.length, 365);
assert.equal(result.heatmap.weeks.flat().filter(Boolean).length, 365);
assert.ok(result.heatmap.monthMarks.length >= 12);
assert.equal(result.streaks.current.days, 1, 'activity above the active-day threshold contributes to current streak');
assert.equal(result.trends.sevenDay.dailyActivity.length, 7);
assert.equal(result.trends.thirtyDay.dailyActivity.length, 30);
assert.equal(result.insights.topBooks[0].title, 'Truyện dài');
console.log('test_reading_analytics_dashboard.mjs: one-load dashboard result, heatmap layout, trends, and derived sections PASS');
