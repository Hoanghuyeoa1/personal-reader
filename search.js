/**
 * Core full-text search for VietReader.
 *
 * This module is deliberately UI-free. It owns projection/matching plus the
 * derived index lifecycle; query callers pass a source snapshot until the
 * later search UI connects index candidates to result navigation.
 */
import { cleanChapterText } from './cleaner.js';
import { TTSEngine } from './tts.js';
import {
  clearSearchIndex,
  commitSearchIndexEntryIfCurrent,
  deleteSearchIndexChapter,
  deleteSearchIndexForBook,
  getAllBooks,
  getAllChapterKeys,
  getAllSearchIndexEntries,
  getBook,
  getBookChaptersMeta,
  getChapter,
  getCustomRules,
  getSearchIndexEntry,
  getSearchIndexSnapshot,
  getSetting,
  putSearchIndexEntry,
  subscribeSearchIndexChanges
} from './storage.js';

export const SEARCH_ALGORITHM_VERSION = 1;
export const SEARCH_INDEX_FORMAT_VERSION = 1;
export const DEFAULT_SEARCH_LIMIT = 200;
export const MAX_SEARCH_LIMIT = 500;
export const MAX_SEARCH_OFFSET = MAX_SEARCH_LIMIT;
export const MIN_NORMALIZED_QUERY_LENGTH = 2;
export const MAX_NORMALIZED_QUERY_LENGTH = 256;
export const MAX_RAW_QUERY_LENGTH = 4096;
export const MAX_MATCHES_PER_PARAGRAPH = 3;

const combiningMark = /\p{M}/u;
const combiningMarks = /\p{M}/gu;
const whitespace = /^\s+$/u;

function forEachGrapheme(text, callback) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const item of segmenter.segment(text)) {
      callback(item.segment, item.index, item.index + item.segment.length);
    }
    return;
  }

  // Fallback for runtimes without Intl.Segmenter: keep combining marks with
  // the preceding code point. UTF-16 offsets are retained throughout.
  let offset = 0;
  let pending = '';
  let pendingStart = 0;
  for (const point of text) {
    const end = offset + point.length;
    if (combiningMark.test(point) && pending) {
      pending += point;
    } else {
      if (pending) callback(pending, pendingStart, offset);
      pending = point;
      pendingStart = offset;
    }
    offset = end;
  }
  if (pending) callback(pending, pendingStart, offset);
}

/**
 * Normalize Vietnamese search text without changing the source string.
 * Whitespace is trimmed/collapsed, accents and đ/Đ are folded, and matching
 * remains Unicode-safe. The returned map is one interval per normalized
 * UTF-16 code unit, pointing back to the complete original grapheme/run.
 */
function normalizeVietnamese(value, includeMap) {
  const original = typeof value === 'string' ? value : '';
  let normalizedText = '';
  const normalizedToOriginal = [];

  forEachGrapheme(original, (grapheme, start, end) => {
    if (whitespace.test(grapheme)) {
      if (!normalizedText) return; // trim leading whitespace
      if (normalizedText.endsWith(' ')) {
        if (includeMap) {
          const last = normalizedToOriginal.length - 1;
          normalizedToOriginal[last] = { start: normalizedToOriginal[last].start, end };
        }
      } else {
        normalizedText += ' ';
        if (includeMap) normalizedToOriginal.push({ start, end });
      }
      return;
    }

    const folded = grapheme
      .replace(/[đĐ]/g, 'd')
      .normalize('NFD')
      .replace(combiningMarks, '')
      .toLowerCase();
    normalizedText += folded;
    if (includeMap) {
      for (let i = 0; i < folded.length; i++) normalizedToOriginal.push({ start, end });
    }
  });

  // Remove trailing collapsed whitespace and its mapping.
  if (normalizedText.endsWith(' ')) {
    normalizedText = normalizedText.slice(0, -1);
    if (includeMap) normalizedToOriginal.pop();
  }

  return { original, normalizedText, normalizedToOriginal };
}

export function normalizeVietnameseWithMap(value) {
  return normalizeVietnamese(value, true);
}

export function normalizeSearchText(value) {
  return normalizeVietnamese(value, false).normalizedText;
}

function normalizeExactPhrase(value) {
  return String(value ?? '').normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Project cleaned chapter content to the exact visible paragraph text used by
 * renderChapterContent (including its per-TTS-chunk trailing spaces).
 */
export function projectChapterText(content, rules = [], enableCleaner = true) {
  const cleanedText = cleanChapterText(content, { rules, enableCleaner });
  if (!cleanedText || !cleanedText.trim()) return [];

  const paragraphs = cleanedText.split(/\n+/);
  const projected = [];
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const trimmed = paragraphs[paragraphIndex].trim();
    if (!trimmed) continue;
    const chunks = TTSEngine.prototype.splitIntoSmartChunks.call({}, trimmed);
    projected.push({
      paragraphIndex,
      text: chunks.map(chunk => `${chunk} `).join('')
    });
  }
  return projected;
}

