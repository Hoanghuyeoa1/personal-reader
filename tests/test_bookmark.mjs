import assert from 'node:assert/strict';

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
globalThis.BroadcastChannel = undefined; // Avoid retaining a Node event-loop handle in this isolated storage test.
const storage = await import('./storage.js');
const bookmarks = await import('./bookmark.js');
const database = await storage.initDB();
assert.deepEqual(database.versions.map(item => item.version), [1, 2, 3, 4, 5, 6]);
assert.deepEqual(database.versions[4].stores, {
  bookmarks: '++id, bookId, [bookId+chapterIndex]'
});
assert.deepEqual(database.versions[5].stores, { readingSessions: 'id, bookId, startedAt' });

const rows = {
  books: [{ id: 1, title: 'Existing book' }],
  chapters: [{ id: 10, bookId: 1, chapterIndex: 0, content: 'First chapter' }],
  settings: [{ key: 'theme', value: 'dark' }],
  customRules: [],
  highlights: [],
  bookmarks: [],
  readingSessions: [],
  searchIndex: []
};
let nextBookmarkId = 1;

function makeCollection(storeName, field, expected) {
  let items = () => rows[storeName].filter(record => {
    if (field === '[bookId+chapterIndex]') return record.bookId === expected[0] && record.chapterIndex === expected[1];
    return record[field] === expected;
  });
  const collection = {
    async first() { return items()[0]; },
    async toArray() { return items(); },
    async sortBy(key) { return items().sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0); },
    async delete() {
      const before = rows[storeName].length;
      rows[storeName] = rows[storeName].filter(record => !items().includes(record));
      return before - rows[storeName].length;
    },
    filter(predicate) {
      const parentItems = items;
      items = () => parentItems().filter(predicate);
      return collection;
    }
  };
  return collection;
}

function makeTable(name) {
  return {
    async get(id) { return rows[name].find(record => record.id === id); },
    async getByKey(key) { return rows[name].find(record => record.key === key); },
    async toArray() { return [...rows[name]]; },
    async count() { return rows[name].length; },
    async add(record) {
      if (name === 'bookmarks' && failNextBookmarkWrite) {
        failNextBookmarkWrite = false;
        throw new Error('simulated IndexedDB write failure');
      }
      const id = name === 'books' ? Math.max(0, ...rows[name].map(item => item.id)) + 1
        : name === 'chapters' ? Math.max(0, ...rows[name].map(item => item.id)) + 1
          : name === 'bookmarks' ? nextBookmarkId++ : Math.max(0, ...rows[name].map(item => item.id || 0)) + 1;
      rows[name].push({ ...record, id });
      return id;
    },
    async bulkAdd(records) { for (const record of records) rows[name].push({ ...record }); },
    async bulkPut(records) { for (const record of records) await this.put(record); },
    async put(record) {
      const index = rows[name].findIndex(item => item.id === record.id || (name === 'settings' && item.key === record.key));
      if (index >= 0) rows[name][index] = { ...record };
      else rows[name].push({ ...record });
    },
    async update(id, updates) {
      const record = rows[name].find(item => item.id === id);
      if (!record) return 0;
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) delete record[key];
        else record[key] = value;
      }
      return 1;
    },
    async delete(id) {
      const before = rows[name].length;
      rows[name] = rows[name].filter(item => item.id !== id);
      return before !== rows[name].length;
    },
    async clear() { rows[name] = []; },
    where(field) { return { equals: value => makeCollection(name, field, value) }; }
  };
}

let failNextBookmarkWrite = false;
for (const name of Object.keys(rows)) database[name] = makeTable(name);
database.transaction = async (...args) => args.at(-1)();

// Opening a v4 database for the v5 declaration leaves all existing stores intact.
assert.equal((await database.books.get(1)).title, 'Existing book');
assert.equal((await database.chapters.where('[bookId+chapterIndex]').equals([1, 0]).first()).content, 'First chapter');
assert.equal((await database.settings.getByKey('theme'))?.value, 'dark');

