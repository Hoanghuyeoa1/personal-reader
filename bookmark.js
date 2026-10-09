import { initDB } from './storage.js';
import { findSearchAnchor } from './searchNavigation.js';
import { normalizeSearchText } from './search.js';

const MAX_LABEL_LENGTH = 120;
const MAX_ANCHOR_LENGTH = 240;
const MAX_CONTEXT_LENGTH = 120;
const MAX_PREVIEW_LENGTH = 180;

function validId(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validIndex(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function optionalText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function formatBookmarkPreview(text, maxLength = MAX_PREVIEW_LENGTH) {
  const limit = Number.isSafeInteger(Number(maxLength)) && Number(maxLength) > 0
    ? Number(maxLength)
    : MAX_PREVIEW_LENGTH;
  const clean = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function compactContext(text, anchorOffset) {
  const source = typeof text === 'string' ? text : '';
  const beforeSource = source.slice(0, Math.max(0, Math.min(source.length, anchorOffset)));
  const clean = source.replace(/\s+/gu, ' ').trim();
  const cleanOffset = beforeSource.replace(/\s+/gu, ' ').length;
  const anchorStart = Math.max(0, cleanOffset - 48);
  const anchorEnd = Math.min(clean.length, cleanOffset + 48);
  const previewStart = Math.max(0, cleanOffset - 82);
  const previewEnd = Math.min(clean.length, cleanOffset + 98);
  return {
    textAnchor: clean.slice(anchorStart, anchorEnd).trim().slice(0, MAX_ANCHOR_LENGTH),
    prefixContext: clean.slice(Math.max(0, anchorStart - 56), anchorStart).trim(),
    suffixContext: clean.slice(anchorEnd, Math.min(clean.length, anchorEnd + 56)).trim(),
    previewText: formatBookmarkPreview(`${previewStart > 0 ? '…' : ''}${clean.slice(previewStart, previewEnd)}${previewEnd < clean.length ? '…' : ''}`)
  };
}

function paragraphIndexOf(paragraph) {
  return validIndex(paragraph?.getAttribute?.('data-para-index'));
}

function visibleRect(element) {
  try { return element?.getBoundingClientRect?.() || null; }
  catch { return null; }
}

function rectDistanceToY(rect, y) {
  if (!rect) return Infinity;
  if (y >= rect.top && y <= rect.bottom) return 0;
  return Math.min(Math.abs(y - rect.top), Math.abs(y - rect.bottom));
}

function getElementTextOffset(paragraph, element, chunks) {
  const index = chunks.indexOf(element);
  if (index < 0) return Math.floor((paragraph.textContent || '').length / 2);
  return chunks.slice(0, index).reduce((length, chunk) => length + (chunk.textContent || '').length, 0)
    + Math.floor((element.textContent || '').length / 2);
}

/**
 * Capture a position only when requested. TTS is authoritative only while
 * actively speaking and when its active rendered chunk maps to a paragraph.
 */
export function captureCurrentReadingPosition({
  bookId,
  chapterIndex,
  readerBodyContent,
  tts = null,
  readerSubHeader = null,
  ttsDock = null,
  windowRef = globalThis.window
} = {}) {
  const numericBookId = validId(bookId);
  const numericChapterIndex = validIndex(chapterIndex);
  if (!numericBookId || numericChapterIndex === null || !readerBodyContent) return null;

  let paragraphs = [];
  try {
    paragraphs = [...readerBodyContent.querySelectorAll('.reader-paragraph')]
      .filter(paragraph => paragraphIndexOf(paragraph) !== null);
  } catch { /* Malformed or detached reader DOM is treated as an empty chapter. */ }

  if (!paragraphs.length) {
    return {
      bookId: numericBookId,
      chapterIndex: numericChapterIndex,
      paragraphIndex: 0,
      textAnchor: '',
      prefixContext: '',
      suffixContext: '',
      previewText: '',
      positionSource: 'empty'
    };
  }

  let paragraph = null;
  let chunk = null;
  let positionSource = 'eye';
  let targetY = null;
  const currentChunkIndex = Number(tts?.currentIndex);
  const isActiveTts = tts?.isPlaying === true && tts?.isPaused !== true
    && Number.isSafeInteger(currentChunkIndex) && currentChunkIndex >= 0
    && Array.isArray(tts?.chunks) && currentChunkIndex < tts.chunks.length;

  if (isActiveTts) {
    try {
      const activeChunk = readerBodyContent.querySelector(
        `.tts-chunk.active-tts-chunk[data-chunk-index="${currentChunkIndex}"]`
      );
      const owner = activeChunk?.closest?.('.reader-paragraph');
      if (activeChunk && owner && readerBodyContent.contains(owner) && paragraphIndexOf(owner) !== null) {
        paragraph = owner;
        chunk = activeChunk;
        positionSource = 'tts';
      }
    } catch { /* If rendered TTS mapping is stale, use the viewport position. */ }
  }

  if (!paragraph) {
    const height = Number(windowRef?.innerHeight);
    if (!Number.isFinite(height) || height <= 0) return null;
    const headerRect = visibleRect(readerSubHeader);
    const dockRect = visibleRect(ttsDock);
    const top = headerRect && headerRect.bottom > 0 && headerRect.top < height
      ? Math.max(0, Math.min(height, headerRect.bottom))
      : 0;
    const bottom = dockRect && dockRect.height > 0 && dockRect.top < height
      ? Math.max(top, Math.min(height, dockRect.top))
      : height;
    targetY = top + (bottom - top) * 0.35;

    const candidates = paragraphs.map((item, order) => {
      const rect = visibleRect(item);
      return { item, order, rect, distance: rectDistanceToY(rect, targetY) };
    }).filter(candidate => candidate.rect);
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.distance - b.distance
      || Math.abs((a.rect.top + a.rect.bottom) / 2 - targetY) - Math.abs((b.rect.top + b.rect.bottom) / 2 - targetY)
      || a.order - b.order);
    paragraph = candidates[0].item;

    const chunks = [...(paragraph.querySelectorAll?.('.tts-chunk') || [])];
    if (chunks.length) {
      chunk = chunks.map((item, order) => {
        const rects = [...(item.getClientRects?.() || [])];
        const distance = rects.length
          ? Math.min(...rects.map(rect => rectDistanceToY(rect, targetY)))
          : Infinity;
        return { item, order, distance };
      }).sort((a, b) => a.distance - b.distance || a.order - b.order)[0]?.item || null;
    }
  }

  const paragraphIndex = paragraphIndexOf(paragraph);
  if (paragraphIndex === null) return null;
  let chunks = [];
  try { chunks = [...(paragraph.querySelectorAll?.('.tts-chunk') || [])]; }
  catch { /* Paragraph text remains a usable fallback. */ }
  const anchorOffset = chunk ? getElementTextOffset(paragraph, chunk, chunks)
    : Math.floor((paragraph.textContent || '').length / 2);
  const context = compactContext(paragraph.textContent || '', anchorOffset);
  const captured = {
    bookId: numericBookId,
    chapterIndex: numericChapterIndex,
    paragraphIndex,
    ...context,
    positionSource
  };
  if (positionSource === 'tts') captured.chunkIndex = currentChunkIndex;
  return captured;
}

function normalizeCreateInput(input) {
  if (!input || typeof input !== 'object') return null;
  const bookId = validId(input.bookId);
  const chapterIndex = validIndex(input.chapterIndex);
  const paragraphIndex = validIndex(input.paragraphIndex);
  if (!bookId || chapterIndex === null || paragraphIndex === null) return null;

  const textAnchor = optionalText(input.textAnchor, MAX_ANCHOR_LENGTH);
  const previewText = formatBookmarkPreview(input.previewText || textAnchor);
  const now = Date.now();
  const record = {
    bookId,
    chapterIndex,
    paragraphIndex,
    textAnchor,
    prefixContext: optionalText(input.prefixContext, MAX_CONTEXT_LENGTH),
    suffixContext: optionalText(input.suffixContext, MAX_CONTEXT_LENGTH),
    previewText,
    anchorVersion: 1,
    createdAt: now,
    updatedAt: now
  };
  const label = optionalText(input.label, MAX_LABEL_LENGTH);
  if (label) record.label = label;
  if (Number.isSafeInteger(Number(input.chunkIndex)) && Number(input.chunkIndex) >= 0) {
    record.chunkIndex = Number(input.chunkIndex);
  }
  return record;
}

function warnStorage(error) {
  console.warn('Bookmark storage operation failed:', error);
}

/** Creates a bookmark or returns the existing bookmark for the same paragraph. */
export async function createBookmark(input) {
  const record = normalizeCreateInput(input);
  if (!record) return null;

  try {
    const database = await initDB();
    return await database.transaction('rw', database.bookmarks, database.books, database.chapters, async () => {
      if (!(await database.books.get(record.bookId))) return null;
      const chapter = await database.chapters
        .where('[bookId+chapterIndex]')
        .equals([record.bookId, record.chapterIndex])
        .first();
      if (!chapter) return null;

      const existing = await database.bookmarks
        .where('[bookId+chapterIndex]')
        .equals([record.bookId, record.chapterIndex])
        .filter(item => Number(item.paragraphIndex) === record.paragraphIndex)
        .first();
      if (existing) {
        const updatedAt = Date.now();
        await database.bookmarks.update(existing.id, { updatedAt });
        return { ...existing, updatedAt };
      }

      const id = await database.bookmarks.add(record);
      return { ...record, id };
    });
  } catch (error) {
    warnStorage(error);
    return null;
  }
}

export async function getBookmark(id) {
  const bookmarkId = validId(id);
  if (!bookmarkId) return null;
  try {
    const database = await initDB();
    return (await database.bookmarks.get(bookmarkId)) || null;
  } catch (error) {
    warnStorage(error);
    return null;
  }
}

export async function getBookBookmarks(bookId) {
  const id = validId(bookId);
  if (!id) return [];
  try {
    const database = await initDB();
    const records = await database.bookmarks.where('bookId').equals(id).toArray();
    return records.sort((a, b) => Number(a.chapterIndex) - Number(b.chapterIndex)
      || Number(a.paragraphIndex) - Number(b.paragraphIndex)
      || Number(a.createdAt) - Number(b.createdAt)
      || Number(a.id) - Number(b.id));
  } catch (error) {
    warnStorage(error);
    return [];
  }
}

export async function getAllBookmarks() {
  try {
    const database = await initDB();
    const records = await database.bookmarks.toArray();
    return records.sort((a, b) => Number(b.createdAt) - Number(a.createdAt) || Number(b.id) - Number(a.id));
  } catch (error) {
    warnStorage(error);
    return [];
  }
}

/** Updates the optional short label. An empty label clears it. */
export async function updateBookmark(id, updates = {}) {
  const bookmarkId = validId(id);
  if (!bookmarkId || !updates || typeof updates !== 'object' || !Object.hasOwn(updates, 'label')) return null;
  try {
    const database = await initDB();
    const current = await database.bookmarks.get(bookmarkId);
    if (!current) return null;
    const label = optionalText(updates.label, MAX_LABEL_LENGTH);
    const patch = { updatedAt: Date.now() };
    if (label) patch.label = label;
    else patch.label = undefined;
    const changed = await database.bookmarks.update(bookmarkId, patch);
    if (!changed) return null;
    const updated = await database.bookmarks.get(bookmarkId);
    if (updated && !label) delete updated.label;
    return updated || null;
  } catch (error) {
    warnStorage(error);
    return null;
  }
}

export async function deleteBookmark(id) {
  const bookmarkId = validId(id);
  if (!bookmarkId) return false;
  try {
    const database = await initDB();
    if (!(await database.bookmarks.get(bookmarkId))) return false;
    await database.bookmarks.delete(bookmarkId);
    return true;
  } catch (error) {
    warnStorage(error);
    return false;
  }
}

export async function deleteBookBookmarks(bookId) {
  const id = validId(bookId);
  if (!id) return 0;
  try {
    const database = await initDB();
    return await database.bookmarks.where('bookId').equals(id).delete();
  } catch (error) {
    warnStorage(error);
    return 0;
  }
}

/** Resolve a bookmark by paragraph first, then by text/context, without throwing. */
export function resolveBookmarkAnchor(bookmark, paragraphs) {
  if (!bookmark || typeof bookmark !== 'object') return null;
  if (!Array.isArray(paragraphs)) return { paragraph: null, start: 0, end: 0, exact: false, status: 'degraded' };
  paragraphs = paragraphs.filter(item => item && typeof item.textContent === 'string');
  if (!paragraphs.length) return { paragraph: null, start: 0, end: 0, exact: false, status: 'degraded' };

  const expected = validIndex(bookmark.paragraphIndex);
  const indexedParagraph = expected === null ? null
    : paragraphs.find(item => paragraphIndexOf(item) === expected) || null;
  const queryNormalized = normalizeSearchText(bookmark.textAnchor || '');
  if (queryNormalized) {
    const result = {
      paragraphIndex: bookmark.paragraphIndex,
      queryNormalized,
      matchedText: bookmark.textAnchor,
      contextBefore: bookmark.prefixContext || '',
      contextAfter: bookmark.suffixContext || ''
    };
    if (indexedParagraph) {
      const primaryMatch = findSearchAnchor(result, [indexedParagraph]);
      if (primaryMatch) return { ...primaryMatch, exact: true, status: 'exact' };
    }
    const fallbackMatch = findSearchAnchor(result, paragraphs);
    if (fallbackMatch) {
      return { ...fallbackMatch, exact: true,
        status: fallbackMatch.paragraph === indexedParagraph ? 'exact' : 'text-anchor' };
    }
  }

  if (indexedParagraph) return { paragraph: indexedParagraph, start: 0, end: 0, exact: false, status: 'index' };
  return { paragraph: null, start: 0, end: 0, exact: false, status: 'degraded' };
}