function compareNumber(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  const leftText = String(a ?? '');
  const rightText = String(b ?? '');
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function safeSnippetBoundary(text, index, direction) {
  let point = Math.max(0, Math.min(text.length, index));
  if (point > 0 && point < text.length) {
    const before = text.charCodeAt(point - 1);
    const after = text.charCodeAt(point);
    if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) {
      point += direction < 0 ? -1 : 1;
    }
  }
  return point;
}

function makeSnippet(text, matchStart, matchEnd, contextUnits = 80) {
  let start = safeSnippetBoundary(text, Math.max(0, matchStart - contextUnits), -1);
  let end = safeSnippetBoundary(text, Math.min(text.length, matchEnd + contextUnits), 1);

  // Prefer nearby word boundaries when that does not remove too much context.
  if (start > 0) {
    const boundary = text.lastIndexOf(' ', Math.min(matchStart, start + 24));
    if (boundary >= Math.max(0, start - 24)) start = boundary + 1;
  }
  if (end < text.length) {
    const boundary = text.indexOf(' ', Math.max(matchEnd, end - 24));
    if (boundary >= matchEnd && boundary < end + 24) end = boundary;
  }

  return {
    text: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    sourceStart: start,
    sourceEnd: end,
    matchStart: (start > 0 ? 1 : 0) + matchStart - start,
    matchEnd: (start > 0 ? 1 : 0) + matchEnd - start
  };
}

function getOriginalRange(mapping, normalizedStart, normalizedEnd) {
  const first = mapping[normalizedStart];
  const last = mapping[normalizedEnd - 1];
  if (!first || !last) return null;
  return { start: first.start, end: last.end };
}

function compareResults(a, b) {
  return a.rank[0] - b.rank[0]
    || compareNumber(a.bookId, b.bookId)
    || compareNumber(a.chapterIndex, b.chapterIndex)
    || compareNumber(a.paragraphIndex, b.paragraphIndex)
    || a.matchStart - b.matchStart;
}

function createResult(chapter, book, paragraph, mapping, normalizedStart, queryNormalized, requestId) {
  const range = getOriginalRange(mapping.normalizedToOriginal, normalizedStart, normalizedStart + queryNormalized.length);
  if (!range) return null;
  const matchedText = paragraph.text.slice(range.start, range.end);
  const exact = normalizeExactPhrase(matchedText) === normalizeExactPhrase(chapter._queryOriginal);
  const snippet = makeSnippet(paragraph.text, range.start, range.end);
  return {
    requestId,
    bookId: chapter.bookId,
    chapterIndex: chapter.chapterIndex,
    paragraphIndex: paragraph.paragraphIndex,
    bookTitle: book?.title ?? chapter.bookTitle ?? '',
    chapterTitle: chapter.title ?? chapter.chapterTitle ?? '',
    queryNormalized,
    matchStart: range.start,
    matchEnd: range.end,
    normalizedStart,
    normalizedEnd: normalizedStart + queryNormalized.length,
    matchedText,
    contextBefore: paragraph.text.slice(Math.max(0, range.start - 32), range.start),
    contextAfter: paragraph.text.slice(range.end, Math.min(paragraph.text.length, range.end + 32)),
    snippet: {
      text: snippet.text,
      matchStart: snippet.matchStart,
      matchEnd: snippet.matchEnd
    },
    rank: [exact ? 0 : 1, Number(chapter.bookId) || 0, Number(chapter.chapterIndex) || 0,
      Number(paragraph.paragraphIndex) || 0, range.start]
  };
}

function yieldToEventLoop() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Search a caller-provided source snapshot. Each chapter is
 * {bookId,chapterIndex,title,content,rules?,enableCleaner?}; caller may instead
 * supply `paragraphs` already projected as [{paragraphIndex,text}].
 */