const base = { bookId: 1, chapterIndex: 0, paragraphIndex: 4, textAnchor: 'Một câu neo.', previewText: 'Một câu neo.' };
const first = await bookmarks.createBookmark(base);
assert.equal(first.id, 1);
assert.equal((await bookmarks.getBookmark(first.id)).previewText, 'Một câu neo.');
assert.equal((await bookmarks.getBookBookmarks(1)).length, 1);
assert.equal((await bookmarks.getAllBookmarks()).length, 1);

const duplicate = await bookmarks.createBookmark({ ...base, label: 'Không ghi đè nhãn hiện tại' });
assert.equal(duplicate.id, first.id, 'same book/chapter/paragraph returns the existing record');
assert.equal(rows.bookmarks.length, 1);
assert.equal(duplicate.label, undefined);
const otherParagraph = await bookmarks.createBookmark({ ...base, paragraphIndex: 5 });
assert.notEqual(otherParagraph.id, first.id);

const labeled = await bookmarks.updateBookmark(first.id, { label: 'Đọc lại' });
assert.equal(labeled.label, 'Đọc lại');
const unlabeled = await bookmarks.updateBookmark(first.id, { label: '   ' });
assert.equal(Object.hasOwn(unlabeled, 'label'), false);
assert.equal(await bookmarks.deleteBookmark(first.id), true);
assert.equal(await bookmarks.getBookmark(first.id), null);
assert.equal(await bookmarks.deleteBookmark(first.id), false);

assert.equal(await bookmarks.createBookmark({ ...base, bookId: undefined }), null);
assert.equal(await bookmarks.createBookmark({ ...base, bookId: '' }), null);
assert.equal(await bookmarks.createBookmark({ ...base, chapterIndex: -1 }), null);
assert.equal(await bookmarks.createBookmark({ ...base, chapterIndex: null }), null);
assert.equal(await bookmarks.createBookmark({ ...base, paragraphIndex: 1.5 }), null);
assert.equal(await bookmarks.createBookmark({ ...base, paragraphIndex: '' }), null);
const emptyPreview = await bookmarks.createBookmark({ ...base, paragraphIndex: 6, textAnchor: '', previewText: '' });
assert.equal(emptyPreview.previewText, '');
assert.equal(bookmarks.formatBookmarkPreview('  Một\n câu   dài  '), 'Một câu dài');
assert.equal((await bookmarks.createBookmark({ ...base, paragraphIndex: 7, bookId: 999 })), null);
assert.equal((await bookmarks.createBookmark({ ...base, paragraphIndex: 7, chapterIndex: 8 })), null);

const paragraphs = [
  { textContent: 'Một đoạn khác.', getAttribute: () => '0' },
  { textContent: 'Trước đó một câu neo. Sau đó tiếp tục.', getAttribute: () => '9' }
];
const resolved = bookmarks.resolveBookmarkAnchor({
  paragraphIndex: 0,
  textAnchor: 'một câu neo.',
  prefixContext: 'Trước đó ',
  suffixContext: ' Sau đó'
}, paragraphs);
assert.equal(resolved.paragraph, paragraphs[1]);
assert.equal(resolved.exact, true);
assert.equal(resolved.status, 'text-anchor');
assert.equal(bookmarks.resolveBookmarkAnchor({ paragraphIndex: 0 }, paragraphs).paragraph, paragraphs[0]);
assert.equal(bookmarks.resolveBookmarkAnchor({ paragraphIndex: 0 }, paragraphs).status, 'index');
assert.equal(bookmarks.resolveBookmarkAnchor({ paragraphIndex: 8, textAnchor: 'không còn' }, paragraphs).status, 'degraded');
assert.equal(bookmarks.resolveBookmarkAnchor({ paragraphIndex: 8, textAnchor: 'Trường Sinh' }, [
  { textContent: 'Truong Sinh tro lai.', getAttribute: () => '2' }
]).status, 'text-anchor', 'Vietnamese accent folding recovers a moved anchor');
const duplicateAnchor = bookmarks.resolveBookmarkAnchor({ paragraphIndex: 9, textAnchor: 'Trường Sinh' }, [
  { textContent: 'Trường Sinh trở lại.', getAttribute: () => '2' },
  { textContent: 'Trường Sinh trở lại.', getAttribute: () => '9' }
]);
assert.equal(duplicateAnchor.paragraph.getAttribute('data-para-index'), '9', 'a valid saved paragraph wins when text repeats');
assert.equal(bookmarks.resolveBookmarkAnchor({ paragraphIndex: 0, textAnchor: 'old words' }, [
  { textContent: 'Cleaner changed these words.', getAttribute: () => '0' }
]).status, 'index', 'a valid paragraph remains usable after cleaner changes its text');
assert.equal(bookmarks.resolveBookmarkAnchor({ paragraphIndex: 0 }, []).status, 'degraded', 'empty chapters degrade safely');
assert.equal(bookmarks.resolveBookmarkAnchor({ paragraphIndex: 0, textAnchor: 'old' }, [null]).status, 'degraded');
assert.equal(bookmarks.resolveBookmarkAnchor({ paragraphIndex: null, textAnchor: { malformed: true } }, paragraphs).status, 'degraded', 'malformed numeric/text anchors are handled safely');

