# Contributing to LiveSub

Thanks for helping! The codebase is intentionally plain: Manifest V3, vanilla
JavaScript, no build step. `git clone`, then "Load unpacked" in
`chrome://extensions` — edit, hit the reload button on the extension card, done.

## Adding support for a new video site

Most sites either use native `<track>` captions (already handled) or render
captions into the DOM. For DOM captions, add an entry to the `SITES` table in
[`src/content/adapters.js`](src/content/adapters.js):

```js
{
  match: (host) => /(^|\.)example\.com$/.test(host),
  make: (onCue) =>
    new DomCaptionAdapter(onCue, {
      selector: '.example-caption-text',      // element(s) holding caption text
      hideCss: '.example-caption { opacity: 0 !important; }' // optional
    })
}
```

Find the selector by turning the site's captions on and inspecting the caption
text in DevTools.

## Adding a translation provider

Add an entry to `PROVIDERS` in
[`src/background/providers.js`](src/background/providers.js) implementing
`translate(texts, opts) -> Promise<string[]>`. If the provider needs a key,
also add a field to the settings schema (`src/common/defaults.js`) and the
options page. Remember to add the API origin to `host_permissions` in
`manifest.json`.

## Guidelines

- Keep it dependency-free — no frameworks, no bundlers.
- All network requests belong in the service worker or offscreen document,
  never in content scripts.
- Never log or transmit API keys or subtitle content anywhere except the
  selected provider.
- Test on both Chrome and Edge if you can (both are Chromium; issues are rare
  but Edge sometimes lags a version).

## Reporting bugs

Open a GitHub issue with the site URL, what you expected, what happened, and
any errors from the extension's service worker console
(`chrome://extensions` → LiveSub → "Inspect views: service worker").
