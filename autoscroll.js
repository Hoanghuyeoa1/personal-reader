/**
 * Text Engine Pro: Hands-Free Auto-Scroll Engine (VietReader)
 * Powered by window.requestAnimationFrame for butter-smooth scrolling.
 * Features:
 * - Adjustable speed from 10px/s to 150px/s
 * - Smart Pause & Resume (2s pause on wheel, touch, or dock hover)
 * - Chapter bottom edge detection
 * - Zero setInterval stutter
 */

export class AutoScrollEngine {
  constructor(options = {}) {
    this.isActive = false;
    this.isPaused = false;
    this.speed = options.speed || 40; // Pixels per second (range: 10 - 150)
    this.resumeDelay = options.resumeDelay || 2000; // 2 seconds resume delay
    this.autoNextChapter = options.autoNextChapter !== undefined ? options.autoNextChapter : true;

    this.rafId = null;
    this.lastTimestamp = null;
    this.resumeTimeout = null;

    // Callbacks
    this.onStateChange = options.onStateChange || null;
    this.onReachBottom = options.onReachBottom || null;

    // Bound handlers for cleanup
    this._handleWheel = this._onUserInteraction.bind(this);
    this._handleTouch = this._onUserInteraction.bind(this);
    this._handleDockEnter = this._onDockEnter.bind(this);
    this._handleDockLeave = this._onDockLeave.bind(this);
    this._loop = this._loop.bind(this);

    this.dockEl = null;
    this.generation = 0;
    this.destroyed = false;
  }

  /**
   * Binds smart pause listeners to window and dock element.
   * @param {HTMLElement} [dockEl]
   */
  bindListeners(dockEl = null) {
    if (this.destroyed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (this.dockEl) {
      this.dockEl.removeEventListener?.('mouseenter', this._handleDockEnter);
      this.dockEl.removeEventListener?.('mouseleave', this._handleDockLeave);
    }
    this.dockEl = null;

    window.addEventListener('wheel', this._handleWheel, { passive: true });
    window.addEventListener('touchstart', this._handleTouch, { passive: true });
    window.addEventListener('touchmove', this._handleTouch, { passive: true });

    if (dockEl) {
      this.dockEl = dockEl;
      this.dockEl.addEventListener?.('mouseenter', this._handleDockEnter);
      this.dockEl.addEventListener?.('mouseleave', this._handleDockLeave);
    }
  }

  /**
   * Cleans up all attached listeners and stops animation.
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;

    window.removeEventListener('wheel', this._handleWheel);
    window.removeEventListener('touchstart', this._handleTouch);
    window.removeEventListener('touchmove', this._handleTouch);

    if (this.dockEl) {
      this.dockEl.removeEventListener('mouseenter', this._handleDockEnter);
      this.dockEl.removeEventListener('mouseleave', this._handleDockLeave);
    }
    this.dockEl = null;
    this.onStateChange = this.onReachBottom = null;
  }

  /**
   * Starts hands-free continuous auto-scrolling.
   */
  start() {
    if (this.destroyed || this.isActive) return;
    const generation = ++this.generation;
    this.isActive = true;
    this.isPaused = false;
    this.lastTimestamp = null;

    this._notifyState();
    if (this.isActive && generation === this.generation) this._scheduleFrame();
  }

  /**
   * Stops auto-scrolling completely.
   */
  stop() {
    const wasActive = this.isActive || this.isPaused;
    this.generation++;

    this.isActive = false;
    this.isPaused = false;
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.resumeTimeout) {
      clearTimeout(this.resumeTimeout);
      this.resumeTimeout = null;
    }
    this.lastTimestamp = null;
    if (wasActive) this._notifyState();
  }

  /**
   * Toggles auto-scroll between active and stopped.
   * @returns {boolean} New active state
   */
  toggle() {
    if (this.isActive) {
      this.stop();
      return false;
    } else {
      this.start();
      return true;
    }
  }

