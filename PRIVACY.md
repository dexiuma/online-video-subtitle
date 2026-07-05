# LiveSub Privacy Policy

LiveSub is an open-source browser extension. It has no servers, no accounts,
no analytics, and no telemetry.

## What data leaves your browser

- **Subtitle text** of the video you are watching is sent to the translation
  provider **you selected** (Google, Microsoft, DeepL, Anthropic, OpenAI, or a
  custom endpoint you configured), solely to obtain a translation.
- **Tab audio**, only while you have explicitly started "live captions", is
  sent in short chunks to the speech-to-text endpoint you configured, solely
  to obtain a transcription. It stops when you stop it or close the tab.

Nothing else is transmitted. Nothing is sent to the extension authors.

## What data is stored

- Your settings and API keys are stored locally in your browser profile via
  `chrome.storage.local`. They are not synced to other devices and are only
  attached to requests to the corresponding provider's API.
- A short-lived, in-memory cache of recent translations exists inside the
  extension's service worker and is discarded when the worker shuts down.

## Third parties

Requests to translation/STT providers are governed by those providers' own
privacy policies. Choose providers you trust; local endpoints (e.g. Ollama)
keep everything on your machine.
