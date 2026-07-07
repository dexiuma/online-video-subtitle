// Central settings schema. Stored under the "settings" key in chrome.storage.local.
// The content script keeps its own minimal copy of these defaults (it cannot use
// ES modules) — keep src/content/main.js DEFAULTS in sync when changing this.

export const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: 'en',
  // 'translated' shows only the translation, 'bilingual' shows original + translation.
  displayMode: 'bilingual',
  // Hostnames where the user turned the extension on. The extension does
  // nothing on a site until it's added here (via the popup's site toggle).
  enabledSites: [],
  translationProvider: 'google-free',
  overlay: {
    fontSizePx: 22,
    background: 'rgba(0, 0, 0, 0.72)',
    textColor: '#ffffff',
    // Vertical offset from the bottom of the video, as a percentage of its height.
    bottomOffsetPct: 8,
    hideNativeCaptions: true
  },
  keys: {
    googleCloud: '',
    azureKey: '',
    azureRegion: '',
    deepl: '',
    openai: '',
    anthropic: '',
    customBaseUrl: '',
    customKey: '',
    customModel: ''
  },
  ai: {
    openaiModel: 'gpt-4o-mini',
    anthropicModel: 'claude-haiku-4-5-20251001',
    // How many previous subtitle lines to send as context for AI translation.
    contextLines: 6
  },
  stt: {
    // OpenAI-compatible /audio/transcriptions endpoint config.
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    chunkSeconds: 5,
    // Optional hint for the spoken language ('' = auto-detect).
    sourceLang: ''
  }
};

export function mergeSettings(stored) {
  const merged = structuredClone(DEFAULT_SETTINGS);
  deepAssign(merged, stored || {});
  return merged;
}

function deepAssign(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepAssign(target[key], value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
