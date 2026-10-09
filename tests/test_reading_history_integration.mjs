import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const tts = await readFile(new URL('./tts.js', import.meta.url), 'utf8');

assert.match(app, /onPlaybackStateChange\s*=\s*\(isPlaying, timestamp\)/,
  'Reader subscribes to actual TTS playback edges');
assert.match(tts, /utterance\.onstart\s*=\s*\(\)\s*=>\s*\{\s*if \(this\.currentUtterance === utterance && !this\.isPaused\)\s*\{\s*this\.emitPlaybackCallback\(this\.onActualChunkStart, this\.currentIndex\);\s*this\.emitActualPlayback\(true\)/,
  'Web Speech starts history only after the utterance actually starts');
assert.match(tts, /addEventListener\('playing',\s*\(\)\s*=>\s*\{[\s\S]*?this\.emitActualPlayback\(true\);\s*\}\)/,
  'Cloud TTS starts history from HTMLAudioElement playing');
assert.match(tts, /addEventListener\('error',\s*\(e\)\s*=>\s*\{[\s\S]*?this\.emitActualPlayback\(false\)/,
  'Cloud TTS closes actual playback on errors before fallback');
assert.match(tts, /onActualChunkComplete\s*=\s*null/);
assert.match(tts, /onNaturalComplete\s*=\s*null/);

assert.match(app, /onStateChange:\s*\(\{ isActive, isPaused, speed \}\)\s*=>\s*\{[\s\S]*?setReadingHistoryAutoScrollState/,
  'History observes the existing AutoScroll state callback');
assert.match(app, /navigateChapter\(1,\s*\{ activity:\s*false \}\)/,
  'AutoScroll chapter continuation does not synthesize user activity');
assert.match(app, /querySelectorAll\('\.reader-paragraph\[data-para-index\]'\)/,
  'Logical paragraph/chunk offsets are built once when a chapter renders');
assert.match(app, /recordReadingHistoryChapterProgress\(\{[\s\S]*?position: chunk\.endWord[\s\S]*?totalWords: logicalProgressMap\.totalWords/,
  'Only naturally completed TTS chunks advance logical word coverage');
assert.match(app, /function resetProgressBaselineAtParagraph\([\s\S]*?explicitJump:\s*true/,
  'Search and Bookmark anchors rebase progress without crediting skipped text');
assert.ok((app.match(/resetProgressBaselineAtParagraph\(/g) || []).length >= 3,
  'Search and Bookmark each use the shared explicit-jump baseline helper');
const eyeProgress = app.slice(app.indexOf('function recordCurrentEyeReadingProgress'), app.indexOf('function resetProgressBaselineAtParagraph'));
assert.match(eyeProgress, /elementFromPoint/);
assert.doesNotMatch(eyeProgress, /querySelectorAll|scrollHeight/,
  'Eye progress uses a logical paragraph hit test without repeated chapter scans or raw scroll ratios');
assert.equal((app.match(/window\.addEventListener\('scroll', handleWindowScroll/g) || []).length, 1,
  'Progress reuses the existing debounced Reader scroll lifecycle');
assert.match(app, /delta > 0 && isReadingHistoryChapterNearEnd\(state\.currentChapterIndex\)[\s\S]*?markReadingHistoryChapterCompleted/,
  'Manual Next only completes chapters after near-end progress');
assert.match(app, /onNaturalComplete\s*=\s*\(\)\s*=>\s*\{[\s\S]*?markReadingHistoryChapterCompleted/,
  'Natural final TTS completion emits completion through a distinct callback');
const autoScrollInit = app.slice(app.indexOf('function initAutoScrollEngine'), app.indexOf('\n}', app.indexOf('function initAutoScrollEngine')) + 2);
assert.match(autoScrollInit, /onReachBottom:\s*\(\)\s*=>\s*\{\s*if \(document\.visibilityState !== 'hidden'\)\s*\{\s*markReadingHistoryChapterCompleted/,
  'Foreground AutoScroll bottom is completion evidence while hidden scrolling is not');
assert.equal((app.match(/document\.addEventListener\('visibilitychange'/g) || []).length, 1,
  'There is exactly one visibility listener');
assert.equal((app.match(/window\.addEventListener\('pagehide'/g) || []).length, 1,
  'There is exactly one pagehide listener');
assert.match(app, /window\.addEventListener\('pagehide',[\s\S]*?setReadingHistoryVisibility\(false, timestamp\)/,
  'Pagehide closes eye-reading where appropriate and checkpoints through the same visibility lifecycle');
assert.match(app, /await importDatabase\(data, clearExisting\);\s*if \(clearExisting\) await resetReadingHistoryAfterRestore\(\)/,
  'replace restore drops the prior in-memory session before Analytics is read again');

const mediaSession = app.slice(app.indexOf('function initMediaSession()'), app.indexOf('\n}', app.indexOf('function initMediaSession()')) + 2);
assert.match(mediaSession, /onPause:[\s\S]*?state\.tts\.pause\(\)/);
assert.match(mediaSession, /onStop:[\s\S]*?state\.tts\.stop\(\)/);
assert.match(mediaSession, /navigateChapter\(-1\)/);
assert.match(mediaSession, /navigateChapter\(1\)/);
assert.doesNotMatch(mediaSession, /markReadingHistory/,
  'Media Session reuses the common TTS/navigation lifecycle without a second history tracker');

const sleepExpiration = app.slice(app.indexOf('function handleSleepTimerExpire'), app.indexOf('\n}', app.indexOf('function handleSleepTimerExpire')) + 2);
assert.match(sleepExpiration, /state\.tts\.stop\(\)/,
  'Sleep Timer expiration closes actual TTS through the existing stop lifecycle');
assert.match(app, /onPlaybackStateChange[\s\S]*?markReadingHistoryTtsStart[\s\S]*?markReadingHistoryTtsPause/);
assert.match(app, /onChunkStart\s*=\s*\(index, text, total\)\s*=>\s*\{[\s\S]*?isChapterSwitching = false/,
  'TTS chunk and chapter transition callback remains intact');
assert.match(app, /Circuit Breaker/);
assert.ok(/Empty Chunk Defense|chunks\.length === 0/.test(tts), 'TTS empty-chunk defense remains present');
assert.match(tts, /Gỡ bỏ callback ngay lập tức để chống Chromium bắn sự kiện lặp vô hạn/);

console.log('test_reading_history_integration.mjs: Reader, TTS, AutoScroll, visibility, Media Session, Sleep Timer, and anti-OOM lifecycle contracts PASS');
