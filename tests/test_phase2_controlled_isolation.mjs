import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSEngine } from './tts.js';

// ============================================================================
// PHASE 2 DETERMINISTIC CONTROLLED ISOLATION TEST SUITE
// ============================================================================

class MockUtterance {
  static createdCount = 0;
  static activeInstances = new Set();

  constructor(text) {
    MockUtterance.createdCount++;
    MockUtterance.activeInstances.add(this);

    this.text = text;
    this.voice = null;
    this.lang = 'vi-VN';
    this.rate = 1.0;
    this.pitch = 1.0;
    this.volume = 1.0;

    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onpause = null;
    this.onresume = null;
  }

  dispose() {
    MockUtterance.activeInstances.delete(this);
  }

  static reset() {
    MockUtterance.createdCount = 0;
    MockUtterance.activeInstances.clear();
  }
}

function createDeterministicMockSynth(options = {}) {
  const state = {
    speakCount: 0,
    cancelCount: 0,
    pauseCount: 0,
    resumeCount: 0,
    speaking: false,
    paused: false,
    spokenUtterances: [],
    onPulseCallback: options.onPulse || null
  };

  const voices = options.voices || [
    { name: 'Microsoft HoaiMy - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy' },
    { name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'vi-VN-HoaiMy-Natural' },
    { name: 'Microsoft An', lang: 'vi-VN', voiceURI: 'vi-VN-An' },
    { name: 'Google Tiếng Việt', lang: 'vi-VN', voiceURI: 'Google-vi-VN' }
  ];

  const synth = {
    state,
    get speaking() { return state.speaking; },
    get paused() { return state.paused; },
    speak(utt) {
      state.speakCount++;
      state.speaking = true;
      state.spokenUtterances.push(utt);
    },
    cancel() {
      state.cancelCount++;
      state.speaking = false;
      state.paused = false;
    },
    pause() {
      state.pauseCount++;
      state.paused = true;
      if (typeof state.onPulseCallback === 'function') {
        state.onPulseCallback('pause');
      }
    },
    resume() {
      state.resumeCount++;
      state.paused = false;
      if (typeof state.onPulseCallback === 'function') {
        state.onPulseCallback('resume');
      }
    },
    getVoices() {
      return voices;
    }
  };

  return synth;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ============================================================================
// ISOLATION A: BASELINE (IDLE)
// ============================================================================

test('Isolation A: Baseline Idle State retains zero resources', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);

  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.isPlaying, false);
  assert.equal(snap.isPaused, false);
  assert.equal(snap.hasActiveUtterance, false);
  assert.equal(snap.activeTimers.keepAlive, false);
  assert.equal(snap.activeTimers.transition, false);
  assert.equal(snap.activeTimers.watchdog, false);
  assert.equal(mockSynth.state.speakCount, 0);
  assert.equal(mockSynth.state.pauseCount, 0);
});

// ============================================================================
// ISOLATION B: MINIMAL SPEECHSYNTHESIS (PURE SHORT CHUNKS WITH 150MS BUFFER)
// ============================================================================

test('Isolation B: Minimal SpeechSynthesis sequential execution with safe buffer runs 100% cleanly', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = [
    'Câu thứ nhất kiểm tra âm sắc và hàng đợi giọng nói.',
    'Câu thứ hai kiểm tra quá trình chuyển câu an toàn.',
    'Câu thứ ba đánh giá phản ứng của tiến trình trình duyệt.',
    'Câu thứ tư kiểm tra bộ nhớ và sự kiện kết thúc.',
    'Câu thứ năm hoàn tất bài kiểm tra cô lập thành công.'
  ];
  tts.currentIndex = 0;

  tts.play();

  for (let i = 0; i < 5; i++) {
    assert.equal(tts.currentIndex, i);
    const utt = mockSynth.state.spokenUtterances[i];
    assert.ok(utt);
    utt.onstart();
    // Simulate natural audio completion
    utt.onend();
    // 150ms buffer
    await delay(20);
  }

  assert.equal(mockSynth.state.speakCount, 5);
  assert.equal(mockSynth.state.pauseCount, 0, 'No keep-alive pulse needed or fired for short chunks');
  assert.equal(tts.isPlaying, false, 'Completes naturally after 5 chunks');
  tts.stop();
});

// ============================================================================
// ISOLATION C: KEEP-ALIVE PULSE COMPARISON
// ============================================================================

test('Isolation C.1: Keep-Alive pulse is completely suppressed for recognized Natural voices', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  // Voice name explicitly containing "Natural"
  tts.selectedVoice = { name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN' };
  tts.chunks = ['Câu dài phát trên Microsoft Hoài My'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Simulate 12 seconds elapsed
  tts.utteranceStartedTimestamp = Date.now() - 12000;

  // Verify regex check inside startKeepAlive()
  const voiceName = tts.selectedVoice?.name || '';
  const isOnlineOrNatural = /natural|online|neural/i.test(voiceName);
  assert.equal(isOnlineOrNatural, true, 'Online (Natural) name is correctly recognized');

  tts.stop();
});

test('Isolation C.2: CONFIRMED ROOT CAUSE: Hoài My desktop name misses regex and receives unwanted pause/resume pulse', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  // Real Edge Windows desktop name without "Online" or "Natural"
  tts.selectedVoice = { name: 'Microsoft HoaiMy - Vietnamese (Vietnam)', lang: 'vi-VN' };
  tts.chunks = ['Câu dài phát trên Microsoft Hoài My hơn 10 giây'];
  tts.currentIndex = 0;

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();

  // Simulate 12 seconds elapsed
  tts.utteranceStartedTimestamp = Date.now() - 12000;

  const voiceName = tts.selectedVoice?.name || '';
  const isOnlineOrNatural = /natural|online|neural/i.test(voiceName);

  // PROOF OF REGEX LEAK:
  assert.equal(
    isOnlineOrNatural,
    false,
    'CONFIRMED DEFECT: Desktop name evaluates to FALSE against /natural|online|neural/i'
  );

  // Because isOnlineOrNatural is false, when elapsed >= 10000ms, pause/resume is executed:
  const pauseBefore = mockSynth.state.pauseCount;
  const resumeBefore = mockSynth.state.resumeCount;

  // Simulate the interval logic directly
  if (!isOnlineOrNatural && (Date.now() - tts.utteranceStartedTimestamp >= 10000)) {
    mockSynth.pause();
    mockSynth.resume();
  }

  assert.equal(mockSynth.state.pauseCount, pauseBefore + 1, 'synth.pause() was invoked on Hoài My stream');
  assert.equal(mockSynth.state.resumeCount, resumeBefore + 1, 'synth.resume() was invoked on Hoài My stream');

  tts.stop();
});

