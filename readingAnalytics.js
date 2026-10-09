import { getAllBooks, getReadingSessions } from './storage.js';
import {
  getLocalCalendarRange,
  getSessionSnapshot,
  isLocalDateKey,
  shiftLocalDateKey
} from './readingHistory.js';

const MAX_TIMESTAMP = 8.64e15;
export const MIN_CONSUMPTION_SESSION_DURATION_MS = 2 * 60_000;
export const MAX_CONSUMPTION_SPEED_WPM = 1_500;
export const PREFERRED_WINDOW_HOURS = 2;
export const MIN_PREFERRED_WINDOW_ACTIVE_DAYS = 7;
export const MIN_PREFERRED_WINDOW_ACTIVE_MS = 5 * 60 * 60_000;
export const MIN_PREFERRED_WINDOW_SESSIONS = 3;
export const MIN_WEEKDAY_SAMPLE_DAYS = 14;
export const TOP_BOOKS_LIMIT = 5;
export const HEATMAP_RANGE_DAYS = 365;
export const HEATMAP_INTENSITY_THRESHOLDS_MS = Object.freeze({
  level2: 15 * 60_000,
  level3: 30 * 60_000,
  level4: 60 * 60_000
});
export const STREAK_ACTIVE_DAY_THRESHOLD_MS = 5 * 60_000;

const TOTAL_FIELDS = [
  'activeDurationMs',
  'ttsDurationMs',
  'wordsReadEstimate',
  'chaptersCompleted'
];

function emptyTotals() {
  return {
    activeDurationMs: 0,
    ttsDurationMs: 0,
    wordsReadEstimate: 0,
    chaptersCompleted: 0,
    booksActive: 0
  };
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function safeMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0;
}

function hasActivity(bucket) {
  return bucket.activeDurationMs > 0 || bucket.wordsReadEstimate > 0 || bucket.chaptersCompleted > 0;
}

function sessionKey(id) {
  if (typeof id === 'string' && id.trim()) return `string:${id.trim()}`;
  if (Number.isSafeInteger(id) && id > 0) return `number:${id}`;
  return null;
}

function sanitizeSession(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const key = sessionKey(source.id);
  const bookId = source.bookId;
  if (!key || !Number.isSafeInteger(bookId) || bookId < 1 || !validTimestamp(source.startedAt)) return null;
  if (source.endedAt !== null && source.endedAt !== undefined
    && (!validTimestamp(source.endedAt) || source.endedAt < source.startedAt)) return null;
  if (!Array.isArray(source.dailyBuckets)) return null;
  for (const field of ['activeDurationMs', 'ttsDurationMs', 'wordsReadEstimate', 'chaptersCompleted']) {
    if (source[field] !== undefined && (typeof source[field] !== 'number'
      || !Number.isFinite(source[field]) || source[field] < 0)) return null;
  }

  const dailyBuckets = [];
  const dailyDates = new Set();
  for (const bucket of source.dailyBuckets) {
    if (!bucket || typeof bucket !== 'object' || !isLocalDateKey(bucket.date)) continue;
    if (dailyDates.has(bucket.date)) continue;
    dailyDates.add(bucket.date);
    const activeDurationMs = safeMetric(bucket.activeDurationMs);
    const ttsDurationMs = Math.min(activeDurationMs, safeMetric(bucket.ttsDurationMs));
    dailyBuckets.push({
      date: bucket.date,
      activeDurationMs,
      ttsDurationMs,
      wordsReadEstimate: safeMetric(bucket.wordsReadEstimate),
      chaptersCompleted: safeMetric(bucket.chaptersCompleted)
    });
  }

  const hourlyBuckets = [];
  const hourlyDates = new Set();
  for (const bucket of Array.isArray(source.hourlyBuckets) ? source.hourlyBuckets : []) {
    if (!bucket || typeof bucket !== 'object' || !isLocalDateKey(bucket.date)
      || hourlyDates.has(bucket.date) || !Array.isArray(bucket.activeDurationMs)
      || bucket.activeDurationMs.length !== 24 || !Array.isArray(bucket.ttsDurationMs)
      || bucket.ttsDurationMs.length !== 24) continue;
    hourlyDates.add(bucket.date);
    const activeDurationMs = bucket.activeDurationMs.map(safeMetric);
    hourlyBuckets.push({
      date: bucket.date,
      activeDurationMs,
      ttsDurationMs: bucket.ttsDurationMs.map((value, hour) => Math.min(activeDurationMs[hour], safeMetric(value)))
    });
  }

  return { key, id: source.id, bookId, startedAt: source.startedAt, dailyBuckets, hourlyBuckets };
}

