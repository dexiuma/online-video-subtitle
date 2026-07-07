# LiveSub — Real-Time Video Subtitle Translator

A modern, open-source browser extension for **Google Chrome** and **Microsoft Edge**
that translates online video subtitles into your language, in real time.

It handles both situations you run into:

1. **The video has subtitles, but not in your language** — LiveSub reads the
   existing subtitles (native `<track>` captions, or the caption rendering of
   supported sites like YouTube, Netflix and Prime Video), translates each line
   as it appears, and shows it as an overlay on the video.
2. **The video has no subtitles at all** — LiveSub captures the tab's audio,
   transcribes it in short chunks with a speech-to-text API (OpenAI Whisper or
   any OpenAI-compatible endpoint, using **your** API key), translates the text,
   and displays it as live captions.

## Features

- 🌍 30+ target languages
- 🔌 Pluggable translation providers:
  - **Google Translate (free)** — works out of the box, no key needed
  - **Google Cloud Translation** — official API, bring your key
  - **Microsoft Azure Translator** — bring your key + region
  - **DeepL** — free (`…:fx`) and pro keys supported
  - **Anthropic Claude / OpenAI / any OpenAI-compatible endpoint** — AI
    translation that uses recent subtitle lines as context for better,
    more natural results (great for idioms, names, tone)
- 🎙 Live captions for videos without subtitles (tab-audio → speech-to-text)
- 🈁 Bilingual mode (original + translation) or translation-only
- 🖱 Draggable overlay, adjustable font size / colors / background opacity
- ⚡ Translation caching and stale-cue dropping to keep up with fast dialogue
- 🌓 Light/dark aware popup and options UI
- 🔒 Privacy-first: no analytics, no middleman servers, keys stay in your
  browser, and code is injected only into sites you explicitly enable

## Install (from source)

1. Clone this repository:
   ```sh
   git clone https://github.com/<you>/online-video-subtitle.git
   ```
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.

No build step — the extension is plain modern JavaScript (Manifest V3).

## Usage

### Videos that already have subtitles

1. Turn the site's subtitles **on** in the video player (any language).
2. Click the LiveSub icon, tick **Enable on \<site\>**, and pick your target
   language and provider. The extension is off on every site until you enable
   it there — nothing is read or translated on sites you haven't opted in.
3. The translated overlay appears over the video. Drag it wherever you like.

By default the site's own captions are hidden while LiveSub is active and the
overlay shows *original + translation* — both are configurable.

### Videos with no subtitles (live captions)

1. Add an OpenAI API key (or a custom OpenAI-compatible endpoint that serves
   `/audio/transcriptions`) in **Options**.
2. Open the video tab, click the LiveSub icon → **Start live captions**.
3. Tab audio is transcribed in ~5-second chunks, translated, and shown as
   captions. Expect a few seconds of delay — that's the chunk length plus API
   latency.

> Live captioning sends the tab's audio to the speech-to-text provider you
> configured. Nothing is recorded or sent anywhere until you explicitly start
> it, and it stops when you stop it or close the tab.

### AI translation

Machine translation services translate line by line. The AI providers
(Anthropic, OpenAI, custom endpoints such as OpenRouter or a local
Ollama/llama.cpp server) receive the last few subtitle lines as context, which
noticeably improves pronouns, tone and terminology. Configure the model in
Options; fast, inexpensive models (e.g. Claude Haiku, GPT-4o mini) are ideal
since subtitles need low latency.

## Supported subtitle sources

| Source | How it's read |
| --- | --- |
| Native HTML5 `<track>` captions | `TextTrack` cue events (works on any site using standard tracks) |
| YouTube | Caption DOM (`.ytp-caption-segment`) |
| Netflix | Caption DOM (`.player-timedtext`) |
| Prime Video | Caption DOM (`.atvwebplayersdk-captions-text`) |
| Anything else | Live captions mode (speech-to-text) |

Adding a site is usually a ~10-line adapter in
[`src/content/adapters.js`](src/content/adapters.js) — PRs welcome.

## Security & privacy

- **No servers of ours.** Subtitle text and audio go directly from your browser
  to the provider you selected. There is no telemetry and no analytics.
- **API keys** are stored in `chrome.storage.local` (this profile only, not
  synced) and are only attached to requests to that provider's API. Note that
  browser extension storage is not encrypted at rest — prefer keys with
  spending limits, and don't use LiveSub on a machine you don't trust.
- **Permissions:**
  - `<all_urls>` content script — needed to render the overlay on any video
    site; it only reads caption text, and you can disable LiveSub per-site.
  - `tabCapture` + `offscreen` — used only while live captions are running.
  - `storage`, `activeTab` — settings and the popup's per-site toggle.
  - Host permissions are limited to the built-in provider APIs; custom
    endpoints ask for permission when you save them.

## Architecture

```
src/
├── background/
│   ├── service-worker.js   # message hub, translation cache, live-caption control
│   └── providers.js        # Google / Azure / DeepL / Anthropic / OpenAI / custom
├── content/
│   ├── adapters.js         # subtitle sources: textTracks + site-specific DOM
│   ├── main.js             # cue pipeline + overlay rendering
│   └── overlay.css
├── offscreen/              # tab-audio capture + chunked speech-to-text
├── popup/                  # quick controls
├── options/                # full settings + API keys
└── common/                 # shared settings schema + language list
```

All network calls happen in the service worker (or the offscreen document for
audio), never in page content scripts, so keys are never exposed to web pages.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Good first contributions: new site adapters, more languages, streaming STT.

## License

[MIT](LICENSE)