const rect = (top, bottom) => ({ top, bottom, height: bottom - top });
function makeChunk(index, text, owner, top, bottom, active = false) {
  return {
    textContent: text,
    getAttribute: name => name === 'data-chunk-index' ? String(index) : null,
    getClientRects: () => [rect(top, bottom)],
    closest: selector => selector === '.reader-paragraph' ? owner : null,
    active
  };
}
function makeParagraph(index, text, top, bottom, chunks = []) {
  const paragraph = {
    textContent: text,
    getAttribute: name => name === 'data-para-index' ? String(index) : null,
    getBoundingClientRect: () => rect(top, bottom),
    querySelectorAll: selector => selector === '.tts-chunk' ? chunks : [],
    chunks
  };
  for (const chunk of chunks) chunk.closest = selector => selector === '.reader-paragraph' ? paragraph : null;
  return paragraph;
}
function makeReader(paragraphList, activeChunk = null) {
  return {
    querySelectorAll: selector => selector === '.reader-paragraph' ? paragraphList : [],
    querySelector: selector => selector.includes('.active-tts-chunk') ? activeChunk : null,
    contains: element => paragraphList.includes(element)
  };
}
const p0Chunk = makeChunk(0, 'Trường Sinh mở đầu câu chuyện.', null, -100, -60, true);
const p0 = makeParagraph(0, p0Chunk.textContent, -120, -40, [p0Chunk]);
const p1Chunk = makeChunk(3, 'Một đoạn ở giữa chương.', null, 190, 220);
const p1 = makeParagraph(1, p1Chunk.textContent, 180, 230, [p1Chunk]);
const p2Chunk = makeChunk(4, 'Hàn Lập nhìn về phía chân trời.', null, 340, 370);
const p2 = makeParagraph(2, p2Chunk.textContent, 330, 380, [p2Chunk]);
const reader = makeReader([p0, p1, p2], p0Chunk);
const header = { getBoundingClientRect: () => rect(64, 100) };
const dock = { getBoundingClientRect: () => rect(800, 980) };
const eyePosition = bookmarks.captureCurrentReadingPosition({
  bookId: 1, chapterIndex: 0, readerBodyContent: reader,
  readerSubHeader: header, ttsDock: dock, windowRef: { innerHeight: 1000 }
});
assert.equal(eyePosition.positionSource, 'eye');
assert.equal(eyePosition.paragraphIndex, 2, 'eye position follows the 35% safe viewport line, not the first DOM paragraph');
assert.equal(eyePosition.previewText.includes('Hàn Lập'), true);
assert.equal(eyePosition.previewText.includes('<span'), false);