function mergeSessionRows(persisted, current) {
  const byId = new Map();
  for (const row of Array.isArray(persisted) ? persisted : []) {
    const sanitized = sanitizeSession(row);
    if (sanitized) byId.set(sanitized.key, sanitized);
  }
  const snapshot = sanitizeSession(current);
  if (snapshot) byId.set(snapshot.key, snapshot);
  return [...byId.values()];
}

function parseRangeInput(input = 'today') {
  if (typeof input === 'string' || Number.isSafeInteger(input)) return { preset: input };
  if (input && typeof input === 'object') return { ...input };
  return { preset: 'today' };
}

function resolveRange(input, now, firstActivityDate = null) {
  const options = parseRangeInput(input);
  const preset = options.preset ?? options.period ?? options.days;
  if (preset !== undefined) {
    const calendar = getLocalCalendarRange(preset, now);
    if (!calendar) return null;
    const from = calendar.from ?? firstActivityDate;
    return {
      preset: String(preset).toLowerCase(),
      from,
      to: calendar.to,
      allTime: calendar.from === null
    };
  }

  const from = options.from ?? null;
  const to = options.to ?? getLocalCalendarRange('today', now).to;
  if ((from !== null && !isLocalDateKey(from)) || !isLocalDateKey(to) || (from && from > to)) return null;
  return { preset: 'custom', from, to, allTime: from === null };
}

function firstDateIn(sessions) {
  let first = null;
  for (const session of sessions) for (const bucket of session.dailyBuckets) {
    if (!first || bucket.date < first) first = bucket.date;
  }
  return first;
}

function emptyDailyRow(date) {
  return {
    date,
    activeDurationMs: 0,
    ttsDurationMs: 0,
    wordsReadEstimate: 0,
    chaptersCompleted: 0,
    booksActive: 0,
    _bookIds: new Set()
  };
}

function weekdayIndex(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return (new Date(year, month - 1, day).getDay() + 6) % 7;
}

function hourLabel(hour) {
  return String(hour).padStart(2, '0');
}

function makeHourlyActivity() {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: hourLabel(hour),
    activeDurationMs: 0,
    ttsDurationMs: 0
  }));
}

function buildPreferredWindow(hourlyActivity, sampleDays, sampleSessions) {
  const totalActiveDurationMs = hourlyActivity.reduce((sum, row) => sum + row.activeDurationMs, 0);
  let winner = null;
  for (let startHour = 0; startHour < 24; startHour++) {
    let activeDurationMs = 0;
    for (let offset = 0; offset < PREFERRED_WINDOW_HOURS; offset++) {
      activeDurationMs += hourlyActivity[(startHour + offset) % 24].activeDurationMs;
    }
    if (!winner || activeDurationMs > winner.activeDurationMs) winner = { startHour, activeDurationMs };
  }
  const enough = sampleDays >= MIN_PREFERRED_WINDOW_ACTIVE_DAYS
    && totalActiveDurationMs >= MIN_PREFERRED_WINDOW_ACTIVE_MS
    && sampleSessions >= MIN_PREFERRED_WINDOW_SESSIONS
    && winner?.activeDurationMs > 0;
  if (!enough) {
    return {
      available: false,
      reason: 'insufficient-data',
      message: 'Chưa đủ dữ liệu để xác định khung giờ đọc thường xuyên.',
      sampleDays,
      sampleSessions
    };
  }
  return {
    available: true,
    startHour: winner.startHour,
    endHour: (winner.startHour + PREFERRED_WINDOW_HOURS) % 24,
    activeDurationMs: winner.activeDurationMs,
    sampleDays,
    sampleSessions
  };
}

function weekdayName(index) {
  return ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật'][index];
}

function rangeDays(range) {
  if (!range.from || !range.to) return 0;
  let days = 0;
  for (let date = range.from; date && date <= range.to; date = shiftLocalDateKey(date, 1)) {
    days++;
    if (date === range.to) break;
  }
  return days;
}

