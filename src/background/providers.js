// Translation providers. Every provider implements:
//   translate(texts: string[], opts) -> Promise<string[]>
// opts: { targetLang, sourceLang, settings, context: string[] }
//
// All network calls happen here, in the service worker, so content scripts
// never see API keys and page CSP cannot interfere.

import { languageName } from '../common/languages.js';

const CONCURRENCY = 4;

export const PROVIDERS = {
  'google-free': {
    label: 'Google Translate (free, no key)',
    needsKey: false,
    translate: googleFree
  },
  'google-cloud': {
    label: 'Google Cloud Translation (API key)',
    needsKey: true,
    translate: googleCloud
  },
  'azure': {
    label: 'Microsoft Azure Translator (API key)',
    needsKey: true,
    translate: azure
  },
  'deepl': {
    label: 'DeepL (API key)',
    needsKey: true,
    translate: deepl
  },
  'anthropic': {
    label: 'Anthropic Claude (API key)',
    needsKey: true,
    translate: anthropic
  },
  'openai': {
    label: 'OpenAI (API key)',
    needsKey: true,
    translate: openai
  },
  'custom-ai': {
    label: 'Custom OpenAI-compatible endpoint',
    needsKey: true,
    translate: customAI
  }
};

export async function translateTexts(texts, opts) {
  const provider = PROVIDERS[opts.settings.translationProvider];
  if (!provider) throw new Error(`Unknown provider: ${opts.settings.translationProvider}`);
  return provider.translate(texts, opts);
}

// ---------------------------------------------------------------- helpers

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${detail}`);
  }
  return res.json();
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ------------------------------------------------------- machine translation

// Unofficial endpoint used by Google Translate's web widget. Free and keyless,
// but not an SLA'd API — the options page tells users this. One request per text.
async function googleFree(texts, { targetLang, sourceLang }) {
  return mapWithConcurrency(texts, CONCURRENCY, async (text) => {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: sourceLang || 'auto',
      tl: targetLang,
      dt: 't',
      q: text
    });
    const data = await fetchJSON(`https://translate.googleapis.com/translate_a/single?${params}`);
    // Response shape: [[["translated","original",...],...], ...]
    return (data[0] || []).map((seg) => seg[0]).join('');
  });
}

async function googleCloud(texts, { targetLang, sourceLang, settings }) {
  const key = settings.keys.googleCloud;
  if (!key) throw new Error('Google Cloud Translation API key is not set.');
  const body = { q: texts, target: targetLang, format: 'text' };
  if (sourceLang) body.source = sourceLang;
  const data = await fetchJSON(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return data.data.translations.map((t) => t.translatedText);
}

async function azure(texts, { targetLang, sourceLang, settings }) {
  const { azureKey, azureRegion } = settings.keys;
  if (!azureKey) throw new Error('Azure Translator key is not set.');
  const params = new URLSearchParams({ 'api-version': '3.0', to: azureLang(targetLang) });
  if (sourceLang) params.set('from', azureLang(sourceLang));
  const headers = {
    'Ocp-Apim-Subscription-Key': azureKey,
    'Content-Type': 'application/json'
  };
  if (azureRegion) headers['Ocp-Apim-Subscription-Region'] = azureRegion;
  const data = await fetchJSON(
    `https://api.cognitive.microsofttranslator.com/translate?${params}`,
    { method: 'POST', headers, body: JSON.stringify(texts.map((Text) => ({ Text }))) }
  );
  return data.map((item) => item.translations[0].text);
}

async function deepl(texts, { targetLang, sourceLang, settings }) {
  const key = settings.keys.deepl;
  if (!key) throw new Error('DeepL API key is not set.');
  // Free-tier keys end in ":fx" and use a different host.
  const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const body = { text: texts, target_lang: deeplLang(targetLang) };
  if (sourceLang) body.source_lang = deeplLang(sourceLang);
  const data = await fetchJSON(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return data.translations.map((t) => t.text);
}

function azureLang(code) {
  const map = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };
  return map[code] || code;
}

function deeplLang(code) {
  // DeepL uses upper-case codes and its own Chinese variants.
  const map = { 'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT' };
  return map[code] || code.toUpperCase();
}

// ------------------------------------------------------------ AI translation
//
// AI providers get a numbered batch plus recent-subtitle context so the model
// can resolve pronouns, tone and terminology across lines.

function buildAIPrompt(texts, { targetLang, context }) {
  const target = languageName(targetLang);
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  let prompt =
    `Translate the following video subtitle lines into ${target}. ` +
    `Keep the tone natural and conversational, preserve names, and keep each ` +
    `translation short enough to read as a subtitle.\n`;
  if (context && context.length) {
    prompt += `\nEarlier subtitle lines, for context only (do NOT translate these):\n` +
      context.map((c) => `- ${c}`).join('\n') + '\n';
  }
  prompt +=
    `\nReturn ONLY the translations, one per line, numbered exactly like the input. ` +
    `No explanations.\n\nLines to translate:\n${numbered}`;
  return prompt;
}

function parseNumberedLines(text, expectedCount) {
  const out = new Array(expectedCount).fill('');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]\s*(.*)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < expectedCount) out[idx] = m[2].trim();
    }
  }
  // If the model ignored the numbering, fall back to raw non-empty lines.
  if (out.every((l) => !l)) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < expectedCount; i++) out[i] = lines[i] || '';
  }
  return out;
}

async function anthropic(texts, opts) {
  const key = opts.settings.keys.anthropic;
  if (!key) throw new Error('Anthropic API key is not set.');
  const data = await fetchJSON('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: opts.settings.ai.anthropicModel,
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildAIPrompt(texts, opts) }]
    })
  });
  const text = (data.content || []).map((b) => b.text || '').join('');
  return parseNumberedLines(text, texts.length);
}

async function openai(texts, opts) {
  const key = opts.settings.keys.openai;
  if (!key) throw new Error('OpenAI API key is not set.');
  return openaiCompatible('https://api.openai.com/v1', key, opts.settings.ai.openaiModel, texts, opts);
}

async function customAI(texts, opts) {
  const { customBaseUrl, customKey, customModel } = opts.settings.keys;
  if (!customBaseUrl) throw new Error('Custom endpoint base URL is not set.');
  if (!customModel) throw new Error('Custom endpoint model is not set.');
  return openaiCompatible(customBaseUrl.replace(/\/+$/, ''), customKey, customModel, texts, opts);
}

async function openaiCompatible(baseUrl, key, model, texts, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const data = await fetchJSON(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildAIPrompt(texts, opts) }],
      temperature: 0.3
    })
  });
  const text = data.choices?.[0]?.message?.content || '';
  return parseNumberedLines(text, texts.length);
}
