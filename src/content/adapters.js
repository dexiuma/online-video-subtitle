// Subtitle-source adapters. Each adapter watches one kind of subtitle source
// and calls onCue(text) whenever the visible caption changes. Loaded before
// main.js (content scripts share one scope, no modules available here).
//
// To support a new site, add a class with start()/stop() and register it in
// pickAdapters() at the bottom.

'use strict';

(() => {
  const CUE_DEBOUNCE_MS = 120;

  class BaseAdapter {
    constructor(onCue) {
      this.onCue = onCue;
      this.lastText = '';
      this.debounceTimer = null;
    }

    emit(text) {
      const clean = (text || '').replace(/\s+/g, ' ').trim();
      if (clean === this.lastText) return;
      this.lastText = clean;
      clearTimeout(this.debounceTimer);
      // Small debounce: sites often build a caption across several mutations.
      this.debounceTimer = setTimeout(() => this.onCue(clean), CUE_DEBOUNCE_MS);
    }

    start() {}
    stop() { clearTimeout(this.debounceTimer); }
    // Adapters that can suppress the site's own caption rendering override these.
    hideNative() {}
    showNative() {}
  }

  // ------------------------------------------------ generic <track> subtitles

  class TextTrackAdapter extends BaseAdapter {
    constructor(onCue) {
      super(onCue);
      this.watched = new Set(); // videos we've attached to
      this.activeTrack = null;
      this.cueHandler = () => this.readActiveCues();
      this.scanTimer = null;
      this.hidden = false;
    }

    start() {
      this.scan();
      // Videos and tracks appear late on many sites; rescan periodically.
      this.scanTimer = setInterval(() => this.scan(), 2000);
    }

    stop() {
      super.stop();
      clearInterval(this.scanTimer);
      if (this.activeTrack) {
        this.activeTrack.removeEventListener('cuechange', this.cueHandler);
        this.activeTrack = null;
      }
      this.showNative();
    }

    scan() {
      for (const video of document.querySelectorAll('video')) {
        if (this.watched.has(video)) continue;
        this.watched.add(video);
        video.textTracks.addEventListener?.('addtrack', () => this.pickTrack(video));
        this.pickTrack(video);
      }
    }

    pickTrack(video) {
      if (this.activeTrack) return;
      const tracks = Array.from(video.textTracks || []);
      const candidates = tracks.filter(
        (t) => t.kind === 'subtitles' || t.kind === 'captions'
      );
      if (!candidates.length) return;
      // Prefer whatever the site is already showing.
      const track =
        candidates.find((t) => t.mode === 'showing') || candidates[0];
      if (track.mode === 'disabled') track.mode = 'hidden'; // load cues without rendering
      this.activeTrack = track;
      track.addEventListener('cuechange', this.cueHandler);
      if (this.hidden) this.hideNative();
    }

    readActiveCues() {
      const cues = Array.from(this.activeTrack?.activeCues || []);
      const text = cues
        .map((c) => (c.text || '').replace(/<[^>]+>/g, '')) // strip VTT markup
        .join(' ');
      this.emit(text);
    }

    hideNative() {
      this.hidden = true;
      if (this.activeTrack && this.activeTrack.mode === 'showing') {
        this.activeTrack.mode = 'hidden';
      }
    }

    showNative() {
      this.hidden = false;
      if (this.activeTrack && this.activeTrack.mode === 'hidden') {
        this.activeTrack.mode = 'showing';
      }
    }
  }

  // ------------------------------------------------------- DOM-based captions
  // For players that render captions as page elements instead of textTracks.

  class DomCaptionAdapter extends BaseAdapter {
    constructor(onCue, { selector, hideCss, windowSelector }) {
      super(onCue);
      this.selector = selector;
      // Optional: container holding one caption "window". Some players leave
      // stale windows in the DOM (e.g. YouTube after seeking); when set, only
      // the most recent window is read.
      this.windowSelector = windowSelector;
      this.hideCss = hideCss;
      this.observer = null;
      this.styleEl = null;
    }

    start() {
      this.observer = new MutationObserver(() => this.read());
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
      this.read();
    }

    stop() {
      super.stop();
      this.observer?.disconnect();
      this.showNative();
    }

    read() {
      let root = document;
      if (this.windowSelector) {
        const windows = document.querySelectorAll(this.windowSelector);
        if (windows.length) root = windows[windows.length - 1];
      }
      const nodes = root.querySelectorAll(this.selector);
      if (!nodes.length) return this.emit('');
      const text = Array.from(nodes).map((n) => n.textContent).join(' ');
      this.emit(text);
    }

    hideNative() {
      if (this.styleEl || !this.hideCss) return;
      this.styleEl = document.createElement('style');
      this.styleEl.textContent = this.hideCss;
      document.documentElement.appendChild(this.styleEl);
    }

    showNative() {
      this.styleEl?.remove();
      this.styleEl = null;
    }
  }

  // -------------------------------------------------------------- site table

  const SITES = [
    {
      match: (host) => /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/.test(host),
      make: (onCue) =>
        new DomCaptionAdapter(onCue, {
          selector: '.ytp-caption-segment',
          windowSelector: '.caption-window',
          hideCss:
            '.ytp-caption-window-container { opacity: 0 !important; pointer-events: none !important; }'
        })
    },
    {
      match: (host) => /(^|\.)netflix\.com$/.test(host),
      make: (onCue) =>
        new DomCaptionAdapter(onCue, {
          selector: '.player-timedtext-text-container',
          hideCss: '.player-timedtext { opacity: 0 !important; }'
        })
    },
    {
      match: (host) => /(^|\.)primevideo\.com$|(^|\.)amazon\./.test(host),
      make: (onCue) =>
        new DomCaptionAdapter(onCue, {
          selector: '.atvwebplayersdk-captions-text',
          hideCss:
            '.atvwebplayersdk-captions-overlay { opacity: 0 !important; }'
        })
    }
  ];

  // Returns the adapters to run on this page: a site-specific one when we have
  // it, always including the generic textTracks adapter as a fallback.
  function pickAdapters(onCue) {
    const host = location.hostname;
    const adapters = [];
    const site = SITES.find((s) => s.match(host));
    if (site) adapters.push(site.make(onCue));
    adapters.push(new TextTrackAdapter(onCue));
    return adapters;
  }

  window.__liveSubAdapters = { pickAdapters };
})();