function addMetric(target, field, value) {
  target[field] = Math.min(Number.MAX_SAFE_INTEGER, target[field] + safeMetric(value));
}

function aggregateRange(sessions, range, books = [], options = {}) {
  const totals = emptyTotals();
  if (!range) return {
    range: null, totals, dailyActivity: [], insights: emptyInsights()
  };

  const daily = new Map();
  const hourlyActivity = makeHourlyActivity();
  const bookTotals = new Map();
  const speedSamples = [];
  const hourlySessionIds = new Set();
  const skipDailyAggregation = options.skipDailyAggregation === true;
  for (const session of sessions) {
    const sessionTotals = { activeDurationMs: 0, ttsDurationMs: 0, wordsReadEstimate: 0, chaptersCompleted: 0 };
    for (const bucket of session.dailyBuckets) {
      if ((range.from && bucket.date < range.from) || bucket.date > range.to) continue;
      if (!skipDailyAggregation) {
        const row = daily.get(bucket.date) || emptyDailyRow(bucket.date);
        for (const field of TOTAL_FIELDS) addMetric(row, field, bucket[field]);
        if (hasActivity(bucket)) row._bookIds.add(session.bookId);
        daily.set(bucket.date, row);
      }
      for (const field of TOTAL_FIELDS) addMetric(sessionTotals, field, bucket[field]);
    }

    if (hasActivity(sessionTotals)) {
      const book = bookTotals.get(session.bookId) || {
        bookId: session.bookId,
        activeDurationMs: 0,
        ttsDurationMs: 0,
        wordsReadEstimate: 0,
        chaptersCompleted: 0
      };
      for (const field of TOTAL_FIELDS) addMetric(book, field, sessionTotals[field]);
      bookTotals.set(session.bookId, book);
    }

    if (sessionTotals.activeDurationMs < MIN_CONSUMPTION_SESSION_DURATION_MS) {
      speedSamples.push({ ...sessionTotals, excluded: 'short-or-zero-duration' });
    } else if (sessionTotals.wordsReadEstimate <= 0) {
      speedSamples.push({ ...sessionTotals, excluded: 'zero-words' });
    } else {
      const wpm = sessionTotals.wordsReadEstimate / (sessionTotals.activeDurationMs / 60_000);
      speedSamples.push({ ...sessionTotals, excluded: wpm > MAX_CONSUMPTION_SPEED_WPM ? 'outlier' : null });
    }

    for (const bucket of session.hourlyBuckets) {
      if ((range.from && bucket.date < range.from) || bucket.date > range.to) continue;
      for (let hour = 0; hour < 24; hour++) {
        addMetric(hourlyActivity[hour], 'activeDurationMs', bucket.activeDurationMs[hour]);
        addMetric(hourlyActivity[hour], 'ttsDurationMs', bucket.ttsDurationMs[hour]);
        if (bucket.activeDurationMs[hour] > 0) hourlySessionIds.add(session.key);
      }
    }
  }

  let dailyActivity = Array.isArray(options.dailyActivity)
    ? options.dailyActivity.map(day => ({ ...day }))
    : [];
  if (!Array.isArray(options.dailyActivity) && range.from) {
    for (let date = range.from; date && date <= range.to; date = shiftLocalDateKey(date, 1)) {
      const row = daily.get(date) || emptyDailyRow(date);
      row.ttsDurationMs = Math.min(row.activeDurationMs, row.ttsDurationMs);
      row.booksActive = row._bookIds.size;
      delete row._bookIds;
      dailyActivity.push(row);
      if (date === range.to) break;
    }
  } else if (!Array.isArray(options.dailyActivity)) {
    for (const row of [...daily.values()].sort((a, b) => a.date.localeCompare(b.date))) {
      row.ttsDurationMs = Math.min(row.activeDurationMs, row.ttsDurationMs);
      row.booksActive = row._bookIds.size;
      delete row._bookIds;
      dailyActivity.push(row);
    }
  }

  for (const day of dailyActivity) {
    for (const field of TOTAL_FIELDS) addMetric(totals, field, day[field]);
  }
  if (!options.skipActiveBookAggregation) {
    const activeBooks = new Set();
    for (const session of sessions) {
      if (session.dailyBuckets.some(bucket => hasActivity(bucket)
        && (!range.from || bucket.date >= range.from) && bucket.date <= range.to)) activeBooks.add(session.bookId);
    }
    totals.booksActive = activeBooks.size;
  }
  totals.ttsDurationMs = Math.min(totals.activeDurationMs, totals.ttsDurationMs);

  for (const hour of hourlyActivity) {
    hour.ttsDurationMs = Math.min(hour.activeDurationMs, hour.ttsDurationMs);
  }
  const weekdayActivity = Array.from({ length: 7 }, (_, index) => ({
    weekday: index,
    label: weekdayName(index),
    activeDurationMs: 0,
    ttsDurationMs: 0,
    wordsReadEstimate: 0,
    chaptersCompleted: 0,
    daysObserved: 0,
    activeDays: 0
  }));
  for (const day of dailyActivity) {
    const weekday = weekdayActivity[weekdayIndex(day.date)];
    weekday.daysObserved++;
    for (const field of TOTAL_FIELDS) addMetric(weekday, field, day[field]);
    if (day.activeDurationMs > 0) weekday.activeDays++;
  }
  const activeWeekdays = weekdayActivity.filter(day => day.activeDurationMs > 0);
  const mostActiveWeekday = rangeDays(range) >= MIN_WEEKDAY_SAMPLE_DAYS && activeWeekdays.length
    ? activeWeekdays.sort((a, b) => b.activeDurationMs - a.activeDurationMs || a.weekday - b.weekday)[0]
    : null;

  const activeDayRows = dailyActivity.filter(day => day.activeDurationMs > 0);
  const bestDay = activeDayRows.reduce((best, day) => !best
    || day.activeDurationMs > best.activeDurationMs
    || (day.activeDurationMs === best.activeDurationMs && day.date > best.date)
    ? { date: day.date, activeDurationMs: day.activeDurationMs,
      wordsReadEstimate: day.wordsReadEstimate, chaptersCompleted: day.chaptersCompleted }
    : best, null);

  const speedIncluded = speedSamples.filter(sample => !sample.excluded);
  const speedWords = speedIncluded.reduce((sum, sample) => Math.min(Number.MAX_SAFE_INTEGER, sum + sample.wordsReadEstimate), 0);
  const speedDuration = speedIncluded.reduce((sum, sample) => Math.min(Number.MAX_SAFE_INTEGER, sum + sample.activeDurationMs), 0);
  const consumptionSpeed = speedDuration > 0 ? {
    available: true,
    label: 'Average Consumption Speed',
    wordsPerMinute: speedWords / (speedDuration / 60_000),
    validSessions: speedIncluded.length,
    wordsReadEstimate: speedWords,
    activeDurationMs: speedDuration,
    excludedSessions: speedSamples.filter(sample => sample.excluded).length,
    maxAcceptedWordsPerMinute: MAX_CONSUMPTION_SPEED_WPM
  } : {
    available: false,
    label: 'Average Consumption Speed',
    wordsPerMinute: null,
    validSessions: 0,
    wordsReadEstimate: 0,
    activeDurationMs: 0,
    excludedSessions: speedSamples.length,
    maxAcceptedWordsPerMinute: MAX_CONSUMPTION_SPEED_WPM,
    message: 'Chưa đủ dữ liệu.'
  };

  const bookCatalog = new Map(books.filter(book => Number.isSafeInteger(Number(book?.id)) && Number(book.id) > 0)
    .map(book => [Number(book.id), book]));
  const topBooks = [...bookTotals.values()]
    .sort((a, b) => b.activeDurationMs - a.activeDurationMs
      || b.wordsReadEstimate - a.wordsReadEstimate
      || b.chaptersCompleted - a.chaptersCompleted
      || b.ttsDurationMs - a.ttsDurationMs
      || a.bookId - b.bookId)
    .slice(0, TOP_BOOKS_LIMIT)
    .map(book => ({
      ...book,
      title: bookCatalog.get(book.bookId)?.title?.trim() || 'Truyện đã xóa'
    }));

  const windowSampleDays = new Set(dailyActivity.filter(day => day.activeDurationMs > 0).map(day => day.date)).size;
  const insights = {
    consumptionSpeed,
    hourlyActivity,
    preferredReadingWindow: buildPreferredWindow(hourlyActivity, windowSampleDays, hourlySessionIds.size),
    weekdayActivity,
    mostActiveWeekday: mostActiveWeekday ? {
      weekday: mostActiveWeekday.weekday,
      label: mostActiveWeekday.label,
      activeDurationMs: mostActiveWeekday.activeDurationMs
    } : null,
    topBooks,
    bestDay
  };
  return { range, totals, dailyActivity, comparison: null, insights };
}

