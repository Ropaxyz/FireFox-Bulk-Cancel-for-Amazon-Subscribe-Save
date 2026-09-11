# Amazon Bulk Cancel for Subscribe & Save

A Firefox (Manifest V3) extension that adds a small draggable panel to Amazon Subscribe & Save pages so you can **cancel many subscriptions in one go**, with a live progress bar and parallel cancellation workers (hidden iframes that drive Amazon's normal cancel flow on your behalf).

Nothing leaves your browser. The extension only runs on your Subscribe & Save pages and only acts after you click **Cancel selected**.

## Install

| Browser | Install | Source |
| --- | --- | --- |
| **Firefox** | [addons.mozilla.org - Amazon Subscribe and Save - Bulk Cancel](https://addons.mozilla.org/en-GB/firefox/addon/amazon-bulk-cancel/) | [Ropaxyz/FireFox-Bulk-Cancel-for-Amazon-Subscribe-Save](https://github.com/Ropaxyz/FireFox-Bulk-Cancel-for-Amazon-Subscribe-Save) (this repo) |
| **Chrome / Edge** | [Chrome Web Store - Amazon Bulk Cancel for Subscribe & Save](https://chromewebstore.google.com/detail/amazon-bulk-cancel-for-su/gojcechafebfbidedlleegdcpcalmcbg) | [Ropaxyz/SubscribeSaveBulkCancelChrome](https://github.com/Ropaxyz/SubscribeSaveBulkCancelChrome) |

**There is a separate Chrome/Edge build.** This repository is the **Firefox** one, so if you
are on Chrome or Edge, use the Chrome links above rather than forking this code - the two
builds are maintained in parallel and only the Chromium one is packaged for that store.

## Features

- Draggable panel injected on supported Subscribe & Save pages
- Per-item overlay checkboxes (with **Select all** / **Clear**)
- **Queue all** - include subscriptions Amazon has not rendered yet (the hub page
  only draws the first batch of tiles, the rest are paginated in)
- Parallel cancellations (1-8, default 3)
- Live progress: `done / running / queued / failed` plus a bar
- **Fast, evidence-based results.** A cancellation is confirmed by the strongest
  signal available, in this order: Amazon's own success redirect, the confirm
  form disappearing after the click, or - if the page never says anything -
  a re-read of your subscription list a few seconds after the click. That last
  check is the same thing your cancellation email tells you, and it is what stops
  items sitting in "running" for the whole timeout.
- **Stop** button to abort cleanly mid-run
- **Auto-retry** for occasional timeouts (0-3 attempts)
- **Stuck after** quiet window adjustable 10-60 s (an item is only abandoned if it
  reports no progress for that long; it is not a total time limit)
- Cancelled items stay faded across the post-run refresh (24 h cache, scoped to the Amazon site you're on)
  - a faded card is still selectable: tick it to re-arm it, which clears it from that cache
- Auto-refreshes at the end (with a click-to-skip countdown)
- Settings (parallel / stuck-after / retries / verify) are remembered per browser

## Supported pages

- Amazon UK - `amazon.co.uk/auto-deliveries` and Subscribe & Save manager pages
- Amazon US - `amazon.com/...`
- Amazon DE - `amazon.de/...`

See `manifest.json` for the exact match patterns.

Both Subscribe & Save layouts are supported:

- the current "hub" page, where subscriptions are a grid of tiles whose only
  identifier is inside `data-edit-url="...subscriptionId=SNST0_..."`
- the older list page, where each item is a `.subscription-card-item` block with
  a `data-subscription-id` attribute

## Install the latest code (temporary, for testing)

The store build lags this repository, so to try the current version:

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Pick `manifest.json` from this folder

A temporary add-on is removed when Firefox closes. For normal use, install the
[store version](https://addons.mozilla.org/en-GB/firefox/addon/amazon-bulk-cancel/).
On Chrome or Edge, use the [Chrome Web Store build](https://chromewebstore.google.com/detail/amazon-bulk-cancel-for-su/gojcechafebfbidedlleegdcpcalmcbg) instead.

## How to use

1. Open your Amazon Subscribe & Save page (`amazon.co.uk/auto-deliveries`, etc.)
2. Click **Load all items** to expand pagination (optional)
3. Tick the items you want to cancel - or click **Select all**
   - For subscriptions that are not on screen yet, click **+ Queue all (incl. not loaded)**.
     Those ids are listed in the status box and counted as `Selected (+n queued)`;
     they are sent through the normal cancel flow once you run the batch.
4. (Optional) Open **Settings** in the panel and adjust **Parallel** / **Stuck after** / **Retries** / **Verify**
5. Click **Cancel selected**
6. Watch the run: the bar fills as items settle, the striped bar means work is in
   flight, and the line under it names what each hidden page is doing
   (`opening cancel page  clicking confirm  cancelled`). Click **Stop** at any time to abort.
7. When the run finishes the page auto-refreshes after 6 seconds (or you can click the green button to refresh immediately).

## Notes & limitations

- The extension is **user-triggered**. It does nothing until you click **Cancel selected**.
- **+ Queue all (incl. not loaded)** only adds ids Amazon has already published on the
  page; it never guesses. The list is remembered for one hour (per Amazon site) so it
  survives a pagination re-render, then expires.
- **Stuck after** is a quiet window, not a total limit: an item is only abandoned if it
  reports no progress for that long. A page that keeps reporting progress is never cut off.
- **Verify** re-reads your subscription list once per item, a few seconds after the
  confirm click. It costs one extra page load per confirmed item and is what makes
  results appear in ~5 s instead of waiting out the timeout. Turn it off in Settings
  if you would rather not have that request.
- Lower **Parallel** if Amazon throttles you. 1-3 is safe; 5+ is aggressive and can cause timeouts.
- Amazon occasionally changes its cancel-page layout. If items get cancelled on Amazon's side but the panel doesn't mark them done, please open an issue with the region you're on (UK/US/DE).

## Power-user tips

A small debug hook is exposed on the page for advanced users:

- `__bulkCancel.prefs.diagnostic = true` - turn on verbose console + status-box logging for the next run.
- `__bulkCancel.clearCompletedCache()` - clear the local "already cancelled" cache so previously-cancelled items aren't auto-faded.
- `__bulkCancel.state` - read-only inspection of in-flight workers, completed IDs, etc.

## Development

Before loading the add-on, run the pre-flight check:

```
node tools/check-content-script.js
```

It compiles the content script the way a browser does. `node --check` is **not**
enough: the stylesheet lives in a template literal, and a stray backtick inside a
CSS comment closes it early - Node parses the result as a tagged template while
the browser refuses to run the whole file, so the panel appears but nothing works.

It also fails if any shipped file gains a UTF-8 BOM or a non-ASCII character.
That is not pedantry: the status log once went through a UTF-8/cp1252 round trip
and every emoji in it rendered as mojibake, which is why the panel text is
deliberately plain ASCII.

### Keeping the two builds in step

There is a parallel Chromium build at [Ropaxyz/SubscribeSaveBulkCancelChrome](https://github.com/Ropaxyz/SubscribeSaveBulkCancelChrome).
Fixes to the Amazon page scraping or the cancel flow usually apply to both, so
when you change anything in `content-script.js` that is not Firefox-specific,
please mirror it there.

## Privacy

No analytics, no telemetry, no external network calls. See [PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
