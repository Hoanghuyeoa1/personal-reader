import assert from 'node:assert/strict';
import {
  createSearchController,
  normalizeSearchText,
  normalizeVietnameseWithMap,
  projectChapterText,
  searchLibrary,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT
} from './search.js';
import { cleanChapterText } from './cleaner.js';
import { TTSEngine } from './tts.js';

function chapter(bookId, chapterIndex, content, extra = {}) {
  return { bookId, chapterIndex, title: `Chương ${chapterIndex + 1}`, content, ...extra };
}

// Vietnamese accent folding, đ/Đ, case, composed and decomposed input.
assert.equal(normalizeSearchText(' Kiếm   Hiệp '), 'kiem hiep');
assert.equal(normalizeSearchText('ĐẠO'), 'dao');
assert.equal(normalizeSearchText('Trường Sinh'), 'truong sinh');
assert.equal(normalizeSearchText('TRƯỜNG SINH'), 'truong sinh');
assert.equal(normalizeSearchText('e\u0301'), 'e');

// Projected text matches the reader's chunk rendering and keeps logical pIdx gaps.
const source = 'First. Second!\n\n\n Third sentence.';
const sourceCopy = source;
const projection = projectChapterText(source, [], false);
const cleaned = cleanChapterText(source, { rules: [], enableCleaner: false });
const expected = [];
for (let pIdx = 0, paras = cleaned.split(/\n+/); pIdx < paras.length; pIdx++) {
  const text = paras[pIdx].trim();
  if (!text) continue;
  expected.push({ paragraphIndex: pIdx, text: TTSEngine.prototype.splitIntoSmartChunks.call({}, text).map(chunk => `${chunk} `).join('') });
}
assert.deepEqual(projection, expected);
assert.equal(source, sourceCopy, 'projection does not mutate source');

// Match offsets map normalized text back to original UTF-16 ranges, including
// complete combining sequences, collapsed whitespace and surrogate pairs.
const nfd = 'tru\u0300o\u031bng';
const mapped = normalizeVietnameseWithMap(nfd);
const mappedStart = mapped.normalizedText.indexOf('truong');
const mappedEnd = mappedStart + 'truong'.length;
assert.equal(nfd.slice(mapped.normalizedToOriginal[mappedStart].start, mapped.normalizedToOriginal[mappedEnd - 1].end), nfd);
const nfdResult = await searchLibrary('truong', {
  chapters: [{ bookId: 9, chapterIndex: 2, paragraphs: [{ paragraphIndex: 3, text: nfd }] }]
});
assert.equal(nfdResult.results[0].matchedText, nfd);
assert.equal(nfd.slice(nfdResult.results[0].matchStart, nfdResult.results[0].matchEnd), nfd);
const spaced = normalizeVietnameseWithMap('a   b');
assert.deepEqual(spaced.normalizedToOriginal[1], { start: 1, end: 4 });
const emojiMap = normalizeVietnameseWithMap('😀 x');
assert.equal('😀 x'.slice(emojiMap.normalizedToOriginal[0].start, emojiMap.normalizedToOriginal[1].end), '😀');

const matchingChapters = [
  chapter(2, 0, 'Kiếm Hiệp và kiem hiep; Đạo, dao; Trường Sinh.'),
  chapter(1, 1, 'Trường Sinh xuất hiện ở đây. Trường Sinh trở lại.', { paragraphs: [{ paragraphIndex: 4, text: 'Trường Sinh xuất hiện ở đây. Trường Sinh trở lại. ' }] })
];
const books = [{ id: 1, title: 'Một' }, { id: 2, title: 'Hai' }];

const accentSearch = await searchLibrary('kiem hiep', { chapters: matchingChapters, books });
assert.equal(accentSearch.results.length, 2);
assert.equal(accentSearch.results[0].matchedText, 'kiem hiep');
assert.equal(accentSearch.results[0].bookId, 2);
assert.ok(accentSearch.results[0].matchStart > 0);
assert.equal(accentSearch.results[0].paragraphIndex, 0);
assert.equal(accentSearch.results[0].snippet.text.slice(accentSearch.results[0].snippet.matchStart, accentSearch.results[0].snippet.matchEnd), 'kiem hiep');

const dao = await searchLibrary('dao', { chapters: matchingChapters, books });
assert.deepEqual(dao.results.map(result => result.matchedText), ['dao', 'Đạo']);
const phrase = await searchLibrary('TRUONG SINH', { chapters: matchingChapters, books });
assert.equal(phrase.totalMatches, 3);
assert.equal(phrase.results[0].matchedText, 'Trường Sinh');
assert.deepEqual(phrase.results.slice(1).map(item => [item.bookId, item.matchStart]), [[1, 29], [2, 34]]);

// Multiple occurrences are non-overlapping, capped at 3 per paragraph.
const repeatedText = `${'ab '.repeat(10)}`;
const repeated = await searchLibrary('ab', { chapters: [chapter(3, 0, repeatedText)] });
assert.equal(repeated.totalMatches, 10);
assert.equal(repeated.results.length, 3);
assert.equal(repeated.truncated, true);

// Query validation, limits and stable deterministic ordering.
assert.equal((await searchLibrary(null, { chapters: matchingChapters })).results.length, 0);
assert.equal((await searchLibrary('   ', { chapters: matchingChapters })).results.length, 0);
assert.equal((await searchLibrary('a', { chapters: matchingChapters })).results.length, 0);
assert.equal((await searchLibrary('x'.repeat(10000), { chapters: matchingChapters })).results.length, 0);
assert.equal((await searchLibrary('😀', { chapters: [chapter(1, 0, '😀 there')] })).results[0].matchedText, '😀');
assert.equal(DEFAULT_SEARCH_LIMIT, 200);
assert.equal(MAX_SEARCH_LIMIT, 500);
const manyChapters = Array.from({ length: 600 }, (_, i) => chapter(i + 1, 0, 'needle here'));
const limited = await searchLibrary('needle', { chapters: manyChapters, limit: 900 });
assert.equal(limited.results.length, MAX_SEARCH_LIMIT);
assert.equal(limited.totalMatches, 600);
assert.equal(limited.truncated, true);
assert.equal((await searchLibrary('needle', { chapters: manyChapters })).results.length, DEFAULT_SEARCH_LIMIT);
const paged = await searchLibrary('needle', { chapters: manyChapters, limit: 10, offset: 10 });
assert.deepEqual(paged.results.map(item => item.bookId), Array.from({ length: 10 }, (_, i) => i + 11));
const run1 = await searchLibrary('needle', { chapters: manyChapters });
const run2 = await searchLibrary('needle', { chapters: manyChapters });
assert.deepEqual(run1.results.map(item => item.rank), run2.results.map(item => item.rank));

// Stale generation protection: starting B cancels the in-flight A request.
const controller = createSearchController();
const largeSet = Array.from({ length: 300 }, (_, i) => chapter(i + 1, 0, 'alpha beta', { paragraphs: [{ paragraphIndex: 0, text: 'alpha beta ' }] }));
const stalePromise = controller.search('alpha', { chapters: largeSet, batchSize: 1 });
const latest = await controller.search('beta', { chapters: largeSet, batchSize: 1 });
const stale = await stalePromise;
assert.equal(latest.cancelled, false);
assert.equal(latest.queryNormalized, 'beta');
assert.equal(stale.cancelled, true);
assert.equal(stale.results.length, 0);
const cancelled = controller.search('alpha', { chapters: largeSet, batchSize: 1 });
controller.cancel();
assert.equal((await cancelled).cancelled, true);

console.log('test_search.mjs: all core search assertions passed');
