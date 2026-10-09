import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class FakeDexie {
  version() { return { stores: () => this }; }
  async open() { return this; }
}

globalThis.window = { Dexie: FakeDexie };
const { resolveBookmarkAnchor } = await import('../bookmark.js');
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

const paragraph = (index, text) => ({
  textContent: text,
  getAttribute: name => name === 'data-para-index' ? String(index) : null
});

const oldParagraph = paragraph(2, 'Văn bản đã được cleaner thay đổi hoàn toàn.');
const movedParagraph = paragraph(7, 'Đoạn trước. Hàn Lập nhìn về phía chân trời. Đoạn sau.');
const fallback = resolveBookmarkAnchor({
  paragraphIndex: 2,
  textAnchor: 'Hàn Lập nhìn về phía chân trời.',
  prefixContext: 'Đoạn trước. ',
  suffixContext: ' Đoạn sau.'
}, [oldParagraph, movedParagraph]);
assert.equal(fallback.paragraph, movedParagraph);
assert.equal(fallback.status, 'text-anchor', 'stale paragraph indexes recover through text context');

const cleanerChanged = resolveBookmarkAnchor({
  paragraphIndex: 2,
  textAnchor: 'old paragraph text'
}, [oldParagraph]);
assert.equal(cleanerChanged.paragraph, oldParagraph);
assert.equal(cleanerChanged.status, 'index', 'a still-valid paragraph index survives cleaner changes');

const degraded = resolveBookmarkAnchor({
  paragraphIndex: 99,
  textAnchor: 'missing passage'
}, [oldParagraph, movedParagraph]);
assert.equal(degraded.paragraph, null);
assert.equal(degraded.status, 'degraded', 'a missing match degrades without removing the bookmark');

const navStart = appSource.indexOf('async function handleBookmarkNavigation');
const navEnd = appSource.indexOf('function clearBookmarkFocus', navStart);
const navigation = appSource.slice(navStart, navEnd);
assert.ok(navigation.includes('await getBookmark(bookmarkId)'));
assert.ok(navigation.includes('await getBook(bookId)'));
assert.ok(navigation.includes('await getBookChaptersMeta(bookId)'));
assert.ok(navigation.includes('const alreadyAtTarget ='));
assert.ok(navigation.includes('if (!alreadyAtTarget)'));
assert.ok(navigation.includes('await loadChapter(chapterIndex, 0, 0)'));
assert.ok(navigation.includes('await openBook(bookId, chapterIndex, {'));
assert.ok(navigation.includes('preserveChunk: savedChapterMatches'));
assert.ok(navigation.includes('restoreScroll: false'));
assert.ok(navigation.includes('resolveBookmarkAnchor(bookmark, paragraphs)'));
assert.ok(navigation.includes("scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })"));
assert.ok(navigation.includes('focusBookmarkParagraph(resolved.paragraph)'));
assert.ok(navigation.includes('pauseTemporary()'));
assert.ok(navigation.includes('Đã mở chương tương ứng.'));
assert.equal(navigation.includes('setTimeout('), false, 'navigation awaits the existing Reader promises');
assert.equal(navigation.includes('updateProgress('), false, 'bookmark navigation uses the existing progress writer');
assert.equal(navigation.includes('currentIndex ='), false, 'eye navigation does not move the TTS pointer');
assert.equal(navigation.includes('speechSynthesis'), false, 'navigation does not bypass TTSEngine');
assert.equal(navigation.includes('addHighlight('), false, 'temporary bookmark focus does not create saved highlights');
assert.ok(appSource.includes("closest?.('.search-focus-match, .bookmark-focus')"), 'keyboard shortcuts are guarded while temporary text focus is active');
const openBookStart = appSource.indexOf('async function openBook');
const openBookEnd = appSource.indexOf('async function loadChapter', openBookStart);
const openBookFlow = appSource.slice(openBookStart, openBookEnd);
assert.ok(openBookFlow.includes('options.preserveChunk === true'), 'bookmark opens can preserve the target book’s saved TTS chunk');
assert.ok(openBookFlow.includes('options.restoreScroll === false'), 'bookmark opens skip the old scroll restoration that could override the target');

const focusStart = appSource.indexOf('function clearBookmarkFocus');
const focusEnd = appSource.indexOf('async function renderBookmarkHubList', focusStart);
const focusCode = appSource.slice(focusStart, focusEnd);
assert.ok(focusCode.includes("classList.remove('bookmark-focus')"));
assert.ok(focusCode.includes("classList.add('bookmark-focus')"));
assert.ok(focusCode.includes('focus({ preventScroll: true })'));
assert.ok(focusCode.includes('2200'), 'temporary visual focus is cleaned up after its pulse');
assert.ok(cssSource.includes('.bookmark-focus'));
assert.ok(cssSource.includes('@media (prefers-reduced-motion: reduce)'));

const searchStart = appSource.indexOf('async function navigateToGlobalSearchResult');
const searchEnd = appSource.indexOf('function showMoreGlobalSearchResults', searchStart);
assert.ok(appSource.slice(searchStart, searchEnd).includes('bookmarkNavigationPending'), 'search and bookmark navigation do not race');
assert.ok(appSource.includes("'.bookmark-jump-button'"), 'the Hub exposes a dedicated navigation action');
console.log('test_bookmark_navigation.mjs: anchor fallback, completion, navigation, and focus contracts passed');
