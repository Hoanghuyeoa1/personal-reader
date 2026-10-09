import assert from 'node:assert/strict';

// Verify the real Dexie declarations without touching a user's IndexedDB.
class FakeDexie {
  constructor(name) { this.name = name; this.versions = []; }
  version(version) {
    const record = { version, stores: null };
    this.versions.push(record);
    return { stores: schema => { record.stores = schema; return this; } };
  }
  async open() { return this; }
}
globalThis.window = { Dexie: FakeDexie };
const storageModule = await import('./storage.js');
const { createSearchFingerprints, createSearchIndexService, SEARCH_INDEX_FORMAT_VERSION, SEARCH_ALGORITHM_VERSION } = await import('./search.js');
const database = await storageModule.initDB();
assert.deepEqual(database.versions.map(item => item.version), [1, 2, 3, 4, 5, 6]);
assert.deepEqual(database.versions[0].stores, {
  books: '++id, title, author, totalChapters, currentChapterIndex, lastReadAt, createdAt',
  chapters: '++id, [bookId+chapterIndex], bookId, chapterIndex, title',
  settings: 'key'
});
assert.deepEqual(database.versions[1].stores, { audioCache: 'key, provider, voice, createdAt' });
assert.deepEqual(database.versions[2].stores, {
  customRules: '++id, bookId, isEnabled, createdAt',
  highlights: '++id, [bookId+chapterIndex], bookId, chapterIndex, paragraphIndex, createdAt'
});
assert.deepEqual(database.versions[3].stores, { searchIndex: '[bookId+chapterIndex], bookId' });
assert.deepEqual(database.versions[4].stores, { bookmarks: '++id, bookId, [bookId+chapterIndex]' });
assert.deepEqual(database.versions[5].stores, { readingSessions: 'id, bookId, startedAt' });
const fakeRows = { books: [], chapters: [], settings: [], customRules: [], highlights: [], bookmarks: [], readingSessions: [], searchIndex: [] };
let fakeBookId = 40;
database.books = {
  toArray: async () => [...fakeRows.books],
  get: async id => fakeRows.books.find(book => book.id === id),
  add: async record => { const id = ++fakeBookId; fakeRows.books.push({ ...record, id }); return id; },
  delete: async id => { fakeRows.books = fakeRows.books.filter(book => book.id !== id); }
};
database.chapters = {
  toArray: async () => [...fakeRows.chapters],
  bulkAdd: async records => { fakeRows.chapters.push(...records); },
  where: field => ({ equals: value => ({
    first: async () => fakeRows.chapters.find(chapter => field === '[bookId+chapterIndex]'
      ? chapter.bookId === value[0] && chapter.chapterIndex === value[1]
      : chapter.bookId === value),
    delete: async () => { fakeRows.chapters = fakeRows.chapters.filter(chapter => field === 'bookId' ? chapter.bookId !== value : true); }
  }) })
};
database.settings = {
  toArray: async () => [...fakeRows.settings],
  get: async key => fakeRows.settings.find(item => item.key === key),
  put: async record => { fakeRows.settings = fakeRows.settings.filter(item => item.key !== record.key); fakeRows.settings.push(record); }
};
database.customRules = {
  toArray: async () => [...fakeRows.customRules],
  add: async record => { const id = fakeRows.customRules.length + 1; fakeRows.customRules.push({ ...record, id }); return id; },
  get: async id => fakeRows.customRules.find(rule => rule.id === id),
  update: async (id, updates) => { const rule = fakeRows.customRules.find(item => item.id === id); if (!rule) return 0; Object.assign(rule, updates); return 1; },
  delete: async id => { fakeRows.customRules = fakeRows.customRules.filter(rule => rule.id !== id); },
  bulkAdd: async records => { for (const record of records) await database.customRules.add(record); },
  clear: async () => { fakeRows.customRules = []; },
  bulkDelete: async ids => { fakeRows.customRules = fakeRows.customRules.filter(rule => !ids.includes(rule.id)); }
};
database.highlights = {
  toArray: async () => [...fakeRows.highlights],
  add: async record => { fakeRows.highlights.push(record); }
};
database.bookmarks = {
  toArray: async () => [...fakeRows.bookmarks],
  bulkAdd: async records => { fakeRows.bookmarks.push(...records); },
  clear: async () => { fakeRows.bookmarks = []; },
  where: field => ({ equals: value => ({ delete: async () => {
    const before = fakeRows.bookmarks.length;
    fakeRows.bookmarks = fakeRows.bookmarks.filter(item => field === 'bookId' ? item.bookId !== value : true);
    return before - fakeRows.bookmarks.length;
  } }) })
};
database.readingSessions = {
  toArray: async () => [...fakeRows.readingSessions],
  bulkAdd: async records => { fakeRows.readingSessions.push(...records); },
  clear: async () => { fakeRows.readingSessions = []; },
  put: async record => {
    fakeRows.readingSessions = fakeRows.readingSessions.filter(item => item.id !== record.id);
    fakeRows.readingSessions.push(record);
  },
  where: field => ({ equals: value => ({
    toArray: async () => fakeRows.readingSessions.filter(item => item[field] === value),
    delete: async () => {
      const before = fakeRows.readingSessions.length;
      fakeRows.readingSessions = fakeRows.readingSessions.filter(item => item[field] !== value);
      return before - fakeRows.readingSessions.length;
    }
  }) })
};
database.searchIndex = {
  toArray: async () => [...fakeRows.searchIndex],
  get: async key => fakeRows.searchIndex.find(entry => entry.bookId === key[0] && entry.chapterIndex === key[1]),
  put: async entry => { fakeRows.searchIndex = fakeRows.searchIndex.filter(item => !(item.bookId === entry.bookId && item.chapterIndex === entry.chapterIndex)); fakeRows.searchIndex.push(entry); },
  clear: async () => { fakeRows.searchIndex = []; },
  where: field => ({ equals: value => ({ delete: async () => {
    fakeRows.searchIndex = fakeRows.searchIndex.filter(entry => field === 'bookId' ? entry.bookId !== value : true);
  } }) })
};
database.transaction = async (...args) => args.at(-1)();
const backup = await storageModule.exportDatabase();
assert.equal(backup.version, 5);
assert.deepEqual(backup.bookmarks, []);
assert.deepEqual(backup.readingSessions, []);
assert.equal(Object.hasOwn(backup, 'searchIndex'), false);

