# Amazon Bulk Cancel (Subscribe & Save)

A Firefox (Manifest V3) extension that adds a small draggable panel to Amazon Subscribe & Save pages, letting you **bulk-cancel** selected subscriptions with a progress bar and parallel “worker” tabs (hidden iframes).

![Demo](./demo.gif)

## What it does
- Injects a UI panel on supported pages
- Lets you select items via overlay checkboxes (or select all)
- Cancels in parallel (default concurrency: 5)
- Marks successes and times out safely
- Auto-refreshes at the end (or you can click to refresh immediately)

## Supported pages
- Amazon UK: `amazon.co.uk/auto-deliveries` and Subscribe & Save manager pages
- Amazon US: `amazon.com/...`
- Amazon DE: `amazon.de/...`

(See `manifest.json` for the exact match patterns.)

## Install (developer / local)
1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `manifest.json` from this folder

## Usage
1. Open your Amazon Subscribe & Save management page
2. Click **Load All Items** (optional, to expand pagination)
3. Tick the items you want to cancel (or **Select All**)
4. Click **CANCEL SELECTED**
5. When finished, click the green button to refresh (or let the countdown run)

## Notes & limitations
- This tool is **user-triggered**. It only runs actions after you click **CANCEL SELECTED**.
- Amazon may change page structure and break selectors. If that happens, open an issue with a screenshot + region (UK/US/DE).

## Privacy
See [PRIVACY.md](PRIVACY.md).

## License
MIT. See [LICENSE](LICENSE).
