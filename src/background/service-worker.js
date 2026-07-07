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
const PAGE_HOOK_ID = 'livesub-page-hook';

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
    ids: [CONTENT_SCRIPT_ID, PAGE_HOOK_ID]
  });
  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({
      ids: existing.map((s) => s.id)
    });
  }
  if (!origins.length) return;

  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      matches: origins,
      js: ['src/content/adapters.js', 'src/content/main.js'],
      css: ['src/content/overlay.css'],
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true
    },
    {
      // Page-world fetch/XHR wrapper that relays downloaded subtitle files;
      // document_start so it's installed before the player requests them.
      id: PAGE_HOOK_ID,
      matches: origins,
      js: ['src/content/page-hook.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
      persistAcrossSessions: true
    }
  ]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    syncContentScripts().catch(() => {});
  }
});
chrome.runtime.onInstalled.addListener(() => syncContentScripts().catch(() => {}));
chrome.runtime.onStartup.addListener(() => syncContentScripts().catch(() => {}));

// ------------------------------------------------------- translation cache

const CACHE_MAX = 5000; // a full episode is a few hundred lines; keep several
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

// Translations currently being fetched, so a caption that appears while its
// prefetch is still in flight joins that request instead of starting another.
const inflight = new Map(); // key -> Promise<string>

// The tab title usually names the show and episode — cheap, high-value
// context for AI translation (readable only for tabs on enabled sites).
async function tabTitle(tabId) {
  if (tabId == null) return '';
  try {
    return ((await chrome.tabs.get(tabId)).title || '').slice(0, 150);
  } catch {
    return '';
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

  // Subtitle lines are short; a huge "line" is scraped garbage — cap it
  // before it inflates a prompt.
  texts = texts.map((t) => String(t).slice(0, 500));

  const results = new Array(texts.length);
  const missing = [];
  const missingIdx = [];
  const joined = []; // [result index, in-flight promise]
  for (let i = 0; i < texts.length; i++) {
    if (!/\p{L}/u.test(texts[i])) {
      results[i] = texts[i]; // ♪, "...", numbers: nothing to translate
      continue;
    }
    const key = cacheKey(provider, targetLang, texts[i]);
    const hit = cacheGet(key);
    if (hit !== undefined) {
      results[i] = hit;
    } else if (inflight.has(key)) {
      joined.push([i, inflight.get(key)]);
    } else {
      missing.push(texts[i]);
      missingIdx.push(i);
    }
  }

  if (missing.length) {
    const context = (recentLines.get(tabId) || []).slice(-settings.ai.contextLines);
    const batch = translateTexts(missing, {
      targetLang,
      sourceLang: sourceLang || '',
      settings,
      context,
      title: await tabTitle(tabId)
    });
    missing.forEach((text, j) => {
      const key = cacheKey(provider, targetLang, text);
      const one = batch.then((arr) => arr[j] ?? '');
      inflight.set(key, one);
      one.then((v) => cacheSet(key, v))
        .catch(() => {})
        .finally(() => inflight.delete(key));
    });
    const translated = await batch;
    for (let j = 0; j < missing.length; j++) {
      results[missingIdx[j]] = translated[j] ?? '';
    }
    pushContext(tabId, missing, Math.max(settings.ai.contextLines * 3, 20));
  }

  for (const [i, promise] of joined) {
    results[i] = await promise;
  }

  return { translations: results, targetLang };
}

// ------------------------------------------------------------ prefetch queue
// Adapters may hand over a whole episode of cue texts at once. Translate them
// in paced chunks: bursts of hundreds of parallel requests would trip provider
// rate limits, and chunk order preserves chronological context for AI
// providers. Display requests skip this queue entirely — they run immediately
// and join any chunk already in flight via the inflight map.

const PREFETCH_CHUNK = 20;
const PREFETCH_GAP_MS = 250;
const prefetchQueue = []; // { text, tabId, sourceLang }
let prefetchRunning = false;

function enqueuePrefetch(texts, tabId, sourceLang) {
  for (const text of texts) prefetchQueue.push({ text, tabId, sourceLang });
  if (!prefetchRunning) runPrefetchQueue();
}

async function runPrefetchQueue() {
  prefetchRunning = true;
  while (prefetchQueue.length) {
    const chunk = prefetchQueue.splice(0, PREFETCH_CHUNK);
    try {
      await handleTranslate(
        { texts: chunk.map((c) => c.text), sourceLang: chunk[0].sourceLang },
        chunk[0].tabId
      );
    } catch {
      // Provider hiccup — skip this chunk; the display path retries per line.
    }
    if (prefetchQueue.length) {
      await new Promise((resolve) => setTimeout(resolve, PREFETCH_GAP_MS));
    }
  }
  prefetchRunning = false;
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
  // Don't keep translating an episode nobody is watching anymore.
  for (let i = prefetchQueue.length - 1; i >= 0; i--) {
    if (prefetchQueue[i].tabId === tabId) prefetchQueue.splice(i, 1);
  }
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

    case 'TRANSLATE_PREFETCH':
      enqueuePrefetch(msg.texts || [], tabId, msg.sourceLang || '');
      return false;

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