function emptyInsights() {
  return {
    consumptionSpeed: { available: false, wordsPerMinute: null, validSessions: 0, message: 'Chưa đủ dữ liệu.' },
    hourlyActivity: makeHourlyActivity(),
    preferredReadingWindow: {
      available: false, reason: 'insufficient-data', message: 'Chưa đủ dữ liệu để xác định khung giờ đọc thường xuyên.',
      sampleDays: 0, sampleSessions: 0
    },
    weekdayActivity: Array.from({ length: 7 }, (_, weekday) => ({
      weekday, label: weekdayName(weekday), activeDurationMs: 0, ttsDurationMs: 0,
      wordsReadEstimate: 0, chaptersCompleted: 0, daysObserved: 0, activeDays: 0
    })),
    mostActiveWeekday: null,
    topBooks: [],
    bestDay: null
  };
}

function buildDailyIndex(sessions) {
  const byDate = new Map();
  for (const session of sessions) {
    for (const bucket of session.dailyBuckets) {
      const row = byDate.get(bucket.date) || emptyDailyRow(bucket.date);
      for (const field of TOTAL_FIELDS) addMetric(row, field, bucket[field]);
      if (hasActivity(bucket)) row._bookIds.add(session.bookId);
      byDate.set(bucket.date, row);
    }
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => {
    row.ttsDurationMs = Math.min(row.activeDurationMs, row.ttsDurationMs);
    row.booksActive = row._bookIds.size;
    return row;
  });
  return { rows };
}

