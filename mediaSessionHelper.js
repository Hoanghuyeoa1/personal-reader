/**
 * Media Session API & Background Audio Helper for VietReader (Audiobook & Sleep Suite)
 * Overcomes Web Speech API background limitation by maintaining a silent looping audio track.
 * Synchronizes lock screen / notification metadata and hardware / Bluetooth headset controls.
 */

// Minimal 1-second silent WAV base64 string
const SILENT_WAV_BASE64 = (() => {
  const bytes = new Uint8Array(8044);
  const view = new DataView(bytes.buffer);
  const label = (at, text) => [...text].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  label(0, 'RIFF'); view.setUint32(4, 8036, true); label(8, 'WAVE');
  label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  label(36, 'data'); view.setUint32(40, 8000, true); bytes.fill(128, 44);
  return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...bytes));
})();
const sessionOwners = new WeakMap();

export class MediaSessionHelper {
  constructor(callbacks = {}) {
    this.callbacks = {
      onPlay: callbacks.onPlay || null,
      onPause: callbacks.onPause || null,
      onPrevTrack: callbacks.onPrevTrack || null,
      onNextTrack: callbacks.onNextTrack || null,
      onSeekBackward: callbacks.onSeekBackward || null,
      onSeekForward: callbacks.onSeekForward || null,
      onStop: callbacks.onStop || null
    };

    this.silentAudio = null;
    this.isSilentAudioPlaying = false;
    this.lastMetadata = null;
    this._playPromise = null;
    this._sessionToken = 0;
    this.destroyed = false;
    this._desiredPlaying = false;
    this._handlingAction = false;
    this._mediaSession = null;

    this.initSilentAudio();
    this.initActionHandlers();
  }

  /**
   * Initializes silent background audio element to keep OS Media Session alive.
   */
  initSilentAudio() {
    if (this.destroyed || this.silentAudio || typeof window === 'undefined' || typeof Audio === 'undefined') return;

    try {
      this.silentAudio = new Audio(SILENT_WAV_BASE64);
      this.silentAudio.loop = true;
      // Inaudible volume to keep audio context actively streaming without disturbing user
      this.silentAudio.volume = 0.001;
    } catch (e) {
      console.warn('Không thể khởi tạo silent audio element:', e);
    }
  }

  /**
   * Starts silent audio track when TTS starts speaking.
   */
  startBackgroundSession() {
    if (this.destroyed) return;
    this.initSilentAudio();
    const audio = this.silentAudio;
    if (!audio) return;
    this._desiredPlaying = true;
    this.setPlaybackState('playing');
    if (this.isSilentAudioPlaying || this._playPromise) return;
    const token = ++this._sessionToken;
    try {
      const promise = Promise.resolve(audio.play());
      this._playPromise = promise;
      promise.then(() => {
        if (this._playPromise === promise) this._playPromise = null;
        if (!this.destroyed && this.silentAudio === audio && this._sessionToken === token && this._desiredPlaying) {
          this.isSilentAudioPlaying = true;
        } else if (this.silentAudio !== audio || !this._desiredPlaying) {
          try { audio.pause(); } catch {}
        }
      }, err => {
        if (this._playPromise === promise) this._playPromise = null;
        if (this._sessionToken === token) this.isSilentAudioPlaying = false;
        console.debug('Silent audio play deferred:', err?.message);
      });
    } catch (err) {
      this.isSilentAudioPlaying = false;
      console.debug('Silent audio play error:', err?.message);
    }
  }

  /**
   * Pauses silent audio track.
   */
  pauseBackgroundSession() {
    if (this.destroyed) return;
    this._sessionToken++;
    this._desiredPlaying = false;
    this._playPromise = null;
    try { this.silentAudio?.pause(); } catch {}
    this.isSilentAudioPlaying = false;
    this.setPlaybackState('paused');
  }

  /**
   * Stops silent audio track completely.
   */
  stopBackgroundSession() {
    this._sessionToken++;
    this._desiredPlaying = false;
    this._playPromise = null;
    const audio = this.silentAudio;
    this.silentAudio = null;
    this.isSilentAudioPlaying = false;
    if (audio) {
      try { audio.pause(); audio.currentTime = 0; } catch {}
      try { audio.removeAttribute?.('src'); audio.src = ''; audio.load?.(); } catch {}
    }
    this.setPlaybackState('none');
  }