  /**
   * Sets scroll speed in pixels per second (clamped: 10 - 150 px/s).
   * @param {number} pxPerSec
   */
  setSpeed(pxPerSec) {
    const clamped = Math.max(10, Math.min(150, Math.round(pxPerSec)));
    this.speed = clamped;
    this._notifyState();
    return this.speed;
  }

  /**
   * Increases speed by delta.
   * @param {number} [delta=10]
   */
  increaseSpeed(delta = 10) {
    return this.setSpeed(this.speed + delta);
  }

  /**
   * Decreases speed by delta.
   * @param {number} [delta=10]
   */
  decreaseSpeed(delta = 10) {
    return this.setSpeed(this.speed - delta);
  }

  /**
   * Triggers temporary pause during manual interactions, automatically resumes after 2 seconds.
   * @param {number} [delayMs=2000]
   */
  pauseTemporary(delayMs = 2000) {
    if (!this.isActive) return;

    const generation = this.generation;
    this.isPaused = true;
    this._notifyState();
    if (!this.isActive || generation !== this.generation) return;

    if (this.resumeTimeout) {
      clearTimeout(this.resumeTimeout);
    }

    const timer = setTimeout(() => {
      if (this.resumeTimeout !== timer || generation !== this.generation) return;
      this.resumeTimeout = null;
      if (this.isActive) {
        this.isPaused = false;
        this.lastTimestamp = null; // Prevent huge delta jump after pause
        this._notifyState();
      }
    }, delayMs);
    this.resumeTimeout = timer;
  }

  /**
   * Internal wheel/touch interaction handler.
   */
  _onUserInteraction() {
    if (this.isActive) {
      this.pauseTemporary(this.resumeDelay);
    }
  }

  /**
   * Pause when cursor enters Floating Dock.
   */
  _onDockEnter() {
    if (this.isActive) {
      this.isPaused = true;
      if (this.resumeTimeout) clearTimeout(this.resumeTimeout);
      this.resumeTimeout = null;
      this._notifyState();
    }
  }

  /**
   * Resume after leaving Floating Dock with 1.5s delay.
   */
  _onDockLeave() {
    if (this.isActive && this.isPaused) {
      this.pauseTemporary(1500);
    }
  }

  /**
   * Main requestAnimationFrame scroll loop.
   */
  _scheduleFrame() {
    const generation = this.generation;
    const frame = window.requestAnimationFrame(timestamp => {
      if (this.rafId !== frame || generation !== this.generation || this.destroyed) return;
      this.rafId = null;
      this._loop(timestamp, generation);
    });
    this.rafId = frame;
  }

  _loop(timestamp, generation = this.generation) {
    if (!this.isActive || generation !== this.generation || this.destroyed) return;

    if (!this.isPaused) {
      if (this.lastTimestamp !== null) {
        const deltaSec = (timestamp - this.lastTimestamp) / 1000;
        // Limit delta to 0.1s to prevent giant jumps when tab switches
        const safeDeltaSec = Math.min(deltaSec, 0.1);
        const distance = this.speed * safeDeltaSec;

        if (distance > 0) {
          window.scrollBy(0, distance);
          if (!this.isActive || generation !== this.generation) return;

          // Check if reached bottom of the document
          const scrollPos = window.innerHeight + window.scrollY;
          const maxScroll = document.documentElement.scrollHeight;

          if (scrollPos >= maxScroll - 6) {
            // Reached bottom
            this.stop();
            if (!this.isActive && this.generation === generation + 1 && this.onReachBottom) {
              this.onReachBottom();
            }
            return;
          }
        }
      }
      this.lastTimestamp = timestamp;
    }

    if (this.isActive && generation === this.generation) this._scheduleFrame();
  }

  /**
   * Notifies state subscribers.
   */
  _notifyState() {
    if (this.onStateChange) {
      this.onStateChange({
        isActive: this.isActive,
        isPaused: this.isPaused,
        speed: this.speed
      });
    }
  }
}