function projectDailyIndex(index, range) {
  const totals = emptyTotals();
  const dailyActivity = [];
  const activeBooks = new Set();
  if (!range) return { range: null, totals, dailyActivity };
  const byDate = new Map(index.rows.map(row => [row.date, row]));
  const selectedRows = [];
  if (range.from) {
    for (let date = range.from; date && date <= range.to; date = shiftLocalDateKey(date, 1)) {
      selectedRows.push(byDate.get(date) || emptyDailyRow(date));
      if (date === range.to) break;
    }
  } else {
    selectedRows.push(...index.rows.filter(row => row.date <= range.to));
  }
  for (const source of selectedRows) {
    const day = {
      date: source.date,
      activeDurationMs: source.activeDurationMs,
      ttsDurationMs: source.ttsDurationMs,
      wordsReadEstimate: source.wordsReadEstimate,
      chaptersCompleted: source.chaptersCompleted,
      booksActive: source.booksActive
    };
    for (const field of TOTAL_FIELDS) addMetric(totals, field, day[field]);
    for (const bookId of source._bookIds) activeBooks.add(bookId);
    dailyActivity.push(day);
  }
  totals.ttsDurationMs = Math.min(totals.activeDurationMs, totals.ttsDurationMs);
  totals.booksActive = activeBooks.size;
  return { range, totals, dailyActivity };
}

function comparisonMetric(current, previous) {
  const delta = current - previous;
  const direction = delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'equal';
  return {
    current,
    previous,
    delta,
    direction,
    percentChange: previous > 0 ? (delta / previous) * 100 : null,
    baseline: previous === 0 ? 'zero' : 'nonzero'
  };
}

function buildComparison(current, previous) {
  const metrics = {};
  for (const field of Object.keys(current.totals)) {
    metrics[field] = comparisonMetric(current.totals[field], previous.totals[field]);
  }
  return { primaryMetric: 'activeDurationMs', previousRange: previous.range, previousTotals: previous.totals, metrics };
}

function getHeatmapIntensity(activeDurationMs) {
  if (activeDurationMs <= 0) return 0;
  if (activeDurationMs < HEATMAP_INTENSITY_THRESHOLDS_MS.level2) return 1;
  if (activeDurationMs < HEATMAP_INTENSITY_THRESHOLDS_MS.level3) return 2;
  if (activeDurationMs < HEATMAP_INTENSITY_THRESHOLDS_MS.level4) return 3;
  return 4;
}

