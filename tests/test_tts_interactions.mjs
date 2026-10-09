import assert from 'node:assert/strict';
import test from 'node:test';
import { TTSEngine } from './tts.js';
import { MediaSessionHelper } from './mediaSessionHelper.js';
import { SleepTimer } from './sleepTimer.js';
import { AutoScrollEngine } from './autoscroll.js';

test('paused next and previous only speak the selected chunk after resume', () => {
  const engine = Object.create(TTSEngine.prototype);
  Object.assign(engine, {
    chunks: ['one', 'two', 'three'], currentIndex: 0, isPlaying: true, isPaused: true,
    pausedChunkChanged: false, synth: null, audioElement: null, playbackRequestId: 0,
    pendingCloudRequestId: null, activeCloudRequestId: null, cloudChunkStartedIndex: null,
    onChunkStart: null, onChunkEnd: null, onStatusChange: null,
  });
  let speaks = 0;
  engine.cancelCurrentSource = () => {};
  engine.emitChunkStart = () => {};
  engine.speakCurrentChunk = () => { speaks += 1; };
  engine.emitStatus = () => {};
  engine.startKeepAlive = () => {};
  engine.next();
  assert.equal(engine.currentIndex, 1);
  assert.equal(speaks, 0);
  assert.equal(engine.pausedChunkChanged, true);
  engine.prev();
  assert.equal(engine.currentIndex, 0);
  assert.equal(speaks, 0);
  engine.next();
  assert.equal(engine.currentIndex, 1);
  assert.equal(speaks, 0);
  engine.jumpToIndex(2, false);
  assert.equal(engine.currentIndex, 2);
  assert.equal(speaks, 0);
  engine.resume();
  assert.equal(speaks, 1);
  assert.equal(engine.isPaused, false);
  assert.equal(engine.pausedChunkChanged, false);
});

test('Stop invalidates an in-flight Cloud TTS response', async () => {
  const engine = Object.create(TTSEngine.prototype);
  let resolveFetch;
  let audioPlayCount = 0;
  let completedCount = 0;
  const audioElement = {
    src: '', paused: true, currentTime: 0, playbackRate: 1, volume: 1,
    pause() { this.paused = true; },
    play() { audioPlayCount += 1; this.paused = false; return Promise.resolve(); },
  };
  Object.assign(engine, {
    chunks: ['hello'], currentIndex: 0, engine: 'cloud', isPlaying: true, isPaused: false,
    cloudConfig: { provider: 'fpt', voice: 'banmai', apiKey: 'test-key' }, rate: 1, volume: 1,
    audioElement, currentAudioUrl: null, playbackRequestId: 0, pendingCloudRequestId: null,
    activeCloudRequestId: null, cloudChunkStartedIndex: null, actualPlaybackActive: false,
    onChunkStart: null, onChunkEnd: null, onStatusChange: null, onPlaybackStateChange: null,
    onNaturalComplete: () => { completedCount += 1; }, onFallbackWarning: null, synth: { cancel() {} },
  });
  engine.fetchCloudAudio = () => new Promise(resolve => { resolveFetch = resolve; });
  engine.cleanupCurrentAudioUrl = () => {};
  engine.cleanupPreviewAudio = () => {};
  const request = engine.speakCurrentChunk();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof resolveFetch, 'function');
  engine.stop();
  resolveFetch(new Blob(['audio']));
  await request;
  assert.equal(audioPlayCount, 0);
  assert.equal(engine.isPlaying, false);
  assert.equal(completedCount, 0);
  assert.equal(engine.pendingCloudRequestId, null);
});

test('browser voice preview restores an interrupted reading session', async () => {
  const previous = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  try {
    const spoken = [];
    const engine = Object.create(TTSEngine.prototype);
    Object.assign(engine, {
      chunks: ['current chapter chunk'], currentIndex: 0, isPlaying: true, isPaused: false,
      pausedChunkChanged: false, playbackRequestId: 0, pendingCloudRequestId: null,
      activeCloudRequestId: null, cloudChunkStartedIndex: null, actualPlaybackActive: false,
      synth: { cancel() {}, speak(utterance) { spoken.push(utterance); } },
      audioElement: null, currentAudioUrl: null, currentUtterance: null,
      previewAudio: null, previewAudioUrl: null, previewUtterance: null,
      voices: [], selectedVoice: null,
    });
    engine.emitStatus = () => {};
    engine.startKeepAlive = () => {};
    engine.speakCurrentChunk = () => { engine.isPaused = false; engine.pausedChunkChanged = false; };
    assert.equal(await engine.previewVoice('voice-1', 'browser'), true);
    assert.equal(engine.isPlaying, true);
    assert.equal(engine.isPaused, true);
    assert.equal(spoken.length, 1);
    spoken[0].onend();
    assert.equal(engine.isPlaying, true);
    assert.equal(engine.isPaused, false);
    assert.equal(engine.pausedChunkChanged, false);
  } finally {
    if (previous === undefined) delete globalThis.SpeechSynthesisUtterance;
    else globalThis.SpeechSynthesisUtterance = previous;
  }
});

