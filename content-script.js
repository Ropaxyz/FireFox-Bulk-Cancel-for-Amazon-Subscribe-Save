/*
 * Amazon Bulk Cancel
 * SPDX-License-Identifier: MIT
 *
 * Purpose: User-triggered bulk cancellation helper for Amazon Subscribe & Save.
 * Notes: Runs only on supported Amazon Subscribe & Save pages. No external network requests.
 */

(() => {
  'use strict';

  const VERSION = '25.5.0';
  const WORKER_NAME_PREFIX = 'BC_';

  // Success URL patterns Amazon redirects to after a successful cancel.
  // The strongest signal is `snsActionCompleted=cancelSubscription`.
  const SUCCESS_URL_PATTERNS = [
    /snsActionCompleted=cancelSubscription/i,
    /[?&]cancellationReason=/i, // present on the redirect target as well
  ];
  const IS_IFRAME = window.self !== window.top;
  const SELECTOR_CARD = '.subscription-card-item';
  const SELECTOR_LOAD_MORE = '.subscription-pagination-trigger';

  // Defaults (user can override via the panel)
  const DEFAULT_CONCURRENCY = 3;
  const DEFAULT_WORKER_TIMEOUT_MS = 25000;
  const DEFAULT_MAX_RETRIES = 1;
  const POLL_INTERVAL_MS = 100;
  const SAFETY_MARGIN_MS = 30000; // master safety = perWorker*total + this, capped

  const LS_PREFS = 'bc_prefs_v25_4';
  const LS_COMPLETED = 'bc_completed_v25_4'; // { origin, ts, ids: [] }
  const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;

  // ========================================================================
  // 🛠️ WORKER MODE (runs inside hidden iframe on the cancellation page)
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
      /abonnement\s+gek(ü|u)ndigt/i,
      /wurde\s+gek(ü|u)ndigt/i,
      /no\s+longer\s+subscribed/i,
    ];

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
        document.querySelector('button[id*="confirm" i]') ||
        document.querySelector('button[data-action*="confirm" i]') ||
        document.querySelector('span[id*="confirmCancel" i] input[type="submit"]') ||
        document.querySelector('span[id*="confirmCancel" i] button') ||
        null
      );
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
    const maxAttempts = Math.ceil(60000 / POLL_INTERVAL_MS); // worker self-cap 60s

    const trySubmit = (btn) => {
      if (!btn) return false;
      submitsTried++;
      // 1) Bare .click() — works for most Amazon submit inputs
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

    // Send an initial snapshot once the DOM is ready enough
    const initialSnap = setTimeout(() => sendSnapshot('initial'), 500);

    const fastPoll = setInterval(() => {
      attempts++;

      // Track URL changes (post-submit navigation)
      if (location.href !== firstUrl && urlChangedAt === 0) {
        urlChangedAt = Date.now();
        sendSnapshot('navigated');
      }

      const text = document.body ? document.body.innerText || '' : '';
      const hasReactivate = /reactivate|reaktivieren/i.test(text);
      const confirmBtn = findConfirmButton();

      if (isSuccess(text)) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        if (verbose) wlog('SUCCESS via text');
        sendSnapshot('success-text');
        post({ type: 'BULK_DONE', subId: myId, status: 'success' });
        return;
      }
      if (hasReactivate && !confirmBtn) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        if (verbose) wlog('SUCCESS via reactivate marker');
        sendSnapshot('success-reactivate');
        post({ type: 'BULK_DONE', subId: myId, status: 'success' });
        return;
      }
      if (looksLikeRedirectSuccess()) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        if (verbose) wlog('SUCCESS via redirect heuristic', location.href);
        sendSnapshot('success-redirect');
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
        // Only attempt submit a handful of times to avoid event spam — Amazon
        // sometimes ignores rapid duplicate clicks.
        if (submitsTried < 6) trySubmit(confirmBtn);
      }

      // Periodic snapshot: every 1s when verbose, every 2s otherwise (forced)
      if (attempts % (verbose ? 10 : 20) === 0) sendSnapshot('tick');

      if (attempts >= maxAttempts) {
        clearInterval(fastPoll);
        clearTimeout(initialSnap);
        sendSnapshot('timeout');
        post({ type: 'BULK_DONE', subId: myId, status: 'timeout', reason: 'worker-timeout' });
      }
    }, POLL_INTERVAL_MS);

    return;
  }

  // ========================================================================
  // 👑 MASTER MODE
  // ========================================================================

  const existing = document.getElementById('bulkCancelUI');
  if (existing) existing.remove();

  // Silent by default — set window.__bulkCancel.prefs.diagnostic = true in
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
      diagnostic: false,
    },
    loadPrefs() || {}
  );

  const state = {
    running: false,
    stopRequested: false,
    runToken: 0,
    pending: [], // queue of subId
    inFlight: new Map(), // subId -> { iframe, timer, attempts }
    completed: loadCompleted(), // Set<subId>
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
    }
    .bulk-cancel-checkbox { display: none; }
    .bc-checkmark {
      width: 24px; height: 24px; background-color: #fff; border: 2px solid #888;
      border-radius: 4px; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2); transition: all 0.15s;
    }
    .bc-checkmark::after {
      content: ''; display: none; width: 6px; height: 12px; border: solid white;
      border-width: 0 3px 3px 0; transform: rotate(45deg) translate(-1px, -1px);
    }
    .bulk-cancel-checkbox-wrapper:hover .bc-checkmark { border-color: #D01E28; transform: scale(1.08); }
    .bulk-cancel-checkbox:checked + .bc-checkmark { background-color: #D01E28; border-color: #D01E28; }
    .bulk-cancel-checkbox:checked + .bc-checkmark::after { display: block; }

    body.bc-running .bulk-cancel-checkbox-wrapper { cursor: not-allowed; opacity: 0.6; pointer-events: none; }
    body.bc-running .bc-btn:not(#bc_run):not(#bc_stop) { opacity: 0.5; pointer-events: none; }

    ${SELECTOR_CARD} { position: relative !important; transition: opacity 0.2s; }
    ${SELECTOR_CARD}.bc-selected { box-shadow: 0 0 0 3px #D01E28 inset !important; background-color: #fff8f8 !important; }
    ${SELECTOR_CARD}.bc-processing { opacity: 0.6; pointer-events: none; }
    ${SELECTOR_CARD}.bc-success { opacity: 0.3; pointer-events: none; filter: grayscale(100%); }
    ${SELECTOR_CARD}.bc-error { box-shadow: 0 0 0 3px #c62828 inset !important; }

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
        <div class="bc-btn-group">
          <button id="bc_all" class="bc-btn" type="button">Select all</button>
          <button id="bc_none" class="bc-btn" type="button">Clear</button>
        </div>

        <div id="bc_settings" aria-label="Settings">
          <div id="bc_settings_head" role="button" tabindex="0" aria-expanded="false" aria-controls="bc_settings_body">
            <span>Settings</span>
            <span><span class="bc-chev">›</span></span>
          </div>
          <div id="bc_settings_body">
            <div class="bc-row">
              <label for="bc_concurrency" title="How many cancellations to run in parallel. Lower is gentler on Amazon's rate limits.">Parallel</label>
              <input id="bc_concurrency" type="range" min="1" max="8" step="1" aria-label="Parallel cancellations" />
              <span class="bc-val" id="bc_concurrency_val" aria-live="polite"></span>
            </div>
            <div class="bc-row">
              <label for="bc_timeout" title="Maximum seconds to wait for one cancellation to finish before retrying or giving up.">Timeout</label>
              <input id="bc_timeout" type="range" min="10" max="60" step="5" aria-label="Per-item timeout in seconds" />
              <span class="bc-val" id="bc_timeout_val" aria-live="polite"></span>
            </div>
            <div class="bc-row">
              <label for="bc_retries" title="How many times to retry a failed cancellation before marking it failed.">Retries</label>
              <input id="bc_retries" type="range" min="0" max="3" step="1" aria-label="Retry attempts" />
              <span class="bc-val" id="bc_retries_val" aria-live="polite"></span>
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

        <button id="bc_run" class="bc-btn bc-btn-primary" type="button">Cancel selected</button>
        <button id="bc_stop" class="bc-btn bc-btn-stop" type="button" style="display:none;">Stop</button>
        <div id="bc_status_box" role="log" aria-live="polite">Ready.</div>
      </div>
    `;
    document.body.appendChild(panel);
    setupDrag(panel);

    document.getElementById('bc_load').onclick = loadAllItems;
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
      document.getElementById('bc_s_done').textContent = String(done);
      document.getElementById('bc_s_run').textContent = String(run);
      document.getElementById('bc_s_queue').textContent = String(queue);
      document.getElementById('bc_s_fail').textContent = String(fail);
    } else {
      stats.style.display = 'none';
      labelEl.textContent = 'Selected:';
      countEl.textContent = String(
        document.querySelectorAll('.bulk-cancel-checkbox:checked').length
      );
      if (bar) bar.style.width = '0%';
    }
  }

  // --- Selection -------------------------------------------------------------
  function setAll(state2) {
    if (state.running) return;
    document.querySelectorAll('.bulk-cancel-checkbox').forEach((cb) => {
      cb.checked = state2;
      toggleVisuals(cb);
    });
    updateProgress();
  }

  function toggleVisuals(checkbox) {
    const card = checkbox.closest(SELECTOR_CARD);
    if (card && !card.classList.contains('bc-success')) {
      if (checkbox.checked) card.classList.add('bc-selected');
      else card.classList.remove('bc-selected');
    }
  }

  async function loadAllItems() {
    if (state.running) return;
    log('Loading items...');
    let clicks = 0;
    while (clicks < 50) {
      const trigger = document.querySelector(SELECTOR_LOAD_MORE);
      if (!trigger || trigger.closest('.aok-hidden') || trigger.offsetHeight === 0) break;
      trigger.click();
      await new Promise((r) => setTimeout(r, 1000));
      clicks++;
    }
    log('Load complete.');
    scanCards();
  }

  function scanCards() {
    const cards = document.querySelectorAll(SELECTOR_CARD);
    let added = 0;
    cards.forEach((card) => {
      if (card.querySelector('.bulk-cancel-checkbox-wrapper')) return;
      let subId = card.getAttribute('data-subscription-id');
      if (!subId) {
        try {
          const json = card.querySelector('[data-a-modal]').getAttribute('data-a-modal');
          const match = json.match(/subscriptionId=([^&"]+)/);
          if (match) subId = match[1];
        } catch (_e) {
          /* ignore */
        }
      }
      if (!subId) return;

      if (state.completed.has(subId)) {
        card.classList.add('bc-success');
        return;
      }

      const wrap = document.createElement('div');
      wrap.className = 'bulk-cancel-checkbox-wrapper';
      wrap.title = `ID: ${subId}`;
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.className = 'bulk-cancel-checkbox';
      inp.dataset.subId = subId;
      const checkmark = document.createElement('div');
      checkmark.className = 'bc-checkmark';
      wrap.appendChild(inp);
      wrap.appendChild(checkmark);

      wrap.onclick = (e) => {
        e.stopPropagation();
        if (state.running) return;
        if (e.target !== inp) inp.checked = !inp.checked;
        toggleVisuals(inp);
        updateProgress();
      };
      card.insertBefore(wrap, card.firstChild);
      added++;
    });
    if (added > 0) log(`Found ${added} items.`);
  }

  // --- Run engine ------------------------------------------------------------
  async function startParallelBatch() {
    if (state.running) return;
    state.runToken++;
    state.failed.clear();
    state.pending = [];
    state.inFlight.clear();
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

    let selectedIds = Array.from(document.querySelectorAll('.bulk-cancel-checkbox:checked'))
      .map((cb) => cb.dataset.subId)
      .filter(Boolean);
    selectedIds = [...new Set(selectedIds)];

    if (selectedIds.length === 0) {
      log('No items selected.', 'orange');
      return;
    }

    // Reset persistence so this batch is tracked fresh (but keep prior completes
    // as the source of truth — they'll just be re-recorded as we go).
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
    iframe.addEventListener('error', () => {
      loadFailed = true;
      log(`⚠️ ${subId}: iframe failed to load`, '#c62828');
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
          log(`⚠️ ${subId}: iframe blocked (cross-origin)`, '#c62828');
          finalize(subId, 'error', { reason: 'iframe-blocked' });
        }
        return;
      }
      if (prefs.diagnostic) {
        log(`↪ ${subId} iframe load #${loadCount}: ${stripHost(currentHref)}`, '#777');
      }

      // === Master-side success detection ===
      // Amazon redirects a successful cancellation to a URL like
      //   /fmc/everyday-essentials-sns?snsActionCompleted=cancelSubscription&cancellationReason=...
      // Our content script doesn't run on /fmc/*, so the worker can't post
      // BULK_DONE — but the master is same-origin and can read the URL here.
      if (SUCCESS_URL_PATTERNS.some((re) => re.test(currentHref))) {
        log(`✅ ${subId} success (redirect)`, '#2e7d32');
        finalize(subId, 'success', { reason: 'master-redirect' });
        return;
      }

      // Generic fallback: if the iframe navigated AWAY from the cancel form
      // (load #2+) to a URL that no longer contains 'cancelSubscription' and
      // doesn't look like an error/login page, treat it as success after a
      // brief settling delay. This catches future URL variations.
      if (
        loadCount > 1 &&
        !/cancelSubscription/i.test(currentHref) &&
        !/(signin|errors?\b|captcha)/i.test(currentHref)
      ) {
        if (prefs.diagnostic) {
          log(`↪ ${subId} navigated off form → assuming success in 1.5s`, '#777');
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
            log(`✅ ${subId} success (off-form)`, '#2e7d32');
            finalize(subId, 'success', { reason: 'master-off-form' });
          }
        }, 1500);
      }
    });

    const params = new URLSearchParams({
      subscriptionId: subId,
      sourcePage: 'subscriptionList',
      deviceType: 'desktop',
      deviceContext: 'web',
    });
    if (prefs.diagnostic) params.set('_bcDiag', '1');
    iframe.src = `${window.location.origin}/auto-deliveries/cancelSubscription?${params.toString()}`;
    document.body.appendChild(iframe);

    const timer = setTimeout(() => {
      log(`⏱️ ${subId} timeout`, '#c62828');
      finalize(subId, 'timeout', { reason: 'master-timeout' });
    }, prefs.timeoutMs);

    state.inFlight.set(subId, { iframe, timer, attempts: item.attempts });
    log(item.attempts === 0 ? `▶ ${subId} starting` : `▶ ${subId} retry ${item.attempts}`);
  }

  function finalize(subId, status, info = {}) {
    const entry = state.inFlight.get(subId);
    if (!entry) return; // already handled
    state.inFlight.delete(subId);

    clearTimeout(entry.timer);
    if (entry.iframe && entry.iframe.parentNode) entry.iframe.remove();

    const checkbox = document.querySelector(`input[data-sub-id="${subId}"]`);
    const card = checkbox ? checkbox.closest(SELECTOR_CARD) : null;
    if (card) card.classList.remove('bc-processing');

    if (status === 'success') {
      state.completed.add(subId);
      saveCompleted(state.completed);
      if (card) {
        const wrap = checkbox ? checkbox.closest('.bulk-cancel-checkbox-wrapper') : null;
        if (wrap) wrap.remove();
        card.classList.add('bc-success');
      }
      log(`✅ ${subId} done`, '#2e7d32');
    } else {
      const nextAttempts = entry.attempts + 1;
      if (nextAttempts <= prefs.retries && !state.stopRequested) {
        log(`↻ ${subId} retrying (${nextAttempts}/${prefs.retries})`, '#ef6c00');
        state.pending.push({ subId, attempts: nextAttempts });
      } else {
        state.failed.add(subId);
        if (card) card.classList.add('bc-error');
        log(
          `❌ ${subId} failed${info.reason ? ' (' + info.reason + ')' : ''}`,
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
      if (prefs.diagnostic) log(`▷ ${data.subId} alive @ ${stripHost(data.url)}`, '#777');
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
      log(`🔎 ${data.subId} ${parts.join(' ')}`, '#1565c0');
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
      return p.pathname + (p.search ? p.search.slice(0, 60) + (p.search.length > 60 ? '…' : '') : '');
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
      if (entry.iframe && entry.iframe.parentNode) entry.iframe.remove();
      state.inFlight.delete(subId);
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
    log(
      `Batch complete. Success: ${done} • Failed: ${fail} • Total: ${state.totalBatchSize}`,
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

  // Power-user debug hook — silent unless someone opens DevTools.
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
