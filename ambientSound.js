/**
 * Ambient White Noise Mixer Engine for VietReader (Audiobook & Sleep Suite)
 * Generates 4 procedural seamless looping environmental sounds using Web Audio API:
 * 1. Cozy Rain (Mưa rơi mái tôn / Cửa sổ)
 * 2. Flowing Stream (Suối chảy róc rách)
 * 3. Bamboo Forest Breeze (Rừng trúc & Gió thổi)
 * 4. Campfire Crackling (Lửa trại bập bùng)
 * 100% offline, zero external audio asset dependencies, zero-gap looping.
 */

export const AMBIENT_SOUND_PRESETS = [
  {
    id: 'rain',
    name: 'Mưa rơi mái tôn',
    subtitle: 'Cozy Rain',
    icon: '🌧️',
    defaultVolume: 0.18,
    description: 'Tiếng mưa rào êm dịu gõ nhẹ ngoài hiên cửa'
  },
  {
    id: 'stream',
    name: 'Suối chảy róc rách',
    subtitle: 'Flowing Stream',
    icon: '🌊',
    defaultVolume: 0.18,
    description: 'Tiếng nước chảy róc rách qua ghềnh đá thanh tịnh'
  },
  {
    id: 'bamboo',
    name: 'Rừng trúc & Gió thổi',
    subtitle: 'Bamboo Forest Breeze',
    icon: '🎋',
    defaultVolume: 0.18,
    description: 'Tiếng gió thoảng lay động ngọn trúc rì rào'
  },
  {
    id: 'campfire',
    name: 'Lửa trại bập bùng',
    subtitle: 'Campfire Crackling',
    icon: '🔥',
    defaultVolume: 0.16,
    description: 'Tiếng củi khô tí tách ấm cúng trong đêm vắng'
  }
];

export class AmbientSoundMixer {
  constructor(options = {}) {
    this.audioCtx = null;
    this.masterGain = null;
    this.masterVolume = options.masterVolume !== undefined ? options.masterVolume : 1.0;
    this.fadeFactor = 1.0; // Controlled by sleep timer (1.0 -> 0.0)

    // Tracks: soundId -> { buffer, sourceNode, gainNode, isPlaying, volume }
    this.tracks = new Map();

    // Cache pre-synthesized audio buffers
    this.bufferCache = new Map();
    this.pendingStops = new Map();
    this.destroyed = false;

    // Initialize preset states
    AMBIENT_SOUND_PRESETS.forEach(preset => {
      this.tracks.set(preset.id, {
        id: preset.id,
        name: preset.name,
        icon: preset.icon,
        volume: preset.defaultVolume,
        isPlaying: false,
        sourceNode: null,
        gainNode: null
      });
    });
  }