function makeHeatmapData(dailyActivity, now, days = HEATMAP_RANGE_DAYS) {
  const range = getLocalCalendarRange(days, now);
  if (!range) return { range: null, cells: [] };
  const byDate = new Map((Array.isArray(dailyActivity) ? dailyActivity : [])
    .filter(day => day && isLocalDateKey(day.date))
    .map(day => [day.date, day]));
  const cells = [];
  for (let date = range.from; date && date <= range.to; date = shiftLocalDateKey(date, 1)) {
    const source = byDate.get(date);
    const activeDurationMs = safeMetric(source?.activeDurationMs);
    cells.push({
      date,
      activeDurationMs,
      wordsReadEstimate: safeMetric(source?.wordsReadEstimate),
      ttsDurationMs: Math.min(activeDurationMs, safeMetric(source?.ttsDurationMs)),
      chaptersCompleted: safeMetric(source?.chaptersCompleted),
      booksActive: safeMetric(source?.booksActive),
      intensity: getHeatmapIntensity(activeDurationMs)
    });
    if (date === range.to) break;
  }
  const firstWeekday = weekdayIndex(range.from);
  const weekCount = Math.ceil((firstWeekday + cells.length) / 7);
  const weeks = Array.from({ length: weekCount }, () => Array(7).fill(null));
  const monthMarks = [];
  let previousMonth = '';
  cells.forEach((cell, index) => {
    const position = firstWeekday + index;
    const weekIndex = Math.floor(position / 7);
    const weekday = position % 7;
    weeks[weekIndex][weekday] = cell;
    const monthKey = cell.date.slice(0, 7);
    if (monthKey !== previousMonth) {
      const [year, month] = monthKey.split('-').map(Number);
      monthMarks.push({
        weekIndex,
        date: cell.date,
        label: new Date(year, month - 1, 1).toLocaleDateString('vi-VN', { month: 'short' })
      });
      previousMonth = monthKey;
    }
  });
  return { range: { preset: `${days}days`, ...range }, cells, weeks, monthMarks };
}

function calculateStreaks(dailyActivity, now) {
  const byDate = new Map((Array.isArray(dailyActivity) ? dailyActivity : [])
    .filter(day => day && isLocalDateKey(day.date))
    .map(day => [day.date, safeMetric(day.activeDurationMs)]));
  const active = date => (byDate.get(date) || 0) >= STREAK_ACTIVE_DAY_THRESHOLD_MS;
  const orderedDates = [...byDate.keys()].sort();
  let longest = { days: 0, startDate: null, endDate: null };
  let run = { days: 0, startDate: null, endDate: null };
  for (const date of orderedDates) {
    if (!active(date)) {
      run = { days: 0, startDate: null, endDate: null };
      continue;
    }
    const consecutive = run.endDate && shiftLocalDateKey(run.endDate, 1) === date;
    run = {
      days: consecutive ? run.days + 1 : 1,
      startDate: consecutive ? run.startDate : date,
      endDate: date
    };
    if (run.days > longest.days || (run.days === longest.days && run.endDate > longest.endDate)) longest = { ...run };
  }

  const today = getLocalCalendarRange('today', now).to;
  const yesterday = shiftLocalDateKey(today, -1);
  const todayActive = active(today);
  const anchorDate = todayActive ? today : (active(yesterday) ? yesterday : null);
  let current = { days: 0, startDate: null, endDate: null, asOfDate: today, countsTodayAsGrace: Boolean(anchorDate && !todayActive) };
  if (anchorDate) {
    let cursor = anchorDate;
    let first = anchorDate;
    let days = 0;
    while (active(cursor)) {
      days++;
      first = cursor;
      cursor = shiftLocalDateKey(cursor, -1);
    }
    current = {
      days,
      startDate: first,
      endDate: anchorDate,
      asOfDate: today,
      countsTodayAsGrace: !todayActive && anchorDate === yesterday
    };
  }
  return { current, longest, activeDayThresholdMs: STREAK_ACTIVE_DAY_THRESHOLD_MS };
}