const storageMutations = [];
const unsubscribeStorage = storageModule.subscribeSearchIndexChanges(change => storageMutations.push(change));
const addedId = await storageModule.saveBookWithChapters({ title: 'Stored book' }, [{ content: 'Stored chapter' }]);
assert.equal(storageMutations.at(-1).type, 'book-added');
assert.equal(storageMutations.at(-1).bookId, addedId);
const storedSnapshot = await storageModule.getSearchIndexSnapshot(addedId, 0);
assert.equal(storedSnapshot.chapter.content, 'Stored chapter');
assert.equal(storedSnapshot.enableCleaner, true);
const testIndexEntry = { bookId: addedId, chapterIndex: 0, payload: true };
assert.equal(await storageModule.commitSearchIndexEntryIfCurrent(testIndexEntry, source => source.chapter.content === 'Stored chapter'), true);
assert.equal(await storageModule.commitSearchIndexEntryIfCurrent({ ...testIndexEntry, payload: false }, source => source.chapter.content === 'not current'), false);
await storageModule.addCustomRule({ findText: 'x', replaceText: 'y' });
assert.equal(storageMutations.at(-1).type, 'rules-changed');
assert.equal(storageMutations.at(-1).global, true);
await storageModule.setSetting('enableGlobalCleaner', false);
assert.equal(storageMutations.at(-1).type, 'cleaner-setting-changed');
await storageModule.deleteBook(addedId);
assert.equal(storageMutations.at(-1).type, 'book-deleted');
fakeRows.searchIndex.push({ bookId: 77, chapterIndex: 4 });
await storageModule.importDatabase({
  books: [{ id: 5, title: 'Restored' }],
  chapters: [{ id: 6, bookId: 5, chapterIndex: 0, content: 'restored source' }],
  customRules: [{ id: 7, bookId: 5, findText: 'old', replaceText: 'new' }],
  highlights: [],
  bookmarks: [{ id: 8, bookId: 5, chapterIndex: 0, paragraphIndex: 0, previewText: 'restored mark' }]
}, false);
const importedBook = fakeRows.books.find(book => book.title === 'Restored');
assert.ok(importedBook?.id);
assert.equal(fakeRows.customRules.find(rule => rule.findText === 'old').bookId, importedBook.id);
assert.equal(fakeRows.bookmarks.find(item => item.previewText === 'restored mark').bookId, importedBook.id);
assert.equal(fakeRows.searchIndex.length, 0, 'restore clears derived cache instead of importing it');
assert.deepEqual([storageMutations.at(-1).type, storageMutations.at(-1).mode], ['database-restored', 'append']);
unsubscribeStorage();

