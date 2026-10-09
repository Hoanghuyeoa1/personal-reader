import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TTSEngine } from '../tts.js';
import { buildChapterChunkMap } from '../chunkMapping.js';

// Phase 1 only. Real production engine with deterministic native Speech mocks.
// Assertions describe desired behavior; failures remain visible.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup() {
  let voices = [{ name: 'Microsoft HoaiMy', voiceURI: 'hoaimy', lang: 'vi-VN' }, { name: 'Other', voiceURI: 'other', lang: 'vi-VN' }];
  const state = { spoken: [], cancels: 0, paused: false };
  const synth = {
    onvoiceschanged: null, speaking: true,
    get paused() { return state.paused; },
    getVoices() { return voices.map(v => ({ ...v })); },
    speak(u) { state.spoken.push(u); },
    cancel() { state.cancels++; state.paused = false; },
    pause() { state.paused = true; }, resume() { state.paused = false; }
  };
  globalThis.window = { speechSynthesis: synth };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const tts = new TTSEngine();
  tts.chunks = ['Câu một.', 'Câu hai.', 'Câu ba.', 'Câu bốn.', 'Câu năm.', 'Câu sáu.'];
  return { tts, synth, state };
}
for (const method of ['setVoice', 'setRate', 'setPitch']) {
  test(method + ': same effective value must not speak or cancel', () => {
    const { tts, state } = setup();
    try {
      tts.play(); const before = [state.spoken.length, state.cancels];
      tts[method](method === 'setVoice' ? { ...tts.selectedVoice } : 1);
      assert.deepEqual([state.spoken.length, state.cancels], before);
    } finally { tts.stop(); }
  });
}
test('voiceschanged with recreated objects must preserve selection without restart', () => {
  const { tts, synth, state } = setup();
  try {
    tts.setVoice('other'); tts.play();
    // app.js populateVoiceSelect calls setVoice for the preferred URI.
    tts.onVoicesLoaded = () => tts.setVoice('other');
    const before = state.spoken.length;
    synth.onvoiceschanged(); synth.onvoiceschanged(); synth.onvoiceschanged();
    assert.equal(state.spoken.length, before);
    assert.equal(tts.selectedVoice.voiceURI, 'other');
  } finally { tts.stop(); }
});
test('onstart then onerror must halt or retry same chunk, never skip six chunks', async () => {
  const { tts, state } = setup();
  let completed = 0; let natural = 0;
  tts.onActualChunkComplete = () => completed++;
  tts.onNaturalComplete = () => natural++;
  try {
    tts.play();
    for (let i = 0; i < 6 && tts.isPlaying; i++) {
      const u = state.spoken.at(-1); u.onstart(); u.onerror({ error: 'network' });
      await delay(25);
    }
    assert.equal(completed, 0); assert.equal(natural, 0);
    assert.equal(tts.currentIndex, 0, 'failed chunks must not be skipped');
    assert.ok(state.spoken.length <= 3, 'bounded retry budget');
  } finally { tts.stop(); }
});
test('onend without onstart must not count actual completion', () => {
  const { tts, state } = setup(); let completed = 0;
  tts.onActualChunkComplete = () => completed++;
  try { tts.play(); state.spoken.at(-1).onend(); assert.equal(completed, 0); }
  finally { tts.stop(); }
});
test('last-chunk error must not emit completed status', () => {
  const { tts, state } = setup(); const statuses = [];
  tts.chunks = ['Câu lỗi.']; tts.onStatusChange = s => statuses.push(s);
  try { tts.play(); const u = state.spoken.at(-1); u.onstart(); u.onerror({ error: 'network' }); assert.ok(!statuses.includes('completed'), statuses.join(',')); }
  finally { tts.stop(); }
});
test('Pause -> Resume -> onend must advance the retained utterance', async () => {
  const { tts, state } = setup();
  try { tts.play(); const u = state.spoken.at(-1); u.onstart(); tts.pause(); tts.resume(); u.onend(); await delay(10); assert.equal(tts.currentIndex, 1); }
  finally { tts.stop(); }
});
test('paused rate change must apply when resuming', () => {
  const { tts, state } = setup();
  try { tts.play(); state.spoken.at(-1).onstart(); tts.pause(); const count = state.spoken.length; tts.setRate(1.5); assert.equal(state.spoken.length, count); tts.resume(); assert.equal(state.spoken.at(-1).rate, 1.5); }
  finally { tts.stop(); }
});
test('stale captured onend must not clear the new utterance watchdog', async () => {
  const { tts, state } = setup();
  try { tts.play(); const oldEnd = state.spoken.at(-1).onend; tts.setRate(1.2); await delay(275); const timer = tts.stuckWatchdogTimer; oldEnd(); assert.equal(tts.stuckWatchdogTimer, timer); }
  finally { tts.stop(); }
});
test('duplicate captured terminal callbacks advance exactly once', async () => {
  const { tts, state } = setup(); let completed = 0;
  tts.onActualChunkComplete = () => completed++;
  try { tts.play(); const u = state.spoken.at(-1); u.onstart(); const end = u.onend; const error = u.onerror; end(); end(); error({ error: 'network' }); await delay(10); assert.equal(completed, 1); assert.equal(tts.currentIndex, 1); assert.equal(state.spoken.length, 2); }
  finally { tts.stop(); }
});
test('watchdog halts without completion and cleans playback timers', async () => {
  const { tts, state } = setup(); let completed = 0; const statuses = [];
  tts.onActualChunkComplete = () => completed++; tts.onStatusChange = s => statuses.push(s);
  try { tts.play(); const u = state.spoken.at(-1); u.onstart(); tts.scheduleStuckWatchdog(u, tts.utteranceToken, tts.generationToken, u.text.length, 5); await delay(20); assert.equal(completed, 0); assert.equal(tts.currentIndex, 0); assert.equal(tts.isPlaying, false); assert.equal(tts.keepAliveTimer, null); assert.equal(tts.transitionTimer, null); assert.ok(statuses.includes('error')); }
  finally { tts.stop(); }
});
test('online voice classification and Stop timer cleanup', () => {
  const { tts, state } = setup();
  tts.play(); state.spoken.at(-1).onstart();
  assert.equal(tts.isNaturalOrOnlineVoice(), true);
  tts.stop(); assert.equal(tts.keepAliveTimer, null); assert.equal(tts.stuckWatchdogTimer, null); assert.equal(tts.transitionTimer, null); assert.equal(tts.currentUtterance, null);
});
test('Reader rendered chunks must equal actual TTS chunks', async () => {
  const { tts } = setup();
  try {
    const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
    const start = source.indexOf('function renderChapterContent(rawContent)');
    const end = source.indexOf(String.fromCharCode(10) + '/**', start);
    assert.ok(start >= 0 && end > start);
    const DOM = { readerBodyContent: { innerHTML: '', querySelectorAll: () => [] } };
    const escapeHTML = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const render = new Function('DOM', 'state', 'escapeHTML', 'buildChapterChunkMap', 'let readerChunkMap = null; const chapterLoadGeneration = 0; ' + source.slice(start, end) + '; return renderChapterContent;')(DOM, { tts }, escapeHTML, buildChapterChunkMap);
    const text = '“Xin chào.”\nCâu hai. Câu ba. Câu bốn. Câu năm.';
    render(text);
    const readerChunks = [...DOM.readerBodyContent.innerHTML.matchAll(/class="tts-chunk"[^>]*>(.*?)<\/span>/g)].map(m => m[1].trim());
    const audioChunks = tts.splitIntoSmartChunks(text);
    console.log('segmentation evidence', JSON.stringify({ readerChunks, audioChunks }));
    assert.deepEqual(readerChunks, audioChunks);
  } finally { tts.stop(); }
});

