import assert from 'node:assert/strict';
import { createReadingAnalytics } from './readingAnalytics.js';
import { ReadingHistoryEngine } from './readingHistory.js';

const now = new Date(2026, 2, 2, 12, 0, 0).getTime();
const keyFor = date => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dateAtOffset = offset => {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return date;
};
const dateKeyAtOffset = offset => keyFor(dateAtOffset(offset));
const day = (date, active, words, chapters = 0, tts = 0) => ({
  date, activeDurationMs: active, ttsDurationMs: tts,
  wordsReadEstimate: words, chaptersCompleted: chapters
});
const hourly = (date, entries) => {
  const activeDurationMs = Array(24).fill(0);
  const ttsDurationMs = Array(24).fill(0);
  for (const [hour, active] of entries) activeDurationMs[hour] = ttsDurationMs[hour] = active;
  return { date, activeDurationMs, ttsDurationMs };
};
const session = (id, bookId, buckets, extra = {}) => ({
  id, bookId, startedAt: now - 1000, endedAt: now, dailyBuckets: buckets,
  hourlyBuckets: [], ...extra
});
const analyticsFor = (rows, books = []) => createReadingAnalytics({
  now: () => now,
  async getReadingSessions() { return rows; },
  async getSessionSnapshot() { return null; },
  async getAllBooks() { return books; }
});

const speedRows = [
  session('speed-short-valid', 1, [day(dateKeyAtOffset(0), 2 * 60_000, 200)]),
  session('speed-long', 1, [day(dateKeyAtOffset(0), 120 * 60_000, 6_000, 0, 110 * 60_000)]),
  session('speed-zero-duration', 2, [day(dateKeyAtOffset(0), 0, 100)]),
  session('speed-too-short', 2, [day(dateKeyAtOffset(0), 60_000, 100)]),
  session('speed-zero-words', 3, [day(dateKeyAtOffset(0), 5 * 60_000, 0)]),
  session('speed-outlier', 4, [day(dateKeyAtOffset(0), 2 * 60_000, 8_000)]),
  session('speed-corrupt', 5, [day(dateKeyAtOffset(0), 2 * 60_000, 500)], { activeDurationMs: Infinity })
];
const speedResult = await analyticsFor(speedRows).getStatsForRange('today');
const speed = speedResult.insights.consumptionSpeed;
assert.equal(speed.available, true);
assert.equal(speed.label, 'Average Consumption Speed', 'TTS-heavy data is not labeled eye-reading speed');
assert.equal(speed.validSessions, 2);
assert.equal(speed.wordsReadEstimate, 6_200);
assert.equal(speed.activeDurationMs, 122 * 60_000);
assert.equal(speed.wordsPerMinute, 6_200 / 122);
assert.equal(speed.excludedSessions, 4, 'zero/short duration, zero-word, and extreme-rate sessions are filtered');
assert.equal(speedResult.insights.consumptionSpeed.maxAcceptedWordsPerMinute, 1_500);

const midnightRows = new Map();
const history = new ReadingHistoryEngine({
  storage: {
    async putReadingSession(row) { midnightRows.set(row.id, structuredClone(row)); },
    async getReadingSessions() { return [...midnightRows.values()]; },
    async getUnfinishedReadingSessions() { return []; }
  },
  now: () => now,
  setInterval: () => 1,
  clearInterval() {}
});
const priorDate = dateAtOffset(-1);
const start = (hour, minute) => new Date(priorDate.getFullYear(), priorDate.getMonth(), priorDate.getDate(), hour, minute).getTime();
async function playSession(at, durationMs, bookId = 10) {
  await history.startSession({ bookId, chapterIndex: 0, timestamp: at });
  await history.markTtsStart(at);
  await history.endSession(at + durationMs);
}
await playSession(start(21, 45), 45 * 60_000);
await playSession(start(23, 45), 45 * 60_000);
await playSession(start(20, 0), 150 * 60_000);
const hourlyResult = await analyticsFor([...midnightRows.values()]).getLifetimeStats();
const hours = hourlyResult.insights.hourlyActivity;
assert.equal(hours.length, 24);
assert.equal(hours[20].activeDurationMs, 60 * 60_000);
assert.equal(hours[21].activeDurationMs, 75 * 60_000, '21:45 to 22:30 contributes 15 minutes to hour 21');
assert.equal(hours[22].activeDurationMs, 60 * 60_000, 'the remainder contributes to hour 22');
assert.equal(hours[23].activeDurationMs, 15 * 60_000);
assert.equal(hours[0].activeDurationMs, 30 * 60_000, 'midnight session contributes to hour 00');
assert.ok(hours.every(row => row.ttsDurationMs <= row.activeDurationMs));
assert.equal(hourlyResult.insights.preferredReadingWindow.available, false,
  'a few sessions over two days are insufficient for a preferred window');
