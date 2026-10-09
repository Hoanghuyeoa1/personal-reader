import { normalizeSearchText, normalizeVietnameseWithMap } from './search.js';

/** Locate the best current paragraph match for a possibly stale indexed result. */
export function findSearchAnchor(result, paragraphs) {
  if (!Array.isArray(paragraphs) || !paragraphs.length) return null;
  const query = result?.queryNormalized || normalizeSearchText(result?.matchedText || '');
  if (!query) return null;
  const preferredParagraph = String(result.paragraphIndex);
  const contextBefore = normalizeSearchText(result.contextBefore || '');
  const contextAfter = normalizeSearchText(result.contextAfter || '');
  const candidates = [];

  const overlapAtEnd = (actual, expected) => {
    const max = Math.min(actual.length, expected.length);
    for (let size = max; size > 0; size--) {
      if (actual.slice(-size) === expected.slice(-size)) return size;
    }
    return 0;
  };
  const overlapAtStart = (actual, expected) => {
    const max = Math.min(actual.length, expected.length);
    for (let size = max; size > 0; size--) {
      if (actual.slice(0, size) === expected.slice(0, size)) return size;
    }
    return 0;
  };

  for (const paragraph of paragraphs) {
    const text = paragraph.textContent || '';
    const mapping = normalizeVietnameseWithMap(text);
    const targetStart = Math.max(0, Number(result.matchStart) || 0);
    let from = 0;
    while (from <= mapping.normalizedText.length - query.length) {
      const normalizedStart = mapping.normalizedText.indexOf(query, from);
      if (normalizedStart < 0) break;
      const first = mapping.normalizedToOriginal[normalizedStart];
      const last = mapping.normalizedToOriginal[normalizedStart + query.length - 1];
      if (first && last) {
        const actualBefore = mapping.normalizedText.slice(Math.max(0, normalizedStart - contextBefore.length), normalizedStart);
        const actualAfter = mapping.normalizedText.slice(normalizedStart + query.length, normalizedStart + query.length + contextAfter.length);
        const contextScore = overlapAtEnd(actualBefore, contextBefore) + overlapAtStart(actualAfter, contextAfter);
        const exactOffset = first.start === targetStart ? 8 : 0;
        const preferred = paragraph.getAttribute('data-para-index') === preferredParagraph ? 1 : 0;
        candidates.push({ paragraph, start: first.start, end: last.end, score: exactOffset + contextScore * 2 + preferred });
      }
      from = normalizedStart + Math.max(1, query.length);
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  return candidates[0] || null;
}