test('Stop during automatic chapter handoff must cancel future autoplay', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('state.tts.onStatusChange = async (status) => {');
  const finish = source.indexOf('\n  };', begin) + 6;
  assert.ok(begin >= 0 && finish > begin);
  let releaseDelay; let starts = 0;
  const state = {
    mediaSession: null, sleepTimer: null, chaptersMeta: [{}, {}],
    currentChapterIndex: 0, currentBook: { id: 1 },
    currentChapter: { content: 'Nội dung chương đủ dài để tiếp tục phát.' },
    tts: { generationToken: 0, isPlaying: false, chunks: ['Câu mới.'], stop() { this.isPlaying = false; }, loadText() {}, jumpToIndex() { this.isPlaying = true; starts++; } }
  };
  const deps = {
    state, updateTTSPlayPauseButton() {}, flushTtsProgressSave() {}, showToast() {},
    loadChapter: async idx => { state.currentChapterIndex = idx; return true; },
    getCustomRules: async () => [], cleanChapterText: text => text,
    clearTimeout() {}, setTimeout: (fn, ms) => { if (ms === 800) releaseDelay = fn; return 1; }
  };
  const cancelStart = source.indexOf('function cancelChapterHandoff()');
  const cancelSource = source.slice(cancelStart, source.indexOf('\n}', cancelStart) + 2);
  const make = new Function('deps', 'const {state, updateTTSPlayPauseButton, flushTtsProgressSave, showToast, loadChapter, getCustomRules, cleanChapterText, setTimeout, clearTimeout} = deps; let isChapterSwitching = false; let chapterSwitchHistory = []; let restoringChunkPosition=false, automaticChapterHandoff=null, chapterHandoffDelay=null, chapterHandoffUnlockTimer=null,chapterLoadGeneration=0,readerNavigationGeneration=0,readerChunkMap={sourceText:state.currentChapter.content}; function isReaderChunkMapCurrent(){return true;} ' + cancelSource + source.slice(begin, finish) + '; return state.tts.onStatusChange;');
  const handler = make(deps);
  const handoff = handler('completed');
  await delay(0); assert.equal(typeof releaseDelay, 'function');
  state.tts.stop(); await handler('stopped');
  releaseDelay(); await handoff;
  assert.equal(starts, 0, 'Stop must invalidate pending chapter autoplay');
});
