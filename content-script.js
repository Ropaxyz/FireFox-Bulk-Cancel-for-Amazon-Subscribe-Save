/*
 * Amazon Bulk Cancel
 * SPDX-License-Identifier: MIT
 *
 * Purpose: User-triggered bulk cancellation helper for Amazon Subscribe & Save.
 * Notes: Runs only on supported Amazon Subscribe & Save pages. No external network requests.
 */

(() => {
  'use strict';

  const VERSION = '25.7.0';
  const WORKER_NAME_PREFIX = 'BC_';

  // Success URL patterns Amazon redirects to after a successful cancel.
  // The strongest signal is `snsActionCompleted=cancelSubscription`.
  const SUCCESS_URL_PATTERNS = [
    /snsActionCompleted=cancelSubscription/i,
    /[?&]cancellationReason=/i, // present on the redirect target as well
    /[?&]actionCompleted=cancel/i,
  ];

  // The cancel page lives at the same path on every marketplace, but Amazon's
  // own "Cancel subscription" link now carries `clientName`/`enableMydExperience`
  // and the current hub payload expects `sourcePage=editSubscriptionFromMYS`.
  // We try Amazon's own parameter set first, then the older/simpler one, then
  // the side-sheet AJAX endpoint that renders the same confirm form.
  function buildCancelUrlCandidates(subId) {
    const base = window.location.origin;
    const p = (extra) =>
      new URLSearchParams({
        subscriptionId: subId,
        deviceType: 'desktop',
        deviceContext: 'web',
        clientName: 'mydHub',
        enableMydExperience: '1',
        ...extra,
      });
    const urls = [
      `${base}/auto-deliveries/cancelSubscription?${p({
        sourcePage: 'editSubscriptionFromMYS',
      }).toString()}`,
      `${base}/auto-deliveries/cancelSubscription?${p({
        sourcePage: 'subscriptionList',
      }).toString()}`,
      `${base}/auto-deliveries/ajax/cancelSubscription?${p({
        sourcePage: 'myd',
      }).toString()}`,
      `${base}/gp/subscribe-and-save/manager/cancelSubscription?${new URLSearchParams({
        subscriptionId: subId,
      }).toString()}`,
    ];
    if (prefs.diagnostic) {
      return urls.map((u) => u + (u.includes('?') ? '&' : '?') + '_bcDiag=1');
    }
    return urls;
  }

  const IS_IFRAME = window.self !== window.top;

  // ---------------------------------------------------------------------------
  // Page-shape constants.
  //
  // Amazon has shipped two different layouts for the Subscribe & Save manager:
  //
  //   OLD (<= 2025): a list of `.subscription-card-item` blocks, each carrying
  //                  `data-subscription-id` and a "Show more subscriptions"
  //                  `.subscription-pagination-trigger`.
  //
  //   NEW (2026+):   a CSS-module "hub" page. Subscriptions render as a grid of
  //                  clickable tiles (`...._clickableTile__*`) that carry the id
  //                  only inside `data-edit-url=/auto-deliveries/ajax/subscription/?...
  //                  subscriptionId=SNST0_...`. The class suffix is a build hash
  //                  and changes without warning, so all matching is done on the
  //                  stable `data-mix-operations` / `data-edit-url` attributes.
  //
  // Everything below is written to work on both shapes at once.
  // ---------------------------------------------------------------------------
  const SELECTOR_TILE = '[data-mix-operations="editSubscriptionModalHandler"]';
  const SELECTOR_LEGACY_CARD = '.subscription-card-item';
  // Third shape: rows/blocks that only carry `data-subscription-id`.
  const SELECTOR_ID_ROW = '[data-subscription-id]';
  const SELECTOR_CARD = `${SELECTOR_TILE}, ${SELECTOR_LEGACY_CARD}, ${SELECTOR_ID_ROW}`;
  // Builds `.a.bc-x, .b.bc-x, .c.bc-x` - see the note in the stylesheet for why
  // each selector needs its own copy of the state class.
  const cardSelectors = SELECTOR_CARD.split(',').map((s) => s.trim()).filter(Boolean);
  const CARD_STATES = (states) =>
    Object.entries(states)
      .map(
        ([state, rules]) =>
          cardSelectors.map((sel) => `${sel}.bc-${state}`).join(', ') + ` { ${rules} }`
      )
      .join('\n    ');
  const SELECTOR_LOAD_MORE =
    '.subscription-pagination-trigger, [data-action="bulk-edit-pagination-action"]';

  // Stable hooks for reading a product name out of a card/tile.
  const SELECTOR_CARD_TITLE =
    '.a-truncate-full, .a-truncate-cut, [data-cypress="product-title"], .product-title, .a-size-base-plus';

  // `subscriptionId` values look like SNST0_<hex> (UK/US) or SNSD0_<base32> (DE).
  const SUB_ID_RE = /(?:SNST0_|SNSD0_|SNS[A-Z0-9]{0,3}_)[A-Za-z0-9]+/;
  const SUB_ID_IN_URL_RE = /[?&]subscriptionId=([^&"'\s]+)/;
  // Suffixes Amazon appends to the id in state keys, e.g. copaPageState-SNST0_ABC.
  const STATE_KEY_TAIL_RE = /-(?:[A-Za-z]*[Pp]age[Ss]tate|data|state)$/;
  // `data-a-state` on a <script> also carries non-subscription page state; the
  // id match below is what filters those out.
  const STATE_KEY_RE = /[a-z]*pageState-([A-Za-z0-9_]+)/i;

  // Defaults (user can override via the panel)
  const DEFAULT_CONCURRENCY = 3;
  // 25 s killed healthy cancellations whose page just took a while to render,
  // which cost a full retry (~25 s) before the item registered as done.
  const DEFAULT_WORKER_TIMEOUT_MS = 45000;
  const DEFAULT_MAX_RETRIES = 1;
  const POLL_INTERVAL_MS = 100;
  // How long a worker may make no progress at all before it is considered stuck.
  const DEFAULT_QUIET_MS = 20000;
  // Absolute cap so a worker that keeps emitting progress can never hang forever.
  const MAX_WORKER_MS = 90000;
  // Give up sooner on verification when a worker has already clicked confirm.
  const VERIFY_QUIET_MS = 12000;
  // After a confirm click, how long to wait before checking the subscription
  // list itself to find out whether the cancellation actually stuck.
  const VERIFY_AFTER_MS = 6000;
  const SAFETY_MARGIN_MS = 30000; // master safety = perWorker*total + this, capped

  const LS_PREFS = 'bc_prefs_v25_4';
  const LS_COMPLETED = 'bc_completed_v25_4'; // { origin, ts, ids: [] }
  const LS_QUEUED = 'bc_queued_v25_6'; // { origin, ts, ids: [] } - ids selected but not visible in the DOM
  const QUEUED_TTL_MS = 60 * 60 * 1000;
  const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;

  // ========================================================================
  // [tool] WORKER MODE (runs inside hidden iframe on the cancellation page)
  // ========================================================================
  if (IS_IFRAME) {
    // Two ways to recognise our worker frame:
    //   1. The master sets iframe.name = "BC_<subId>" before assigning src,
    //      and that name persists across same-origin navigations within the
    //      same iframe element. This is the source of truth.
    //   2. Fallback: a URL containing cancelSubscription with subscriptionId.
    const wname = (window.name || '').toString();
    const isOurWorker = wname.startsWith(WORKER_NAME_PREFIX);
    if (!isOurWorker && !location.href.includes('cancelSubscription')) return;

    const url = new URL(location.href);
    const myId = isOurWorker
      ? wname.slice(WORKER_NAME_PREFIX.length)
      : url.searchParams.get('subscriptionId');
    if (!myId) return;
    const targetOrigin = window.location.origin;
    const verbose = url.searchParams.get('_bcDiag') === '1' || /[?&]_bcDiag=1/.test(wname);

    // Multi-language / variant success markers
    const SUCCESS_PATTERNS = [
      /subscription\s+cancell?ed/i,
      /cancell?ed\s+your\s+subscription/i,
      /has\s+been\s+cancell?ed/i,
      /your\s+subscription\s+has\s+been\s+cancell?ed/i,
      /subscription\s+has\s+been\s+stopped/i,
      /we'?ve\s+cancell?ed/i,
      /abonnement\s+gek(?:\u00fc|ue|u)ndigt/i, // German: u-umlaut, ue transliteration, or plain u
      /wurde\s+gek(?:\u00fc|ue|u)ndigt/i,
      /no\s+longer\s+subscribed/i,
    ];

    // Amazon redirects here after a successful cancellation. Landing on any of
    // these is proof enough, with or without a "cancelled" sentence on screen.
    const isSuccessUrl = (href) =>
      /[?&](snsActionCompleted|cancellationReason|actionCompleted)=/i.test(href) ||
      /cancel(lation)?[-_]?confirm/i.test(href);

    const findConfirmButton = () => {
      const container = document.getElementById('confirmCancelLink');
      if (container) {
        const inner = container.querySelector('input[type="submit"], button, a.a-button-text');
        if (inner) return inner;
      }
      return (
        document.querySelector('input[type="submit"][aria-labelledby*="confirmCancel" i]') ||
        document.querySelector('input[type="submit"][name*="confirm" i]') ||
        document.querySelector('button[name*="confirm" i]') ||
        document.querySelector('input[type="submit"][value*="cancel" i]') ||
        document.querySelector('input[type="submit"][value*="confirm" i]') ||
        document.querySelector('button[id*="confirm" i]') ||
        document.querySelector('button[data-action*="confirm" i]') ||
        document.querySelector('span[id*="confirmCancel" i] input[type="submit"]') ||
        document.querySelector('span[id*="confirmCancel" i] button') ||
        // Last resort: the only submit button / primary button on the page.
        (document.querySelectorAll('input[type="submit"]').length === 1
          ? document.querySelector('input[type="submit"]')
          : null) ||
        document.querySelector('input[name="confirmCancellation"]') ||
        document.querySelector('button.a-button-primary, span.a-button-primary input') ||
        null
      );
    };

    // Progress is broadcast while the form is being driven so the panel can show
    // something moving - a stuck cancel used to look identical to a hung addon.
    const postProgress = (stage, note) =>
      post({
        type: 'BULK_PROGRESS',
        subId: myId,
        stage,
        note: note || '',
        hasConfirmBtn: !!findConfirmButton(),
        url: location.href,
      });

    // What kind of page did we actually land on?
    const describePage = () => {
      const text = document.body ? (document.body.innerText || '').slice(0, 400) : '';
      if (/signin|passwort|anmelden/i.test(location.href)) return 'sign-in';
      if (/captcha|validateCaptcha/i.test(location.href)) return 'captcha';
      if (findConfirmButton()) return 'confirm-form';
      if (/cancell?ed|gek(?:\u00fc|ue|u)ndigt/i.test(text)) return 'cancelled';
      if (/problem|error|sorry|not available/i.test(text)) return 'error';
      return text.trim() ? 'unknown' : 'empty';
    };

    const isSuccess = (text) => SUCCESS_PATTERNS.some((re) => re.test(text));

    const post = (msg) => {
      try {
        window.top.postMessage(msg, targetOrigin);
      } catch (_e) {
        /* origin mismatch */
      }
    };

    const wlog = (...args) => {
      try {
        console.log(`[BulkWorker ${myId}]`, ...args);
      } catch (_e) {}
    };

    let attempts = 0;
    let submitsTried = 0;
    let firstUrl = location.href;
    let urlChangedAt = 0;
    let submittedAt = 0;
    const maxAttempts = Math.ceil(60000 / POLL_INTERVAL_MS); // worker self-cap 60s

    const trySubmit = (btn) => {
      if (!btn) return false;
      submitsTried++;
      // 1) Bare .click() - works for most Amazon submit inputs
      try { btn.click(); return true; } catch (_e) {}
      // 2) Form-level submit
      const form = btn.closest && btn.closest('form');
      if (form) {
        try { if (form.requestSubmit) { form.requestSubmit(btn); return true; } } catch (_e) {}
        try { form.submit(); return true; } catch (_e) {}
      }
      // 3) Synthesized mouse sequence
      try {
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        btn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
        btn.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (_e) {}
      return false;
    };

    const looksLikeRedirectSuccess = () => {
      // Landing on one of Amazon's post-cancel URLs is success on its own, no
      // settling delay needed.
      if (isSuccessUrl(location.href) && !location.href.includes('cancelSubscription')) return true;

      // After Amazon processes the cancellation it typically navigates away
      // from the cancelSubscription form. If we land somewhere else AND the
      // form is no longer present, treat it as success.
      const stillOnCancelForm =
        location.href.includes('cancelSubscription') &&
        (document.getElementById('sns-cancellation-dropdown') ||
          document.getElementById('confirmCancelLink'));
      if (stillOnCancelForm) return false;
      // Must have left the form and waited at least 1.5s after navigation
      // (so we don't false-positive on the empty in-between state).
      if (location.href === firstUrl) return false;
      if (Date.now() - urlChangedAt < 1500) return false;
      return true;
    };

    // We clicked confirm and the confirm form is now gone: Amazon accepted it
    // and moved us on. This is the fastest reliable success signal, and it does
    // not depend on the success page rendering inside a hidden iframe.
    const looksLikeSubmittedSuccess = () => {
      if (submitsTried === 0) return false;
      if (document.getElementById('confirmCancelLink')) return false;
      if (document.getElementById('sns-cancellation-dropdown')) return false;
      if (location.href.includes('cancelSubscription') && document.querySelector('form[action*="cancel" i]')) return false;
      // Give the page a moment to settle so we don't read a half-rendered state.
      return Date.now() - submittedAt >= 1200;
    };

    let lastSnapshot = '';
    const sendSnapshot = (note) => {
      const text = document.body ? (document.body.innerText || '').trim() : '';
      const dropdown = document.getElementById('sns-cancellation-dropdown');
      const confirmBtn = findConfirmButton();
      const sample = text.slice(0, 200).replace(/\s+/g, ' ');
      const sig = `${location.href}|${!!dropdown}|${!!confirmBtn}|${sample}|${attempts}|${submitsTried}`;
      const force = !!note;
      // Always emit when 'note' is set; otherwise emit if signature changed
      // OR every periodic tick (caller decides cadence).
      if (force || sig !== lastSnapshot) {
        lastSnapshot = sig;
        post({
          type: 'BULK_DIAG',
          subId: myId,
          note: note || 'state',
          attempts,
          submitsTried,
          url: location.href,
          hasDropdown: !!dropdown,
          dropdownValue: dropdown ? dropdown.value : null,
          dropdownOptions: dropdown
            ? [...dropdown.options].map((o) => ({ value: o.value, label: o.text.slice(0, 40) }))
            : null,
          hasConfirmBtn: !!confirmBtn,
          confirmBtnTag: confirmBtn ? confirmBtn.tagName : null,
          confirmBtnId: confirmBtn ? confirmBtn.id : null,
          textSample: sample,
          textLen: text.length,
        });
        if (verbose) wlog(note || 'state', { url: location.href, hasDropdown: !!dropdown, hasConfirmBtn: !!confirmBtn, attempts, submitsTried, sample });
      }
    };

    post({ type: 'BULK_ALIVE', subId: myId, url: location.href });
    if (verbose) wlog('worker started', { url: location.href, name: window.name });

    // Tell the panel straight away what we loaded and what we found, so the run
    // shows activity from the first moment instead of sitting silent.
    let reportedPage = '';
    const reportPage = (stage) => {
      const kind = describePage();
      reportedPage = kind;
      postProgress(stage, kind);
      return kind;
    };
    setTimeout(() => reportPage('loaded'), 150);

    // Send an initial snapshot once the DOM is ready enough
    const initialSnap = setTimeout(() => sendSnapshot('initial'), 500);

    const fastPoll = setInterval(() => {
      attempts++;

      // Track URL changes (post-submit navigation)
      if (location.href !== firstUrl && urlChangedAt === 0) {
        urlChangedAt = Date.now();
        sendSnapshot('navigated');
        reportPage('navigated');
      }

      const text = document.body ? document.body.innerText || '' : '';
      const hasReactivate = /reactivate|reaktivieren/i.test(text);
      const confirmBtn = findConfirmButton();

      if (isSuccess(text)) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        if (verbose) wlog('SUCCESS via text');
        postProgress('confirmed', 'success-text');
        sendSnapshot('success-text');
        post({ type: 'BULK_DONE', subId: myId, status: 'success' });
        return;
      }
      if (hasReactivate && !confirmBtn) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        if (verbose) wlog('SUCCESS via reactivate marker');
        postProgress('confirmed', 'success-reactivate');
        sendSnapshot('success-reactivate');
        post({ type: 'BULK_DONE', subId: myId, status: 'success' });
        return;
      }
      if (looksLikeRedirectSuccess()) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        if (verbose) wlog('SUCCESS via redirect heuristic', location.href);
        postProgress('confirmed', 'success-redirect');
        sendSnapshot('success-redirect');
        post({ type: 'BULK_DONE', subId: myId, status: 'success' });
        return;
      }
      if (looksLikeSubmittedSuccess()) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        if (verbose) wlog('SUCCESS via submitted-and-gone', location.href);
        postProgress('confirmed', 'success-after-submit');
        sendSnapshot('success-after-submit');
        post({ type: 'BULK_DONE', subId: myId, status: 'success' });
        return;
      }

      const dropdown = document.getElementById('sns-cancellation-dropdown');
      if (dropdown && dropdown.value === '') {
        const target =
          dropdown.querySelector('option[value*="expensive" i]') ||
          dropdown.querySelector('option[value*="no_longer" i]') ||
          dropdown.querySelector('option[value*="dont_need" i]') ||
          dropdown.options[1];
        if (target) {
          dropdown.value = target.value;
          dropdown.dispatchEvent(new Event('input', { bubbles: true }));
          dropdown.dispatchEvent(new Event('change', { bubbles: true }));
          if (verbose) wlog('selected reason', target.value);
        }
      }

      if (confirmBtn) {
        // Only attempt submit a handful of times to avoid event spam - Amazon
        // sometimes ignores rapid duplicate clicks.
        if (submitsTried < 6) {
          // Announce the first attempt so the panel shows the click happening.
          if (submitsTried === 0) {
            postProgress('submitting', confirmBtn.tagName.toLowerCase());
            submittedAt = Date.now();
          }
          trySubmit(confirmBtn);
        }
      } else if (attempts % 20 === 0) {
        // Nothing to click and nothing changed: keep the panel informed about
        // what kind of page we are stuck on.
        postProgress('waiting', reportedPage || describePage());
      }

      // Periodic snapshot: every 1s when verbose, every 2s otherwise (forced)
      if (attempts % (verbose ? 10 : 20) === 0) sendSnapshot('tick');

      if (attempts >= maxAttempts) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        postProgress('timeout', reportedPage || describePage());
        sendSnapshot('timeout');
        post({ type: 'BULK_DONE', subId: myId, status: 'timeout', reason: 'worker-timeout' });
      }
    }, POLL_INTERVAL_MS);

    return;
  }

  // ========================================================================
  // '' MASTER MODE
  // ========================================================================

  const existing = document.getElementById('bulkCancelUI');
  if (existing) existing.remove();

  // Silent by default - set window.__bulkCancel.prefs.diagnostic = true in
  // DevTools to enable verbose logging.

  // --- Persistence helpers ----------------------------------------------------
  const loadPrefs = () => {
    try {
      const raw = localStorage.getItem(LS_PREFS);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_e) {
      return null;
    }
  };
  const savePrefs = (p) => {
    try {
      localStorage.setItem(LS_PREFS, JSON.stringify(p));
    } catch (_e) {}
  };

  const loadCompleted = () => {
    try {
      const raw = localStorage.getItem(LS_COMPLETED);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.origin !== window.location.origin) return new Set();
      if (!parsed.ts || Date.now() - parsed.ts > COMPLETED_TTL_MS) {
        localStorage.removeItem(LS_COMPLETED);
        return new Set();
      }
      return new Set(parsed.ids || []);
    } catch (_e) {
      return new Set();
    }
  };
  const saveCompleted = (set) => {
    try {
      localStorage.setItem(
        LS_COMPLETED,
        JSON.stringify({ origin: window.location.origin, ts: Date.now(), ids: [...set] })
      );
    } catch (_e) {}
  };
  const clearCompleted = () => {
    try {
      localStorage.removeItem(LS_COMPLETED);
    } catch (_e) {}
  };

  // --- State -----------------------------------------------------------------
  const prefs = Object.assign(
    {
      concurrency: DEFAULT_CONCURRENCY,
      timeoutMs: DEFAULT_WORKER_TIMEOUT_MS,
      retries: DEFAULT_MAX_RETRIES,
      // Re-read the subscription list a few seconds after a confirm click to
      // settle items Amazon never acknowledges on-screen. One page load per
      // confirmed item; can be switched off in Settings.
      verify: true,
      diagnostic: false,
    },
    loadPrefs() || {}
  );

  // --- Queued (selected but not currently visible) subscriptions --------------
  // Amazon only renders the first batch of tiles; the rest are fetched by
  // "Show more subscriptions". Ids the user queued from that hidden tail are
  // cached so they survive the pagination re-render, with a short TTL so a
  // stale selection can never fire hours later.
  const loadQueued = () => {
    try {
      const raw = localStorage.getItem(LS_QUEUED);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.origin !== window.location.origin) return new Set();
      if (!parsed.ts || Date.now() - parsed.ts > QUEUED_TTL_MS) {
        localStorage.removeItem(LS_QUEUED);
        return new Set();
      }
      return new Set(parsed.ids || []);
    } catch (_e) {
      return new Set();
    }
  };
  const saveQueued = (set) => {
    try {
      if (!set || set.size === 0) {
        localStorage.removeItem(LS_QUEUED);
        return;
      }
      localStorage.setItem(
        LS_QUEUED,
        JSON.stringify({ origin: window.location.origin, ts: Date.now(), ids: [...set] })
      );
    } catch (_e) {}
  };
  const clearQueued = () => {
    try {
      localStorage.removeItem(LS_QUEUED);
    } catch (_e) {}
  };

  // Worker stage -> human label, used for the live "doing X" line.
  const STAGE_LABELS = {
    starting: 'opening cancel page',
    loaded: 'cancel page loaded',
    navigated: 'page changed',
    submitting: 'clicking confirm',
    confirmed: 'cancelled',
    waiting: 'waiting for the confirm form',
    timeout: 'gave up',
  };
  const reportedStages = new Set();

  const state = {
    running: false,
    stopRequested: false,
    runToken: 0,
    pending: [], // queue of subId
    inFlight: new Map(), // subId -> { iframe, timer, attempts }
    completed: loadCompleted(), // Set<subId>
    queued: loadQueued(), // Set<subId> selected but not in the DOM
    current: new Map(), // subId -> latest worker stage label
    failed: new Set(),
    totalBatchSize: 0,
    refreshTimer: null,
    safetyTimer: null,
  };

  // --- Styles ----------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #bulkCancelUI {
      position: fixed; top: 80px; right: 20px; z-index: 2147483647;
      background: #fff; border: 1px solid #ccc; border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.18); width: 272px;
      font-family: "Amazon Ember", Arial, sans-serif;
      overflow: hidden;
      color: #111;
    }
    #bc_header {
      background: #232F3E; color: #fff; padding: 10px 12px; cursor: move;
      font-weight: 700; font-size: 13px; user-select: none;
      display: flex; justify-content: space-between; align-items: center;
      letter-spacing: 0.2px;
    }
    #bc_header .bc-drag-hint { font-size: 10px; opacity: 0.7; font-weight: 400; }
    #bc_body { padding: 12px; }
    .bc-btn {
      width: 100%; padding: 8px 10px; margin-bottom: 8px; cursor: pointer;
      border-radius: 6px; border: 1px solid #D5D9D9; background: #F0F2F2;
      font-size: 12px; transition: background 0.15s, opacity 0.15s, transform 0.05s;
      color: #111;
    }
    .bc-btn:hover { background: #E3E6E6; }
    .bc-btn:active { transform: translateY(1px); }
    .bc-btn:focus-visible { outline: 2px solid #1565c0; outline-offset: 1px; }
    .bc-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
    .bc-btn-primary {
      background: #D01E28; color: white; border: none; font-weight: 700;
      box-shadow: 0 2px 5px rgba(208,30,40,0.25);
    }
    .bc-btn-primary:hover { background: #B61B22; }
    .bc-btn-stop {
      background: #555; color: #fff; border: none; font-weight: 700;
    }
    .bc-btn-stop:hover { background: #333; }
    .bc-btn-link {
      width: auto; background: none; border: 0; padding: 2px 4px;
      font-size: 11px; color: #1565c0; text-decoration: none; margin: 0;
      cursor: pointer;
    }
    .bc-btn-link:hover { text-decoration: underline; background: none; }
    .bc-btn-group { display: flex; gap: 8px; margin-bottom: 8px; }

    #bc_settings {
      background: #fafafa; border: 1px solid #eee; border-radius: 6px;
      padding: 8px 10px; margin-bottom: 8px;
    }
    #bc_settings_head {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 11px; color: #555; cursor: pointer; user-select: none;
    }
    #bc_settings_head .bc-chev { transition: transform 0.15s; }
    #bc_settings.bc-open #bc_settings_head .bc-chev { transform: rotate(90deg); }
    #bc_settings_body { display: none; margin-top: 6px; }
    #bc_settings.bc-open #bc_settings_body { display: block; }
    .bc-row { display: flex; align-items: center; gap: 8px; font-size: 11px; margin: 6px 0; }
    .bc-row label { flex: 1; color: #555; }
    .bc-row input[type="range"] { flex: 2; accent-color: #D01E28; }
    .bc-row .bc-val { width: 36px; text-align: right; font-variant-numeric: tabular-nums; color: #232F3E; font-weight: 700; }

    #bc_count_line {
      font-size: 12px; text-align: center; margin: 6px 0 4px; color: #444;
    }
    #bc_count_line strong { color: #D01E28; font-size: 14px; }

    #bc_status_box {
      background: #F8F8F8; border: 1px solid #EEE; padding: 8px;
      border-radius: 6px; font-size: 11px; color: #555;
      max-height: 100px; overflow-y: auto; margin-top: 8px;
      line-height: 1.4;
    }

    #bc_now { font-size: 11px; color: #444; margin: 0 0 8px; min-height: 14px; }
    /* Animate the bar while work is in flight so a stalled percentage still
       reads as "busy" rather than "dead". */
    @keyframes bc-stripes {
      from { background-position: 0 0; }
      to { background-position: 28px 0; }
    }
    #bc_progress_wrap.bc-busy #bc_progress_bar {
      /* The longhand background-image would be reset by the bar's own
         background shorthand, so set the whole background here. */
      background: #D01E28 linear-gradient(
        45deg, rgba(255,255,255,0.45) 25%, transparent 25%,
        transparent 50%, rgba(255,255,255,0.45) 50%,
        rgba(255,255,255,0.45) 75%, transparent 75%, transparent
      );
      background-size: 28px 28px;
      animation: bc-stripes 0.9s linear infinite;
      min-width: 6%;
    }

    .bc-stats {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
      font-size: 10px; text-align: center; margin: 6px 0 4px; color: #555;
    }
    .bc-stats div { background: #f3f3f3; border-radius: 4px; padding: 4px 0; }
    .bc-stats strong { display: block; font-size: 13px; color: #232F3E; line-height: 1.2; }
    .bc-stats .bc-s-done strong { color: #2e7d32; }
    .bc-stats .bc-s-fail strong { color: #c62828; }
    .bc-stats .bc-s-run strong { color: #1565c0; }

    .bulk-cancel-checkbox-wrapper {
      position: absolute; top: 10px; left: 10px; z-index: 9000; cursor: pointer;
      display: block; margin: 0; padding: 0; line-height: 0;
    }
    /* The visible box is a span[role=checkbox] whose state lives in
       aria-checked; the hidden <input> only carries the subscription id.
       A real visible <input> proved unreliable on the hub page, where
       Amazon's own click handlers interfere with native checkbox activation. */
    .bulk-cancel-checkbox { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
    .bc-checkmark {
      width: 24px; height: 24px; background-color: #fff; border: 2px solid #888;
      border-radius: 4px; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2); transition: all 0.15s;
      box-sizing: border-box; outline: none;
    }
    .bc-checkmark::after {
      content: ''; display: none; width: 6px; height: 12px; border: solid white;
      border-width: 0 3px 3px 0; transform: rotate(45deg) translate(-1px, -1px);
    }
    .bulk-cancel-checkbox-wrapper:hover .bc-checkmark { border-color: #D01E28; transform: scale(1.08); }
    .bc-checkmark:focus-visible { outline: 2px solid #1565c0; outline-offset: 2px; }
    .bc-checkmark[aria-checked="true"] { background-color: #D01E28; border-color: #D01E28; }
    .bc-checkmark[aria-checked="true"]::after { display: block; }

    body.bc-running .bulk-cancel-checkbox-wrapper { cursor: not-allowed; opacity: 0.6; pointer-events: none; }
    body.bc-running .bc-btn:not(#bc_run):not(#bc_stop) { opacity: 0.5; pointer-events: none; }

    ${SELECTOR_CARD} { position: relative !important; transition: opacity 0.2s; }
    /*
     * SELECTOR_CARD is a comma-separated list, so every state rule must repeat
     * the list AND the state class per selector. Appending the class to the
     * whole list produces the selector LIST
     *   [tile], .subscription-card-item, [data-subscription-id].bc-success
     * which makes the bare first selector match every tile - greying out and
     * disabling the whole page on load. Hence the per-selector mapping below.
     */
    ${CARD_STATES({ selected: 'box-shadow: 0 0 0 3px #D01E28 inset !important; background-color: #fff8f8 !important;' })}
    ${CARD_STATES({ processing: 'opacity: 0.6;' })}
    ${CARD_STATES({ success: 'opacity: 0.45;' })}
    ${CARD_STATES({ error: 'box-shadow: 0 0 0 3px #c62828 inset !important;' })}
    /* New hub grid: keep the checkbox above Amazon's own hover affordances. */
    ${SELECTOR_CARD} { isolation: isolate; }
    ${SELECTOR_CARD} .bulk-cancel-checkbox-wrapper { z-index: 50; }
    ${SELECTOR_CARD}:hover .bc-checkmark { border-color: #D01E28; box-shadow: 0 2px 8px rgba(0,0,0,0.28); }
    /* A card restored from the "already cancelled" cache is inert until the
       user clicks its checkbox, which is what re-arms it. */
    ${CARD_STATES({ success: 'cursor: pointer;' })}

    /* Hidden by default; toggled via window.__bulkCancel.prefs.diagnostic = true */
    .bc-diag-frame {
      width: 360px !important; height: 240px !important;
      opacity: 1 !important; right: 10px !important; bottom: 10px !important;
      left: auto !important; top: auto !important;
      border: 2px solid #1565c0 !important; border-radius: 4px;
      background: #fff;
    }
  `;
  document.head.appendChild(style);

  // --- UI Injection ----------------------------------------------------------
  function injectUI() {
    const panel = document.createElement('div');
    panel.id = 'bulkCancelUI';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Amazon Bulk Cancel panel');
    panel.innerHTML = `
      <div id="bc_header">
        <span>Bulk Cancel</span>
        <span class="bc-drag-hint">drag</span>
      </div>
      <div id="bc_body">
        <button id="bc_load" class="bc-btn" type="button" aria-label="Load all subscription items">Load all items</button>
        <button id="bc_queue_all" class="bc-btn bc-btn-link" type="button" aria-label="Queue every subscription on this page, including ones not loaded yet">+ Queue all (incl. not loaded)</button>
        <div class="bc-btn-group">
          <button id="bc_all" class="bc-btn" type="button">Select all</button>
          <button id="bc_none" class="bc-btn" type="button">Clear</button>
        </div>

        <div id="bc_settings" aria-label="Settings">
          <div id="bc_settings_head" role="button" tabindex="0" aria-expanded="false" aria-controls="bc_settings_body">
            <span>Settings</span>
            <span><span class="bc-chev">></span></span>
          </div>
          <div id="bc_settings_body">
            <div class="bc-row">
              <label for="bc_concurrency" title="How many cancellations to run in parallel. Lower is gentler on Amazon's rate limits.">Parallel</label>
              <input id="bc_concurrency" type="range" min="1" max="8" step="1" aria-label="Parallel cancellations" />
              <span class="bc-val" id="bc_concurrency_val" aria-live="polite"></span>
            </div>
            <div class="bc-row">
              <label for="bc_timeout" title="How long an item may make no progress at all before it is considered stuck. It is a quiet-window, not a total limit: a page that keeps reporting progress is never cut off.">Stuck after</label>
              <input id="bc_timeout" type="range" min="10" max="60" step="5" aria-label="Stuck-after timeout in seconds" />
              <span class="bc-val" id="bc_timeout_val" aria-live="polite"></span>
            </div>
            <div class="bc-row">
              <label for="bc_retries" title="How many times to retry a failed cancellation before marking it failed.">Retries</label>
              <input id="bc_retries" type="range" min="0" max="3" step="1" aria-label="Retry attempts" />
              <span class="bc-val" id="bc_retries_val" aria-live="polite"></span>
            </div>
            <div class="bc-row">
              <label for="bc_verify" title="A few seconds after clicking confirm, re-read your subscription list to confirm the cancellation. Makes results appear much sooner when Amazon does not show a confirmation page.">Verify</label>
              <input id="bc_verify" type="checkbox" aria-label="Verify cancellations against the subscription list" />
              <span class="bc-val"></span>
            </div>
          </div>
        </div>

        <div id="bc_count_line">
          <span id="bc_count_label">Selected:</span>
          <strong id="bc_count">0</strong>
        </div>

        <div class="bc-stats" id="bc_stats" style="display:none;" aria-live="polite">
          <div class="bc-s-done"><strong id="bc_s_done">0</strong>done</div>
          <div class="bc-s-run"><strong id="bc_s_run">0</strong>running</div>
          <div><strong id="bc_s_queue">0</strong>queued</div>
          <div class="bc-s-fail"><strong id="bc_s_fail">0</strong>failed</div>
        </div>

        <div style="margin:6px 0 10px;">
          <div id="bc_progress_wrap" style="height:6px; background:#e7e7e7; border-radius:4px; overflow:hidden;" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div id="bc_progress_bar" style="height:100%; width:0%; background:#D01E28; transition: width 0.3s;"></div>
          </div>
        </div>

        <div id="bc_now" style="display:none; font-size:11px; color:#444; margin:0 0 8px; min-height:14px;" aria-live="polite"></div>

        <button id="bc_run" class="bc-btn bc-btn-primary" type="button">Cancel selected</button>
        <button id="bc_stop" class="bc-btn bc-btn-stop" type="button" style="display:none;">Stop</button>
        <div id="bc_status_box" role="log" aria-live="polite">Ready.</div>
      </div>
    `;
    document.body.appendChild(panel);
    setupDrag(panel);

    document.getElementById('bc_load').onclick = loadAllItems;
    document.getElementById('bc_queue_all').onclick = queueAllSubscriptions;
    document.getElementById('bc_all').onclick = () => setAll(true);
    document.getElementById('bc_none').onclick = () => setAll(false);
    document.getElementById('bc_run').onclick = startParallelBatch;
    document.getElementById('bc_stop').onclick = requestStop;

    // Collapsible settings
    const settings = document.getElementById('bc_settings');
    const settingsHead = document.getElementById('bc_settings_head');
    const toggleSettings = () => {
      const open = settings.classList.toggle('bc-open');
      settingsHead.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    settingsHead.addEventListener('click', toggleSettings);
    settingsHead.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSettings();
      }
    });

    const wireSlider = (rangeId, valId, key, fmt = (v) => v) => {
      const r = document.getElementById(rangeId);
      const v = document.getElementById(valId);
      r.value = String(prefs[key]);
      v.textContent = fmt(prefs[key]);
      r.addEventListener('input', () => {
        prefs[key] = Number(r.value);
        v.textContent = fmt(prefs[key]);
        savePrefs(prefs);
      });
    };
    wireSlider('bc_concurrency', 'bc_concurrency_val', 'concurrency');
    {
      const r = document.getElementById('bc_timeout');
      const v = document.getElementById('bc_timeout_val');
      const seconds = Math.round(prefs.timeoutMs / 1000);
      r.value = String(seconds);
      v.textContent = `${seconds}s`;
      r.addEventListener('input', () => {
        prefs.timeoutMs = Number(r.value) * 1000;
        v.textContent = `${r.value}s`;
        savePrefs(prefs);
      });
    }
    wireSlider('bc_retries', 'bc_retries_val', 'retries');
    {
      const cb = document.getElementById('bc_verify');
      cb.checked = prefs.verify !== false;
      cb.addEventListener('change', () => {
        prefs.verify = cb.checked;
        savePrefs(prefs);
      });
    }
  }

  function setupDrag(panel) {
    const header = document.getElementById('bc_header');
    let isDragging = false;
    let startX;
    let startY;
    let initialLeft;
    let initialTop;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      panel.style.right = 'auto';
      panel.style.left = initialLeft + 'px';
      panel.style.top = initialTop + 'px';
      header.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panel.style.left = `${initialLeft + (e.clientX - startX)}px`;
      panel.style.top = `${initialTop + (e.clientY - startY)}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      header.style.cursor = 'move';
    });
  }

  // --- Logging / progress ----------------------------------------------------
  function log(msg, color = '#333', isBold = false) {
    const el = document.getElementById('bc_status_box');
    if (el) {
      const div = document.createElement('div');
      div.style.color = color;
      div.style.marginBottom = '2px';
      if (isBold) div.style.fontWeight = 'bold';
      div.textContent = msg;
      el.prepend(div);
    }
    if (prefs.diagnostic) console.log(`[BulkCancel] ${msg}`);
  }

  function updateProgress() {
    const countEl = document.getElementById('bc_count');
    const labelEl = document.getElementById('bc_count_label');
    const bar = document.getElementById('bc_progress_bar');
    const stats = document.getElementById('bc_stats');
    if (!countEl || !labelEl) return;

    if (state.running) {
      stats.style.display = 'grid';
      labelEl.textContent = 'Progress:';
      const done = state.completed.size;
      const fail = state.failed.size;
      const run = state.inFlight.size;
      const queue = state.pending.length;
      const total = Math.max(1, state.totalBatchSize);
      const finished = done + fail;
      const pct = Math.min(100, Math.round((finished / total) * 100));

      countEl.textContent = `${finished} / ${state.totalBatchSize}`;
      if (bar) bar.style.width = pct + '%';
      const wrapEl = document.getElementById('bc_progress_wrap');
      if (wrapEl) wrapEl.setAttribute('aria-valuenow', String(pct));
      document.getElementById('bc_s_done').textContent = String(done);
      document.getElementById('bc_s_run').textContent = String(run);
      document.getElementById('bc_s_queue').textContent = String(queue);
      document.getElementById('bc_s_fail').textContent = String(fail);
      renderNow();
    } else {
      stats.style.display = 'none';
      const visible = document.querySelectorAll('.bulk-cancel-checkbox:checked').length;
      // Queued ids whose tile is not in the DOM at all (Amazon paginates them).
      const hiddenQueued = [...state.queued].filter(
        (id) => !document.querySelector(`.bulk-cancel-checkbox[data-sub-id="${id}"]`)
      ).length;
      const marked = state.completed.size;
      const label = [];
      if (hiddenQueued > 0) label.push(`+${hiddenQueued} queued`);
      if (marked > 0) label.push(`${marked} marked cancelled`);
      labelEl.textContent = label.length ? `Selected (${label.join(', ')}):` : 'Selected:';
      countEl.textContent = String(visible + hiddenQueued);
      if (bar) bar.style.width = '0%';
      const nowEl = document.getElementById('bc_now');
      if (nowEl) {
        nowEl.style.display = 'none';
        nowEl.textContent = '';
      }
    }
  }

  // The "what is happening right now" line: names the items still being worked
  // on and the stage each worker reported.
  function renderNow() {
    const el = document.getElementById('bc_now');
    const wrapEl = document.getElementById('bc_progress_wrap');
    const setBusy = (busy) => {
      if (wrapEl) wrapEl.classList.toggle('bc-busy', !!busy);
    };
    if (!el) return;
    if (!state.running) {
      el.style.display = 'none';
      el.textContent = '';
      setBusy(false);
      return;
    }
    const entries = [...state.inFlight.keys()];
    el.style.display = 'block';
    setBusy(entries.length > 0);
    if (entries.length === 0) {
      el.textContent = state.pending.length > 0 ? 'Starting next item...' : 'Finishing up...';
      return;
    }
    const shown = entries.slice(0, 2).map((id) => {
      const stage = state.current.get(id);
      return stage ? `${shortId(id)}: ${stage}` : `${shortId(id)}: working...`;
    });
    const more = entries.length > 2 ? ` +${entries.length - 2} more` : '';
    el.textContent = `[wait] ${shown.join(' - ')}${more}`;
  }

  function shortId(id) {
    const s = String(id || '');
    return s.length > 14 ? `${s.slice(0, 8)}...${s.slice(-4)}` : s;
  }

  function setCurrent(subId, stage) {
    state.current.set(subId, stage);
    renderNow();
  }

  // --- Selection -------------------------------------------------------------
  function setAll(state2) {
    if (state.running) return;
    document.querySelectorAll('.bulk-cancel-checkbox').forEach((cb) => {
      cb.checked = state2;
      toggleVisuals(cb);
    });
    // Update every visible checkmark in one pass (cheaper than per-item
    // updateProgress calls).
    document.querySelectorAll('.bc-checkmark').forEach((mark) => {
      mark.setAttribute('aria-checked', state2 ? 'true' : 'false');
    });
    // "Clear" must also drop the queued (not-yet-rendered) selections.
    if (!state2) {
      state.queued.clear();
      clearQueued();
    }
    updateProgress();
  }

  function toggleVisuals(checkbox) {
    const card = checkbox.closest(SELECTOR_CARD);
    if (card && !card.classList.contains('bc-success')) {
      if (checkbox.checked) card.classList.add('bc-selected');
      else card.classList.remove('bc-selected');
    }
  }

  // Single place that keeps the hidden input, the visible checkmark's
  // aria-checked state and the card highlight in sync.
  function setCheckboxChecked(checkbox, checked) {
    checkbox.checked = !!checked;
    const mark = checkbox.parentNode && checkbox.parentNode.querySelector('.bc-checkmark');
    if (mark) mark.setAttribute('aria-checked', checked ? 'true' : 'false');
    toggleVisuals(checkbox);
    updateProgress();
  }

  function isChecked(checkbox) {
    return !!checkbox.checked;
  }

  const isLoadMoreUsable = (el) =>
    !!el && el.offsetHeight > 0 && !el.closest('.aok-hidden') && !el.classList.contains('aok-hidden');

  async function loadAllItems() {
    if (state.running) return;
    log('Loading items...');

    // On the hub layout the pagination link is initially hidden behind an
    // `aok-hidden` wrapper until the page's own JS enables it, so give it a
    // moment to appear instead of giving up immediately.
    let trigger = null;
    for (let i = 0; i < 12; i++) {
      const candidate = document.querySelector(SELECTOR_LOAD_MORE);
      if (isLoadMoreUsable(candidate)) {
        trigger = candidate;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!trigger) {
      log('No "Show more subscriptions" control - nothing to expand.', '#777');
      scanCards();
      return;
    }

    let clicks = 0;
    let stalled = 0;
    let lastCount = document.querySelectorAll(SELECTOR_CARD).length;
    while (clicks < 60) {
      const next = document.querySelector(SELECTOR_LOAD_MORE);
      if (!isLoadMoreUsable(next)) break;
      next.click();
      await new Promise((r) => setTimeout(r, 1200));
      clicks++;
      const count = document.querySelectorAll(SELECTOR_CARD).length;
      if (count > lastCount) {
        lastCount = count;
        stalled = 0;
      } else if (++stalled >= 3) {
        log('Pagination stalled - stopping the load loop.', '#ef6c00');
        break;
      }
    }
    log(`Load complete (${lastCount} items).`);
    scanCards();
  }

  // Every subscription id Amazon has published on this page - including ids
  // whose tiles are not in the DOM yet (beyond the paginated first batch).
  // Amazon renders one `copaPageState-<subId>` state block per subscription and
  // keeps `subscriptionId=` links around, which is a far more reliable index
  // than the (previously used) visible-card-only scan.
  function collectPageSubscriptionIds() {
    const ids = new Set();

    document.querySelectorAll('script[data-a-state]').forEach((el) => {
      const key = el.getAttribute('data-a-state') || '';
      // e.g. {"key":"copaPageState-SNST0_141AB550BC4C491F8CFC"}
      const match = key.match(STATE_KEY_RE);
      if (!match) return;
      let id = (match[1] || '').replace(STATE_KEY_TAIL_RE, '');
      if (!SUB_ID_RE.test(id)) return;
      id = id.match(SUB_ID_RE)[0];
      ids.add(id);
    });

    const attrNames = ['data-edit-url', 'data-content', 'data-show-slide-over', 'data-a-modal', 'href'];
    attrNames.forEach((name) => {
      document.querySelectorAll(`[${name}]`).forEach((el) => {
        const value = el.getAttribute(name) || '';
        const match = value.match(SUB_ID_IN_URL_RE) || value.match(SUB_ID_RE);
        if (match) ids.add(match[1] || match[0]);
      });
    });

    return ids;
  }

  // Amazon's `data-edit-url` / `data-a-modal` attributes are HTML-escaped JSON
  // or a URL; either way `subscriptionId=` is what identifies the subscription.
  function extractSubId(card) {
    if (!card) return null;
    const direct = card.getAttribute && card.getAttribute('data-subscription-id');
    if (direct) return direct;

    const attrs = ['data-edit-url', 'data-show-slide-over', 'data-a-modal', 'data-content', 'data-lineitemid'];
    for (const name of attrs) {
      const raw = card.getAttribute && card.getAttribute(name);
      if (!raw) continue;
      const match = raw.match(SUB_ID_IN_URL_RE) || raw.match(SUB_ID_RE);
      if (match) return match[1] || match[0];
    }

    // Legacy markup buried the id inside a modal payload on a child element.
    const holder = card.querySelector('[data-a-modal], [data-edit-url], a[href*="subscriptionId="]');
    const rawChild = holder
      ? holder.getAttribute('data-a-modal') ||
        holder.getAttribute('data-edit-url') ||
        holder.getAttribute('href') ||
        ''
      : '';
    const childMatch = rawChild.match(SUB_ID_IN_URL_RE) || rawChild.match(SUB_ID_RE);
    if (childMatch) return childMatch[1] || childMatch[0];

    // Last resort: anything inside the card mentioning the id.
    const html = card.innerHTML || '';
    const htmlMatch = html.match(SUB_ID_IN_URL_RE) || html.match(SUB_ID_RE);
    return htmlMatch ? htmlMatch[1] || htmlMatch[0] : null;
  }

  function cardTitle(card) {
    const el = card.querySelector(SELECTOR_CARD_TITLE);
    let text = el ? (el.textContent || '').trim() : '';
    if (!text) {
      const img = card.querySelector('img[alt]');
      text = img ? (img.getAttribute('alt') || '').trim() : '';
    }
    return text.replace(/\s+/g, ' ').slice(0, 60) || 'subscription';
  }

  function buildCheckbox(card, subId, checked) {
    const title = cardTitle(card);

    // The wrapper is what the user actually sees/click; the hidden input stays
    // only as the carrier of the subscription id and for querySelectors.
    const wrap = document.createElement('label');
    wrap.className = 'bulk-cancel-checkbox-wrapper';
    wrap.dataset.subId = subId;
    wrap.title = `${title}\nID: ${subId}`;

    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.className = 'bulk-cancel-checkbox';
    inp.dataset.subId = subId;
    inp.checked = !!checked;
    inp.tabIndex = -1;
    inp.setAttribute('aria-hidden', 'true');

    const checkmark = document.createElement('span');
    checkmark.className = 'bc-checkmark';
    checkmark.setAttribute('role', 'checkbox');
    checkmark.setAttribute('aria-checked', checked ? 'true' : 'false');
    checkmark.setAttribute('aria-label', `Select ${title}`);
    checkmark.tabIndex = 0;

    wrap.appendChild(inp);
    wrap.appendChild(checkmark);

    const toggle = () => {
      if (state.running) return;
      // A card that was greyed out from the "already cancelled" cache becomes
      // selectable again the moment the user interacts with it.
      if (state.completed.has(subId)) clearCancelledState(card, subId);
      setCheckboxChecked(inp, checkmark.getAttribute('aria-checked') !== 'true');
    };

    wrap.addEventListener('click', (e) => {
      // Keep Amazon's tile handler (opens the edit sheet) out of the way.
      e.stopPropagation();
      e.preventDefault();
      // Clicks landing on the hidden input came from automation, not a user;
      // ignore them so they can't fight the visible checkmark's state.
      if (e.target === inp) return;
      toggle();
    });
    checkmark.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    });
    return wrap;
  }

  // Clears the "already cancelled" marking and re-arms the card's checkbox.
  // Needed because the 24 h cache can name a subscription that is alive again
  // (re-subscribed, or a cancel that never actually stuck) - previously that
  // state removed the checkbox and made the card permanently unselectable.
  function clearCancelledState(card, subId) {
    if (card) card.classList.remove('bc-success');
    state.completed.delete(subId);
    saveCompleted(state.completed);
    const cb = card
      ? card.querySelector('input.bulk-cancel-checkbox')
      : document.querySelector(`.bulk-cancel-checkbox[data-sub-id="${subId}"]`);
    if (cb) {
      const wrap = cb.closest('.bulk-cancel-checkbox-wrapper');
      if (wrap) {
        wrap.hidden = false;
        wrap.style.display = '';
        wrap.title = `${cardTitle(card || wrap.parentElement)}\nID: ${subId}`;
      }
      cb.disabled = false;
    }
    return cb;
  }

  function scanCards() {
    const cards = document.querySelectorAll(SELECTOR_CARD);
    let added = 0;
    cards.forEach((card) => {
      if (card.querySelector(':scope > .bulk-cancel-checkbox-wrapper')) return;
      const subId = extractSubId(card);
      if (!subId) return;

      const cancelledEarlier = state.completed.has(subId);
      const checked = state.queued.has(subId);
      const wrap = buildCheckbox(card, subId, checked);
      card.insertBefore(wrap, card.firstChild);
      if (cancelledEarlier) {
        // Marked but still selectable: clicking the checkbox re-arms it.
        card.classList.add('bc-success');
        wrap.title = `Marked cancelled (${
          cardTitle(card)
        })\nID: ${subId}\n\nClick to re-arm and cancel again.`;
      }
      if (checked) card.classList.add('bc-selected');
      added++;
    });
    if (added > 0) log(`Found ${added} items.`);
  }

  // Queue subscriptions that are on the page but whose tiles have not been
  // paginated into the DOM yet. They cannot be shown or ticked, so they are
  // queued explicitly and reported in the status log. Running the batch without
  // this button selected only ticked (visible) items.
  function queueAllSubscriptions() {
    if (state.running) return;
    const ids = collectPageSubscriptionIds();
    // "Visible" means the tile exists in the DOM (a checkbox was injected for
    // it). Those are ticked normally; everything else has to be queued blindly.
    const rendered = new Set();
    document.querySelectorAll('.bulk-cancel-checkbox').forEach((cb) => {
      if (cb.dataset.subId) rendered.add(cb.dataset.subId);
    });

    let queued = 0;
    let already = 0;
    ids.forEach((id) => {
      if (state.completed.has(id)) return;
      if (state.queued.has(id)) {
        already++;
        return;
      }
      if (rendered.has(id)) return;
      state.queued.add(id);
      queued++;
    });
    saveQueued(state.queued);

    // Reflect the (possibly new) ids back into any visible tiles.
    scanCards();
    updateProgress();
    if (queued === 0) {
      log(
        already > 0
          ? `All ${already} not-yet-loaded subscription(s) are already queued.`
          : 'Nothing to queue - every subscription on this page is already visible.',
        '#777'
      );
    } else {
      log(
        `Queued ${queued} subscription(s) beyond the ${rendered.size} shown on the page.`,
        '#1565c0',
        true
      );
    }
  }

  // --- Run engine ------------------------------------------------------------
  async function startParallelBatch() {
    if (state.running) return;
    state.runToken++;
    state.failed.clear();
    state.pending = [];
    state.inFlight.clear();
    state.current.clear();
    reportedStages.clear();
    state.stopRequested = false;

    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.safetyTimer) {
      clearTimeout(state.safetyTimer);
      state.safetyTimer = null;
    }
    window.removeEventListener('message', handleMessage);

    const tickedIds = Array.from(document.querySelectorAll('.bulk-cancel-checkbox:checked'))
      .map((cb) => cb.dataset.subId)
      .filter(Boolean);
    const selectedIds = [...new Set([...tickedIds, ...state.queued])].filter(
      (id) => !state.completed.has(id)
    );

    if (selectedIds.length === 0) {
      log('No items selected.', 'orange');
      return;
    }
    if (state.queued.size > 0) {
      log(`Includes ${state.queued.size} queued subscription(s) not visible on this page.`, '#777');
    }

    // Reset persistence so this batch is tracked fresh (but keep prior completes
    // as the source of truth - they'll just be re-recorded as we go).
    state.completed = new Set();
    saveCompleted(state.completed);

    state.running = true;
    document.body.classList.add('bc-running');
    state.totalBatchSize = selectedIds.length;
    state.pending = selectedIds.map((id) => ({ subId: id, attempts: 0 }));
    updateProgress();

    document.querySelectorAll('.bc-btn').forEach((b) => (b.disabled = true));
    const runBtn = document.getElementById('bc_run');
    const stopBtn = document.getElementById('bc_stop');
    runBtn.textContent = 'Processing...';
    runBtn.style.opacity = '0.7';
    stopBtn.style.display = 'block';
    stopBtn.disabled = false;

    log(
      `Starting batch of ${state.totalBatchSize} (parallel: ${prefs.concurrency}, timeout: ${Math.round(
        prefs.timeoutMs / 1000
      )}s, retries: ${prefs.retries})`,
      '#1565c0',
      true
    );
    log('Opening hidden cancel pages... watch the progress line below.', '#777');

    window.addEventListener('message', handleMessage);
    pump();

    // Master safety: roughly enough time for the queue plus a margin
    const safetyMs = Math.min(
      30 * 60 * 1000,
      Math.ceil(state.totalBatchSize / Math.max(1, prefs.concurrency)) *
        (prefs.timeoutMs * (prefs.retries + 1)) +
        SAFETY_MARGIN_MS
    );
    const myToken = state.runToken;
    state.safetyTimer = setTimeout(() => {
      if (!state.running || state.runToken !== myToken) return;
      log('Safety timeout reached. Aborting remaining workers.', 'red');
      requestStop(true);
    }, safetyMs);
  }

  function pump() {
    if (state.stopRequested) return finishIfDone();

    while (state.inFlight.size < prefs.concurrency && state.pending.length > 0) {
      const item = state.pending.shift();
      if (!item) break;
      if (state.completed.has(item.subId) || state.failed.has(item.subId)) continue;
      startWorker(item);
    }
    updateProgress();
    finishIfDone();
  }

  // A worker is only abandoned when it goes quiet, not merely because a fixed
  // clock ran out. Its own progress reports keep resetting the window, up to an
  // absolute cap so a chatty failure can't hang the batch forever.
  // Does the subscription still exist? This is the same evidence the "your
  // subscription has been cancelled" email gives the user, so it settles a
  // cancellation far sooner than any render or redirect heuristic.
  // Returns true (gone), false (still there) or null (could not tell).
  async function fetchSubscriptionStillPresent(subId, signal) {
    try {
      const res = await fetch(window.location.origin + '/auto-deliveries', {
        credentials: 'same-origin',
        signal,
      });
      if (!res.ok) return null;
      const body = await res.text();
      const stuck = /are you sure|captcha|signin/i.test(body.slice(0, 5000));
      if (stuck) return null;
      return body.includes(subId);
    } catch (_e) {
      return null; // aborted, offline, or blocked - treat as "no idea"
    }
  }

  function armWatchdog(subId) {
    const entry = state.inFlight.get(subId);
    if (!entry) return;
    clearTimeout(entry.timer);
    // Verification is the authority after a confirm click. It gets one verdict
    // per attempt; only after that may a silent item be abandoned (or hit the
    // absolute cap), so a stopped page cannot livelock the batch.
    const pendingVerify =
      prefs.verify && entry.submitted && !entry.verifiedThisAttempt;
    const quietMs = entry.submitted ? VERIFY_QUIET_MS : DEFAULT_QUIET_MS;
    const elapsed = Date.now() - entry.startedAt;
    const remainingCap = Math.max(4000, entry.maxMs - elapsed);
    let wait = Math.min(quietMs, remainingCap);
    if (pendingVerify) {
      // Leave enough room for verification to run and answer.
      const sinceSubmit = Date.now() - (entry.submittedAt || Date.now());
      wait = Math.max(wait, Math.min(VERIFY_AFTER_MS + 4000 - sinceSubmit, remainingCap));
    }
    entry.timer = setTimeout(() => {
      if (!state.inFlight.has(subId)) return;
      const fresh = state.inFlight.get(subId);
      const gaveUp = Date.now() - fresh.startedAt >= fresh.maxMs;
      if (!gaveUp && Date.now() - fresh.since < quietMs - 250) {
        armWatchdog(subId); // it moved again while the timer was firing
        return;
      }
      const stage = state.current.get(subId);
      log(`[stuck] ${subId} stuck${stage ? ` while ${stage}` : ''}`, '#c62828');
      finalize(subId, 'timeout', { reason: fresh.submitted ? 'verify-timeout' : 'master-timeout' });
    }, wait);
  }

  function startWorker(item) {
    const { subId } = item;
    const checkbox = document.querySelector(`input[data-sub-id="${subId}"]`);
    const card = checkbox ? checkbox.closest(SELECTOR_CARD) : null;
    if (card) card.classList.add('bc-processing');

    const iframe = document.createElement('iframe');
    iframe.id = 'frame_' + subId;
    // Set the iframe name BEFORE assigning src so the worker content script
    // sees it on first load. The name persists across same-origin navigations
    // within this iframe, so we still recognise the worker after Amazon
    // redirects post-cancel.
    iframe.name = WORKER_NAME_PREFIX + subId;
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.position = 'fixed';
    iframe.style.bottom = '0';
    iframe.style.opacity = '0';
    iframe.style.border = '0';

    if (prefs.diagnostic && state.inFlight.size === 0) {
      iframe.classList.add('bc-diag-frame');
    }

    let loadFailed = false;
    let loadCount = 0;
    let lastLoadHref = '';
    let triedFallback = false;
    const cancelUrls = buildCancelUrlCandidates(subId);
    const tryNextCancelUrl = () => {
      if (triedFallback || state.stopRequested) return;
      const idx = Number(iframe.dataset.bcUrlIndex || '0') + 1;
      if (idx >= cancelUrls.length) return;
      triedFallback = true;
      iframe.dataset.bcUrlIndex = String(idx);
      log(`[retry] ${subId}: trying an alternate cancel URL`, '#ef6c00');
      loadCount = 0;
      iframe.src = cancelUrls[idx];
    };
    iframe.addEventListener('error', () => {
      loadFailed = true;
      log(`[warn] ${subId}: iframe failed to load`, '#c62828');
      finalize(subId, 'error', { reason: 'iframe-error' });
    });

    iframe.addEventListener('load', () => {
      loadCount++;
      let currentHref = '';
      try {
        currentHref = iframe.contentWindow.location.href;
      } catch (_e) {
        if (!loadFailed) {
          loadFailed = true;
          log(`[warn] ${subId}: iframe blocked (cross-origin)`, '#c62828');
          finalize(subId, 'error', { reason: 'iframe-blocked' });
        }
        return;
      }
      if (prefs.diagnostic) {
        log(`-> ${subId} iframe load #${loadCount}: ${stripHost(currentHref)}`, '#777');
      }

      // Bot-check / error interstitial instead of the cancel form: try the next
      // known cancel endpoint rather than burning the whole per-item timeout.
      const isAuthWall = /(signin|ap\/signin|\/ap\/|validateCaptcha|captcha)/i.test(currentHref);
      const isInterstitial = /(errors?\b|something-went-wrong|sorry)/i.test(currentHref);
      if (isAuthWall && currentHref !== lastLoadHref) {
        // Every other cancel URL will hit the same wall: stop and say so.
        lastLoadHref = currentHref;
        log(`[warn] ${subId}: Amazon asked for a sign-in - session looks expired`, '#c62828');
        finalize(subId, 'error', { reason: 'session-expired' });
        return;
      }
      if (isInterstitial && currentHref !== lastLoadHref) {
        lastLoadHref = currentHref;
        tryNextCancelUrl();
        return;
      }
      lastLoadHref = currentHref;

      // === Master-side success detection ===
      // Amazon redirects a successful cancellation to a URL like
      //   /fmc/everyday-essentials-sns?snsActionCompleted=cancelSubscription&cancellationReason=...
      // Our content script doesn't run on /fmc/*, so the worker can't post
      // BULK_DONE - but the master is same-origin and can read the URL here.
      if (SUCCESS_URL_PATTERNS.some((re) => re.test(currentHref))) {
        log(`[ok] ${subId} success (redirect)`, '#2e7d32');
        finalize(subId, 'success', { reason: 'master-redirect' });
        return;
      }

      // Generic fallback: if the iframe navigated AWAY from the cancel form to
      // a URL that no longer contains 'cancelSubscription' and doesn't look
      // like an error/login page, treat it as success after a brief settling
      // delay. Requires that the worker already clicked confirm, otherwise a
      // mere redirect (e.g. a sign-in bounce) would score as a cancellation.
      if (
        (loadCount > 1 || state.inFlight.get(subId)?.submitted) &&
        !/cancelSubscription/i.test(currentHref) &&
        !/(signin|errors?\b|captcha)/i.test(currentHref)
      ) {
        if (prefs.diagnostic) {
          log(`-> ${subId} navigated off form -> assuming success in 1.5s`, '#777');
        }
        const settleToken = state.runToken;
        setTimeout(() => {
          if (state.runToken !== settleToken) return;
          if (!state.inFlight.has(subId)) return;
          let stillHref = '';
          try {
            stillHref = iframe.contentWindow.location.href;
          } catch (_e) {}
          if (stillHref && !/cancelSubscription/i.test(stillHref)) {
            log(`[ok] ${subId} success (off-form)`, '#2e7d32');
            finalize(subId, 'success', { reason: 'master-off-form' });
          }
        }, 1500);
      }
    });

    const verifySchedule = setTimeout(() => {
      const entry = state.inFlight.get(subId);
      if (entry && entry.submitted && prefs.verify) verifyCancellation(subId);
    }, VERIFY_AFTER_MS + 400);

    iframe.src = cancelUrls[0];
    iframe.dataset.bcUrlIndex = '0';
    document.body.appendChild(iframe);

    state.inFlight.set(subId, {
      iframe,
      timer: null,
      verifySchedule,
      verifyAbort: new AbortController(),
      attempts: item.attempts,
      stage: 'starting',
      since: Date.now(),
      startedAt: Date.now(),
      maxMs: prefs.timeoutMs + 15000,
      submitted: false,
      submittedAt: 0,
      verifyTried: false,
      verifiedThisAttempt: false,
    });
    armWatchdog(subId);
    setCurrent(subId, STAGE_LABELS.starting);
    log(item.attempts === 0 ? `> ${subId} starting` : `> ${subId} retry ${item.attempts}`);
    updateProgress();

    // Belt and braces for the laggy case: once the worker has clicked confirm,
    // poll the iframe's own URL. A success redirect is then seen within ~300 ms
    // instead of waiting for another load event that may never fire.
    const watchStartedAt = Date.now();
    const confirmWatch = setInterval(() => {
      const entry = state.inFlight.get(subId);
      if (!entry || Date.now() - watchStartedAt > MAX_WORKER_MS) {
        clearInterval(confirmWatch);
        return;
      }
      if (!entry.submitted || Date.now() - entry.submittedAt < 600) return;
      let href = '';
      try {
        href = iframe.contentWindow.location.href;
      } catch (_e) {
        return;
      }
      if (SUCCESS_URL_PATTERNS.some((re) => re.test(href))) {
        clearInterval(confirmWatch);
        log(`[ok] ${subId} success (redirect, fast)`, '#2e7d32');
        finalize(subId, 'success', { reason: 'master-redirect-fast' });
        return;
      }
      if (
        !/cancelSubscription/i.test(href) &&
        !/(signin|errors?\b|captcha)/i.test(href) &&
        Date.now() - entry.submittedAt > 1500
      ) {
        clearInterval(confirmWatch);
        log(`[ok] ${subId} success (left the form after confirming)`, '#2e7d32');
        finalize(subId, 'success', { reason: 'master-off-form-fast' });
      }
    }, 300);
    state.inFlight.get(subId).confirmWatch = confirmWatch;
  }

  // Runs once per item, a few seconds after the confirm click, when the page
  // itself gave us no verdict. Re-reads the subscription list and treats the
  // item as done if it is no longer listed.
  async function verifyCancellation(subId) {
    const entry = state.inFlight.get(subId);
    if (!entry || entry.verifiedThisAttempt) return;
    entry.verifiedThisAttempt = true;
    log(`[i] ${subId} checking the subscription list...`, '#777');
    const stillPresent = await fetchSubscriptionStillPresent(subId, entry.verifyAbort?.signal);
    const current = state.inFlight.get(subId);
    if (!current) return; // finished or stopped while we were fetching
    if (stillPresent === false) {
      log(`[ok] ${subId} gone from the subscription list`, '#2e7d32');
      finalize(subId, 'success', { reason: 'verified-absent' });
    } else if (stillPresent === true) {
      // The cancellation did not take. Fail now instead of waiting out the
      // timeout - the subscription list is authoritative.
      log(`[FAIL] ${subId} still listed after confirming`, '#c62828');
      finalize(subId, 'timeout', { reason: 'verify-still-listed' });
    } else if (prefs.diagnostic) {
      log(`-> ${subId} verification inconclusive`, '#777');
    }
  }

  function finalize(subId, status, info = {}) {
    const entry = state.inFlight.get(subId);
    if (!entry) return; // already handled
    state.inFlight.delete(subId);
    state.current.delete(subId);

    clearTimeout(entry.timer);
    if (entry.verifySchedule) clearTimeout(entry.verifySchedule);
    if (entry.verifyAbort) {
      try {
        entry.verifyAbort.abort();
      } catch (_e) {}
    }
    if (entry.confirmWatch) clearInterval(entry.confirmWatch);
    if (entry.iframe && entry.iframe.parentNode) entry.iframe.remove();

    const checkbox = document.querySelector(`input[data-sub-id="${subId}"]`);
    const card = checkbox ? checkbox.closest(SELECTOR_CARD) : null;
    if (card) card.classList.remove('bc-processing');

    if (status === 'success') {
      state.completed.add(subId);
      saveCompleted(state.completed);
      if (card) {
        // Keep the checkbox in place: an item marked cancelled must stay
        // re-armable (click it to cancel it again) rather than becoming dead.
        card.classList.add('bc-success');
        card.classList.remove('bc-processing', 'bc-selected');
        const wrap = checkbox ? checkbox.closest('.bulk-cancel-checkbox-wrapper') : null;
        if (wrap) {
          wrap.hidden = false;
          wrap.title = `Cancelled just now\nID: ${subId}\n\nClick to re-arm and cancel again.`;
        }
        if (checkbox) {
          checkbox.checked = false;
          const mark = wrap ? wrap.querySelector('.bc-checkmark') : null;
          if (mark) mark.setAttribute('aria-checked', 'false');
        }
      }
      log(`[ok] ${subId} done`, '#2e7d32');
    } else {
      const nextAttempts = entry.attempts + 1;
      const stage = entry.stage ? ` - was ${STAGE_LABELS[entry.stage] || entry.stage}` : '';
      const pageKind = entry.pageKind && entry.pageKind !== 'unknown' ? `, page: ${entry.pageKind}` : '';
      // "still listed" is a verdict from the subscription list itself: a retry
      // would only repeat the same confirm click, so report it straight away.
      const retryWorthwhile = info.reason !== 'verify-still-listed';
      if (retryWorthwhile && nextAttempts <= prefs.retries && !state.stopRequested) {
        log(`retry ${subId} retrying (${nextAttempts}/${prefs.retries})${stage}`, '#ef6c00');
        state.pending.push({ subId, attempts: nextAttempts });
      } else {
        state.failed.add(subId);
        if (card) card.classList.add('bc-error');
        log(
          `[FAIL] ${subId} failed${info.reason ? ' (' + info.reason + ')' : ''}${stage}${pageKind}`,
          '#c62828'
        );
      }
    }

    updateProgress();
    pump();
  }

  function handleMessage(event) {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || !data.subId) return;

    if (data.type === 'BULK_ALIVE') {
      if (prefs.diagnostic) log(`. ${data.subId} alive @ ${stripHost(data.url)}`, '#777');
      return;
    }

    if (data.type === 'BULK_PROGRESS') {
      const entry = state.inFlight.get(data.subId);
      if (entry) {
        entry.stage = data.stage;
        entry.pageKind = data.note || entry.pageKind;
        entry.since = Date.now(); // heartbeat: this worker is still making progress
        if (data.stage === 'submitting' && !entry.submitted) {
          entry.submitted = true;
          entry.submittedAt = Date.now();
          // Once the click has happened, stop waiting the full per-item time and
          // apply the verification decision point.
          armWatchdog(data.subId);
        }
      }
      // Report each distinct stage once per item so the log stays readable but
      // the panel always shows movement.
      const key = `${data.subId}:${data.stage}:${data.note || ''}`;
      if (!reportedStages.has(key)) {
        reportedStages.add(key);
        const label = STAGE_LABELS[data.stage] || data.stage;
        const detail = data.note && data.note !== label ? ` (${data.note})` : '';
        if (data.stage === 'submitting') {
          log(`[click] ${data.subId} ${label}${detail}`, '#1565c0');
        } else if (data.stage === 'waiting' || data.stage === 'timeout') {
          log(`[wait] ${data.subId} ${label}${detail}`, '#ef6c00');
        } else {
          log(`-> ${data.subId} ${label}${detail}`, '#777');
        }
      }
      setCurrent(data.subId, STAGE_LABELS[data.stage] || data.stage);
      updateProgress();
      return;
    }

    if (data.type === 'BULK_DIAG') {
      if (!prefs.diagnostic) return;
      const parts = [];
      if (data.note && data.note !== 'state') parts.push(`[${data.note}]`);
      if (typeof data.attempts === 'number') parts.push(`a=${data.attempts}`);
      if (typeof data.submitsTried === 'number') parts.push(`s=${data.submitsTried}`);
      parts.push(`drop=${data.hasDropdown ? (data.dropdownValue ? 'Y(' + data.dropdownValue + ')' : 'Y(empty)') : 'n'}`);
      parts.push(`btn=${data.hasConfirmBtn ? data.confirmBtnTag + (data.confirmBtnId ? '#' + data.confirmBtnId : '') : 'n'}`);
      parts.push(`text=${data.textLen}c`);
      parts.push(`url=${stripHost(data.url)}`);
      log(`[diag] ${data.subId} ${parts.join(' ')}`, '#1565c0');
      if (data.textSample) log(`   "${data.textSample}"`, '#888');
      console.log('[BulkCancel] diag', data);
      return;
    }

    if (data.type === 'BULK_DONE') {
      finalize(data.subId, data.status === 'success' ? 'success' : 'timeout', {
        reason: data.reason,
      });
    }
  }

  function stripHost(u) {
    try {
      const p = new URL(u);
      return p.pathname + (p.search ? p.search.slice(0, 60) + (p.search.length > 60 ? '...' : '') : '');
    } catch (_e) {
      return u;
    }
  }

  function finishIfDone() {
    if (state.inFlight.size === 0 && state.pending.length === 0) {
      finishBatch();
    }
  }

  function requestStop(silent) {
    if (!state.running) return;
    state.stopRequested = true;
    if (!silent) log('Stop requested. Cancelling in-flight workers...', '#ef6c00');

    // Drain pending into failed
    state.pending.forEach((item) => state.failed.add(item.subId));
    state.pending = [];

    // Kill in-flight
    [...state.inFlight.entries()].forEach(([subId, entry]) => {
      clearTimeout(entry.timer);
      if (entry.verifySchedule) clearTimeout(entry.verifySchedule);
      if (entry.verifyAbort) {
        try {
          entry.verifyAbort.abort();
        } catch (_e) {}
      }
      if (entry.confirmWatch) clearInterval(entry.confirmWatch);
      if (entry.iframe && entry.iframe.parentNode) entry.iframe.remove();
      state.inFlight.delete(subId);
      state.current.delete(subId);
      state.failed.add(subId);
      const checkbox = document.querySelector(`input[data-sub-id="${subId}"]`);
      const card = checkbox ? checkbox.closest(SELECTOR_CARD) : null;
      if (card) {
        card.classList.remove('bc-processing');
        card.classList.add('bc-error');
      }
    });
    updateProgress();
    finishBatch();
  }

  function hardRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    log('Performing hard refresh...', '#1565c0');
    const url = new URL(window.location.href);
    url.searchParams.set('_bc', Date.now().toString());
    window.location.replace(url.toString());
  }

  function finishBatch() {
    if (!state.running) return;
    state.running = false;
    document.body.classList.remove('bc-running');
    state.current.clear();
    renderNow(); // clears the busy animation and the "in progress" line

    if (state.safetyTimer) {
      clearTimeout(state.safetyTimer);
      state.safetyTimer = null;
    }
    window.removeEventListener('message', handleMessage);
    document.querySelectorAll('iframe[id^="frame_"]').forEach((f) => f.remove());

    const bar = document.getElementById('bc_progress_bar');
    if (bar) {
      const pct =
        state.totalBatchSize === 0
          ? 0
          : Math.round(
              ((state.completed.size + state.failed.size) / state.totalBatchSize) * 100
            );
      bar.style.width = pct + '%';
    }

    const done = state.completed.size;
    const fail = state.failed.size;
    state.queued.clear();
    clearQueued();
    log(
      `Batch complete. Success: ${done} | Failed: ${fail} | Total: ${state.totalBatchSize}`,
      fail > 0 ? '#ef6c00' : '#1565c0',
      true
    );

    const stopBtn = document.getElementById('bc_stop');
    stopBtn.style.display = 'none';

    document.querySelectorAll('.bc-btn').forEach((b) => (b.disabled = false));
    const btn = document.getElementById('bc_run');
    btn.style.opacity = '1';
    btn.style.background = fail > 0 ? '#ef6c00' : '#28a745';
    btn.onclick = hardRefresh;

    let count = 6;
    btn.textContent = `Refreshing in ${count}... (click to skip)`;
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      count--;
      if (count <= 0) {
        btn.textContent = 'Refreshing now...';
        hardRefresh();
      } else {
        btn.textContent = `Refreshing in ${count}... (click to skip)`;
      }
    }, 1000);
  }

  // --- Init ------------------------------------------------------------------
  injectUI();
  scanCards();
  new MutationObserver(() => scanCards()).observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Restore persisted "completed" so previously-cancelled cards get faded
  // instantly on a refresh (anti-zombie).
  if (state.completed.size > 0) {
    log(`Restored ${state.completed.size} previously cancelled item(s) from cache.`, '#777');
  }

  // Power-user debug hook - silent unless someone opens DevTools.
  // Toggle `__bulkCancel.prefs.diagnostic = true` to enable verbose logs.
  try {
    Object.defineProperty(window, '__bulkCancel', {
      value: {
        version: VERSION,
        prefs,
        state,
        clearCompletedCache: clearCompleted,
      },
      configurable: false,
      writable: false,
      enumerable: false,
    });
  } catch (_e) {}
})();
