// Content script entry point. Watches subtitle sources (via adapters.js),
// requests translations from the service worker, and renders the overlay.
// Also displays live captions pushed from the service worker in STT mode.

'use strict';

(() => {
  if (window.__liveSubLoaded) return; // already injected (popup + registration)
  window.__liveSubLoaded = true;

  // Content scripts can't import ES modules; keep in sync with src/common/defaults.js.
  const DEFAULTS = {
    enabled: true,
    targetLang: 'en',
    displayMode: 'bilingual',
    enabledSites: [],
    overlay: {
      fontSizePx: 22,
      background: 'rgba(0, 0, 0, 0.72)',
      textColor: '#ffffff',
      bottomOffsetPct: 8,
      hideNativeCaptions: true
    }
  };

  let settings = DEFAULTS;
  let adapters = [];
  let overlay = null;
  let hideTimer = null;
  let requestSeq = 0; // drop responses that arrive after a newer cue

  // ------------------------------------------------------------- settings

  function mergedSettings(stored) {
    const s = stored || {};
    return {
      ...DEFAULTS,
      ...s,
      overlay: { ...DEFAULTS.overlay, ...(s.overlay || {}) }
    };
  }

  function siteEnabled() {
    return settings.enabledSites.includes(location.hostname);
  }

  function active() {
    return settings.enabled && siteEnabled();
  }

  async function init() {
    const { settings: stored } = await chrome.storage.local.get('settings');
    settings = mergedSettings(stored);
    if (active()) startAdapters();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const wasActive = active();
      settings = mergedSettings(changes.settings.newValue);
      applyOverlayStyle();
      if (active() && !wasActive) startAdapters();
      if (!active() && wasActive) stopAdapters();
    });
  }

  // ------------------------------------------------------------- adapters

  function startAdapters() {
    if (adapters.length) return;
    adapters = window.__liveSubAdapters.pickAdapters(onCue, onUpcoming);
    for (const a of adapters) {
      a.start();
      if (settings.overlay.hideNativeCaptions) a.hideNative();
    }
  }

  function stopAdapters() {
    for (const a of adapters) a.stop();
    adapters = [];
    removeOverlay();
  }

  // ------------------------------------------------------ translation flow

  async function onCue(text, sourceLang) {
    if (!active()) return;
    const seq = ++requestSeq;

    if (!text) {
      scheduleHide(400);
      return;
    }

    // Show the original in sync with the video; the translation replaces or
    // joins it as soon as it arrives (instantly, when cached).
    showCaption(text, '', undefined, true);

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE',
        texts: [text],
        sourceLang: sourceLang || ''
      });
    } catch {
      return; // extension reloaded / worker unavailable
    }
    if (seq !== requestSeq) return; // a newer cue superseded this one

    if (!response?.ok) {
      showCaption(text, '', response?.error);
      return;
    }
    showCaption(text, response.translations[0]);
  }

  // Fire-and-forget: warm the translation cache with upcoming cue texts so
  // they display instantly when their time comes.
  function onUpcoming(texts, sourceLang) {
    if (!active()) return;
    chrome.runtime
      .sendMessage({ type: 'TRANSLATE_PREFETCH', texts, sourceLang: sourceLang || '' })
      .catch(() => {});
  }

  // ------------------------------------------------------------- overlay

  function overlayHost() {
    // In fullscreen, the overlay must live inside the fullscreen element.
    return document.fullscreenElement || document.body;
  }

  function ensureOverlay() {
    if (overlay && overlay.isConnected && overlay.parentElement === overlayHost()) {
      return overlay;
    }
    removeOverlay();
    overlay = document.createElement('div');
    overlay.id = 'livesub-overlay';
    overlay.setAttribute('lang', settings.targetLang);
    overlay.innerHTML =
      '<div class="livesub-original"></div>' +
      '<div class="livesub-translated"></div>' +
      '<div class="livesub-error"></div>';
    makeDraggable(overlay);
    overlayHost().appendChild(overlay);
    applyOverlayStyle();
    positionOverlay();
    return overlay;
  }

  function removeOverlay() {
    clearTimeout(hideTimer);
    overlay?.remove();
    overlay = null;
  }

  function applyOverlayStyle() {
    if (!overlay) return;
    const o = settings.overlay;
    overlay.style.setProperty('--livesub-font-size', `${o.fontSizePx}px`);
    overlay.style.setProperty('--livesub-bg', o.background);
    overlay.style.setProperty('--livesub-color', o.textColor);
  }

  function positionOverlay() {
    if (!overlay || overlay.dataset.dragged) return;
    const video = largestVideo();
    if (video) {
      const rect = video.getBoundingClientRect();
      const bottomGap = (rect.height * settings.overlay.bottomOffsetPct) / 100;
      overlay.style.left = `${rect.left + rect.width / 2}px`;
      overlay.style.top = `${rect.bottom - bottomGap}px`;
      overlay.style.transform = 'translate(-50%, -100%)';
    } else {
      overlay.style.left = '50%';
      overlay.style.top = '85%';
      overlay.style.transform = 'translate(-50%, -100%)';
    }
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

  function showCaption(original, translated, error, interim = false) {
    const el = ensureOverlay();
    // Interim = translation still on its way; show the original meanwhile
    // even in translation-only mode so the caption stays in sync.
    const showOriginal =
      (settings.displayMode === 'bilingual' || (interim && !translated)) && original;
    el.querySelector('.livesub-original').textContent = showOriginal ? original : '';
    el.querySelector('.livesub-original').style.display = showOriginal ? '' : 'none';
    el.querySelector('.livesub-translated').textContent = translated || '';
    el.querySelector('.livesub-translated').style.display = translated ? '' : 'none';
    const errEl = el.querySelector('.livesub-error');
    errEl.textContent = error ? `⚠ ${error}` : '';
    errEl.style.display = error ? '' : 'none';
    el.style.visibility = 'visible';
    positionOverlay();
    // Live captions have no "cue ended" signal; expire them after a while.
    scheduleHide(8000);
  }

  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (overlay) overlay.style.visibility = 'hidden';
    }, ms);
  }

  function makeDraggable(el) {
    let startX, startY, origLeft, origTop;
    el.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        el.dataset.dragged = '1';
        el.style.transform = 'none';
        el.style.left = `${origLeft + ev.clientX - startX}px`;
        el.style.top = `${origTop + ev.clientY - startY}px`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  document.addEventListener('fullscreenchange', () => {
    if (overlay) {
      const visible = overlay.style.visibility !== 'hidden';
      const parts = overlay
        ? {
            o: overlay.querySelector('.livesub-original').textContent,
            t: overlay.querySelector('.livesub-translated').textContent
          }
        : null;
      removeOverlay();
      if (visible && parts && (parts.o || parts.t)) {
        showCaption(parts.o, parts.t);
      }
    }
  });

  window.addEventListener('resize', positionOverlay);

  // --------------------------------------------- live captions (STT mode)

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LIVE_CAPTION') {
      showCaption(msg.original, msg.translated, msg.error);
    } else if (msg.type === 'LIVE_STATE' && !msg.running) {
      scheduleHide(1500);
    }
  });

  init();
})();