const books = new Map([[1, { id: 1, title: 'Book One' }], [2, { id: 2, title: 'Book Two' }]]);
const chapters = new Map([
  ['1:0', { bookId: 1, chapterIndex: 0, title: 'First', content: 'Trường Sinh.' }],
  ['1:1', { bookId: 1, chapterIndex: 1, title: 'Empty', content: null }],
  ['2:0', { bookId: 2, chapterIndex: 0, title: 'Second', content: 'Đạo.' }]
]);
let rules = [];
let cleanerEnabled = true;
const index = new Map();
const listeners = new Set();
let blockNextRead = null;
let sourceReadCount = 0;
const keyOf = (bookId, chapterIndex) => `${Number(bookId)}:${Number(chapterIndex)}`;
const memoryStorage = {
  async getAllBooks() { return [...books.values()]; },
  async getAllChapterKeys() { return [...chapters.values()].map(({ bookId, chapterIndex }) => ({ bookId, chapterIndex })); },
  async getAllSearchIndexEntries() { return [...index.values()]; },
  async getBook(id) { return books.get(Number(id)); },
  async getBookChaptersMeta(id) { return [...chapters.values()].filter(ch => ch.bookId === Number(id)).map(ch => ({ chapterIndex: ch.chapterIndex, title: ch.title })); },
  async getChapter(bookId, chapterIndex) {
    sourceReadCount++;
    if (blockNextRead) { const pending = blockNextRead; blockNextRead = null; await pending.promise; }
    return chapters.get(keyOf(bookId, chapterIndex));
  },
  async getCustomRules(id) { return rules.filter(rule => rule.bookId == null || rule.bookId === 'global' || Number(rule.bookId) === Number(id)); },
  async getSetting() { return cleanerEnabled; },
  async getSearchIndexEntry(bookId, chapterIndex) { return index.get(keyOf(bookId, chapterIndex)); },
  async putSearchIndexEntry(entry) { index.set(keyOf(entry.bookId, entry.chapterIndex), entry); },
  async deleteSearchIndexChapter(bookId, chapterIndex) { index.delete(keyOf(bookId, chapterIndex)); },
  async deleteSearchIndexForBook(bookId) { for (const key of index.keys()) if (key.startsWith(`${Number(bookId)}:`)) index.delete(key); },
  async clearSearchIndex() { index.clear(); },
  async commitSearchIndexEntryIfCurrent(entry, validate) {
    const book = books.get(Number(entry.bookId));
    const chapter = chapters.get(keyOf(entry.bookId, entry.chapterIndex));
    const effectiveRules = rules.filter(rule => rule.bookId == null || rule.bookId === 'global' || Number(rule.bookId) === Number(entry.bookId));
    const snapshot = { book, chapter, rules: effectiveRules, enableCleaner: cleanerEnabled };
    if (!validate(snapshot)) return false;
    index.set(keyOf(entry.bookId, entry.chapterIndex), entry);
    return true;
  },
  subscribeSearchIndexChanges(listener) { listeners.add(listener); return () => listeners.delete(listener); }
};

