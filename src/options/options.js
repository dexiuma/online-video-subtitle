import { loadSettings, saveSettings } from '../common/defaults.js';
import { fillLanguageSelect } from '../common/languages.js';
import { PROVIDERS } from '../background/providers.js';

const $ = (id) => document.getElementById(id);

let settings;

async function init() {
  settings = await loadSettings();

  fillLanguageSelect($('targetLang'), settings.targetLang);
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.label;
    if (id === settings.translationProvider) opt.selected = true;
    $('provider').appendChild(opt);
  }
  $('displayMode').value = settings.displayMode;

  const k = settings.keys;
  $('googleCloud').value = k.googleCloud;
  $('azureKey').value = k.azureKey;
  $('azureRegion').value = k.azureRegion;
  $('deepl').value = k.deepl;
  $('anthropic').value = k.anthropic;
  $('openai').value = k.openai;
  $('deepseek').value = k.deepseek;
  $('customBaseUrl').value = k.customBaseUrl;
  $('customKey').value = k.customKey;
  $('customModel').value = k.customModel;

  $('anthropicModel').value = settings.ai.anthropicModel;
  $('openaiModel').value = settings.ai.openaiModel;
  $('deepseekModel').value = settings.ai.deepseekModel;

  $('sttBaseUrl').value = settings.stt.baseUrl;
  $('sttModel').value = settings.stt.model;
  $('sttChunk').value = settings.stt.chunkSeconds;
  $('sttSourceLang').value = settings.stt.sourceLang;

  $('fontSize').value = settings.overlay.fontSizePx;
  $('textColor').value = settings.overlay.textColor;
  $('bgOpacity').value = parseOpacity(settings.overlay.background);
  $('hideNative').checked = settings.overlay.hideNativeCaptions;

  $('saveBtn').addEventListener('click', save);
  $('testBtn').addEventListener('click', testTranslation);
}

function parseOpacity(rgba) {
  const m = rgba.match(/rgba\([^)]*,\s*([\d.]+)\)/);
  return m ? Math.round(parseFloat(m[1]) * 100) : 72;
}

async function save() {
  settings.targetLang = $('targetLang').value;
  settings.translationProvider = $('provider').value;
  settings.displayMode = $('displayMode').value;

  settings.keys = {
    googleCloud: $('googleCloud').value.trim(),
    azureKey: $('azureKey').value.trim(),
    azureRegion: $('azureRegion').value.trim(),
    deepl: $('deepl').value.trim(),
    anthropic: $('anthropic').value.trim(),
    openai: $('openai').value.trim(),
    deepseek: $('deepseek').value.trim(),
    customBaseUrl: $('customBaseUrl').value.trim(),
    customKey: $('customKey').value.trim(),
    customModel: $('customModel').value.trim()
  };

  settings.ai.anthropicModel = $('anthropicModel').value.trim();
  settings.ai.openaiModel = $('openaiModel').value.trim();
  settings.ai.deepseekModel = $('deepseekModel').value.trim() || 'deepseek-chat';

  settings.stt.baseUrl = $('sttBaseUrl').value.trim();
  settings.stt.model = $('sttModel').value.trim();
  settings.stt.chunkSeconds = Math.min(15, Math.max(3, Number($('sttChunk').value) || 5));
  settings.stt.sourceLang = $('sttSourceLang').value.trim();

  settings.overlay.fontSizePx = Math.min(48, Math.max(12, Number($('fontSize').value) || 22));
  settings.overlay.textColor = $('textColor').value;
  settings.overlay.background = `rgba(0, 0, 0, ${Number($('bgOpacity').value) / 100})`;
  settings.overlay.hideNativeCaptions = $('hideNative').checked;

  // Custom endpoints need optional host permission for the service worker fetch.
  const status = $('saveStatus');
  for (const url of [settings.keys.customBaseUrl, settings.stt.baseUrl]) {
    const origin = originPattern(url);
    if (origin && !isBuiltinHost(origin)) {
      try {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          setStatus(status, `Permission for ${origin} was declined — requests to it may fail.`, false);
        }
      } catch (err) {
        setStatus(status, `Could not request permission for ${origin}: ${err.message}`, false);
      }
    }
  }

  await saveSettings(settings);
  setStatus(status, 'Saved ✓', true);
  setTimeout(() => { status.textContent = ''; }, 2500);
}

function originPattern(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.origin}/*` : '';
  } catch {
    return '';
  }
}

function isBuiltinHost(originPat) {
  return [
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://api.deepseek.com/*',
    'https://api.deepl.com/*',
    'https://api-free.deepl.com/*'
  ].includes(originPat);
}

async function testTranslation() {
  const result = $('testResult');
  result.textContent = '…';
  result.className = '';
  // Save first so the test uses what's on screen.
  await save();
  const res = await chrome.runtime.sendMessage({
    type: 'TEST_TRANSLATE',
    text: $('testText').value || 'Hello, world!'
  });
  if (res?.ok) {
    setStatus(result, `→ ${res.translation}`, true);
  } else {
    setStatus(result, res?.error || 'Failed', false);
  }
}

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

init();
