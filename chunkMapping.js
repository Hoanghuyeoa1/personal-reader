/** Canonical Reader/TTS segmentation over already-cleaned text. UTF-16 offsets match DOM anchors. */
export const SEGMENTATION_VERSION = 'vietreader-chunks-v1';
const hasSpeech = text => /[\p{L}\p{N}]/u.test(text);

export function splitParagraphIntoChunks(paragraph) {
  const text = String(paragraph ?? '').trim();
  if (!text || !hasSpeech(text)) return [];
  const ranges = [];
  const regex = /[^.!?…;:\n]+[.!?…;:\"'”’»\)\]]*|\S+/g;
  for (const match of text.matchAll(regex)) {
    let start = match.index;
    let end = start + match[0].length;
    while (start < end && /\s/u.test(text[start])) start++;
    while (end > start && /\s/u.test(text[end - 1])) end--;
    if (start === end) continue;
    if (!hasSpeech(text.slice(start, end))) {
      if (ranges.length) ranges[ranges.length - 1].end = end;
      continue;
    }
    if (!ranges.length) start = 0; // Retain leading punctuation, never create a punctuation-only chunk.
    const sentence = text.slice(start, end);
    if (sentence.length <= 220) { ranges.push({ start, end }); continue; }
    // Preserve the established comma-clause soft limits, retaining commas at boundaries.
    const clauses = [];
    let cursor = start;
    for (const comma of sentence.matchAll(/,\s+/g)) {
      const next = start + comma.index + comma[0].length;
      clauses.push({ start: cursor, end: next }); cursor = next;
    }
    clauses.push({ start: cursor, end });
    let buffer = null;
    for (const clause of clauses) {
      if (!buffer) buffer = { ...clause };
      else if (clause.end - buffer.start < 180) buffer.end = clause.end;
      else {
        if (hasSpeech(text.slice(buffer.start, buffer.end))) ranges.push(buffer);
        else clause.start = buffer.start;
        buffer = { ...clause };
      }
    }
    if (buffer) {
      if (hasSpeech(text.slice(buffer.start, buffer.end))) ranges.push(buffer);
      else if (ranges.length) ranges[ranges.length - 1].end = buffer.end;
    }
  }
  // Include all trailing punctuation; whitespace outside ranges stays visible in Reader.
  if (ranges.length) ranges[ranges.length - 1].end = text.length;
  return ranges.map(range => {
    while (range.start < range.end && /\s/u.test(text[range.start])) range.start++;
    while (range.end > range.start && /\s/u.test(text[range.end - 1])) range.end--;
    return { ...range, text: text.slice(range.start, range.end) };
  }).filter(chunk => hasSpeech(chunk.text));
}

function sourceFingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return text.length + ':' + (hash >>> 0).toString(16);
}

export function buildChapterChunkMap(sourceText) {
  sourceText = String(sourceText ?? '');
  const chunks = [];
  const paragraphs = sourceText.split(/\n+/).map((raw, paragraphIndex) => {
    const text = raw.trim();
    const paragraphChunks = splitParagraphIntoChunks(text).map(chunk => {
      const logical = { ...chunk, index: chunks.length, paragraphIndex };
      chunks.push(logical); return logical;
    });
    return { index: paragraphIndex, text, chunks: paragraphChunks };
  });
  return { version: SEGMENTATION_VERSION, sourceText, sourceKey: sourceFingerprint(sourceText), paragraphs, chunks };
}

export function createChunkAnchor(map, index, chapterIndex) {
  const chunk = map?.chunks[index];
  if (!chunk || !Number.isSafeInteger(index)) return null;
  const paragraph = map.paragraphs[chunk.paragraphIndex].text;
  return {
    version: map.version, sourceKey: map.sourceKey, chapterIndex, index,
    paragraphIndex: chunk.paragraphIndex, start: chunk.start,
    head: chunk.text.slice(0, 80), tail: chunk.text.slice(-80),
    prefix: paragraph.slice(Math.max(0, chunk.start - 32), chunk.start),
    suffix: paragraph.slice(chunk.end, chunk.end + 32)
  };
}

export function resolveSavedChunkIndex(map, savedIndex, anchor = null, chapterIndex = 0) {
  const numeric = (typeof savedIndex === 'number' || (typeof savedIndex === 'string' && savedIndex.trim())) ? Number(savedIndex) : NaN;
  const valid = Number.isSafeInteger(numeric) && numeric >= 0;
  const index = valid ? Math.min(numeric, Math.max(0, map.chunks.length - 1)) : 0;
  if (!map.chunks.length) return { index: 0, status: 'empty' };
  if (!anchor) return { index, status: valid && numeric === index ? 'legacy-index' : 'invalid-index' };
  if (anchor.chapterIndex !== chapterIndex) return { index: 0, status: 'chapter-mismatch' };
  const matchesText = chunk => chunk.text.slice(0, 80) === anchor.head && chunk.text.slice(-80) === anchor.tail;
  const candidate = map.chunks[index];
  if (anchor.version === map.version && anchor.sourceKey === map.sourceKey && anchor.index === index &&
      candidate.paragraphIndex === anchor.paragraphIndex && candidate.start === anchor.start && matchesText(candidate)) {
    return { index, status: 'exact' };
  }
  if (typeof anchor.head === 'string' && anchor.head && typeof anchor.tail === 'string') {
    let matches = map.chunks.filter(matchesText);
    if (matches.length > 1) matches = matches.filter(chunk => {
      const text = map.paragraphs[chunk.paragraphIndex].text;
      return text.slice(Math.max(0, chunk.start - 32), chunk.start) === anchor.prefix && text.slice(chunk.end, chunk.end + 32) === anchor.suffix;
    });
    if (matches.length === 1) return { index: matches[0].index, status: 'text-anchor' };
  }
  const paragraph = map.paragraphs.find(p => p.index === anchor.paragraphIndex && p.chunks.length);
  if (paragraph && Number.isSafeInteger(anchor.start) && anchor.start >= 0) {
    const nearest = paragraph.chunks.find(chunk => chunk.end > anchor.start) || paragraph.chunks.at(-1);
    return { index: nearest.index, status: 'paragraph-fallback' };
  }
  return { index, status: 'index-fallback' };
}