const service = createSearchIndexService({ storage: memoryStorage, batchSize: 1 });
const waitUntil = async (condition, message) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
};
const emit = change => { for (const listener of listeners) listener(change); };

const progress = [];
const firstStart = service.start({ progressCallback: item => progress.push(item) });
await service.start({ progressCallback: item => progress.push(item) });
await firstStart;
assert.equal(listeners.size, 1, 'repeated start keeps one mutation listener');
await waitUntil(() => index.size === 3, 'initial build indexes every existing chapter');
await waitUntil(() => !service.getProgress().indexing && service.getProgress().totalChapters === 3, 'initial full index validation completes');
await waitUntil(() => progress.length > 0, 'index progress callback reports work');
assert.equal(progress.at(-1).totalChapters, 3);
assert.equal(sourceReadCount, 3, 'repeated start does not duplicate the full indexing job');
await service.start();
assert.equal(sourceReadCount, 3, 'starting a validated service does not rebuild the full index');
assert.equal(index.get('1:1').paragraphs.length, 0, 'empty chapters have valid empty entries');
assert.equal(index.get('1:0').formatVersion, SEARCH_INDEX_FORMAT_VERSION);
assert.equal(index.get('1:0').algorithmVersion, SEARCH_ALGORITHM_VERSION);

// Query API returns normalized Vietnamese matches from the index-backed service.
const accentedMatches = await service.search('Trường Sinh');
assert.equal(accentedMatches.totalMatches, 1);
assert.equal(accentedMatches.results[0].bookTitle, 'Book One');
assert.equal(accentedMatches.results[0].chapterTitle, 'First');
const unaccentedMatches = await service.search('truong sinh');
assert.equal(unaccentedMatches.totalMatches, 1);
assert.equal(unaccentedMatches.results[0].matchedText.toLowerCase(), 'trường sinh');
sourceReadCount = 0;
assert.equal((await service.search('not-present')).totalMatches, 0);
assert.equal(sourceReadCount, 0, 'validated non-candidate index entries avoid chapter source reads');
sourceReadCount = 0;
assert.equal((await service.search('truong sinh')).totalMatches, 1);
assert.equal(sourceReadCount, 1, 'only matching indexed chapters load source content');
assert.equal((await service.search('x')).results.length, 0, 'queries shorter than the normalized minimum are ignored');

// Incremental ensure leaves a current entry untouched and rebuilds missing,
// malformed, and fingerprint-stale entries from source.
const initial = index.get('1:0');
assert.equal((await service.ensureChapterIndex(1, 0)).indexedAt, initial.indexedAt);
index.set('1:0', { ...initial, paragraphs: [{ paragraphIndex: 'bad', normalizedText: 42 }] });
assert.equal((await service.ensureChapterIndex(1, 0)).paragraphs[0].normalizedText, 'truong sinh.');
index.delete('2:0');
assert.equal((await service.ensureChapterIndex(2, 0)).paragraphs[0].normalizedText, 'dao.');
chapters.set('1:0', { ...chapters.get('1:0'), content: 'Body changed.' });
assert.equal((await service.ensureChapterIndex(1, 0)).paragraphs[0].normalizedText, 'body changed.');
chapters.set('1:0', { ...chapters.get('1:0'), content: 'Body changed again.' });
const staleCandidate = await service.search('body');
assert.equal(staleCandidate.totalMatches, 1, 'candidate fingerprint mismatch rebuilds a stale entry');
assert.equal(index.get('1:0').paragraphs[0].normalizedText, 'body changed again.');

