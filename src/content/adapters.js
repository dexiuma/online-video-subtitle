// Subtitle-source adapters. Each adapter watches one kind of subtitle source
// and calls onCue(text) whenever the visible caption changes. Loaded before
// main.js (content scripts share one scope, no modules available here).
//
// To support a new site, add a class with start()/stop() and register it in
// pickAdapters() at the bottom.

'use strict';

(() => {
  if (window.__liveSubAdapters) return; // already injected (popup + registration)

  const CUE_DEBOUNCE_MS = 120;

  class BaseAdapter {
    constructor(onCue) {
      this.onCue = onCue;
      this.lastText = '';
      this.debounceTimer = null;
      this.lang = ''; // source language, when the subtitle source declares it
    }

    emit(text) {
      const clean = (text || '').replace(/\s+/g, ' ').trim();
      if (clean === this.lastText) return;
      this.lastText = clean;
      clearTimeout(this.debounceTimer);
      // Small debounce: sites often build a caption across several mutations.
      this.debounceTimer = setTimeout(() => this.onCue(clean, this.lang), CUE_DEBOUNCE_MS);
    }

    start() {}
    stop() { clearTimeout(this.debounceTimer); }
    // Adapters that can suppress the site's own caption rendering override these.
    hideNative() {}
    showNative() {}
  }

  function cleanCueText(text) {
    return (text || '').replace(/<[^>]+>/g, ''); // strip VTT markup
  }

  function largestVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // When a parsed subtitle file is driving the overlay (SubtitleFileAdapter),
  // the scraping adapters stay silent so the same line isn't emitted twice
  // with competing timing.
  let fileSubtitlesActive = false;

  // ------------------------------------------------ generic <track> subtitles

  class TextTrackAdapter extends BaseAdapter {
    constructor(onCue, onUpcoming) {
      super(onCue);
      this.onUpcoming = onUpcoming; // optional: receives future cue texts
      this.watched = new Set(); // videos we've attached to
      this.activeTrack = null;
      this.activeVideo = null;
      this.prefetched = 0; // cues handed off for prefetch so far
      this.cueHandler = () => {
        this.readActiveCues();
        this.prefetchNewCues();
      };
      this.scanTimer = null;
      this.hidden = false;
    }

    start() {
      this.scan();
      // Videos and tracks appear late on many sites; rescan periodically.
      // Prefetching here too picks up cues that stream in (e.g. HLS).
      this.scanTimer = setInterval(() => {
        this.scan();
        this.prefetchNewCues();
      }, 2000);
    }

    stop() {
      super.stop();
      clearInterval(this.scanTimer);
      if (this.activeTrack) {
        this.activeTrack.removeEventListener('cuechange', this.cueHandler);
        this.activeTrack = null;
      }
      this.activeVideo = null;
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
      this.activeVideo = video;
      // Primary subtag only ("en-US" -> "en"); a source hint stops providers
      // from misdetecting the language of short or name-heavy lines.
      this.lang = (track.language || '').split('-')[0].toLowerCase();
      this.prefetched = 0;
      track.addEventListener('cuechange', this.cueHandler);
      if (this.hidden) this.hideNative();
      this.prefetchNewCues();
    }

    readActiveCues() {
      if (fileSubtitlesActive) return;
      const cues = Array.from(this.activeTrack?.activeCues || []);
      const text = cues
        .map((c) => cleanCueText(c.text))
        .join(' ');
      this.emit(text);
    }

    // The track knows its cues in advance — for a plain VTT that's the whole
    // episode as soon as it loads. Hand every cue we haven't sent yet to the
    // service worker, which translates them at its own pace and caches them,
    // so lines are already translated when playback reaches them. The
    // watermark means each cue is sent once; streamed-in cues (HLS) are
    // picked up as the list grows.
    prefetchNewCues() {
      const cues = this.activeTrack?.cues;
      if (!this.onUpcoming || !cues || cues.length <= this.prefetched) return;
      // Cues from the current position onward go first, then the ones behind
      // it — so starting or seeking mid-episode caches what's about to play
      // next instead of working through the episode from the top.
      const now = this.activeVideo?.currentTime ?? 0;
      const ahead = [];
      const behind = [];
      const seen = new Set();
      for (let i = this.prefetched; i < cues.length; i++) {
        const clean = cleanCueText(cues[i].text).replace(/\s+/g, ' ').trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        (cues[i].startTime >= now ? ahead : behind).push(clean);
      }
      this.prefetched = cues.length;
      const texts = ahead.concat(behind);
      if (texts.length) this.onUpcoming(texts, this.lang);
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
      this.hideWanted = false;
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
      const text = nodes.length
        ? Array.from(nodes).map((n) => n.textContent).join(' ')
        : '';
      // Only hide the native captions once this selector has actually matched
      // text, so we never blank captions we turn out not to be reading.
      if (text.trim() && this.hideWanted) this.applyHide();
      if (fileSubtitlesActive) return;
      this.emit(text);
    }

    hideNative() {
      this.hideWanted = true;
      if (this.lastText) this.applyHide();
    }

    applyHide() {
      if (this.styleEl || !this.hideCss) return;
      this.styleEl = document.createElement('style');
      this.styleEl.textContent = this.hideCss;
      document.documentElement.appendChild(this.styleEl);
    }

    showNative() {
      this.hideWanted = false;
      this.styleEl?.remove();
      this.styleEl = null;
    }
  }

  // --------------------------------------------------- subtitle file adapter
  // page-hook.js (MAIN world) posts the text of any .vtt/.srt file the player
  // downloads. With the parsed cues we know every line and its timing up
  // front: the whole episode is prefetched and the overlay is driven off the
  // video clock, so nothing waits on the player's own caption rendering.

  function parseTimedText(text) {
    const cues = [];
    const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l.trim());
      const timeIdx = lines.findIndex((l) => l.includes('-->'));
      if (timeIdx === -1) continue;
      const [a, b] = lines[timeIdx].split('-->');
      const start = parseTimestamp(a);
      const end = parseTimestamp(b);
      if (start == null || end == null) continue;
      const cueText = lines.slice(timeIdx + 1).join(' ');
      const clean = cleanCueText(cueText).replace(/\s+/g, ' ').trim();
      if (clean) cues.push({ start, end, text: clean });
    }
    return cues;
  }

  function parseTimestamp(s) {
    // "01:02:03.450", "02:03,450" (SRT) or "02:03.450"
    const m = String(s).match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) +
      Number(m[4].padEnd(3, '0')) / 1000;
  }

  class SubtitleFileAdapter extends BaseAdapter {
    constructor(onCue, onUpcoming) {
      super(onCue);
      this.onUpcoming = onUpcoming;
      this.cues = [];
      this.tickTimer = null;
      this.msgHandler = (e) => {
        const d = e.data;
        if (d && d.__livesub === 'subtitle-file' && typeof d.text === 'string') {
          this.load(d.text);
        }
      };
    }

    start() {
      window.addEventListener('message', this.msgHandler);
      this.tickTimer = setInterval(() => this.tick(), 150);
    }

    stop() {
      super.stop();
      window.removeEventListener('message', this.msgHandler);
      clearInterval(this.tickTimer);
      this.cues = [];
      fileSubtitlesActive = false;
    }

    load(text) {
      const cues = parseTimedText(text);
      if (cues.length < 2) return; // not a real subtitle file
      this.cues = cues; // a new file (e.g. language switch) replaces the old
      fileSubtitlesActive = true;
      if (!this.onUpcoming) return;
      // Prefetch everything, lines at/after the playhead first.
      const now = largestVideo()?.currentTime ?? 0;
      const ahead = [];
      const behind = [];
      const seen = new Set();
      for (const cue of cues) {
        if (seen.has(cue.text)) continue;
        seen.add(cue.text);
        (cue.end >= now ? ahead : behind).push(cue.text);
      }
      this.onUpcoming(ahead.concat(behind), this.lang);
    }

    tick() {
      if (!this.cues.length) return;
      const video = largestVideo();
      if (!video) return;
      const t = video.currentTime;
      const text = this.cues
        .filter((c) => t >= c.start && t <= c.end)
        .map((c) => c.text)
        .join(' ');
      this.emit(text);
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

  // Caption DOM of widely-used player libraries (JW Player, Video.js, Plyr,
  // ArtPlayer). Covers the embed hosts most streaming sites load their player
  // from, where captions are rendered as page elements rather than textTracks.
  // Hiding is deferred until a selector matches (see DomCaptionAdapter.read),
  // so listing several players here never blanks captions we aren't reading.
  const GENERIC_PLAYERS = {
    selector: [
      '.jw-captions .jw-text-track-cue',
      '.vjs-text-track-display .vjs-text-track-cue',
      '.plyr__captions .plyr__caption',
      '.art-subtitle'
    ].join(', '),
    hideCss:
      '.jw-captions, .vjs-text-track-display, .plyr__captions, .art-subtitle' +
      ' { opacity: 0 !important; }'
  };

  // Returns the adapters to run on this page: a site-specific one when we have
  // it (otherwise the generic player-library one), always including the
  // textTracks adapter as a fallback. onUpcoming (optional) receives batches
  // of future cue texts for prefetching.
  function pickAdapters(onCue, onUpcoming) {
    const host = location.hostname;
    const adapters = [];
    const site = SITES.find((s) => s.match(host));
    if (site) adapters.push(site.make(onCue));
    else adapters.push(new DomCaptionAdapter(onCue, GENERIC_PLAYERS));
    adapters.push(new TextTrackAdapter(onCue, onUpcoming));
    adapters.push(new SubtitleFileAdapter(onCue, onUpcoming));
    return adapters;
  }

  window.__liveSubAdapters = { pickAdapters, parseTimedText };
})();
