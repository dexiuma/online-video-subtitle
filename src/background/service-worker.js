// Service worker: message hub between content scripts, popup/options,
// and the offscreen document that does live audio capture.

import { loadSettings } from '../common/defaults.js';
import { translateTexts } from './providers.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

// ------------------------------------------- content script registration
// Content scripts are registered dynamically, only for the sites the user
// enabled in the popup. On every other page the extension injects nothing:
// no DOM access, no observers, no code at all.

const CONTENT_SCRIPT_ID = 'livesub-captions';

async function syncContentScripts() {
  const { enabledSites } = await loadSettings();

  // Only register for origins we actually hold permission for; a host the
  // user revoked in the browser UI must not break registration for the rest.
  const origins = [];
  for (const host of enabledSites) {
    const origin = `https://${host}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) {
      origins.push(origin);
    }
  }

  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID]
  });

  if (!origins.length) {
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
    return;
  }

  const script = {
    id: CONTENT_SCRIPT_ID,
    matches: origins,
    js: ['src/content/adapters.js', 'src/content/main.js'],
    css: ['src/content/overlay.css'],
    runAt: 'document_idle',
    allFrames: true,
    persistAcrossSessions: true
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    syncContentScripts().catch(() => {});
  }
});
chrome.runtime.onInstalled.addListener(() => syncContentScripts().catch(() => {}));
chrome.runtime.onStartup.addListener(() => syncContentScripts().catch(() => {}));

// ------------------------------------------------------- translation cache

const CACHE_MAX = 1000;
const cache = new Map(); // key -> translation, Map preserves insertion order (LRU-ish)

function cacheKey(provider, targetLang, text) {
  return `${provider}\u0000${targetLang}\u0000${text}`;
}

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value); // refresh recency
  return value;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

// Rolling context of recent original lines per tab, for AI providers.
const recentLines = new Map(); // tabId -> string[]

function pushContext(tabId, texts, limit) {
  const lines = recentLines.get(tabId) || [];
  lines.push(...texts);
  while (lines.length > limit) lines.shift();
  recentLines.set(tabId, lines);
}

// ------------------------------------------------------------- translation

async function handleTranslate({ texts, sourceLang }, tabId) {
  const settings = await loadSettings();
  const { translationProvider: provider, targetLang } = settings;

  const results = new Array(texts.length);
  const missing = [];
  const missingIdx = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = cacheGet(cacheKey(provider, targetLang, texts[i]));
    if (hit !== undefined) {
      results[i] = hit;
    } else {
      missing.push(texts[i]);
      missingIdx.push(i);
    }
  }

  if (missing.length) {
    const context = (recentLines.get(tabId) || []).slice(-settings.ai.contextLines);
    const translated = await translateTexts(missing, {
      targetLang,
      sourceLang: sourceLang || '',
      settings,
      context
    });
    for (let j = 0; j < missing.length; j++) {
      results[missingIdx[j]] = translated[j] ?? '';
      cacheSet(cacheKey(provider, targetLang, missing[j]), translated[j] ?? '');
    }
    pushContext(tabId, missing, Math.max(settings.ai.contextLines * 3, 20));
  }

  return { translations: results, targetLang };
}

// ---------------------------------------------------------- live captioning

let liveTabId = null; // tab currently being captured (one at a time)

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio to generate live translated captions.'
  });
}

async function startLiveCaptions(tabId) {
  const settings = await loadSettings();

  // Captions render through the content script, which only exists on
  // enabled sites — and capturing a tab the user hasn't opted in would
  // defeat the per-site permission model anyway.
  const tab = await chrome.tabs.get(tabId);
  let host = '';
  try { host = new URL(tab.url || '').hostname; } catch { /* no URL access */ }
  if (!settings.enabledSites.includes(host)) {
    throw new Error('Enable LiveSub on this site first (checkbox above).');
  }

  const sttKey = settings.keys.openai || settings.keys.customKey;
  if (!sttKey) {
    throw new Error(
      'Live captions need a speech-to-text API key. Add an OpenAI (or compatible) key in Options.'
    );
  }
  if (liveTabId !== null) await stopLiveCaptions();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START',
    target: 'offscreen',
    streamId,
    tabId,
    stt: {
      baseUrl: settings.stt.baseUrl.replace(/\/+$/, ''),
      apiKey: sttKey,
      model: settings.stt.model,
      chunkSeconds: settings.stt.chunkSeconds,
      sourceLang: settings.stt.sourceLang
    }
  });
  liveTabId = tabId;
  chrome.tabs.sendMessage(tabId, { type: 'LIVE_STATE', running: true }).catch(() => {});
}

async function stopLiveCaptions() {
  const tabId = liveTabId;
  liveTabId = null;
  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', target: 'offscreen' });
  } catch {
    // Offscreen document may already be gone.
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch { /* not open */ }
  if (tabId !== null) {
    chrome.tabs.sendMessage(tabId, { type: 'LIVE_STATE', running: false }).catch(() => {});
  }
}

async function handleSttResult({ tabId, text }) {
  if (!text || !text.trim()) return;
  try {
    const { translations, targetLang } = await handleTranslate({ texts: [text] }, tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: 'LIVE_CAPTION',
      original: text,
      translated: translations[0],
      targetLang
    });
  } catch (err) {
    await chrome.tabs.sendMessage(tabId, {
      type: 'LIVE_CAPTION',
      original: text,
      translated: '',
      error: String(err.message || err)
    }).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  recentLines.delete(tabId);
  if (tabId === liveTabId) stopLiveCaptions();
});

// -------------------------------------------------------------- message hub

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages addressed to the offscreen document are not for us.
  if (msg.target === 'offscreen') return false;

  const tabId = sender.tab?.id ?? msg.tabId;

  const respond = (promise) => {
    promise
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the channel open for the async response
  };

  switch (msg.type) {
    case 'TRANSLATE':
      return respond(handleTranslate(msg, tabId));

    case 'LIVE_START':
      return respond(startLiveCaptions(msg.tabId));

    case 'LIVE_STOP':
      return respond(stopLiveCaptions());

    case 'LIVE_STATUS':
      sendResponse({ ok: true, running: liveTabId !== null, tabId: liveTabId });
      return false;

    case 'STT_RESULT':
      handleSttResult(msg);
      return false;

    case 'STT_ERROR':
      if (msg.tabId != null) {
        chrome.tabs.sendMessage(msg.tabId, {
          type: 'LIVE_CAPTION', original: '', translated: '', error: msg.error
        }).catch(() => {});
      }
      return false;

    case 'TEST_TRANSLATE':
      return respond(
        (async () => {
          const settings = await loadSettings();
          const out = await translateTexts([msg.text || 'Hello, world!'], {
            targetLang: settings.targetLang,
            sourceLang: '',
            settings,
            context: []
          });
          return { translation: out[0] };
        })()
      );

    default:
      return false;
  }
});
