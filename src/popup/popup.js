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
  $('siteEnabled').checked = host ? !settings.disabledSites.includes(host) : true;
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
    return ['http:', 'https:'].includes(u.protocol) ? u.hostname : '';
  } catch {
    return '';
  }
}

async function save(patch) {
  Object.assign(settings, patch);
  await saveSettings(settings);
}

async function toggleSite() {
  const host = hostOf(currentTab?.url);
  if (!host) return;
  const set = new Set(settings.disabledSites);
  if ($('siteEnabled').checked) set.delete(host);
  else set.add(host);
  await save({ disabledSites: [...set] });
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