history.destroy();

const preferredRows = [];
for (let offset = -6; offset <= 0; offset++) {
  const date = dateKeyAtOffset(offset);
  preferredRows.push(session(`preferred-${offset}`, 30, [day(date, 60 * 60_000, 300, 1)], {
    hourlyBuckets: [hourly(date, [[21, 30 * 60_000], [22, 30 * 60_000]])]
  }));
}
const preferred = (await analyticsFor(preferredRows).getLifetimeStats()).insights.preferredReadingWindow;
assert.equal(preferred.available, true);
assert.equal(preferred.startHour, 21);
assert.equal(preferred.endHour, 23);
assert.equal(preferred.sampleDays, 7);
assert.equal(preferred.sampleSessions, 7);

const last30Offsets = [];
for (let offset = -29; offset <= 0; offset++) last30Offsets.push(offset);
const mondayOffsets = last30Offsets.filter(offset => (dateAtOffset(offset).getDay() + 6) % 7 === 0).slice(0, 2);
const tuesdayOffsets = last30Offsets.filter(offset => (dateAtOffset(offset).getDay() + 6) % 7 === 1).slice(0, 2);
const insightRows = [];
for (const [i, offset] of mondayOffsets.entries()) {
  insightRows.push(session(`monday-${i}`, 1, [day(dateKeyAtOffset(offset), 60, 10, 1)]));
}
for (const [i, offset] of tuesdayOffsets.entries()) {
  insightRows.push(session(`tuesday-${i}`, 2, [day(dateKeyAtOffset(offset), 60, 20, 1)]));
}
insightRows.push(session('top-three-monday', 3, [day(dateKeyAtOffset(mondayOffsets[0]), 161, 1, 0)]));
insightRows.push(session('top-three-tuesday', 3, [day(dateKeyAtOffset(tuesdayOffsets[0]), 161, 1, 0)]));
const insightResult = await analyticsFor(insightRows, [{ id: 1, title: 'Book One' }]).getStatsForRange('30days');
assert.equal(insightResult.insights.weekdayActivity.length, 7);
assert.equal(insightResult.insights.weekdayActivity[0].label, 'Thứ Hai');
assert.equal(insightResult.insights.mostActiveWeekday.label, 'Thứ Hai', 'weekday tie-break is Monday-first');
assert.equal(insightResult.insights.topBooks[0].bookId, 3, 'active time ranks before secondary metrics');
assert.equal(insightResult.insights.topBooks[1].bookId, 2, 'words break equal active-time ties');
assert.equal(insightResult.insights.topBooks[1].title, 'Truyện đã xóa', 'missing book metadata uses a safe fallback title');
assert.equal(insightResult.insights.topBooks[2].bookId, 1, 'multiple sessions for one book are combined');
assert.equal(insightResult.insights.topBooks[2].activeDurationMs, 120);
const tiedBestDays = [dateKeyAtOffset(mondayOffsets[0]), dateKeyAtOffset(tuesdayOffsets[0])].sort();
assert.equal(insightResult.insights.bestDay.date, tiedBestDays.at(-1), 'best-day ties select the most recent date');
assert.equal(insightResult.insights.bestDay.activeDurationMs, 221);

const noInsights = await analyticsFor([]).getStatsForRange('today');
assert.equal(noInsights.insights.consumptionSpeed.available, false);
assert.equal(noInsights.insights.preferredReadingWindow.available, false);
assert.equal(noInsights.insights.mostActiveWeekday, null);
assert.deepEqual(noInsights.insights.topBooks, []);
assert.equal(noInsights.insights.bestDay, null);

console.log('test_reading_insights.mjs: consumption speed, hourly overlap, preferred window, weekdays, top books, and best day PASS');
