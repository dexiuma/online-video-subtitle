// Offscreen document: captures tab audio via tabCapture, records it in short
// chunks, sends each chunk to an OpenAI-compatible /audio/transcriptions
// endpoint, and forwards the text to the service worker.
//
// Each chunk uses its own MediaRecorder so every blob is a complete, standalone
// WebM file (chunks from a single long-running recorder lack the init segment).

let session = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'OFFSCREEN_START') start(msg);
  if (msg.type === 'OFFSCREEN_STOP') stop();
});

async function start({ streamId, tabId, stt }) {
  await stop();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
  } catch (err) {
    reportError(tabId, `Could not capture tab audio: ${err.message}`);
    return;
  }

  // Capturing mutes the tab, so route the audio back to the speakers.
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  // Analyser to skip silent chunks (no point paying for STT on silence).
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  session = { stream, audioCtx, analyser, tabId, stt, running: true, recorder: null };
  recordLoop(session);
}

async function stop() {
  if (!session) return;
  session.running = false;
  try { session.recorder?.stop(); } catch { /* already stopped */ }
  session.stream.getTracks().forEach((t) => t.stop());
  try { await session.audioCtx.close(); } catch { /* already closed */ }
  session = null;
}

async function recordLoop(s) {
  while (s.running) {
    const blob = await recordChunk(s);
    if (!s.running || !blob) break;
    if (blob.size < 2000 || !hasSound(s)) continue; // skip silence / empty chunks
    transcribe(s, blob); // fire-and-forget so recording of the next chunk isn't delayed
  }
}

function recordChunk(s) {
  return new Promise((resolve) => {
    const chunks = [];
    let recorder;
    try {
      recorder = new MediaRecorder(s.stream, { mimeType: 'audio/webm;codecs=opus' });
    } catch (err) {
      reportError(s.tabId, `MediaRecorder failed: ${err.message}`);
      s.running = false;
      resolve(null);
      return;
    }
    s.recorder = recorder;
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));
    recorder.onerror = () => resolve(null);
    recorder.start();
    setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, (s.stt.chunkSeconds || 5) * 1000);
  });
}

function hasSound(s) {
  const data = new Uint8Array(s.analyser.fftSize);
  s.analyser.getByteTimeDomainData(data);
  let sumSq = 0;
  for (const v of data) {
    const centered = (v - 128) / 128;
    sumSq += centered * centered;
  }
  const rms = Math.sqrt(sumSq / data.length);
  return rms > 0.01;
}

async function transcribe(s, blob) {
  const form = new FormData();
  form.append('file', blob, 'chunk.webm');
  form.append('model', s.stt.model);
  form.append('response_format', 'json');
  if (s.stt.sourceLang) form.append('language', s.stt.sourceLang);

  try {
    const res = await fetch(`${s.stt.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${s.stt.apiKey}` },
      body: form
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`STT HTTP ${res.status}: ${detail}`);
    }
    const data = await res.json();
    const text = (data.text || '').trim();
    if (text && s.running) {
      chrome.runtime.sendMessage({ type: 'STT_RESULT', tabId: s.tabId, text });
    }
  } catch (err) {
    reportError(s.tabId, String(err.message || err));
  }
}

function reportError(tabId, error) {
  chrome.runtime.sendMessage({ type: 'STT_ERROR', tabId, error });
}
