import { loadSettings, saveSettings } from '../common/defaults.js';
import { fillLanguageSelect } from '../common/languages.js';
import { PROVIDERS } from '../background/providers.js';

const $ = (id) => document.getElementById(id);

let settings;
let currentTab;

async function init() {
  settings = await loadSettings();
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  fillLanguageSelect($('targetLang'), settings.targetLang);

  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.label;
    if (id === settings.translationProvider) opt.selected = true;
    $('provider').appendChild(opt);
  }

  $('enabled').checked = settings.enabled;
  $('displayMode').value = settings.displayMode;

  const host = hostOf(currentTab?.url);
  $('siteHost').textContent = host || 'this site';
  $('siteEnabled').checked = host ? settings.enabledSites.includes(host) : false;
  $('siteEnabled').disabled = !host;

  await refreshLiveState();

  $('enabled').addEventListener('change', () => save({ enabled: $('enabled').checked }));
  $('targetLang').addEventListener('change', () => save({ targetLang: $('targetLang').value }));
  $('provider').addEventListener('change', () => save({ translationProvider: $('provider').value }));
  $('displayMode').addEventListener('change', () => save({ displayMode: $('displayMode').value }));
  $('siteEnabled').addEventListener('change', toggleSite);
  $('liveBtn').addEventListener('click', toggleLive);
  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function hostOf(url) {
  try {
    const u = new URL(url);
    // https only: optional_host_permissions doesn't cover http, and we don't
    // want caption text collected from (or sent over) insecure pages anyway.
    return u.protocol === 'https:' ? u.hostname : '';
  } catch {
    return '';
  }
}

async function save(patch) {
  Object.assign(settings, patch);
  await saveSettings(settings);
}

async function toggleSite() {
  hideStatus();
  const host = hostOf(currentTab?.url);
  if (!host) return;
  const origin = `https://${host}/*`;
  const set = new Set(settings.enabledSites);

  if ($('siteEnabled').checked) {
    // Ask for this origin only; content scripts are then registered for it
    // by the service worker (see syncContentScripts).
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      $('siteEnabled').checked = false;
      showStatus('Permission declined — the site stays disabled.');
      return;
    }
    set.add(host);
    await save({ enabledSites: [...set] });
    await injectIntoCurrentTab();
  } else {
    set.delete(host);
    await save({ enabledSites: [...set] });
    // Hand the origin permission back; nothing needs it anymore.
    chrome.permissions.remove({ origins: [origin] }).catch(() => {});
  }
}

// Registration only affects future page loads; inject into the open tab so
// the toggle takes effect without a refresh. Both scripts guard against
// running twice.
async function injectIntoCurrentTab() {
  try {
    const target = { tabId: currentTab.id, allFrames: true };
    await chrome.scripting.insertCSS({ target, files: ['src/content/overlay.css'] });
    await chrome.scripting.executeScript({
      target,
      files: ['src/content/adapters.js', 'src/content/main.js']
    });
  } catch {
    // Page can't be scripted (e.g. a browser page); next load will work.
  }
}

async function refreshLiveState() {
  const res = await chrome.runtime.sendMessage({ type: 'LIVE_STATUS' });
  const runningHere = res?.running && res.tabId === currentTab?.id;
  $('liveBtn').classList.toggle('running', !!runningHere);
  $('liveBtn').textContent = runningHere
    ? '⏹ Stop live captions'
    : '🎙 Start live captions (no subtitles)';
  $('liveBtn').dataset.running = runningHere ? '1' : '';
}

async function toggleLive() {
  hideStatus();
  const running = $('liveBtn').dataset.running === '1';
  const msg = running
    ? { type: 'LIVE_STOP' }
    : { type: 'LIVE_START', tabId: currentTab.id };
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) {
    showStatus(res?.error || 'Something went wrong.');
  }
  await refreshLiveState();
}

function showStatus(text) {
  $('status').textContent = text;
  $('status').hidden = false;
}

function hideStatus() {
  $('status').hidden = true;
}

init();