const activeTtsPosition = bookmarks.captureCurrentReadingPosition({
  bookId: 1, chapterIndex: 0, readerBodyContent: reader,
  tts: { isPlaying: true, isPaused: false, currentIndex: 0, chunks: ['Trường Sinh mở đầu câu chuyện.'] },
  readerSubHeader: header, ttsDock: dock, windowRef: { innerHeight: 1000 }
});
assert.equal(activeTtsPosition.positionSource, 'tts');
assert.equal(activeTtsPosition.paragraphIndex, 0, 'active rendered TTS mapping takes priority over eye position');
assert.equal(activeTtsPosition.chunkIndex, 0);
const pausedTtsPosition = bookmarks.captureCurrentReadingPosition({
  bookId: 1, chapterIndex: 0, readerBodyContent: reader,
  tts: { isPlaying: true, isPaused: true, currentIndex: 0, chunks: ['Trường Sinh mở đầu câu chuyện.'] },
  readerSubHeader: header, ttsDock: dock, windowRef: { innerHeight: 1000 }
});
assert.equal(pausedTtsPosition.positionSource, 'eye', 'paused TTS does not replace the eye position');
assert.equal(pausedTtsPosition.paragraphIndex, 2);

const mobileParagraph = makeParagraph(5, 'Đoạn giữa trên màn hình nhỏ.', 180, 225, [
  makeChunk(5, 'Đoạn giữa trên màn hình nhỏ.', null, 185, 220)
]);
const mobilePosition = bookmarks.captureCurrentReadingPosition({
  bookId: 1, chapterIndex: 1, readerBodyContent: makeReader([mobileParagraph]),
  readerSubHeader: { getBoundingClientRect: () => rect(24, 55) },
  ttsDock: { getBoundingClientRect: () => rect(450, 590) }, windowRef: { innerHeight: 600 }
});
assert.equal(mobilePosition.paragraphIndex, 5, 'the same safe-region rule works on a mobile viewport');
const firstPosition = bookmarks.captureCurrentReadingPosition({
  bookId: 1, chapterIndex: 0, readerBodyContent: makeReader([makeParagraph(0, 'Đầu chương.', 340, 380)]),
  windowRef: { innerHeight: 1000 }
});
assert.equal(firstPosition.paragraphIndex, 0);
const lastPosition = bookmarks.captureCurrentReadingPosition({
  bookId: 1, chapterIndex: 0, readerBodyContent: makeReader([makeParagraph(12, 'Cuối chương.', 340, 380)]),
  windowRef: { innerHeight: 1000 }
});
assert.equal(lastPosition.paragraphIndex, 12);
const emptyPosition = bookmarks.captureCurrentReadingPosition({
  bookId: 1, chapterIndex: 2, readerBodyContent: makeReader([]), windowRef: { innerHeight: 600 }
});
assert.equal(emptyPosition.positionSource, 'empty');
assert.equal(emptyPosition.paragraphIndex, 0);
assert.equal(emptyPosition.previewText, '');

failNextBookmarkWrite = true;
assert.equal(await bookmarks.createBookmark({ ...base, paragraphIndex: 8 }), null, 'write failures are contained by the service');
assert.deepEqual(await bookmarks.getBookBookmarks('invalid'), []);

const backup = await storage.exportDatabase();
  assert.equal(backup.version, 5);
  assert.ok(Array.isArray(backup.bookmarks));
  assert.ok(Array.isArray(backup.readingSessions));
assert.equal(Object.hasOwn(backup, 'searchIndex'), false);

// Appending remaps IDs and deduplicates the same logical position, keeping its latest label.
await storage.importDatabase({
  books: [{ id: '5', title: 'Imported' }],
  chapters: [{ id: 50, bookId: 5, chapterIndex: 0, content: 'Imported chapter' }],
  bookmarks: [
    { id: 80, bookId: 5, chapterIndex: 0, paragraphIndex: 2, previewText: 'Imported mark', createdAt: 10, updatedAt: 10 },
    { id: 81, bookId: '5', chapterIndex: 0, paragraphIndex: 2, previewText: 'Duplicate mark', label: 'Keep duplicate label', createdAt: 11, updatedAt: 20 }
  ]
}, false);
const importedBook = rows.books.find(book => book.title === 'Imported');
const importedMark = rows.bookmarks.find(item => item.label === 'Keep duplicate label');
assert.ok(importedMark);
assert.equal(importedMark.bookId, importedBook.id);
assert.notEqual(importedMark.bookId, 5);
assert.equal(rows.bookmarks.filter(item => item.bookId === importedBook.id).length, 1);
assert.equal(importedMark.createdAt, 10);