export async function searchLibrary(query, options = {}) {
  const {
    chapters = [], books = [], mode = 'contains', limit = DEFAULT_SEARCH_LIMIT,
    offset = 0, signal, requestId = 0, isCurrent = () => true,
    batchSize = 40
  } = options;
  const rawQuery = typeof query === 'string' ? query : '';
  if (rawQuery.length > MAX_RAW_QUERY_LENGTH) {
    return { requestId, queryNormalized: '', results: [], totalMatches: 0, truncated: false, cancelled: false };
  }
  const queryNormalized = normalizeSearchText(rawQuery);
  const empty = { requestId, queryNormalized, results: [], totalMatches: 0, truncated: false, cancelled: false };
  if (mode !== 'contains' || !Array.isArray(chapters) || !chapters.length
      || queryNormalized.length < MIN_NORMALIZED_QUERY_LENGTH
      || queryNormalized.length > MAX_NORMALIZED_QUERY_LENGTH) return empty;

  const maxResults = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(Number(limit) || DEFAULT_SEARCH_LIMIT)));
  const startOffset = Math.max(0, Math.min(MAX_SEARCH_OFFSET, Math.trunc(Number(offset) || 0)));
  const pageLimit = Math.min(maxResults, MAX_SEARCH_LIMIT - startOffset);
  const windowSize = startOffset + pageLimit;
  const bookMap = new Map(books.map(book => [String(book.id), book]));
  const candidates = [];
  let totalMatches = 0;
  let eligibleResults = 0;
  let truncated = false;
  let workSinceYield = 0;
  const active = () => !(signal?.aborted) && isCurrent(requestId);
  const addCandidate = result => {
    eligibleResults++;
    if (windowSize === 0) return;
    let low = 0;
    let high = candidates.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareResults(candidates[middle], result) <= 0) low = middle + 1;
      else high = middle;
    }
    if (low < windowSize) {
      candidates.splice(low, 0, result);
      if (candidates.length > windowSize) candidates.pop();
    } else if (candidates.length < windowSize) {
      candidates.push(result);
    }
  };

  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
    if (!active()) return { ...empty, cancelled: true };
    const chapter = chapters[chapterIndex];
    const projectedParagraphs = Array.isArray(chapter.paragraphs)
      ? chapter.paragraphs
      : projectChapterText(chapter.content, chapter.rules || [], chapter.enableCleaner !== false);
    const chapterForResult = { ...chapter, _queryOriginal: String(query ?? '') };
    const book = bookMap.get(String(chapter.bookId));

    for (const paragraph of projectedParagraphs) {
      if (!paragraph || typeof paragraph.text !== 'string') continue;
      const mapping = normalizeVietnameseWithMap(paragraph.text);
      let from = 0;
      let paragraphMatches = 0;
      while (from <= mapping.normalizedText.length - queryNormalized.length) {
        const matchAt = mapping.normalizedText.indexOf(queryNormalized, from);
        if (matchAt < 0) break;
        totalMatches++;
        if (paragraphMatches < MAX_MATCHES_PER_PARAGRAPH) {
          const result = createResult(chapterForResult, book, paragraph, mapping, matchAt, queryNormalized, requestId);
          if (result) addCandidate(result);
        } else {
          truncated = true;
        }
        paragraphMatches++;
        from = matchAt + Math.max(1, queryNormalized.length); // non-overlapping occurrences
        workSinceYield++;
        if (workSinceYield >= 1000) {
          workSinceYield = 0;
          await yieldToEventLoop();
          if (!active()) return { ...empty, cancelled: true };
        }
      }
      if (paragraphMatches > MAX_MATCHES_PER_PARAGRAPH) truncated = true;
      workSinceYield++;
      if (workSinceYield >= 100) {
        workSinceYield = 0;
        await yieldToEventLoop();
        if (!active()) return { ...empty, cancelled: true };
      }
    }

    if ((chapterIndex + 1) % Math.max(1, batchSize) === 0) {
      await yieldToEventLoop();
      if (!active()) return { ...empty, cancelled: true };
    }
  }

  if (!active()) return { ...empty, cancelled: true };
  if (eligibleResults > windowSize) truncated = true;
  const results = candidates.slice(startOffset, startOffset + pageLimit);
  return { requestId, queryNormalized, results, totalMatches, truncated, cancelled: false };
}

/** Owns monotonically increasing request IDs and aborts the previous query. */
export function createSearchController() {
  let requestId = 0;
  let pendingController = null;
  return {
    async search(query, options = {}) {
      pendingController?.abort();
      const controller = new AbortController();
      pendingController = controller;
      const currentId = ++requestId;
      const externalSignal = options.signal;
      if (externalSignal?.aborted) controller.abort();
      else externalSignal?.addEventListener('abort', () => controller.abort(), { once: true });
      const result = await searchLibrary(query, {
        ...options,
        requestId: currentId,
        signal: controller.signal,
        isCurrent: id => id === requestId
      });
      if (currentId !== requestId) return { ...result, results: [], cancelled: true };
      return result;
    },
    cancel() {
      requestId++;
      pendingController?.abort();
      pendingController = null;
    },
    getCurrentRequestId() { return requestId; }
  };
}