export function createReadingAnalytics(options = {}) {
  const now = options.now || (() => Date.now());
  const loadSessions = options.getReadingSessions || getReadingSessions;
  const readCurrentSnapshot = options.getSessionSnapshot || getSessionSnapshot;
  const loadBooks = options.getAllBooks || (options.getReadingSessions ? async () => [] : getAllBooks);

  async function loadSanitizedSessions(timestamp) {
    const [persisted, current] = await Promise.all([
      loadSessions(),
      readCurrentSnapshot(timestamp)
    ]);
    return mergeSessionRows(persisted, current);
  }

  async function getStatsForRange(input = 'today', callOptions = {}) {
    const parsedInput = parseRangeInput(input);
    const timestamp = callOptions.now ?? parsedInput.now ?? now();
    const sessions = await loadSanitizedSessions(timestamp);
    const preset = parsedInput.preset ?? parsedInput.period ?? parsedInput.days;
    const range = resolveRange(input, timestamp, preset !== undefined && String(preset).toLowerCase().replace(/[- ]/g, '') === 'alltime'
      ? firstDateIn(sessions)
      : null);
    const books = sessions.length ? await loadBooks() : [];
    return { ...aggregateRange(sessions, range, books), comparison: null };
  }

  async function getLifetimeStats(callOptions = {}) {
    return getStatsForRange('allTime', callOptions);
  }

  async function getDailyActivity(input = 'today', callOptions = {}) {
    const parsedInput = parseRangeInput(input);
    const timestamp = callOptions.now ?? parsedInput.now ?? now();
    const sessions = await loadSanitizedSessions(timestamp);
    const preset = parsedInput.preset ?? parsedInput.period ?? parsedInput.days;
    const range = resolveRange(input, timestamp, preset !== undefined
      && String(preset).toLowerCase().replace(/[- ]/g, '') === 'alltime' ? firstDateIn(sessions) : null);
    return aggregateRange(sessions, range).dailyActivity;
  }

  async function getHeatmapData(callOptions = {}) {
    const timestamp = callOptions.now ?? now();
    const days = Number.isSafeInteger(callOptions.days) && callOptions.days > 0
      ? callOptions.days
      : HEATMAP_RANGE_DAYS;
    const source = callOptions.dailyActivity ?? callOptions.result?.dailyActivity
      ?? await getDailyActivity(days, { now: timestamp });
    return makeHeatmapData(source, timestamp, days);
  }

  async function getStreaks(callOptions = {}) {
    const timestamp = callOptions.now ?? now();
    const source = callOptions.dailyActivity ?? callOptions.result?.dailyActivity
      ?? await getDailyActivity('allTime', { now: timestamp });
    return calculateStreaks(source, timestamp);
  }

  async function getTrendData(period = '7days', callOptions = {}) {
    const timestamp = callOptions.now ?? now();
    const range = getLocalCalendarRange(period, timestamp);
    if (!range || ![7, 30].includes(Number.isSafeInteger(period) ? period : ({ '7days': 7, '7-days': 7, week: 7, '30days': 30, '30-days': 30, month: 30 })[String(period).toLowerCase()])) {
      return { range: null, dailyActivity: [] };
    }
    const source = callOptions.dailyActivity ?? callOptions.result?.dailyActivity
      ?? await getDailyActivity(period, { now: timestamp });
    const byDate = new Map((Array.isArray(source) ? source : [])
      .filter(day => day && isLocalDateKey(day.date))
      .map(day => [day.date, day]));
    const dailyActivity = [];
    for (let date = range.from; date && date <= range.to; date = shiftLocalDateKey(date, 1)) {
      dailyActivity.push({ date, duration: safeMetric(byDate.get(date)?.activeDurationMs) });
      if (date === range.to) break;
    }
    return { range, dailyActivity };
  }

  async function comparePeriods(input = '7days', callOptions = {}) {
    const parsed = parseRangeInput(input);
    const timestamp = callOptions.now ?? parsed.now ?? now();
    const preset = parsed.preset ?? parsed.period ?? parsed.days;
    const normalized = String(preset).toLowerCase().replace(/[- ]/g, '');
    const days = normalized === '7days' ? 7 : normalized === '30days' ? 30 : null;
    if (!days) return { ...aggregateRange([], null), comparison: null };

    const sessions = await loadSanitizedSessions(timestamp);
    const currentRange = resolveRange(preset, timestamp);
    const previousCalendar = getLocalCalendarRange(days, timestamp, -days);
    const previousRange = {
      preset: `previous${days}days`,
      from: previousCalendar.from,
      to: previousCalendar.to,
      allTime: false
    };
    const books = sessions.length ? await loadBooks() : [];
    const current = aggregateRange(sessions, currentRange, books);
    const previous = aggregateRange(sessions, previousRange);
    return { ...current, comparison: buildComparison(current, previous) };
  }

  async function getDashboardData(input = '7days', callOptions = {}) {
    const parsed = parseRangeInput(input);
    const timestamp = callOptions.now ?? parsed.now ?? now();
    const preset = parsed.preset ?? parsed.period ?? parsed.days;
    const normalized = String(preset).toLowerCase().replace(/[- ]/g, '');
    const sessions = await loadSanitizedSessions(timestamp);
    const first = firstDateIn(sessions);
    const currentRange = resolveRange(input, timestamp,
      normalized === 'alltime' ? first : null);
    const lifetimeRange = resolveRange('allTime', timestamp, first);
    const books = sessions.length ? await loadBooks() : [];
    const dailyIndex = buildDailyIndex(sessions);
    const currentProjection = projectDailyIndex(dailyIndex, currentRange);
    const current = aggregateRange(sessions, currentRange, books, {
      dailyActivity: currentProjection.dailyActivity,
      skipDailyAggregation: true,
      skipActiveBookAggregation: true
    });
    current.totals = currentProjection.totals;
    current.dailyActivity = currentProjection.dailyActivity;
    const lifetime = projectDailyIndex(dailyIndex, lifetimeRange);

    const periodSummaries = new Map();
    const summaryForDays = days => {
      if (periodSummaries.has(days)) return periodSummaries.get(days);
      const periodRange = resolveRange(`${days}days`, timestamp);
      const previousCalendar = getLocalCalendarRange(days, timestamp, -days);
      const previousRange = {
        preset: `previous${days}days`,
        from: previousCalendar.from,
        to: previousCalendar.to,
        allTime: false
      };
      const periodSummary = normalized === `${days}days`
        ? currentProjection
        : projectDailyIndex(dailyIndex, periodRange);
      const previousSummary = projectDailyIndex(dailyIndex, previousRange);
      const result = { periodSummary, previousSummary };
      periodSummaries.set(days, result);
      return result;
    };
    const sevenDay = summaryForDays(7);
    const thirtyDay = summaryForDays(30);
    const comparisons = {
      sevenDay: buildComparison(sevenDay.periodSummary, sevenDay.previousSummary),
      thirtyDay: buildComparison(thirtyDay.periodSummary, thirtyDay.previousSummary)
    };
    const comparison = normalized === '7days' ? comparisons.sevenDay
      : normalized === '30days' ? comparisons.thirtyDay : null;

    const trend = days => {
      const aggregate = summaryForDays(days).periodSummary;
      return {
        range: aggregate.range,
        dailyActivity: aggregate.dailyActivity.map(day => ({ date: day.date, duration: day.activeDurationMs }))
      };
    };
    const heatmap = makeHeatmapData(lifetime.dailyActivity, timestamp, HEATMAP_RANGE_DAYS);
    return {
      ...current,
      comparison,
      comparisons,
      lifetime,
      heatmap,
      streaks: calculateStreaks(lifetime.dailyActivity, timestamp),
      trends: { sevenDay: trend(7), thirtyDay: trend(30) }
    };
  }

  return { getLifetimeStats, getStatsForRange, getDailyActivity, getHeatmapData, getStreaks, getTrendData, comparePeriods, getDashboardData };
}

const readingAnalytics = createReadingAnalytics();
export const getLifetimeStats = options => readingAnalytics.getLifetimeStats(options);
export const getStatsForRange = (range, options) => readingAnalytics.getStatsForRange(range, options);
export const getDailyActivity = (range, options) => readingAnalytics.getDailyActivity(range, options);
export const getHeatmapData = options => readingAnalytics.getHeatmapData(options);
export const getStreaks = options => readingAnalytics.getStreaks(options);
export const getTrendData = (period, options) => readingAnalytics.getTrendData(period, options);
export const comparePeriods = (range, options) => readingAnalytics.comparePeriods(range, options);
export const getDashboardData = (range, options) => readingAnalytics.getDashboardData(range, options);