const beforeOrphanImportBookIds = rows.books.map(book => book.id);
await assert.rejects(storage.importDatabase({
  books: [{ id: 6, title: 'Must not import' }],
  chapters: [{ id: 60, bookId: 6, chapterIndex: 0, content: 'Chapter' }],
  bookmarks: [{ bookId: 999, chapterIndex: 0, paragraphIndex: 1 }]
}, false), /does not|không liên kết/i);
assert.deepEqual(rows.books.map(book => book.id), beforeOrphanImportBookIds, 'orphan bookmarks reject before mutating imported books');
await assert.rejects(storage.importDatabase({
  books: [{ id: 7, title: 'Missing chapter' }],
  chapters: [],
  bookmarks: [{ bookId: 7, chapterIndex: 0, paragraphIndex: 1 }]
}, false), /chapter|chương/i);
await assert.rejects(storage.importDatabase({
  books: [{ id: 8, title: 'Malformed position' }],
  chapters: [{ id: 80, bookId: 8, chapterIndex: 0, content: 'Chapter' }],
  bookmarks: [{ bookId: 8, chapterIndex: null, paragraphIndex: 0 }]
}, false), /index|chỉ mục/i);

// A pre-v4 backup has no bookmarks and remains importable in both append and replace modes.
await storage.importDatabase({ books: [{ id: 6, title: 'Old backup' }], chapters: [{ id: 60, bookId: 6, chapterIndex: 0, content: 'Old chapter' }] }, false);
assert.ok(rows.books.some(book => book.title === 'Old backup'));
await storage.importDatabase({ books: [{ id: 6, title: 'Replacement old backup' }], chapters: [{ id: 60, bookId: 6, chapterIndex: 0, content: 'Old chapter' }] }, true);
assert.equal(rows.bookmarks.length, 0);
assert.ok(rows.books.some(book => book.title === 'Replacement old backup'));

await storage.importDatabase({
  books: [{ id: 12, title: 'Replace with marks' }],
  chapters: [{ id: 120, bookId: 12, chapterIndex: 0, content: 'Chapter' }],
  bookmarks: [{ id: 123, bookId: 12, chapterIndex: 0, paragraphIndex: 1, previewText: '' }]
}, true);
assert.equal(rows.bookmarks.length, 1);
assert.equal(rows.bookmarks[0].id, 123);
assert.equal(rows.bookmarks[0].previewText, '');

// Malformed replacement bookmark data rejects before existing data is cleared.
const beforeMalformedReplaceBooks = rows.books.map(book => book.id);
await assert.rejects(storage.importDatabase({
  books: [{ id: 13, title: 'Must not replace' }],
  chapters: [{ id: 130, bookId: 13, chapterIndex: 0, content: 'Chapter' }],
  bookmarks: [
    { id: 133, bookId: 13, chapterIndex: 0, paragraphIndex: 1, previewText: '' },
    { bookId: 13, chapterIndex: -1, paragraphIndex: 1 },
    { bookId: 13, chapterIndex: 0, paragraphIndex: 'bad' },
    null
  ]
}, true), /Bookmark/i);
assert.deepEqual(rows.books.map(book => book.id), beforeMalformedReplaceBooks);
assert.equal(rows.bookmarks.length, 1, 'replace import failure leaves existing bookmarks intact');

// Book deletion removes bookmarks in the same storage transaction.
await bookmarks.createBookmark({ bookId: 12, chapterIndex: 0, paragraphIndex: 0, previewText: 'Delete with book' });
rows.readingSessions.push({ id: 'delete-with-book', bookId: 12, startedAt: 1, endedAt: 2,
  activeDurationMs: 1, ttsDurationMs: 0, safeCheckpointAt: 2, dailyBuckets: [] });
await storage.deleteBook(12);
assert.equal(rows.bookmarks.some(item => item.bookId === 12), false);
assert.equal(rows.readingSessions.some(item => item.bookId === 12), false);
assert.equal(rows.books.some(book => book.id === 12), false);
console.log('test_bookmark.mjs: all bookmark service and storage assertions passed');