function fastFingerprint(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    second ^= second >>> 13;
  }
  return `${text.length}:${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function canonicalEffectiveRules(rules, enableCleaner) {
  return JSON.stringify({
    enableCleaner: enableCleaner !== false,
    rules: (Array.isArray(rules) ? rules : []).map(rule => ({
      findText: String(rule?.findText ?? ''),
      replaceText: String(rule?.replaceText ?? ''),
      isRegex: !!rule?.isRegex,
      isCaseSensitive: !!rule?.isCaseSensitive,
      isEnabled: rule?.isEnabled !== false
    }))
  });
}

function fingerprintIndexParagraphs(paragraphs) {
  return `paragraphs-v1:${fastFingerprint(JSON.stringify(paragraphs))}`;
}

export function createSearchFingerprints(content, rules = [], enableCleaner = true) {
  return {
    contentFingerprint: `content-v1:${fastFingerprint(content)}`,
    rulesFingerprint: `rules-v1:${fastFingerprint(canonicalEffectiveRules(rules, enableCleaner))}`
  };
}

function isStructurallyValidSearchIndexEntry(entry) {
  return !!entry && typeof entry === 'object'
    && Number.isFinite(Number(entry.bookId))
    && Number.isInteger(Number(entry.chapterIndex))
    && entry.formatVersion === SEARCH_INDEX_FORMAT_VERSION
    && entry.algorithmVersion === SEARCH_ALGORITHM_VERSION
    && typeof entry.contentFingerprint === 'string'
    && typeof entry.rulesFingerprint === 'string'
    && typeof entry.indexFingerprint === 'string'
    && Number.isFinite(Number(entry.indexedAt))
    && Array.isArray(entry.paragraphs)
    && entry.paragraphs.every(paragraph => Number.isInteger(paragraph?.paragraphIndex)
      && paragraph.paragraphIndex >= 0 && typeof paragraph.normalizedText === 'string')
    && entry.paragraphs.every((paragraph, index) => index === 0
      || entry.paragraphs[index - 1].paragraphIndex < paragraph.paragraphIndex)
    && entry.indexFingerprint === fingerprintIndexParagraphs(entry.paragraphs);
}

function isValidSearchIndexEntry(entry, bookId, chapterIndex, fingerprints) {
  return isStructurallyValidSearchIndexEntry(entry)
    && entry.bookId === Number(bookId)
    && entry.chapterIndex === Number(chapterIndex)
    && entry.contentFingerprint === fingerprints.contentFingerprint
    && entry.rulesFingerprint === fingerprints.rulesFingerprint;
}

function scheduleIdle(callback) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      try { resolve(await callback()); }
      catch (error) { reject(error); }
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(run, { timeout: 1000 });
    } else {
      setTimeout(run, 0);
    }
  });
}

/**
 * Persistent chapter-index lifecycle. The index is rebuildable cache only;
 * source reads and validation always use the books/chapters/rules stores.
 */
export function createSearchIndexService({ storage = null, batchSize = 8, onProgress = null } = {}) {
  const store = storage || {
    clearSearchIndex, commitSearchIndexEntryIfCurrent, deleteSearchIndexChapter,
    deleteSearchIndexForBook, getAllBooks, getAllChapterKeys,
    getAllSearchIndexEntries, getBook, getBookChaptersMeta, getChapter,
    getCustomRules, getSearchIndexEntry, getSetting, putSearchIndexEntry,
    getSearchIndexSnapshot, subscribeSearchIndexChanges
  };
  let generation = 0;
  let started = false;
  let disposeSubscription = null;
  let buildTask = null;
  let activeBookBuilds = 0;
  let restartBuildRequested = false;
  let latestProgress = { indexing: false, indexedChapters: 0, totalChapters: 0 };
  let fullIndexValidated = false;
  const bookGenerations = new Map();
  const bookTasks = new Map();
  const ensureTasks = new Map();

  const getBookGeneration = bookId => bookGenerations.get(String(bookId)) || 0;
  const bumpBookGeneration = bookId => {
    const key = String(bookId);
    const next = getBookGeneration(bookId) + 1;
    bookGenerations.set(key, next);
    return next;
  };
  const report = (progress, callback) => {
    if (progress.phase !== 'searching') {
      latestProgress = {
        ...latestProgress,
        ...progress,
        indexing: progress.indexing !== undefined ? progress.indexing : true
      };
    }
    try { (callback || onProgress)?.(progress); }
    catch (error) { console.warn('Search index progress callback failed:', error); }
  };

  async function readSource(bookId, chapterIndex) {
    const snapshot = typeof store.getSearchIndexSnapshot === 'function'
      ? await store.getSearchIndexSnapshot(bookId, chapterIndex)
      : await Promise.all([
        store.getBook(bookId), store.getChapter(bookId, chapterIndex),
        store.getCustomRules(bookId), store.getSetting('enableGlobalCleaner', true)
      ]).then(([book, chapter, rules, cleanerSetting]) => ({ book, chapter, rules, enableCleaner: cleanerSetting !== false }));
    const { book, chapter, rules, enableCleaner } = snapshot;
    if (!book || !chapter) return null;
    const content = typeof chapter.content === 'string' ? chapter.content : '';
    return { ...snapshot, book, chapter, content, rules, enableCleaner };
  }

  function makeEntry(bookId, chapterIndex, source) {
    const { content, rules, enableCleaner } = source;
    const fingerprints = createSearchFingerprints(content, rules, enableCleaner);
    const paragraphs = projectChapterText(content, rules, enableCleaner).map(paragraph => ({
      paragraphIndex: paragraph.paragraphIndex,
      normalizedText: normalizeSearchText(paragraph.text)
    }));
    return {
      bookId: Number(bookId),
      chapterIndex: Number(chapterIndex),
      formatVersion: SEARCH_INDEX_FORMAT_VERSION,
      algorithmVersion: SEARCH_ALGORITHM_VERSION,
      ...fingerprints,
      indexFingerprint: fingerprintIndexParagraphs(paragraphs),
      indexedAt: Date.now(),
      paragraphs
    };
  }

  async function commitEntry(entry, capturedGeneration, capturedBookGeneration) {
    const validate = snapshot => {
      if (generation !== capturedGeneration || getBookGeneration(entry.bookId) !== capturedBookGeneration) return false;
      const content = typeof snapshot.chapter?.content === 'string' ? snapshot.chapter.content : '';
      const current = createSearchFingerprints(content, snapshot.rules, snapshot.enableCleaner);
      return !!snapshot.book
        && current.contentFingerprint === entry.contentFingerprint
        && current.rulesFingerprint === entry.rulesFingerprint;
    };
    if (typeof store.commitSearchIndexEntryIfCurrent === 'function') {
      return store.commitSearchIndexEntryIfCurrent(entry, validate);
    }
    if (generation !== capturedGeneration || getBookGeneration(entry.bookId) !== capturedBookGeneration) return false;
    const latest = await readSource(entry.bookId, entry.chapterIndex);
    if (!latest || !validate({ ...latest, chapter: latest.chapter })) return false;
    await store.putSearchIndexEntry(entry);
    return true;
  }

  async function indexChapter(bookId, chapterIndex, sourceSnapshot = undefined) {
    const capturedGeneration = generation;
    const capturedBookGeneration = getBookGeneration(bookId);
    let source = sourceSnapshot;
    if (source === undefined) {
      try { source = await readSource(bookId, chapterIndex); }
      catch (error) {
        console.warn(`Search index source read failed for chapter ${bookId}/${chapterIndex}:`, error);
        return { status: 'source-error', bookId: Number(bookId), chapterIndex: Number(chapterIndex), error };
      }
    }
    if (!source) {
      try { await store.deleteSearchIndexChapter(bookId, chapterIndex); } catch { /* cache cleanup is best effort */ }
      return { status: 'missing', bookId: Number(bookId), chapterIndex: Number(chapterIndex) };
    }
    let entry;
    try { entry = makeEntry(bookId, chapterIndex, source); }
    catch (error) {
      console.warn(`Unable to index chapter ${bookId}/${chapterIndex}:`, error);
      return { status: 'invalid', bookId: Number(bookId), chapterIndex: Number(chapterIndex), error };
    }
    if (generation !== capturedGeneration || getBookGeneration(bookId) !== capturedBookGeneration) {
      return { status: 'cancelled', bookId: Number(bookId), chapterIndex: Number(chapterIndex) };
    }
    try {
      const committed = await commitEntry(entry, capturedGeneration, capturedBookGeneration);
      return { status: committed ? 'indexed' : 'stale', bookId: Number(bookId), chapterIndex: Number(chapterIndex), entry: committed ? entry : undefined };
    } catch (error) {
      console.warn(`Search index write failed for chapter ${bookId}/${chapterIndex}:`, error);
      return { status: 'cache-error', bookId: Number(bookId), chapterIndex: Number(chapterIndex), error };
    }
  }

  async function ensureChapterIndexUnshared(bookId, chapterIndex) {
    const capturedGeneration = generation;
    const capturedBookGeneration = getBookGeneration(bookId);
    let source;
    try { source = await readSource(bookId, chapterIndex); }
    catch (error) {
      console.warn(`Search index source validation failed for chapter ${bookId}/${chapterIndex}:`, error);
      return null;
    }
    if (capturedGeneration !== generation || capturedBookGeneration !== getBookGeneration(bookId)) return null;
    if (!source) {
      try { await store.deleteSearchIndexChapter(bookId, chapterIndex); } catch { /* best effort */ }
      return null;
    }
    const fingerprints = createSearchFingerprints(source.content, source.rules, source.enableCleaner);
    try {
      const cached = source.indexEntry ?? await store.getSearchIndexEntry(bookId, chapterIndex);
      if (capturedGeneration === generation && capturedBookGeneration === getBookGeneration(bookId)
        && isValidSearchIndexEntry(cached, bookId, chapterIndex, fingerprints)) return cached;
    } catch (error) {
      console.warn(`Search index read failed for chapter ${bookId}/${chapterIndex}:`, error);
    }
    const rebuilt = await indexChapter(bookId, chapterIndex, source);
    return rebuilt.status === 'indexed' ? rebuilt.entry : null;
  }

  async function ensureChapterIndex(bookId, chapterIndex) {
    const key = `${generation}:${getBookGeneration(bookId)}:${Number(bookId)}:${Number(chapterIndex)}`;
    const existing = ensureTasks.get(key);
    if (existing) return existing;
    const task = ensureChapterIndexUnshared(bookId, chapterIndex);
    ensureTasks.set(key, task);
    try { return await task; }
    finally { if (ensureTasks.get(key) === task) ensureTasks.delete(key); }
  }

  async function indexBook(bookId, { progressCallback = null } = {}) {
    const key = String(bookId);
    const bookGeneration = getBookGeneration(bookId);
    const existing = bookTasks.get(key);
    if (existing?.generation === generation && existing.bookGeneration === bookGeneration) return existing.promise;
    activeBookBuilds++;
    const capturedGeneration = generation;
    const task = (async () => {
      const book = await store.getBook(bookId);
      if (!book) {
        try { await store.deleteSearchIndexForBook(bookId); } catch { /* best effort */ }
        return { status: 'missing', indexedChapters: 0, totalChapters: 0 };
      }
      const chapters = await store.getBookChaptersMeta(bookId);
      let indexedChapters = 0;
      for (let i = 0; i < chapters.length; i++) {
        if (capturedGeneration !== generation || bookGeneration !== getBookGeneration(bookId)) {
          return { status: 'cancelled', indexedChapters, totalChapters: chapters.length };
        }
        const entry = await ensureChapterIndex(bookId, chapters[i].chapterIndex);
        if (entry) indexedChapters++;
        report({ bookId: Number(bookId), indexedChapters, totalChapters: chapters.length }, progressCallback);
        if ((i + 1) % Math.max(1, batchSize) === 0 && i + 1 < chapters.length) {
          await scheduleIdle(() => undefined);
        }
      }
      return { status: 'complete', indexedChapters, totalChapters: chapters.length };
    })().catch(error => {
      console.warn(`Search index build failed for book ${bookId}:`, error);
      return { status: 'error', indexedChapters: 0, totalChapters: 0, error };
    });
    bookTasks.set(key, { generation: capturedGeneration, bookGeneration, promise: task });
    try { return await task; }
    finally {
      if (bookTasks.get(key)?.promise === task) bookTasks.delete(key);
      activeBookBuilds = Math.max(0, activeBookBuilds - 1);
      if (activeBookBuilds === 0 && !buildTask) {
        latestProgress = { ...latestProgress, indexing: false };
        report(latestProgress, progressCallback);
      }
    }
  }

  async function cleanupOrphans() {
    try {
      const [books, chapterKeys, entries] = await Promise.all([
        store.getAllBooks(), store.getAllChapterKeys(), store.getAllSearchIndexEntries()
      ]);
      const bookIds = new Set(books.map(book => String(book.id)));
      const chapterIds = new Set(chapterKeys.map(chapter => `${chapter.bookId}:${chapter.chapterIndex}`));
      let removed = 0;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const key = `${entry?.bookId}:${entry?.chapterIndex}`;
        if (!entry || !bookIds.has(String(entry.bookId)) || !chapterIds.has(key)
          || !isStructurallyValidSearchIndexEntry(entry)) {
          try {
            if (entry?.bookId !== undefined && entry?.chapterIndex !== undefined) {
              await store.deleteSearchIndexChapter(entry.bookId, entry.chapterIndex);
            }
            removed++;
          } catch (error) {
            console.warn('Search index orphan cleanup failed:', error);
          }
        }
        if ((i + 1) % 100 === 0 && i + 1 < entries.length) await scheduleIdle(() => undefined);
      }
      return { removed };
    } catch (error) {
      console.warn('Search index recovery scan failed:', error);
      return { removed: 0, error };
    }
  }

  async function buildSearchIndex({ progressCallback = null } = {}) {
    const capturedGeneration = generation;
    const books = await store.getAllBooks();
    const chapterLists = await Promise.all(books.map(book => store.getBookChaptersMeta(book.id)));
    const totalChapters = chapterLists.reduce((count, chapters) => count + chapters.length, 0);
    let indexedChapters = 0;
    let visited = 0;
    latestProgress = { indexing: totalChapters > 0, indexedChapters, totalChapters };
    for (let bookIndex = 0; bookIndex < books.length; bookIndex++) {
      if (capturedGeneration !== generation) return { status: 'cancelled', indexedChapters, totalChapters };
      const bookId = books[bookIndex].id;
      for (const chapter of chapterLists[bookIndex]) {
        if (capturedGeneration !== generation) return { status: 'cancelled', indexedChapters, totalChapters };
        const entry = await ensureChapterIndex(bookId, chapter.chapterIndex);
        if (entry) indexedChapters++;
        visited++;
        report({ indexedChapters, totalChapters, bookId: Number(bookId), chapterIndex: chapter.chapterIndex }, progressCallback);
        if (visited % Math.max(1, batchSize) === 0 && visited < totalChapters) {
          await scheduleIdle(() => undefined);
        }
      }
    }
    latestProgress = { indexing: false, indexedChapters, totalChapters };
    fullIndexValidated = true;
    report(latestProgress, progressCallback);
    return { status: 'complete', indexedChapters, totalChapters };
  }

  async function searchIndexedLibrary(query, options = {}) {
    const {
      limit = DEFAULT_SEARCH_LIMIT, offset = 0, signal,
      requestId = 0, isCurrent = () => true, progressCallback = null
    } = options;
    const queryNormalized = normalizeSearchText(query);
    const empty = { requestId, queryNormalized, results: [], totalMatches: 0, truncated: false, cancelled: false };
    if (queryNormalized.length < MIN_NORMALIZED_QUERY_LENGTH
      || queryNormalized.length > MAX_NORMALIZED_QUERY_LENGTH) return empty;

    const capturedGeneration = generation;
    const active = () => !signal?.aborted && isCurrent(requestId) && capturedGeneration === generation;
    const maxResults = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(Number(limit) || DEFAULT_SEARCH_LIMIT)));
    const startOffset = Math.max(0, Math.min(MAX_SEARCH_OFFSET, Math.trunc(Number(offset) || 0)));
    const pageLimit = Math.min(maxResults, MAX_SEARCH_LIMIT - startOffset);
    const windowSize = startOffset + pageLimit;
    const books = await store.getAllBooks();
    if (!active()) return { ...empty, cancelled: true };
    const capturedBookGenerations = new Map(books.map(book => [String(book.id), getBookGeneration(book.id)]));
    const isBookCurrent = bookId => capturedBookGenerations.get(String(bookId)) === getBookGeneration(bookId);
    const chapterLists = await Promise.all(books.map(book => store.getBookChaptersMeta(book.id)));
    const totalChapters = chapterLists.reduce((total, list) => total + list.length, 0);
    let scannedChapters = 0;
    let totalMatches = 0;
    let truncated = false;
    let topResults = [];
    let batch = [];

    const addResult = result => {
      if (!windowSize) return;
      let low = 0;
      let high = topResults.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareResults(topResults[middle], result) <= 0) low = middle + 1;
        else high = middle;
      }
      if (low < windowSize) {
        topResults.splice(low, 0, result);
        if (topResults.length > windowSize) topResults.pop();
      } else if (topResults.length < windowSize) topResults.push(result);
    };

    const flushBatch = async () => {
      if (!batch.length) return true;
      const batchBookIds = [...new Set(batch.map(chapter => String(chapter.bookId)))];
      const response = await searchLibrary(query, {
        chapters: batch,
        books,
        limit: MAX_SEARCH_LIMIT,
        requestId,
        signal,
        isCurrent: id => active() && id === requestId && batchBookIds.every(bookId => isBookCurrent(bookId)),
        batchSize: 8
      });
      batch = [];
      if (response.cancelled || !active()) return false;
      totalMatches += response.totalMatches;
      truncated ||= response.truncated;
      for (const result of response.results) addResult(result);
      return true;
    };

    for (let bookIndex = 0; bookIndex < books.length; bookIndex++) {
      const book = books[bookIndex];
      for (const meta of chapterLists[bookIndex]) {
        if (!active() || !isBookCurrent(book.id)) return { ...empty, cancelled: true };
        let entry = null;
        if (fullIndexValidated) {
          try { entry = await store.getSearchIndexEntry(book.id, meta.chapterIndex); }
          catch (error) { console.warn('Unable to read search index entry:', error); }
          if (!isStructurallyValidSearchIndexEntry(entry)
            || entry.bookId !== Number(book.id) || entry.chapterIndex !== Number(meta.chapterIndex)) entry = null;
        }
        if (!entry) {
          try { entry = await ensureChapterIndex(book.id, meta.chapterIndex); }
          catch (error) { console.warn('Unable to validate search index entry:', error); }
        }
        if (!active() || !isBookCurrent(book.id)) return { ...empty, cancelled: true };
        const indexMayMatch = !entry || entry.paragraphs.some(paragraph => paragraph.normalizedText.includes(queryNormalized));

        if (indexMayMatch) {
          let source = null;
          try { source = await readSource(book.id, meta.chapterIndex); }
          catch (error) { console.warn('Unable to load source for search result:', error); }
          if (!active() || !isBookCurrent(book.id)) return { ...empty, cancelled: true };
          if (source) {
            let entryMatchesSource = !!entry;
            if (entry) {
              const currentFingerprints = createSearchFingerprints(source.content, source.rules, source.enableCleaner);
              entryMatchesSource = currentFingerprints.contentFingerprint === entry.contentFingerprint
                && currentFingerprints.rulesFingerprint === entry.rulesFingerprint;
              if (!entryMatchesSource) {
                try { entry = await ensureChapterIndex(book.id, meta.chapterIndex); }
                catch (error) { console.warn('Unable to rebuild stale search index entry:', error); }
              }
            }
            if (!active() || !isBookCurrent(book.id)) return { ...empty, cancelled: true };
            const paragraphs = projectChapterText(source.content, source.rules, source.enableCleaner);
            const sourceMayMatch = paragraphs.some(paragraph => normalizeSearchText(paragraph.text).includes(queryNormalized));
            if (!entryMatchesSource || !entry || sourceMayMatch) {
              batch.push({
                bookId: book.id,
                chapterIndex: meta.chapterIndex,
                title: meta.title,
                paragraphs
              });
            }
          }
        }

        scannedChapters++;
        report({ phase: 'searching', indexedChapters: scannedChapters, totalChapters }, progressCallback);
        if (batch.length >= 8 && !(await flushBatch())) return { ...empty, cancelled: true };
        if (scannedChapters % Math.max(1, batchSize) === 0) {
          await yieldToEventLoop();
          if (!active()) return { ...empty, cancelled: true };
        }
      }
    }
    if (!(await flushBatch()) || !active()
      || topResults.some(result => !isBookCurrent(result.bookId))) return { ...empty, cancelled: true };
    return {
      requestId,
      queryNormalized,
      results: topResults.slice(startOffset, startOffset + pageLimit),
      totalMatches,
      truncated: truncated || totalMatches > windowSize,
      cancelled: false
    };
  }

  function scheduleBookBuild(bookId) {
    void scheduleIdle(() => indexBook(bookId)).catch(error => console.warn('Scheduled search index build failed:', error));
  }

  function scheduleLibraryBuild() {
    if (buildTask) {
      restartBuildRequested = true;
      return;
    }
    buildTask = scheduleIdle(async () => {
      try { return await buildSearchIndex(); }
      finally {
        buildTask = null;
        if (restartBuildRequested) {
          restartBuildRequested = false;
          scheduleLibraryBuild();
        }
      }
    }).catch(error => {
      buildTask = null;
      console.warn('Scheduled full search index build failed:', error);
    });
  }

  async function removeBookFromIndex(bookId) {
    bumpBookGeneration(bookId);
    try { await store.deleteSearchIndexForBook(bookId); }
    catch (error) { console.warn(`Search index removal failed for book ${bookId}:`, error); }
  }

  async function invalidateBookIndex(bookId, { rebuild = true } = {}) {
    bumpBookGeneration(bookId);
    try { await store.deleteSearchIndexForBook(bookId); }
    catch (error) { console.warn(`Search index invalidation failed for book ${bookId}:`, error); }
    if (rebuild) scheduleBookBuild(bookId);
  }

  async function invalidateAllSearchIndex({ rebuild = true } = {}) {
    generation++;
    fullIndexValidated = false;
    try { await store.clearSearchIndex(); }
    catch (error) { console.warn('Search index invalidation failed:', error); }
    if (rebuild) scheduleLibraryBuild();
  }

  function handleMutation(change) {
    if (!change) return;
    if (change.type === 'book-added') {
      scheduleBookBuild(change.bookId);
    } else if (change.type === 'book-deleted') {
      void removeBookFromIndex(change.bookId);
    } else if (change.type === 'database-restored' || change.type === 'cleaner-setting-changed'
      || change.global) {
      void invalidateAllSearchIndex();
    } else if (change.type === 'rules-changed') {
      for (const bookId of change.bookIds || []) void invalidateBookIndex(bookId);
    }
  }

  async function start({ progressCallback = null } = {}) {
    if (started && (buildTask || fullIndexValidated)) return { status: 'started' };
    if (!started) {
      started = true;
      disposeSubscription = store.subscribeSearchIndexChanges?.(handleMutation) || null;
    }
    await cleanupOrphans();
    // Existing libraries are indexed lazily in the background, in batches.
    if (!buildTask && !fullIndexValidated) {
      buildTask = scheduleIdle(async () => {
        try { return await buildSearchIndex({ progressCallback }); }
        finally {
          buildTask = null;
          if (restartBuildRequested) {
            restartBuildRequested = false;
            scheduleLibraryBuild();
          }
        }
      }).catch(error => {
        buildTask = null;
        console.warn('Initial search index build failed:', error);
      });
    }
    return { status: 'started' };
  }

  function stop() {
    generation++;
    fullIndexValidated = false;
    started = false;
    disposeSubscription?.();
    disposeSubscription = null;
  }

  return {
    start,
    stop,
    buildSearchIndex,
    indexBook,
    indexChapter,
    ensureChapterIndex,
    removeBookFromIndex,
    invalidateBookIndex,
    invalidateAllSearchIndex,
    cleanupOrphans,
    search: searchIndexedLibrary,
    getProgress: () => ({ ...latestProgress })
  };
}
