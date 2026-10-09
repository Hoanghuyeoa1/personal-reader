import assert from 'node:assert/strict';

let openAttempts = 0;
class FailingDexie {
  version() { return { stores: () => this }; }
  async open() {
    openAttempts++;
    throw new Error('simulated IndexedDB migration/open failure');
  }
}

globalThis.window = { Dexie: FailingDexie };
globalThis.BroadcastChannel = undefined;
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);

try {
  const bookmarks = await import('./bookmark.js');
  assert.equal(await bookmarks.createBookmark({ bookId: 1, chapterIndex: 0, paragraphIndex: 0 }), null);
  assert.deepEqual(await bookmarks.getBookBookmarks(1), []);
  assert.equal(await bookmarks.getBookmark(1), null);
  assert.equal(await bookmarks.deleteBookmark(1), false);
  assert.equal(openAttempts, 4, 'failed opens are not cached as a ready database');
  assert.equal(warnings.length, 4, 'storage failures are contained and reported');
  console.log('test_bookmark_storage_errors.mjs: migration/open failures are contained and retryable');
} finally {
  console.warn = originalWarn;
}