  /**
   * Updates OS Media Notification metadata (title, artist, album, cover artwork).
   * @param {Object} info
   * @param {string} info.title - Current chapter title
   * @param {string} info.bookTitle - Book title
   * @param {string} [info.author] - Book author
   * @param {string} [info.artworkUrl] - Custom artwork or generated SVG
   */
  updateMetadata(info = {}) {
    if (this.destroyed || typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') {
      return;
    }

    const title = info.title || 'Đang đọc';
    const bookTitle = info.bookTitle || 'VietReader Sách Nói';
    const author = info.author || 'VietReader AI TTS';
    const artworkUrl = info.artworkUrl || this.generateDefaultCoverSvg(bookTitle);

    this.lastMetadata = { title, bookTitle, author };

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: `VietReader - ${bookTitle}`,
        album: author,
        artwork: [
          { src: artworkUrl, sizes: '512x512', type: 'image/svg+xml' }
        ]
      });
    } catch (err) {
      console.warn('Lỗi cập nhật MediaSession metadata:', err);
    }
  }

  /**
   * Sets MediaSession playback state ('none' | 'paused' | 'playing').
   * @param {'none'|'paused'|'playing'} state
   */
  setPlaybackState(state) {
    if (this.destroyed || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (sessionOwners.get(navigator.mediaSession) && sessionOwners.get(navigator.mediaSession) !== this) return;

    try {
      navigator.mediaSession.playbackState = state;
    } catch (err) {
      console.warn('Lỗi cập nhật playbackState:', err);
    }
  }

  /**
   * Registers Action Handlers for OS and Bluetooth headset buttons.
   */
  initActionHandlers() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    this._mediaSession = navigator.mediaSession;
    sessionOwners.set(this._mediaSession, this);
    const actionMap = [
      {
        action: 'play',
        handler: () => {
          if (typeof this.callbacks.onPlay === 'function') this.callbacks.onPlay();
          else this.startBackgroundSession();
        }
      },
      {
        action: 'pause',
        handler: () => {
          if (typeof this.callbacks.onPause === 'function') this.callbacks.onPause();
          else this.pauseBackgroundSession();
        }
      },
      {
        action: 'previoustrack',
        handler: () => {
          if (typeof this.callbacks.onPrevTrack === 'function') {
            this.callbacks.onPrevTrack();
          }
        }
      },
      {
        action: 'nexttrack',
        handler: () => {
          if (typeof this.callbacks.onNextTrack === 'function') {
            this.callbacks.onNextTrack();
          }
        }
      },
      {
        action: 'seekbackward',
        handler: (details) => {
          const skipSeconds = details?.seekOffset || 10;
          if (typeof this.callbacks.onSeekBackward === 'function') {
            this.callbacks.onSeekBackward(skipSeconds);
          }
        }
      },
      {
        action: 'seekforward',
        handler: (details) => {
          const skipSeconds = details?.seekOffset || 10;
          if (typeof this.callbacks.onSeekForward === 'function') {
            this.callbacks.onSeekForward(skipSeconds);
          }
        }
      },
      {
        action: 'stop',
        handler: () => {
          this.stopBackgroundSession();
          if (typeof this.callbacks.onStop === 'function') {
            this.callbacks.onStop();
          }
        }
      }
    ];

    actionMap.forEach(({ action, handler }) => {
      try {
        this._mediaSession.setActionHandler(action, details => {
          if (this.destroyed || sessionOwners.get(this._mediaSession) !== this || this._handlingAction) return;
          this._handlingAction = true;
          try { handler(details); } finally { this._handlingAction = false; }
        });
      } catch (err) {
        // Some actions might not be supported on all operating systems
        console.debug(`Action handler [${action}] không được hỗ trợ:`, err.message);
      }
    });
  }

  /**
   * Cleans up silent audio and removes registered MediaSession action handlers.
   */
  destroy() {
    if (this.destroyed) return;
    this.stopBackgroundSession();
    this.destroyed = true;
    const session = this._mediaSession;
    if (session && sessionOwners.get(session) === this) {
      for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'stop']) {
        try { session.setActionHandler(action, null); } catch {}
      }
      try { session.metadata = null; session.playbackState = 'none'; } catch {}
      sessionOwners.delete(session);
    }
    this._mediaSession = null;
    this.lastMetadata = null;
    this.callbacks = {};
  }

  /**
   * Generates a clean vector SVG book cover data URL for notification banner display.
   * @param {string} title
   * @returns {string} - Data URL string
   */
  generateDefaultCoverSvg(title) {
    const safeTitle = (title || 'VietReader')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#4f46e5" />
            <stop offset="50%" stop-color="#7c3aed" />
            <stop offset="100%" stop-color="#0284c7" />
          </linearGradient>
        </defs>
        <rect width="512" height="512" rx="64" fill="url(#grad)" />
        <circle cx="256" cy="180" r="80" fill="rgba(255,255,255,0.15)" />
        <path d="M220 140 L320 200 L220 260 Z" fill="#ffffff" />
        <text x="256" y="360" font-family="system-ui, sans-serif" font-size="34" font-weight="bold" fill="#ffffff" text-anchor="middle">
          ${safeTitle.length > 20 ? safeTitle.substring(0, 18) + '...' : safeTitle}
        </text>
        <text x="256" y="410" font-family="system-ui, sans-serif" font-size="22" fill="rgba(255,255,255,0.8)" text-anchor="middle">
          VietReader Audio Suite
        </text>
      </svg>
    `.trim();

    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
}
