import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findSearchAnchor } from '../searchNavigation.js';
import { normalizeSearchText, searchLibrary } from '../search.js';

const paragraph = (index, text) => ({ textContent: text, getAttribute: name => name === 'data-para-index' ? String(index) : null });

const visibleText = 'Tài liệu ghi rằng Trường Sinh trở về.';
const searchResponse = await searchLibrary('truong sinh', {
  books: [{ id: 9, title: 'Test Book' }],
  chapters: [{ bookId: 9, chapterIndex: 3, title: 'Test Chapter', paragraphs: [{ paragraphIndex: 6, text: visibleText }] }]
});
assert.equal(searchResponse.results[0].bookId, 9);
assert.equal(searchResponse.results[0].chapterIndex, 3);
const integratedAnchor = findSearchAnchor(searchResponse.results[0], [paragraph(6, visibleText)]);
assert.equal(visibleText.slice(integratedAnchor.start, integratedAnchor.end), 'Trường Sinh');
const text = 'Trước đó, Trường Sinh trở về nhà.';
const matchStart = text.indexOf('Trường Sinh');
const exact = findSearchAnchor({
  paragraphIndex: 4,
  matchStart,
  queryNormalized: normalizeSearchText('Trường Sinh'),
  matchedText: 'Trường Sinh',
  contextBefore: text.slice(Math.max(0, matchStart - 32), matchStart),
  contextAfter: text.slice(matchStart + 'Trường Sinh'.length, matchStart + 'Trường Sinh'.length + 32)
}, [paragraph(4, text)]);
assert.equal(exact.paragraph.getAttribute('data-para-index'), '4');
assert.equal(text.slice(exact.start, exact.end), 'Trường Sinh');

const movedText = 'Một đoạn mở đầu riêng. A passage unique context Trường Sinh continues to shine.';
const movedAt = movedText.indexOf('Trường Sinh');
const stale = findSearchAnchor({
  paragraphIndex: 0,
  matchStart: 2,
  queryNormalized: normalizeSearchText('Trường Sinh'),
  matchedText: 'Trường Sinh',
  contextBefore: 'A passage unique context ',
  contextAfter: ' continues to shine.'
}, [paragraph(0, 'Paragraph changed and no longer contains the old match.'), paragraph(1, movedText)]);
assert.equal(stale.paragraph.getAttribute('data-para-index'), '1', 'stale paragraph index falls back to context in the chapter');
assert.equal(movedText.slice(stale.start, stale.end), 'Trường Sinh');

assert.equal(findSearchAnchor({ queryNormalized: 'khongco', paragraphIndex: 0 }, [paragraph(0, 'Nội dung đã thay đổi.')]), null);
assert.equal(findSearchAnchor({ queryNormalized: 'truong', paragraphIndex: 0 }, []), null);

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const snippetStart = appSource.indexOf('function appendSafeHighlightedSnippet');
const snippetEnd = appSource.indexOf('function renderGlobalSearchResults', snippetStart);
const safeSnippetRenderer = appSource.slice(snippetStart, snippetEnd);
assert.ok(safeSnippetRenderer.includes('document.createTextNode'));
assert.ok(safeSnippetRenderer.includes('mark.textContent'));
assert.equal(safeSnippetRenderer.includes('innerHTML'), false, 'book snippets are rendered without HTML parsing');
const navigationStart = appSource.indexOf('async function navigateToGlobalSearchResult');
const navigationEnd = appSource.indexOf('function showMoreGlobalSearchResults', navigationStart);
const navigationFlow = appSource.slice(navigationStart, navigationEnd);
assert.ok(navigationFlow.includes('await loadChapter('));
assert.ok(navigationFlow.includes('await openBook('));
assert.ok(navigationFlow.includes('scrollIntoView('));
assert.equal(navigationFlow.includes('setTimeout('), false, 'navigation waits for the existing chapter Promise');
assert.equal(navigationFlow.includes('updateProgress('), false, 'search does not write a second progress update');
assert.equal(navigationFlow.includes('speechSynthesis'), false, 'search does not bypass the TTS abstraction');
assert.ok(appSource.includes('globalSearchUiGeneration++'));
assert.ok(appSource.includes('globalSearchAbortController?.abort()'));
assert.ok(appSource.includes('}, 250);'), 'typing uses the configured debounce');
assert.ok(appSource.includes("DOM.globalSearchModal?.classList.contains('open')"));
assert.ok(cssSource.includes('.search-focus-match'));
assert.ok(cssSource.includes('@media (max-width: 640px)'));
for (const theme of [':root', 'body.theme-dark', 'body.theme-sepia', 'body.theme-navy']) assert.ok(cssSource.includes(theme));
console.log('test_search_navigation.mjs: anchor, security, and integration contract assertions passed');
