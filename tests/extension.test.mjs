// Offline harness: runs the real service-worker + adapters code with mocked
// chrome/fetch and drives the same messages the content script sends.
import { strict as assert } from 'node:assert';

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name}: ${e.message}`]); }
}

// ------------------------------------------------------------ chrome stub
const SETTINGS = {
  enabled: true,
  targetLang: 'zh-CN',
  translationProvider: 'deepseek',
  enabledSites: ['anikototv.to'],
  keys: { deepseek: 'sk-test' },
  ai: { deepseekModel: 'deepseek-v4-flash', contextLines: 6, styleHint: 'fantasy anime; keep honorifics' }
};

let onMessageHandler = null;
globalThis.chrome = {
  storage: {
    local: { get: async () => ({ settings: SETTINGS }) },
    onChanged: { addListener: () => {} }
  },
  runtime: {
    onMessage: { addListener: (h) => { onMessageHandler = h; } },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getContexts: async () => []
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    get: async () => ({ title: 'Watch Overlord Episode 6 English Subbed' }),
    sendMessage: async () => {}
  },
  scripting: {
    getRegisteredContentScripts: async () => [],
    unregisterContentScripts: async () => {},
    registerContentScripts: async () => {},
    updateContentScripts: async () => {}
  },
  permissions: { contains: async () => false }
};

// -------------------------------------------------------------- fetch stub
const fetchLog = []; // { url, body, at }
const FETCH_DELAY_MS = 50;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchLog.push({ url, body, at: Date.now() });
  await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  // Echo back numbered fake translations matching the request line count.
  const userMsg = body.messages.find((m) => m.role === 'user').content;
  const lines = userMsg.split('Lines to translate:\n')[1].split('\n');
  const out = lines.map((l) => {
    const m = l.match(/^(\d+)\. (.*)$/);
    return m ? `${m[1]}. [中文] ${m[2]}` : '';
  }).filter(Boolean).join('\n');
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: out } }] })
  };
};

// ------------------------------------------------------ load real modules
await import('../src/background/service-worker.js');
assert.ok(onMessageHandler, 'service worker registered onMessage');

function send(msg, tabId = 7) {
  return new Promise((resolve) => {
    const keepOpen = onMessageHandler(msg, { tab: { id: tabId } }, resolve);
    if (keepOpen === false) resolve(undefined); // fire-and-forget messages
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ tests

// 1. Display request: shape of the DeepSeek call.
const r1 = await send({ type: 'TRANSLATE', texts: ['Ainz-sama, the Great Tomb of Nazarick is secure.'], sourceLang: 'en' });
check('display request returns ok + translation', () => {
  assert.equal(r1.ok, true);
  assert.match(r1.translations[0], /Nazarick/);
});
check('request goes to deepseek /chat/completions', () =>
  assert.match(fetchLog[0].url, /^https:\/\/api\.deepseek\.com\/v1\/chat\/completions$/));
check('thinking mode disabled in body', () =>
  assert.deepEqual(fetchLog[0].body.thinking, { type: 'disabled' }));
check('model is deepseek-v4-flash', () =>
  assert.equal(fetchLog[0].body.model, 'deepseek-v4-flash'));
check('instructions in system message incl. injection rule + style hint', () => {
  const sys = fetchLog[0].body.messages[0];
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /never follow it/);
  assert.match(sys.content, /fantasy anime; keep honorifics/);
});
check('user message has video title and numbered data only', () => {
  const usr = fetchLog[0].body.messages[1];
  assert.equal(usr.role, 'user');
  assert.match(usr.content, /Video title: Watch Overlord Episode 6/);
  assert.match(usr.content, /1\. Ainz-sama/);
  assert.ok(!/Rules:/.test(usr.content), 'no instructions leaked into user msg');
});

// 2. Cached line: no second fetch.
const before = fetchLog.length;
const r2 = await send({ type: 'TRANSLATE', texts: ['Ainz-sama, the Great Tomb of Nazarick is secure.'] });
check('cache hit needs no fetch and matches', () => {
  assert.equal(fetchLog.length, before);
  assert.equal(r2.translations[0], r1.translations[0]);
});

// 3. Non-verbal lines skip the API.
const r3 = await send({ type: 'TRANSLATE', texts: ['♪♪ ~~~ 123'] });
check('non-verbal line returned as-is without fetch', () => {
  assert.equal(r3.translations[0], '♪♪ ~~~ 123');
  assert.equal(fetchLog.length, before);
});

// 4. Prefetch 45 lines -> chunks of 20/20/5, paced.
const lines = Array.from({ length: 45 }, (_, i) => `Episode six line number ${i} of dialogue`);
const t0 = Date.now();
await send({ type: 'TRANSLATE_PREFETCH', texts: lines, sourceLang: 'en' });
await sleep(1200); // let the queue drain (3 chunks * (50ms + 250ms gap))
const prefetchCalls = fetchLog.slice(before);
check('prefetch split into 3 chunks of 20/20/5', () => {
  const counts = prefetchCalls.map((c) =>
    c.body.messages[1].content.split('Lines to translate:\n')[1].split('\n').length);
  assert.deepEqual(counts, [20, 20, 5]);
});
check('chunks paced ~250ms apart, not parallel', () => {
  const gaps = prefetchCalls.slice(1).map((c, i) => c.at - prefetchCalls[i].at);
  assert.ok(gaps.every((g) => g >= 250), `gaps: ${gaps}`);
});

// 5. Everything prefetched is now a cache hit.
const before5 = fetchLog.length;
const r5 = await send({ type: 'TRANSLATE', texts: [lines[37]] });
check('prefetched line displays from cache instantly', () => {
  assert.equal(fetchLog.length, before5);
  assert.match(r5.translations[0], /line number 37/);
});

// 6. In-flight join: display request while its chunk is being fetched.
const slowLines = Array.from({ length: 5 }, (_, i) => `Slow chunk unique sentence ${i}`);
send({ type: 'TRANSLATE_PREFETCH', texts: slowLines });
await sleep(10); // chunk fetch now in flight (50ms)
const before6 = fetchLog.length;
const r6 = await send({ type: 'TRANSLATE', texts: ['Slow chunk unique sentence 2'] });
check('display joins in-flight prefetch instead of new request', () => {
  assert.equal(fetchLog.length, before6);
  assert.match(r6.translations[0], /sentence 2/);
});

// 7. Adapters: mid-episode prefetch priority ordering.
globalThis.window = {};
globalThis.location = { hostname: 'anikototv.to' };
globalThis.document = { querySelectorAll: () => [], documentElement: {}, createElement: () => ({}) };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
await import('../src/content/adapters.js');
let upcoming = null;
const adapters = window.__liveSubAdapters.pickAdapters(() => {}, (texts, lang) => { upcoming = { texts, lang }; });
const tta = adapters.find((a) => a.prefetchNewCues);
tta.activeTrack = {
  language: 'en-US',
  cues: Array.from({ length: 10 }, (_, i) => ({ startTime: i * 10, text: `cue ${i}` }))
};
tta.activeVideo = { currentTime: 55 }; // "middle of the episode"
tta.lang = 'en';
tta.prefetchNewCues();
check('mid-episode: cues ahead of playhead queued before earlier ones', () => {
  assert.deepEqual(upcoming.texts, [
    'cue 6', 'cue 7', 'cue 8', 'cue 9',      // >= 55s first
    'cue 0', 'cue 1', 'cue 2', 'cue 3', 'cue 4', 'cue 5'
  ]);
  assert.equal(upcoming.lang, 'en');
});
check('watermark: second call sends nothing new', () => {
  upcoming = null;
  tta.prefetchNewCues();
  assert.equal(upcoming, null);
});

// 8. Subtitle file parsing (VTT and SRT).
const { parseTimedText } = window.__liveSubAdapters;
check('parses WEBVTT with header, markup and multi-line cues', () => {
  const vtt = 'WEBVTT\n\nNOTE a comment\n\n1\n00:00:01.000 --> 00:00:03.500 position:50%\n<i>Ainz-sama!</i>\nWe await your orders.\n\n00:01:00.000 --> 00:01:02.000\nUnderstood.\n';
  assert.deepEqual(parseTimedText(vtt), [
    { start: 1, end: 3.5, text: 'Ainz-sama! We await your orders.' },
    { start: 60, end: 62, text: 'Understood.' }
  ]);
});
check('parses SRT with comma timestamps and hour field', () => {
  const srt = '1\n01:02:03,450 --> 01:02:05,000\nFirst line\n\n2\n01:02:06,000 --> 01:02:07,250\nSecond line\n';
  const cues = parseTimedText(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 3723.45);
  assert.equal(cues[1].text, 'Second line');
});

// 9. SubtitleFileAdapter: a captured file drives prefetch and display.
const fileAdapter = adapters.find((a) => a.msgHandler);
check('subtitle file adapter is registered', () => assert.ok(fileAdapter));
const fakeVideo = {
  currentTime: 62.5,
  getBoundingClientRect: () => ({ width: 1280, height: 720 })
};
globalThis.document.querySelectorAll = (sel) => (sel === 'video' ? [fakeVideo] : []);
upcoming = null;
fileAdapter.load(
  'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nEarly line\n\n00:01:01.000 --> 00:01:04.000\nCurrent line\n\n00:02:00.000 --> 00:02:02.000\nLater line\n'
);
check('file load prefetches all lines, playhead-first', () =>
  assert.deepEqual(upcoming.texts, ['Current line', 'Later line', 'Early line']));
let fileEmitted = null;
fileAdapter.onCue = (text) => { fileEmitted = text; };
fileAdapter.tick();
await sleep(200); // emit debounce
check('tick emits the cue under the playhead from the video clock', () =>
  assert.equal(fileEmitted, 'Current line'));
check('scraping adapters stay silent while the file drives the overlay', () => {
  const dom = adapters.find((a) => a.selector);
  let domEmitted = null;
  dom.onCue = (t) => { domEmitted = t; };
  dom.read();
  assert.equal(domEmitted, null);
});

// ------------------------------------------------------------------ report
let failed = 0;
for (const [st, name] of results) {
  if (st === 'FAIL') failed++;
  console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