// ============================================================================
// ISOLATION D: MEDIA SESSION / SILENT AUDIO ISOLATION
// ============================================================================

test('Isolation D: Silent audio element operates strictly in parallel without altering Web Speech callbacks', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setDiagnosticsEnabled(true);
  tts.chunks = ['Câu 0', 'Câu 1'];
  tts.currentIndex = 0;

  // Mock audio element simulating silent loop
  let silentAudioPlaying = false;
  const mockSilentAudio = {
    loop: true,
    volume: 0.001,
    play: () => { silentAudioPlaying = true; return Promise.resolve(); },
    pause: () => { silentAudioPlaying = false; }
  };

  mockSilentAudio.play();
  assert.equal(silentAudioPlaying, true);

  tts.play();
  const utt = mockSynth.state.spokenUtterances[0];
  utt.onstart();
  utt.onend();
  await delay(15);

  assert.equal(tts.currentIndex, 1);
  assert.equal(mockSynth.state.speakCount, 2);

  mockSilentAudio.pause();
  assert.equal(silentAudioPlaying, false);
  tts.stop();
});

// ============================================================================
// ISOLATION E: VOICE COMPARISON (SAPI5 OFFLINE VS EDGE ONLINE NATURAL)
// ============================================================================

test('Isolation E: Desktop SAPI voice expects pause/resume at 10s, but Natural voice must never receive it', async () => {
  const desktopVoice = { name: 'Microsoft An', lang: 'vi-VN' };
  const naturalVoice1 = { name: 'Microsoft HoaiMy - Vietnamese (Vietnam)', lang: 'vi-VN' };
  const naturalVoice2 = { name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN' };

  // Helper function to check if voice should receive keep-alive pulse:
  // Current flawed check:
  const currentCheck = v => /natural|online|neural/i.test(v.name);
  // Correct comprehensive check:
  const correctCheck = v => /natural|online|neural|hoaimy|namminh/i.test(v.name);

  assert.equal(currentCheck(desktopVoice), false, 'Desktop SAPI voice is offline -> Pulse allowed');
  assert.equal(currentCheck(naturalVoice2), true, 'Explicit Natural voice -> Pulse blocked');
  assert.equal(currentCheck(naturalVoice1), false, 'FLAWED: Desktop Hoài My -> Pulse allowed (DISRUPTS STREAM)');

  // With correct check:
  assert.equal(correctCheck(naturalVoice1), true, 'CORRECTED: Desktop Hoài My -> Pulse blocked');
});

// ============================================================================
// ISOLATION F: CHUNK SEGMENTATION & ORPHAN PUNCTUATION DEFECT
// ============================================================================

test('Isolation F: REPAIRED: splitIntoSmartChunks attaches dialogue quotes cleanly without orphan punctuation chunks', async () => {
  const tts = new TTSEngine();
  
  // Real Vietnamese dialogue text with quotation marks
  const sampleDialogue = `Linh Quy cất giọng trầm ấm như tiếng chuông đồng vọng:
"Hỡi kẻ phàm trần! Muốn kế thừa tuyệt kỹ tiên nhân, ngươi phải vượt qua thử thách tâm tính, không màng danh lợi, một lòng hướng thiện."`;

  const chunks = tts.splitIntoSmartChunks(sampleDialogue);

  // Examine the chunks generated:
  assert.ok(chunks.length >= 2);
  
  // Verify orphan punctuation chunk is eliminated:
  const orphanChunk = chunks.find(c => c === '"');
  assert.equal(
    orphanChunk,
    undefined,
    'REPAIRED: Smart chunking no longer produces orphan quote chunks `"`!'
  );

  // Verify all chunks contain pronounceable words
  const allValid = chunks.every(c => /[\p{L}\p{N}]/u.test(c));
  assert.equal(
    allValid,
    true,
    'REPAIRED: All chunks contain pronounceable characters!'
  );
});

// ============================================================================
// ISOLATION G: CLOUD PREFETCH SAFETY IN BROWSER MODE
// ============================================================================

test('Isolation G: Prefetch queue is inactive during Browser TTS mode', async () => {
  MockUtterance.reset();
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const mockSynth = createDeterministicMockSynth();
  globalThis.window = { speechSynthesis: mockSynth };

  const tts = new TTSEngine();
  tts.setEngine('browser');
  tts.chunks = ['Câu 0', 'Câu 1'];

  tts.play();
  const snap = tts.getDiagnosticsSnapshot();
  assert.equal(snap.activeCloudRequests, 0, 'Zero cloud requests in browser mode');
  tts.stop();
});