  /**
   * Initializes AudioContext and master gain node lazily on user gesture.
   */
  initAudioContext() {
    if (this.destroyed) return null;
    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') {
        Promise.resolve(this.audioCtx.resume()).catch(error => console.debug('Ambient resume failed:', error));
      }
      return this.audioCtx;
    }

    if (typeof window === 'undefined') return null;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      console.warn('Web Audio API không được hỗ trợ trên trình duyệt này.');
      return null;
    }

    this.audioCtx = new AudioContextClass();
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.setValueAtTime(this.masterVolume * this.fadeFactor, this.audioCtx.currentTime);
    this.masterGain.connect(this.audioCtx.destination);

    return this.audioCtx;
  }

  /**
   * Generates or retrieves a procedural seamless loop buffer for a sound.
   * @param {string} soundId
   * @returns {AudioBuffer|null}
   */
  getOrCreateBuffer(soundId) {
    if (this.destroyed || !this.tracks.has(soundId)) return null;
    if (this.bufferCache.has(soundId)) {
      return this.bufferCache.get(soundId);
    }

    const ctx = this.initAudioContext();
    if (!ctx) return null;

    const sampleRate = ctx.sampleRate || 44100;
    const durationSeconds = 6; // 6-second seamless loop buffer
    const frameCount = sampleRate * durationSeconds;
    const buffer = ctx.createBuffer(2, frameCount, sampleRate); // Stereo

    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    switch (soundId) {
      case 'rain':
        this.synthesizeRain(left, right, frameCount, sampleRate);
        break;
      case 'stream':
        this.synthesizeStream(left, right, frameCount, sampleRate);
        break;
      case 'bamboo':
        this.synthesizeBamboo(left, right, frameCount, sampleRate);
        break;
      case 'campfire':
        this.synthesizeCampfire(left, right, frameCount, sampleRate);
        break;
      default:
        this.synthesizeRain(left, right, frameCount, sampleRate);
    }

    // Apply seamless loop edge crossfade (200ms)
    this.applySeamlessCrossfade(left, right, frameCount, Math.floor(sampleRate * 0.2));

    this.bufferCache.set(soundId, buffer);
    return buffer;
  }

  /**
   * 1. Cozy Rain Synthesizer: Continuous filtered pink noise with micro-droplet impulses.
   */
  synthesizeRain(left, right, length, sampleRate) {
    let b0L = 0, b1L = 0, b2L = 0;
    let b0R = 0, b1R = 0, b2R = 0;

    for (let i = 0; i < length; i++) {
      const whiteL = Math.random() * 2 - 1;
      const whiteR = Math.random() * 2 - 1;

      // Pink noise filter (Paul Kellet's filter)
      b0L = 0.99886 * b0L + whiteL * 0.0555179;
      b1L = 0.99332 * b1L + whiteL * 0.0750759;
      b2L = 0.96900 * b2L + whiteL * 0.1538520;
      let pinkL = b0L + b1L + b2L + whiteL * 0.05;

      b0R = 0.99886 * b0R + whiteR * 0.0555179;
      b1R = 0.99332 * b1R + whiteR * 0.0750759;
      b2R = 0.96900 * b2R + whiteR * 0.1538520;
      let pinkR = b0R + b1R + b2R + whiteR * 0.05;

      // Occasional random rain droplet impulses (soft clicks / plops)
      if (Math.random() < 0.0018) {
        const dropFreq = 1100 + Math.random() * 600;
        const dropAmp = 0.35 * Math.random();
        for (let d = 0; d < 120 && (i + d) < length; d++) {
          const env = Math.exp(-d / 25);
          const dropSample = Math.sin((2 * Math.PI * dropFreq * d) / sampleRate) * dropAmp * env;
          pinkL += dropSample;
          pinkR += dropSample * 0.7;
        }
      }

      left[i] = pinkL * 0.16;
      right[i] = pinkR * 0.16;
    }
  }

  /**
   * 2. Flowing Stream Synthesizer: Modulated bubbling bandpass noise.
   */
  synthesizeStream(left, right, length, sampleRate) {
    let b0L = 0, b1L = 0, b2L = 0;
    let b0R = 0, b1R = 0, b2R = 0;

    for (let i = 0; i < length; i++) {
      const whiteL = Math.random() * 2 - 1;
      const whiteR = Math.random() * 2 - 1;

      b0L = 0.997 * b0L + whiteL * 0.06;
      b1L = 0.985 * b1L + whiteL * 0.10;
      b2L = 0.950 * b2L + whiteL * 0.22;
      const pinkL = b0L + b1L + b2L;

      b0R = 0.997 * b0R + whiteR * 0.06;
      b1R = 0.985 * b1R + whiteR * 0.10;
      b2R = 0.950 * b2R + whiteR * 0.22;
      const pinkR = b0R + b1R + b2R;

      // Gentle undulating flow oscillation (0.25Hz and 0.6Hz currents)
      const t = i / sampleRate;
      const waveCurrent1 = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.28 * t);
      const waveCurrent2 = 0.80 + 0.20 * Math.cos(2 * Math.PI * 0.55 * t);

      left[i] = pinkL * waveCurrent1 * 0.15;
      right[i] = pinkR * waveCurrent2 * 0.15;
    }
  }

  /**
   * 3. Bamboo Forest Breeze Synthesizer: Soft resonant sweeping wind.
   */
  synthesizeBamboo(left, right, length, sampleRate) {
    let lastL = 0;
    let lastR = 0;

    for (let i = 0; i < length; i++) {
      const whiteL = Math.random() * 2 - 1;
      const whiteR = Math.random() * 2 - 1;

      const t = i / sampleRate;
      // Gentle wind envelope swell (0.16Hz cycle)
      const windSwell = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.16 * t);

      // Lowpass smoothing filter for rustling wind
      lastL = lastL + 0.08 * (whiteL - lastL);
      lastR = lastR + 0.08 * (whiteR - lastR);

      // Subtle bamboo whistle harmonic
      const whistle = Math.sin(2 * Math.PI * 480 * t) * 0.02 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.3 * t));

      left[i] = (lastL * windSwell + whistle) * 0.24;
      right[i] = (lastR * windSwell + whistle * 0.8) * 0.24;
    }
  }

  /**
   * 4. Campfire Crackling Synthesizer: Warm low rumble with Poisson sharp crackle bursts.
   */
  synthesizeCampfire(left, right, length, sampleRate) {
    let brownL = 0;
    let brownR = 0;

    for (let i = 0; i < length; i++) {
      const whiteL = Math.random() * 2 - 1;
      const whiteR = Math.random() * 2 - 1;

      // Low rumble brown noise
      brownL = (brownL + (0.02 * whiteL)) / 1.02;
      brownR = (brownR + (0.02 * whiteR)) / 1.02;

      let sampleL = brownL * 0.7;
      let sampleR = brownR * 0.7;

      // Random wood snap / crackle impulses
      if (Math.random() < 0.0012) {
        const snapAmp = 0.6 + Math.random() * 0.4;
        const snapDecay = 15 + Math.random() * 25;
        for (let c = 0; c < 150 && (i + c) < length; c++) {
          const env = Math.exp(-c / snapDecay);
          const noiseBurst = (Math.random() * 2 - 1) * snapAmp * env;
          sampleL += noiseBurst;
          sampleR += noiseBurst * (0.8 + Math.random() * 0.4);
        }
      }

      left[i] = sampleL * 0.22;
      right[i] = sampleR * 0.22;
    }
  }

  /**
   * Applies crossfade between end and beginning of buffer to guarantee 100% click-free loop.
   */
  applySeamlessCrossfade(left, right, length, crossfadeFrames) {
    for (let i = 0; i < crossfadeFrames; i++) {
      const ratio = i / crossfadeFrames;
      const headIdx = i;
      const tailIdx = length - crossfadeFrames + i;

      // Linear blend between tail and head
      const blendedL = left[tailIdx] * (1 - ratio) + left[headIdx] * ratio;
      const blendedR = right[tailIdx] * (1 - ratio) + right[headIdx] * ratio;

      left[headIdx] = blendedL;
      left[tailIdx] = blendedL;
      right[headIdx] = blendedR;
      right[tailIdx] = blendedR;
    }
  }

  /**
   * Starts playing a specific ambient sound.
   * @param {string} soundId
   */
  startSound(soundId) {
    if (this.destroyed) return;
    this.finishPendingStop(soundId);
    const track = this.tracks.get(soundId);
    if (!track) return;

    const ctx = this.initAudioContext();
    if (!ctx) return;

    if (track.isPlaying && track.sourceNode) {
      return; // Already playing
    }

    const buffer = this.getOrCreateBuffer(soundId);
    if (!buffer) return;

    // Create source and gain nodes
    const sourceNode = ctx.createBufferSource();
    sourceNode.buffer = buffer;
    sourceNode.loop = true;

    const gainNode = ctx.createGain();
    const effectiveVol = track.volume;
    gainNode.gain.setValueAtTime(effectiveVol, ctx.currentTime);

    sourceNode.connect(gainNode);
    gainNode.connect(this.masterGain);

    sourceNode.start(0);

    track.sourceNode = sourceNode;
    track.gainNode = gainNode;
    track.isPlaying = true;
  }

  /**
   * Stops playing a specific ambient sound with a smooth fade-out.
   * @param {string} soundId
   */
  finishPendingStop(soundId) {
    const pending = this.pendingStops.get(soundId);
    if (!pending) return;
    this.pendingStops.delete(soundId);
    clearTimeout(pending.timer);
    try { pending.source.stop(); } catch {}
    try { pending.source.disconnect(); } catch {}
    try { pending.source.buffer = null; } catch {}
    try { pending.gain.disconnect(); } catch {}
  }

  stopSound(soundId) {
    const track = this.tracks.get(soundId);
    if (!track || !track.isPlaying) return;
    this.finishPendingStop(soundId);
    const source = track.sourceNode, gain = track.gainNode;
    track.sourceNode = track.gainNode = null;
    track.isPlaying = false;
    if (!source || !gain) return;
    const pending = { source, gain, timer: null };
    this.pendingStops.set(soundId, pending);
    try {
      gain.gain.setValueAtTime(gain.gain.value, this.audioCtx.currentTime);
      gain.gain.linearRampToValueAtTime(0.0001, this.audioCtx.currentTime + 0.04);
      pending.timer = setTimeout(() => {
        if (this.pendingStops.get(soundId) === pending) this.finishPendingStop(soundId);
      }, 50);
    } catch { this.finishPendingStop(soundId); }
  }

  /**
   * Toggles an ambient sound on or off.
   * @param {string} soundId
   * @param {boolean} [forceState]
   * @returns {boolean} - New playing state
   */
  toggleSound(soundId, forceState) {
    const track = this.tracks.get(soundId);
    if (!track) return false;

    const targetState = forceState !== undefined ? !!forceState : !track.isPlaying;
    if (targetState) {
      this.startSound(soundId);
    } else {
      this.stopSound(soundId);
    }
    return track.isPlaying;
  }

  /**
   * Adjusts volume of an individual sound track.
   * @param {string} soundId
   * @param {number} volume - Float between 0.0 and 1.0
   */
  setSoundVolume(soundId, volume) {
    const track = this.tracks.get(soundId);
    if (!track) return;

    track.volume = Math.max(0, Math.min(1, parseFloat(volume) || 0));

    if (track.gainNode && this.audioCtx) {
      const effectiveVol = track.volume;
      track.gainNode.gain.setValueAtTime(effectiveVol, this.audioCtx.currentTime);
    }
  }

  /**
   * Adjusts master volume for all ambient sounds.
   * @param {number} volume - Float between 0.0 and 1.0
   */
  setMasterVolume(volume) {
    this.masterVolume = Math.max(0, Math.min(1, parseFloat(volume) || 0));
    this.updateAllEffectiveVolumes();
  }

  /**
   * Sets sleep timer fade-out factor (1.0 down to 0.0).
   * @param {number} factor - Float between 0.0 and 1.0
   */
  setFadeFactor(factor) {
    this.fadeFactor = Math.max(0, Math.min(1, parseFloat(factor) || 0));
    this.updateAllEffectiveVolumes();
  }

  /**
   * Updates gain nodes for all actively playing tracks.
   */
  updateAllEffectiveVolumes() {
    if (!this.audioCtx) return;

    this.tracks.forEach(track => {
      if (track.gainNode && track.isPlaying) {
        const effectiveVol = track.volume;
        track.gainNode.gain.setValueAtTime(effectiveVol, this.audioCtx.currentTime);
      }
    });

    if (this.masterGain) {
      this.masterGain.gain.setValueAtTime(this.masterVolume * this.fadeFactor, this.audioCtx.currentTime);
    }
  }

  /**
   * Stops all playing ambient sounds.
   */
  stopAll() {
    this.tracks.forEach((track, id) => {
      if (track.isPlaying) {
        this.stopSound(id);
      }
    });
  }

  /**
   * Pauses all ambient sounds while remembering their playing state for resume.
   */
  pauseAll() {
    if (this.audioCtx && this.audioCtx.state === 'running') {
      Promise.resolve(this.audioCtx.suspend()).catch(error => console.debug('Ambient suspend failed:', error));
    }
  }

  /**
   * Resumes all playing ambient sounds.
   */
  resumeAll() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  /**
   * Checks if any ambient sound is currently playing.
   * @returns {boolean}
   */
  hasAnyPlaying() {
    for (const track of this.tracks.values()) {
      if (track.isPlaying) return true;
    }
    return false;
  }

  /**
   * Gets serializable state of mixer for persistence.
   */
  getState() {
    const soundStates = {};
    this.tracks.forEach((track, id) => {
      soundStates[id] = {
        enabled: track.isPlaying,
        volume: track.volume
      };
    });
    return {
      masterVolume: this.masterVolume,
      sounds: soundStates
    };
  }

  /**
   * Restores state from persistent storage.
   * @param {Object} savedState
   * @param {boolean} [autoPlay=false] - Whether to immediately start sounds marked as enabled
   */
  loadState(savedState, autoPlay = false) {
    if (!savedState) return;

    if (savedState.masterVolume !== undefined) {
      this.masterVolume = Math.max(0, Math.min(1, Number(savedState.masterVolume)));
    }

    if (savedState.sounds) {
      Object.entries(savedState.sounds).forEach(([id, config]) => {
        const track = this.tracks.get(id);
        if (track) {
          if (config.volume !== undefined) {
            track.volume = Math.max(0, Math.min(1, Number(config.volume)));
          }
          if (autoPlay && config.enabled) {
            this.startSound(id);
          }
        }
      });
    }
  }

  /**
   * Cleans up all ambient tracks, disconnects master nodes, and closes AudioContext.
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAll();
    for (const id of [...this.pendingStops.keys()]) this.finishPendingStop(id);
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch (e) {}
      this.masterGain = null;
    }
    if (this.audioCtx) {
      try {
        if (typeof this.audioCtx.close === 'function') {
          Promise.resolve(this.audioCtx.close()).catch(error => console.debug('Ambient close failed:', error));
        }
      } catch (e) {}
      this.audioCtx = null;
    }
    this.bufferCache.clear();
  }
}