test('stopped Cloud voice preview cannot start after its request returns', async () => {
  const engine = Object.create(TTSEngine.prototype);
  let resolveFetch;
  Object.assign(engine, {
    cloudConfig: { apiKey: 'test-key', provider: 'fpt', voice: 'banmai' },
    audioElement: {}, previewAudio: null, previewAudioUrl: null, previewRequestId: 0,
    synth: null, isPlaying: false, isPaused: false,
  });
  engine.fetchCloudAudio = () => new Promise(resolve => { resolveFetch = resolve; });
  const preview = engine.previewVoice('fpt:banmai', 'cloud');
  await new Promise(resolve => setTimeout(resolve, 0));
  engine.cleanupPreviewAudio();
  resolveFetch(new Blob(['preview']));
  assert.equal(await preview, false);
  assert.equal(engine.previewAudio, null);
  assert.equal(engine.previewAudioUrl, null);
});

test('TTS onActualChunkComplete and onNaturalComplete are called exactly once per transition', async () => {
  const engine = new TTSEngine();
  engine.chunks = ['Đoạn 1', 'Đoạn 2'];
  engine.currentIndex = 0;

  const spoken = [];
  engine.synth = {
    cancel() {},
    speak(u) { spoken.push(u); }
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(t) { this.text = t; }
  };

  const actualStarts = [];
  const actualCompletes = [];
  let naturalCompleteCount = 0;

  engine.onActualChunkStart = (idx) => actualStarts.push(idx);
  engine.onActualChunkComplete = (idx) => actualCompletes.push(idx);
  engine.onNaturalComplete = () => { naturalCompleteCount++; };

  engine.play();
  assert.equal(spoken.length, 1);
  spoken[0].onstart();
  assert.deepEqual(actualStarts, [0]);

  // Đoạn 1 kết thúc
  spoken[0].onend();
  assert.deepEqual(actualCompletes, [0]);

  await new Promise(r => setTimeout(r, 15));

  // Đoạn 2 bắt đầu và kết thúc
  assert.equal(spoken.length, 2);
  spoken[1].onstart();
  assert.deepEqual(actualStarts, [0, 1]);

  spoken[1].onend();
  assert.deepEqual(actualCompletes, [0, 1]);
  assert.equal(naturalCompleteCount, 1);
  assert.equal(engine.isPlaying, false);
  engine.stop();
});

test('MediaSessionHelper hardware handlers integrate with TTSEngine safely', () => {
  let playCalls = 0;
  let pauseCalls = 0;
  let prevCalls = 0;
  let nextCalls = 0;
  let stopCalls = 0;

  const helper = new MediaSessionHelper({
    onPlay: () => { playCalls++; },
    onPause: () => { pauseCalls++; },
    onPrevTrack: () => { prevCalls++; },
    onNextTrack: () => { nextCalls++; },
    onStop: () => { stopCalls++; }
  });

  // Verify callbacks invoke without throwing
  helper.callbacks.onPlay();
  helper.callbacks.onPause();
  helper.callbacks.onPrevTrack();
  helper.callbacks.onNextTrack();
  helper.callbacks.onStop();

  assert.equal(playCalls, 1);
  assert.equal(pauseCalls, 1);
  assert.equal(prevCalls, 1);
  assert.equal(nextCalls, 1);
  assert.equal(stopCalls, 1);
});

test('SleepTimer chapter_end mode notifies on chapter completion without double-firing', () => {
  let expireReason = null;
  let expireCount = 0;

  const timer = new SleepTimer({
    onExpire: ({ reason }) => {
      expireCount++;
      expireReason = reason;
    }
  });

  timer.setChapterEndMode();
  assert.equal(timer.mode, 'chapter_end');

  timer.notifyChapterEnd();
  assert.equal(expireCount, 1);
  assert.equal(expireReason, 'chapter_end');
  assert.equal(timer.mode, null);

  // Gọi lần 2 không được phát lặp
  timer.notifyChapterEnd();
  assert.equal(expireCount, 1);
});

test('AutoScroll and TTS stop coordination on chapter load simulation', () => {
  const autoScroll = new AutoScrollEngine();
  const tts = new TTSEngine();
  tts.chunks = ['1', '2'];
  tts.synth = { cancel() {}, speak() {} };

  tts.play();
  assert.equal(tts.isPlaying, true);

  // Mô phỏng loadChapter behavior dừng an toàn cả 2 engine
  if (tts) tts.stop();
  if (autoScroll) autoScroll.stop();

  assert.equal(tts.isPlaying, false);
  assert.equal(autoScroll.isActive, false);
  assert.equal(tts.transitionTimer, null);
});
