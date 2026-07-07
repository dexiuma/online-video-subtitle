// Runs in the page's MAIN world at document_start. Wraps fetch/XHR so that
// when the video player downloads a subtitle file (.vtt/.srt), its text is
// relayed to the content script via postMessage. With the full file, the
// extension can translate the whole episode ahead of time and display cues
// on the video clock instead of scraping them after the player renders them.
//
// The wrappers are transparent: original behavior is untouched and every
// added step is wrapped in try/catch so a failure can never break the site.

'use strict';

(() => {
  if (window.__liveSubHooked) return;
  window.__liveSubHooked = true;

  const SUB_URL = /\.(vtt|srt)([?#]|$)/i;

  function report(url, text) {
    try {
      if (typeof text === 'string' && text.length && text.length < 5e6) {
        window.postMessage({ __livesub: 'subtitle-file', url: String(url), text }, '*');
      }
    } catch { /* never break the page */ }
  }

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url =
          typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const type = (res.headers && res.headers.get('content-type')) || '';
        if (SUB_URL.test(url) || type.includes('text/vtt')) {
          res.clone().text().then((t) => report(url, t)).catch(() => {});
        }
      } catch { /* never break the page */ }
      return res;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (SUB_URL.test(String(url))) {
        this.addEventListener('load', () => {
          try {
            report(url, this.responseText);
          } catch { /* non-text responseType */ }
        });
      }
    } catch { /* never break the page */ }
    return origOpen.call(this, method, url, ...rest);
  };
})();