// Book rule and global rule changes invalidate the appropriate scopes.
const beforeBookRule = index.get('1:0').rulesFingerprint;
rules = [{ bookId: 1, findText: 'Body', replaceText: 'Thesis', isEnabled: true }];
emit({ type: 'rules-changed', global: false, bookIds: [1] });
await waitUntil(() => !!index.get('1:0') && index.get('1:0').rulesFingerprint !== beforeBookRule, 'book rule change rebuilds that book');
assert.equal(index.get('2:0').rulesFingerprint, createSearchFingerprints('Đạo.', [], true).rulesFingerprint);
const beforeGlobal = index.get('2:0').rulesFingerprint;
rules = [{ bookId: null, findText: 'Đạo', replaceText: 'Pháp', isEnabled: true }];
emit({ type: 'rules-changed', global: true, bookIds: [] });
await waitUntil(() => !!index.get('2:0') && index.get('2:0').rulesFingerprint !== beforeGlobal, 'global rule change rebuilds library');
assert.equal(index.get('2:0').paragraphs[0].normalizedText, 'phap.');
const beforeCleanerChange = index.get('2:0').rulesFingerprint;
cleanerEnabled = false;
emit({ type: 'cleaner-setting-changed' });
await waitUntil(() => !!index.get('2:0') && index.get('2:0').rulesFingerprint !== beforeCleanerChange, 'global cleaner setting invalidates search index');
assert.equal(index.get('2:0').rulesFingerprint, createSearchFingerprints('Đạo.', rules, false).rulesFingerprint);

// Restore invalidation clears old rows and rebuilds from restored source.
index.set('99:0', { bookId: 99, chapterIndex: 0 });
chapters.set('2:0', { ...chapters.get('2:0'), content: '' });
emit({ type: 'database-restored', mode: 'replace' });
await waitUntil(() => index.size === 3 && !index.has('99:0') && index.get('2:0')?.paragraphs.length === 0, 'restore clears cache and schedules rebuild');

// New books build in the background; deletion removes cached entries.
books.set(3, { id: 3, title: 'New' });
chapters.set('3:0', { bookId: 3, chapterIndex: 0, title: 'New chapter', content: 'new text' });
emit({ type: 'book-added', bookId: 3 });
await waitUntil(() => index.has('3:0'), 'added book schedules an index build');
await waitUntil(() => !service.getProgress().indexing, 'background book build clears indexing progress');
books.delete(3);
chapters.delete('3:0');
emit({ type: 'book-deleted', bookId: 3 });
await waitUntil(() => !index.has('3:0'), 'deleted book index entries are removed');

// Orphans are pruned, and invalidation cancels an in-flight writer so it
// cannot resurrect an entry after a rules/content lifecycle change.
index.set('77:8', { bookId: 77, chapterIndex: 8, formatVersion: 1, algorithmVersion: 1 });
assert.equal((await service.cleanupOrphans()).removed, 1);
let releaseRead;
blockNextRead = { promise: new Promise(resolve => { releaseRead = resolve; }) };
const cancelledBuild = service.indexChapter(1, 0);
await service.invalidateBookIndex(1, { rebuild: false });
releaseRead();
assert.equal((await cancelledBuild).status, 'cancelled');
assert.equal(index.has('1:0'), false);
assert.equal((await service.indexChapter(1, 0)).status, 'indexed');

let releaseQueryRead;
blockNextRead = { promise: new Promise(resolve => { releaseQueryRead = resolve; }) };
const inFlightDeleteSearch = service.search('body');
await waitUntil(() => typeof releaseQueryRead === 'function' && blockNextRead === null, 'query reaches a matching chapter source read');
books.delete(1);
chapters.delete('1:0');
emit({ type: 'book-deleted', bookId: 1 });
releaseQueryRead();
assert.equal((await inFlightDeleteSearch).cancelled, true, 'deleting a book cancels in-flight results for that book');

service.stop();
assert.equal(listeners.size, 0, 'stop removes the search-index mutation listener');
console.log('test_search_index.mjs: all index lifecycle assertions passed');
