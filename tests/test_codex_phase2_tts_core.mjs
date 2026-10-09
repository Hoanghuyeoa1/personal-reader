import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TTSEngine, VIETNAMESE_VOICE_CATALOG, formatBrowserVoiceLabel } from '../tts.js';

// Small deterministic clock: no browser, network, native audio or real long-running timers.
class Clock {
  now = 1000; tasks = new Map(); sequence = 0;
  add(fn, ms, repeat = false) {
    const handle = { id: ++this.sequence, unref() {} };
    this.tasks.set(handle, { fn, due: this.now + ms, ms, repeat }); return handle;
  }
  advance(ms) {
    const target = this.now + ms; let steps = 0;
    while (true) {
      const next = [...this.tasks].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      assert.ok(++steps < 1000, 'bounded timer execution');
      const [handle, task] = next; this.now = task.due;
      if (task.repeat) task.due += task.ms; else this.tasks.delete(handle);
      task.fn();
    }
    this.now = target;
  }
}
function environment(options = {}) {
  const saved = new Map();
  const patch = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const clock = new Clock(); const savedNow = Date.now;
  patch('setTimeout', (fn, ms = 0) => clock.add(fn, ms)); patch('clearTimeout', h => clock.tasks.delete(h));
  patch('setInterval', (fn, ms) => clock.add(fn, ms, true)); patch('clearInterval', h => clock.tasks.delete(h));
  Date.now = () => clock.now;
  let voices = options.delayed ? [] : [
    { name: 'Microsoft HoaiMy', voiceURI: 'hoaimy', lang: 'vi-VN' },
    { name: 'Offline SAPI', voiceURI: 'offline', lang: 'vi-VN', localService: true }
  ];
  const state = { spoken: [], created: [], active: null, capturedEnd: null, cancel: 0, pause: 0, resume: 0, speaking: false, paused: false, maxActive: 0 };
  const synth = {
    onvoiceschanged: null, get speaking() { return state.speaking; }, get paused() { return state.paused; },
    getVoices() { return voices.map(v => ({ ...v })); },
    speak(u) { assert.equal(state.active, null, 'native utterance ownership must remain singular'); state.active = u; state.speaking = true; state.spoken.push(u); state.capturedEnd = u.onend; state.maxActive = Math.max(state.maxActive, 1); },
    cancel() { state.cancel++; const callback = state.capturedEnd; state.active = null; state.speaking = false; state.paused = false; if (options.syncCancelEnd) callback?.(); },
    pause() { state.pause++; state.paused = true; options.onNativePause?.(); },
    resume() { state.resume++; state.paused = false; state.active?.onresume?.(); }
  };
  patch('window', { speechSynthesis: synth });
  patch('SpeechSynthesisUtterance', class { constructor(text) { this.text = text; state.created.push(this); } });
  patch('Audio', options.audio ? class {
    listeners = new Map(); src = ''; paused = true;
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    pause() { this.paused = true; } play() { this.paused = false; return Promise.resolve(); }
    removeAttribute() { this.src = ''; } load() {}
  } : undefined);
  const tts = new TTSEngine(); tts.chunks = ['Câu một.', 'Câu hai.', 'Câu ba.'];
  const events = { start: [], complete: [], natural: [], status: [], warnings: [] };
  tts.onActualChunkStart = i => events.start.push(i); tts.onActualChunkComplete = i => events.complete.push(i);
  tts.onNaturalComplete = i => events.natural.push(i); tts.onStatusChange = s => events.status.push(s); tts.onFallbackWarning = s => events.warnings.push(s);
  return { tts, synth, state, clock, events,
    start() { state.active?.onstart?.(); },
    end(u = state.active) { if (state.active === u) { state.active = null; state.speaking = false; } u?.onend?.(); },
    error(reason, u = state.active) { if (state.active === u) { state.active = null; state.speaking = false; } u?.onerror?.({ error: reason }); },
    setVoices(list) { voices = list; },
    cleanup() {
      try { tts.dispose(); assert.equal(clock.tasks.size, 0, 'all engine timers released on dispose'); }
      finally { Date.now = savedNow; for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
    }
  };
}
function check(name, fn, options) { test(name, () => { const env = environment(options); try { fn(env); } finally { env.cleanup(); } }); }

check('Voice: same normalized setters and recreated identity are no-ops after debounce window', e => {
  e.tts.play(); e.start(); const before = [e.state.spoken.length, e.state.cancel];
  e.tts.setVoice({ ...e.tts.selectedVoice }); e.tts.setVoice('hoaimy'); e.tts.setRate('1.0'); e.tts.setPitch('1');
  e.clock.advance(500); assert.deepEqual([e.state.spoken.length, e.state.cancel], before);
});
check('Voice: repeated fresh voiceschanged preserves explicit selection and creates no restart', e => {
  e.tts.setVoice('offline'); e.tts.play(); e.start();
  for (let i = 0; i < 20; i++) e.synth.onvoiceschanged();
  e.clock.advance(500); assert.equal(e.tts.selectedVoice.voiceURI, 'offline'); assert.equal(e.state.spoken.length, 1);
});
check('Voice: selection requested before async voice availability survives polling', e => {
  e.tts.setVoice('preferred');
  e.setVoices([{ name: 'Preferred', voiceURI: 'preferred', lang: 'vi-VN' }]); e.synth.onvoiceschanged();
  assert.equal(e.tts.selectedVoice.voiceURI, 'preferred'); assert.equal(e.tts.voicePollTimer, null);
}, { delayed: true });
check('Voice: one restart for rapid voice/rate/pitch changes, same index and singular utterance', e => {
  e.tts.currentIndex = 1; e.tts.play(); e.start();
  e.tts.setVoice('offline'); e.tts.setRate(1.2); e.tts.setPitch(0.8); e.tts.setRate(1.4);
  assert.equal(e.state.spoken.length, 1); assert.equal(e.clock.tasks.size, 3);
  e.clock.advance(249); assert.equal(e.state.spoken.length, 1); e.clock.advance(1);
  assert.equal(e.state.spoken.length, 2); assert.equal(e.state.cancel, 1); assert.equal(e.tts.currentIndex, 1);
  assert.equal(e.state.active.voice.voiceURI, 'offline'); assert.equal(e.state.active.rate, 1.4); assert.equal(e.state.active.pitch, 0.8);
});
check('Voice: changes reverted to actual utterance settings cause zero restart', e => {
  e.tts.play(); e.start(); e.tts.setRate(1.4); e.tts.setRate(1); e.clock.advance(500);
  assert.equal(e.state.spoken.length, 1); assert.equal(e.tts.configurationRestartTimer, null);
});
check('Voice: pending configuration restart cannot run after Stop or a new Play', e => {
  e.tts.play(); e.start(); e.tts.setRate(1.3); const oldTimer = e.clock.tasks.get(e.tts.configurationRestartTimer).fn;
  e.tts.stop(); assert.equal(e.tts.configurationRestartTimer, null); e.tts.play(); e.start(); oldTimer(); e.clock.advance(500);
  assert.equal(e.state.spoken.length, 2); assert.equal(e.state.active.rate, 1.3);
});
check('Voice: Pause cancels pending debounce; Resume applies all changes exactly once', e => {
  e.tts.play(); e.start(); e.tts.setRate(1.2); e.tts.pause(); e.tts.setVoice('offline'); e.tts.setPitch(0.9);
  e.clock.advance(500); assert.equal(e.state.spoken.length, 1); assert.equal(e.tts.keepAliveTimer, null);
  e.tts.resume(); assert.equal(e.state.spoken.length, 2); assert.equal(e.state.active.rate, 1.2); assert.equal(e.state.active.pitch, 0.9); e.clock.advance(500); assert.equal(e.state.spoken.length, 2);
});
check('Voice: populateVoiceSelect refresh is read-only for Browser and Cloud configuration', e => {
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function populateVoiceSelect(voices, activeVoice)'); const end = source.indexOf('\n/**', begin);
  const document = { createElement() { return { appendChild() {} }; } };
  const DOM = { ttsVoiceSelect: { value: '', appendChild() {} } };
  const state = { tts: e.tts, settings: { ttsVoice: 'hoaimy' } };
  const populate = new Function('document', 'DOM', 'state', 'VIETNAMESE_VOICE_CATALOG', 'formatBrowserVoiceLabel', source.slice(begin, end) + ';return populateVoiceSelect;')(document, DOM, state, VIETNAMESE_VOICE_CATALOG, formatBrowserVoiceLabel);
  e.tts.setVoice('offline'); e.tts.play(); e.start();
  for (let i = 0; i < 5; i++) populate(e.synth.getVoices(), e.tts.selectedVoice);
  e.clock.advance(500); assert.equal(e.state.spoken.length, 1); assert.equal(e.tts.selectedVoice.voiceURI, 'offline'); assert.equal(DOM.ttsVoiceSelect.value, 'offline');
  e.tts.stop(); e.tts.setEngine('cloud'); e.tts.setCloudConfig({ provider: 'openai', voice: 'nova' });
  populate(e.synth.getVoices(), e.tts.selectedVoice); assert.equal(e.tts.engine, 'cloud'); assert.equal(DOM.ttsVoiceSelect.value, 'openai:nova');
});
check('Lifecycle: normal multi-chunk playback completes in order with one natural completion', e => {
  e.tts.play();
  for (let i = 0; i < 3; i++) { e.start(); e.end(); e.clock.advance(0); }
  assert.deepEqual(e.events.complete, [0, 1, 2]); assert.deepEqual(e.events.natural, [2]); assert.equal(e.state.spoken.length, 3);
  assert.equal(e.tts.isPlaying, false); assert.equal(e.clock.tasks.size, 0); assert.equal(e.events.status.at(-1), 'completed');
});
check('Lifecycle: duplicate onend/onerror only handles one terminal event', e => {
  e.tts.play(); e.start(); const u = e.state.active; const end = u.onend; const error = u.onerror;
  e.end(); end(); error({ error: 'network' }); e.clock.advance(0);
  assert.deepEqual(e.events.complete, [0]); assert.equal(e.tts.currentIndex, 1); assert.equal(e.state.spoken.length, 2);
});
check('Lifecycle: onstart/network error/onstart/network error has exactly one same-chunk retry', e => {
  e.tts.play(); e.start(); const end = e.state.active.onend; e.error('network'); end();
  assert.equal(e.events.complete.length, 0); e.clock.advance(0); assert.equal(e.state.spoken.length, 2); assert.equal(e.tts.currentIndex, 0);
  e.start(); assert.equal(e.tts.consecutiveErrorCount, 1); e.error('network'); e.clock.advance(5000);
  assert.equal(e.state.spoken.length, 2); assert.equal(e.tts.currentIndex, 0); assert.equal(e.tts.isPlaying, false); assert.equal(e.events.status.at(-1), 'error'); assert.equal(e.clock.tasks.size, 0);
});
for (const reason of ['synthesis-failed', 'not-allowed', 'voice-unavailable', 'canceled', 'interrupted']) {
  check('Lifecycle: active ' + reason + ' halts without advance/completion/retry', e => {
    e.tts.play(); e.start(); e.error(reason); e.clock.advance(5000);
    assert.equal(e.tts.isPlaying, false); assert.equal(e.tts.currentIndex, 0); assert.equal(e.state.spoken.length, 1); assert.equal(e.events.complete.length, 0); assert.equal(e.events.status.at(-1), 'error'); assert.equal(e.clock.tasks.size, 0);
  });
}
check('Lifecycle: synchronous captured cancel-onend cannot recurse or advance', e => {
  e.tts.play(); e.start(); e.tts.setRate(1.2); e.clock.advance(250); assert.equal(e.state.spoken.length, 2);
  e.start(); e.tts.stop(); e.clock.advance(1000); assert.equal(e.state.spoken.length, 2); assert.equal(e.events.complete.length, 0);
}, { syncCancelEnd: true });
check('Lifecycle: old callbacks and timer closures cannot clear current watchdog or change playback', e => {
  e.tts.play(); e.start(); const old = e.state.active; const callbacks = [old.onstart, old.onend, old.onerror, old.onresume];
  const oldWatchdog = e.clock.tasks.get(e.tts.stuckWatchdogTimer).fn;
  e.tts.setRate(1.2); e.clock.advance(250); e.start(); const watchdog = e.tts.stuckWatchdogTimer;
  callbacks.forEach(fn => fn({ error: 'network' })); oldWatchdog();
  assert.equal(e.tts.stuckWatchdogTimer, watchdog); assert.equal(e.tts.currentIndex, 0); assert.equal(e.events.complete.length, 0); assert.equal(e.events.start.length, 2);
});
check('Lifecycle: Pause/Resume retains utterance ownership and rearms watchdog', e => {
  e.tts.play(); e.start(); const u = e.state.active; const generation = e.tts.generationToken;
  e.tts.pause(); e.clock.advance(500); e.tts.resume(); assert.equal(e.state.active, u); assert.equal(e.tts.generationToken, generation); assert.ok(e.tts.stuckWatchdogTimer);
  e.end(); e.clock.advance(0); assert.equal(e.tts.currentIndex, 1); assert.deepEqual(e.events.complete, [0]);
});
check('Lifecycle: terminal event while paused stays paused and Resume replays same chunk safely', e => {
  e.tts.play(); e.start(); e.tts.pause(); e.end(); e.clock.advance(500); assert.equal(e.events.complete.length, 0); assert.equal(e.tts.isPaused, true);
  e.tts.resume(); assert.equal(e.tts.currentIndex, 0); assert.equal(e.state.spoken.length, 2);
});
check('Lifecycle: missing onstart completion halts and preserves index', e => {
  e.tts.play(); e.end(); e.clock.advance(1000); assert.equal(e.tts.currentIndex, 0); assert.equal(e.events.complete.length, 0); assert.equal(e.events.status.at(-1), 'error'); assert.equal(e.tts.lastPlaybackOutcome.reason, 'missing-start');
});
for (const rate of [0.7, 1, 2.2]) {
  check('Completion: short valid utterance at rate ' + rate + ' is not time-gated', e => {
    e.tts.chunks = ['Ừ.']; e.tts.setRate(rate); e.tts.play(); e.start(); e.end(); assert.deepEqual(e.events.complete, [0]); assert.equal(e.events.status.at(-1), 'completed');
  });
  check('Completion: suspicious immediate long completion at rate ' + rate + ' halts, never retries', e => {
    e.tts.chunks = ['Một câu văn dài '.repeat(12)]; e.tts.setRate(rate); e.tts.play(); e.start(); e.end(); e.clock.advance(1000);
    assert.equal(e.events.complete.length, 0); assert.equal(e.state.spoken.length, 1); assert.equal(e.events.status.at(-1), 'error'); assert.equal(e.tts.lastPlaybackOutcome.reason, 'premature-end');
  });
  check('Completion: ordinary long completion at rate ' + rate + ' remains valid', e => {
    e.tts.chunks = ['Một câu văn dài '.repeat(12)]; e.tts.setRate(rate); e.tts.play(); e.start(); e.clock.advance(1000); e.end(); assert.deepEqual(e.events.complete, [0]);
  });
}
check('Completion: pause duration does not disguise a premature long completion', e => {
  e.tts.chunks = ['Một câu văn dài '.repeat(12)]; e.tts.play(); e.start(); e.tts.pause(); e.clock.advance(10000); e.tts.resume(); e.end();
  assert.equal(e.events.complete.length, 0); assert.equal(e.tts.lastPlaybackOutcome.reason, 'premature-end');
});
check('Lifecycle: watchdog timeout never completes, advances or retries', e => {
  e.tts.play(); e.start(); e.clock.advance(14000);
  assert.equal(e.events.complete.length, 0); assert.equal(e.tts.currentIndex, 0); assert.equal(e.state.spoken.length, 1); assert.equal(e.events.status.at(-1), 'error'); assert.equal(e.tts.lastPlaybackOutcome.type, 'timeout'); assert.equal(e.clock.tasks.size, 0);
});
check('Lifecycle: Stop clears a pending retry and repeated Play is idempotent', e => {
  e.tts.play(); e.tts.play(); e.start(); e.error('network'); e.tts.stop(); e.clock.advance(0); assert.equal(e.state.spoken.length, 1); assert.equal(e.clock.tasks.size, 0);
});
check('KeepAlive: offline pulse occurs once, timer replacement suppresses captured old heartbeat', e => {
  e.tts.setVoice('offline'); e.tts.chunks = ['Một câu dài để giữ nhịp.']; e.tts.play(); e.start();
  const oldPulse = e.clock.tasks.get(e.tts.keepAliveTimer).fn; e.tts.startKeepAlive(); assert.equal([...e.clock.tasks.values()].filter(t => t.repeat).length, 1);
  e.clock.advance(10000); assert.equal(e.state.pause, 1); assert.equal(e.state.resume, 1);
  oldPulse(); assert.equal(e.state.pause, 1); e.tts.stop(); oldPulse(); assert.equal(e.state.pause, 1); assert.equal(e.clock.tasks.size, 0);
});
check('KeepAlive: HoaiMy Natural never receives pulses, including pending offline selection', e => {
  e.tts.chunks = ['Một câu dài để giữ nhịp.']; e.tts.play(); e.start(); e.clock.advance(10000); assert.equal(e.state.pause, 0);
  e.tts.setVoice('offline'); const pulse = e.clock.tasks.get(e.tts.keepAliveTimer).fn; pulse(); assert.equal(e.state.pause, 0);
});
check('KeepAlive: no pulse before start, during pause, at chunk boundary or after Stop', e => {
  e.tts.setVoice('offline'); e.tts.play(); const pulse = e.clock.tasks.get(e.tts.keepAliveTimer).fn;
  e.clock.advance(10000); assert.equal(e.state.pause, 0); e.start(); e.tts.pause(); pulse(); assert.equal(e.state.pause, 1);
  e.tts.resume(); e.end(); pulse(); assert.equal(e.state.pause, 1); e.clock.advance(0); assert.equal(e.state.spoken.length, 2);
  e.tts.stop(); pulse(); assert.equal(e.state.pause, 1);
});
check('KeepAlive: native pause callback stopping playback prevents the paired resume', e => {
  e.tts.setVoice('offline'); e.tts.chunks = ['Một câu dài.']; e.tts.play(); e.start();
  const originalPause = e.synth.pause; e.synth.pause = () => { originalPause(); e.tts.stop(); };
  e.clock.advance(10000); assert.equal(e.state.pause, 1); assert.equal(e.tts.isPlaying, false);
  // cancelCurrentSource may unpause only if cancel left synth paused; the mock cancel clears it.
  assert.equal(e.state.resume, 0);
});
check('Resources: repeated Play/Stop and audio initialization keep timers/listeners bounded', e => {
  assert.equal(e.tts.audioEventListeners.length, 4); e.tts.initAudioElement(); assert.equal(e.tts.audioEventListeners.length, 4);
  for (let i = 0; i < 10; i++) {
    e.tts.play(); e.start(); e.tts.setRate(i % 2 ? 1 : 1.2); e.tts.stop(); e.clock.advance(1000);
    assert.equal(e.clock.tasks.size, 0); assert.equal(e.tts.currentUtterance, null); assert.equal(e.tts.browserPlayback, null);
  }
  assert.equal(e.state.spoken.length, 10); e.tts.dispose(); assert.equal(e.tts.audioEventListeners.length, 0); assert.equal(e.synth.onvoiceschanged, null);
  e.tts.play(); e.tts.jumpToIndex(0); assert.equal(e.state.spoken.length, 10);
}, { audio: true });
check('Resources: dispose owns voice polling and cannot erase another engine voice handler', e => {
  assert.ok(e.tts.voicePollTimer); const newer = () => {}; e.synth.onvoiceschanged = newer; e.tts.dispose(); assert.equal(e.clock.tasks.size, 0); assert.equal(e.synth.onvoiceschanged, newer);
}, { delayed: true });
check('Observers: Stop in completion callback prevents next-chunk playback', e => {
  e.tts.onActualChunkComplete = i => { e.events.complete.push(i); e.tts.stop(); };
  e.tts.play(); e.start(); e.end(); e.clock.advance(0); assert.equal(e.state.spoken.length, 1); assert.equal(e.tts.isPlaying, false);
});
check('Observers: new playback in error cleanup cannot be overwritten by the old error status', e => {
  e.tts.onChunkEnd = () => { e.tts.onChunkEnd = null; e.tts.play(); };
  e.tts.play(); e.start(); e.error('not-allowed'); assert.equal(e.state.spoken.length, 2); assert.equal(e.tts.isPlaying, true); assert.equal(e.events.status.at(-1), 'playing');
});

check('Voice: first native voice availability must not restart pending Cloud playback', e => {
  e.tts.setEngine('cloud'); e.tts.setCloudConfig({ apiKey: 'mock-key' });
  e.tts.queueScheduler.requestChunk = () => new Promise(() => {});
  e.tts.play(); const request = e.tts.playbackRequestId;
  e.setVoices([{ name: 'Microsoft HoaiMy', voiceURI: 'hoaimy', lang: 'vi-VN' }]); e.synth.onvoiceschanged(); e.clock.advance(500);
  assert.equal(e.tts.configurationRestartTimer, null); assert.equal(e.tts.playbackRequestId, request); assert.equal(e.state.spoken.length, 0);
}, { delayed: true, audio: true });
check('Lifecycle: final chunk network failure never emits chapter completion', e => {
  e.tts.chunks = ['Câu cuối.']; e.tts.play(); e.start(); e.error('network'); e.clock.advance(0); e.start(); e.error('network');
  assert.deepEqual(e.events.complete, []); assert.deepEqual(e.events.natural, []); assert.ok(!e.events.status.includes('completed')); assert.equal(e.tts.currentIndex, 0);
});
check('Lifecycle: successful retry resets budget only on valid end, allowing one retry in next chunk', e => {
  e.tts.play(); e.start(); e.error('network'); e.clock.advance(0); e.start(); e.end(); e.clock.advance(0);
  assert.equal(e.tts.currentIndex, 1); assert.equal(e.tts.consecutiveErrorCount, 0); e.start(); e.error('network'); e.clock.advance(0);
  assert.equal(e.tts.currentIndex, 1); assert.equal(e.state.spoken.length, 4);
});
check('Resources: circuit breaker remains bounded for synthetic rapid terminal events', e => {
  e.tts.chunks = Array.from({ length: 65 }, () => 'Ừ.'); e.tts.play();
  for (let i = 0; i < 65 && e.tts.isPlaying; i++) { e.start(); e.end(); e.clock.advance(0); }
  assert.equal(e.tts.isPlaying, false); assert.equal(e.state.spoken.length, 60); assert.equal(e.events.status.at(-1), 'error'); assert.equal(e.clock.tasks.size, 0);
});
check('Observers: duplicate onstart and stale preview terminal cannot restart paused newer playback', e => {
  e.tts.play(); e.start(); e.start(); assert.deepEqual(e.events.start, [0]);
  void e.tts.previewVoice('offline'); const finishPreview = e.tts.previewUtterance.onend;
  e.tts.stop(); e.tts.play(); e.start(); e.tts.pause(); const before = e.state.spoken.length;
  finishPreview(); assert.equal(e.tts.isPaused, true); assert.equal(e.state.spoken.length, before);
});

check('Voice: paused changes reverted to actual configuration resume without replacement', e => {
  e.tts.play(); e.start(); const u = e.state.active; e.tts.pause(); e.tts.setRate(1.3); e.tts.setRate(1); e.tts.setPitch(0.8); e.tts.setPitch(1);
  e.tts.resume(); assert.equal(e.state.active, u); assert.equal(e.state.spoken.length, 1); e.end(); e.clock.advance(0); assert.equal(e.tts.currentIndex, 1);
});
check('Observers: playback status replacing a generation cannot make old Play submit again', e => {
  let replace = true;
  e.tts.onStatusChange = status => {
    if (status === 'playing' && replace) { replace = false; e.tts.stop(); e.tts.play(); }
  };
  e.tts.play(); assert.equal(e.state.spoken.length, 1); assert.equal(e.state.cancel, 1);
});

check('Lifecycle: empty and punctuation chunks are filtered iteratively without recursive speak', e => {
  e.tts.chunks = [...Array.from({ length: 100 }, (_, i) => i % 2 ? '”' : ''), 'Câu hợp lệ.'];
  e.tts.play(); e.start(); assert.equal(e.tts.currentIndex, 100); assert.equal(e.state.spoken.length, 1); assert.equal(e.state.active.text, 'Câu hợp lệ.');
  assert.equal(e.tts.diagnosticsCounts.speakCurrentChunk, 1); assert.equal(e.tts.diagnosticsCounts.speakBrowserChunk, 1);
});
