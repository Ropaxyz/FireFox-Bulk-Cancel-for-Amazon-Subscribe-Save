/*
 * Amazon Bulk Cancel
 * SPDX-License-Identifier: MIT
 *
 * Purpose: User-triggered bulk cancellation helper for Amazon Subscribe & Save.
 * Notes: Runs only on supported Amazon Subscribe & Save pages. No external network requests.
 */

(() => {
  'use strict';

  const IS_IFRAME = window.self !== window.top;
  const SELECTOR_CARD = '.subscription-card-item';
  const SELECTOR_LOAD_MORE = '.subscription-pagination-trigger';
  const CONCURRENCY = 5;

  // --- GLOBALS FOR STATE MANAGEMENT ---
  let isRunning = false;           // Locks UI during execution
  let totalBatchSize = 0;          // For progress counter
  let bcFinished = false;
  let bcRefreshTimer = null;
  let bcSafetyTimer = null;
  let bcRunToken = 0;
  const completedSubs = new Set();
  let pendingIds = [];

  // ========================================================================
  // 🛠️ WORKER MODE (Runs inside hidden iframes)
  // ========================================================================
  if (IS_IFRAME) {
    if (!location.href.includes('cancelSubscription')) return;

    const myId = new URL(location.href).searchParams.get('subscriptionId');
    const targetOrigin = window.location.origin; // Security: Lock to origin
    let attempts = 0;

    const fastPoll = setInterval(() => {
      attempts++;
      const text = document.body.innerText || "";

      // 1. Precise Success Check
      const hasCancelText =
        text.includes('Subscription cancelled') ||
        text.includes('Subscription Canceled') ||
        text.includes('cancelled your subscription') ||
        text.includes('has been cancelled');

      const hasReactivate = /reactivate/i.test(text);

      // "Reactivate" is only success if the Confirm button is GONE.
      const hasConfirmBtn =
        !!document.getElementById('confirmCancelLink') ||
        !!document.querySelector('input[type="submit"][aria-labelledby*="confirmCancel"]');

      if (hasCancelText || (hasReactivate && !hasConfirmBtn)) {
        clearInterval(fastPoll);
        window.top.postMessage({ type: 'BULK_DONE', subId: myId, status: 'success' }, targetOrigin);
        return;
      }

      // 2. Dropdown Survey
      const dropdown = document.getElementById('sns-cancellation-dropdown');
      if (dropdown && dropdown.value === "") {
        let target = dropdown.querySelector('option[value*="expensive"]') || dropdown.options[1];
        if (target) {
          dropdown.value = target.value;
          dropdown.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // 3. Click Confirm Button
      let btn = null;
      const confirmContainer = document.getElementById('confirmCancelLink');
      if (confirmContainer) btn = confirmContainer.querySelector('input[type="submit"]');
      if (!btn) btn = document.querySelector('input[type="submit"][aria-labelledby*="confirmCancel"]');
      if (!btn && !dropdown) btn = document.querySelector('input[type="submit"]');
      if (btn) btn.click();

      // 4. Timeout (15s max)
      if (attempts > 150) {
        clearInterval(fastPoll);
        window.top.postMessage({ type: 'BULK_DONE', subId: myId, status: 'timeout' }, targetOrigin);
      }
    }, 100);

    return;
  }

  // ========================================================================
  // 👑 MASTER MODE
  // ========================================================================

  const existing = document.getElementById('bulkCancelUI');
  if (existing) existing.remove();

  console.log(`[BulkMaster v25.3] Ready.`);

  // --- STYLES ---
  const style = document.createElement('style');
  style.innerHTML = `
    #bulkCancelUI {
      position: fixed; top: 80px; right: 20px; z-index: 2147483647;
      background: #fff; border: 1px solid #ccc; border-radius: 8px;
      box-shadow: 0 4px 15px rgba(0,0,0,0.2); width: 260px;
      font-family: "Amazon Ember", Arial, sans-serif;
      overflow: hidden;
    }
    #bc_header {
      background: #232F3E; color: white; padding: 10px; cursor: move;
      font-weight: bold; font-size: 14px; user-select: none;
      display: flex; justify-content: space-between; align-items: center;
    }
    #bc_body { padding: 12px; }
    .bc-btn {
      width: 100%; padding: 8px; margin-bottom: 8px; cursor: pointer;
      border-radius: 4px; border: 1px solid #D5D9D9; background: #F0F2F2;
      font-size: 12px; transition: 0.2s;
    }
    .bc-btn:hover { background: #E3E6E6; }
    .bc-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
    .bc-btn-primary {
      background: #D01E28; color: white; border: none; font-weight: bold;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    }
    .bc-btn-primary:hover { background: #B61B22; }
    .bc-btn-group { display: flex; gap: 8px; margin-bottom: 8px; }
    #bc_status_box {
      background: #F8F8F8; border: 1px solid #EEE; padding: 8px;
      border-radius: 4px; font-size: 11px; color: #555;
      max-height: 100px; overflow-y: auto; margin-top: 8px;
    }
    /* CHECKBOXES */
    .bulk-cancel-checkbox-wrapper {
      position: absolute; top: 10px; left: 10px; z-index: 9000; cursor: pointer;
    }
    .bulk-cancel-checkbox { display: none; }
    .bc-checkmark {
      width: 24px; height: 24px; background-color: #fff; border: 2px solid #888;
      border-radius: 4px; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2); transition: all 0.2s;
    }
    .bc-checkmark::after {
      content: ''; display: none; width: 6px; height: 12px; border: solid white;
      border-width: 0 3px 3px 0; transform: rotate(45deg) translate(-1px, -1px);
    }
    .bulk-cancel-checkbox-wrapper:hover .bc-checkmark { border-color: #D01E28; transform: scale(1.1); }
    .bulk-cancel-checkbox:checked + .bc-checkmark { background-color: #D01E28; border-color: #D01E28; }
    .bulk-cancel-checkbox:checked + .bc-checkmark::after { display: block; }

    /* RUNNING STATE LOCKS */
    /* Note: #bc_run is excluded so it can be clicked for refresh */
    body.bc-running .bulk-cancel-checkbox-wrapper { cursor: not-allowed; opacity: 0.6; pointer-events: none; }
    body.bc-running .bc-btn:not(#bc_run) { opacity: 0.5; pointer-events: none; }

    ${SELECTOR_CARD} { position: relative !important; transition: opacity 0.2s; }
    ${SELECTOR_CARD}.bc-selected { box-shadow: 0 0 0 3px #D01E28 inset !important; background-color: #fff8f8 !important; }
    ${SELECTOR_CARD}.bc-processing { opacity: 0.6; pointer-events: none; }
    ${SELECTOR_CARD}.bc-success { opacity: 0.3; pointer-events: none; filter: grayscale(100%); }
    ${SELECTOR_CARD}.bc-error { box-shadow: 0 0 0 3px red inset !important; }
  `;
  document.head.appendChild(style);

  // --- UI INJECTION ---
  function injectUI() {
    const panel = document.createElement('div');
    panel.id = 'bulkCancelUI';
    panel.innerHTML = `
      <div id="bc_header">
        <span>Bulk Cancel v25.3</span>
        <span style="font-size:10px; opacity:0.7;">✛ Drag</span>
      </div>
      <div id="bc_body">
        <button id="bc_load" class="bc-btn">⬇️ Load All Items</button>
        <div class="bc-btn-group">
          <button id="bc_all" class="bc-btn">Select All</button>
          <button id="bc_none" class="bc-btn">None</button>
        </div>
        <div style="font-size:13px; text-align:center; margin-bottom:5px;">
          <span id="bc_count_label">Selected:</span>
          <strong id="bc_count" style="color:#D01E28;">0</strong>
        </div>

        <!-- PROGRESS BAR -->
        <div style="margin:5px 0 10px;">
          <div id="bc_progress_wrap" style="height:6px; background:#e7e7e7; border-radius:4px; overflow:hidden;">
            <div id="bc_progress_bar" style="height:100%; width:0%; background:#D01E28; transition: width 0.3s;"></div>
          </div>
        </div>

        <button id="bc_run" class="bc-btn bc-btn-primary">CANCEL SELECTED</button>
        <div id="bc_status_box">Ready.</div>
      </div>
    `;
    document.body.appendChild(panel);
    setupDrag(panel);

    document.getElementById('bc_load').onclick = loadAllItems;
    document.getElementById('bc_all').onclick = () => setAll(true);
    document.getElementById('bc_none').onclick = () => setAll(false);
    document.getElementById('bc_run').onclick = startParallelBatch;
  }

  function setupDrag(panel) {
    const header = document.getElementById('bc_header');
    let isDragging = false, startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      initialLeft = rect.left; initialTop = rect.top;
      panel.style.right = 'auto';
      panel.style.left = initialLeft + 'px';
      panel.style.top = initialTop + 'px';
      header.style.cursor = 'grabbing';
    });

    const onMove = (e) => {
      if (!isDragging) return;
      panel.style.left = `${initialLeft + (e.clientX - startX)}px`;
      panel.style.top = `${initialTop + (e.clientY - startY)}px`;
    };

    const onUp = () => {
      isDragging = false;
      header.style.cursor = 'move';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function log(msg, color = '#333') {
    const el = document.getElementById('bc_status_box');
    if (el) el.innerHTML = `<div style="color:${color}; margin-bottom:2px;">${msg}</div>` + el.innerHTML;
    console.log(`[BulkMaster] ${msg}`);
  }

  function updateCount() {
    const el = document.getElementById('bc_count');
    const label = document.getElementById('bc_count_label');
    const bar = document.getElementById('bc_progress_bar');
    if (!el || !label) return;

    if (isRunning) {
      const done = completedSubs.size;
      const total = Math.max(1, totalBatchSize);
      const pct = Math.min(100, Math.round((done / total) * 100));

      label.innerText = "Progress:";
      el.innerText = `${done} / ${total}`;
      if (bar) bar.style.width = pct + "%";
    } else {
      label.innerText = "Selected:";
      el.innerText = document.querySelectorAll('.bulk-cancel-checkbox:checked').length;
      if (bar) bar.style.width = "0%";
    }
  }

  function setAll(state) {
    if (isRunning) return;
    document.querySelectorAll('.bulk-cancel-checkbox').forEach(cb => {
      cb.checked = state;
      toggleVisuals(cb);
    });
    updateCount();
  }

  function toggleVisuals(checkbox) {
    const card = checkbox.closest(SELECTOR_CARD);
    if (card && !card.classList.contains('bc-success')) {
      if (checkbox.checked) card.classList.add('bc-selected');
      else card.classList.remove('bc-selected');
    }
  }

  async function loadAllItems() {
    if (isRunning) return;
    log("Loading items...");
    let clicks = 0;
    while (clicks < 50) {
      const trigger = document.querySelector(SELECTOR_LOAD_MORE);
      if (!trigger || trigger.closest('.aok-hidden') || trigger.offsetHeight === 0) break;
      trigger.click();
      await new Promise(r => setTimeout(r, 1000));
      clicks++;
    }
    log("Load complete.");
    scanCards();
  }

  function scanCards() {
    const cards = document.querySelectorAll(SELECTOR_CARD);
    let added = 0;
    cards.forEach(card => {
      if (card.querySelector('.bulk-cancel-checkbox-wrapper')) return;
      let subId = card.getAttribute('data-subscription-id');
      if (!subId) {
        try {
          const json = card.querySelector('[data-a-modal]').getAttribute('data-a-modal');
          const match = json.match(/subscriptionId=([^&"]+)/);
          if (match) subId = match[1];
        } catch (e) {}
      }
      if (!subId) return;

      // Anti-Zombie
      if (completedSubs.has(subId)) {
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

      // CLICK HANDLER WITH LOCK
      wrap.onclick = (e) => {
        e.stopPropagation();
        if (isRunning) return; // 🔒 LOCKED DURING RUN
        if (e.target !== inp) inp.checked = !inp.checked;
        toggleVisuals(inp);
        updateCount();
      };
      card.insertBefore(wrap, card.firstChild);
      added++;
    });
    if (added > 0) log(`Found ${added} items.`);
  }

  // --- PARALLEL ENGINE ---
  let activeWorkers = 0;
  let successTotal = 0;

  async function startParallelBatch() {
    bcFinished = false;
    completedSubs.clear();
    bcRunToken++;

    if (bcRefreshTimer) { clearInterval(bcRefreshTimer); bcRefreshTimer = null; }
    if (bcSafetyTimer) { clearTimeout(bcSafetyTimer); bcSafetyTimer = null; }

    window.removeEventListener('message', handleMessage);

    // 1. BUILD ID QUEUE & DEDUPE
    let selectedIds = Array.from(document.querySelectorAll('.bulk-cancel-checkbox:checked'))
      .map(cb => cb.dataset.subId)
      .filter(Boolean);

    selectedIds = [...new Set(selectedIds)];

    if (selectedIds.length === 0) {
      log("Selecting ALL...", "orange");
      setAll(true);
      selectedIds = Array.from(document.querySelectorAll('.bulk-cancel-checkbox:checked'))
        .map(cb => cb.dataset.subId)
        .filter(Boolean);

      selectedIds = [...new Set(selectedIds)];

      if (selectedIds.length === 0) return log("No items found.", "red");
    }

    // 2. LOCK UI & SET STATE
    isRunning = true;
    document.body.classList.add('bc-running');
    totalBatchSize = selectedIds.length;
    updateCount();

    // Disable all buttons (bc_run gets re-enabled in finishBatch)
    document.querySelectorAll('.bc-btn').forEach(b => b.disabled = true);
    const btn = document.getElementById('bc_run');
    btn.innerText = "Processing...";
    btn.style.opacity = "0.7";

    pendingIds = selectedIds;
    activeWorkers = 0;
    successTotal = 0;

    window.addEventListener('message', handleMessage);
    processNext();

    // --- SAFETY VALVE ---
    const myToken = bcRunToken;
    bcSafetyTimer = setTimeout(() => {
      if (bcFinished) return;
      if (bcRunToken !== myToken) return;
      log("Safety timeout (120s) reached.", "red");
      finishBatch();
    }, 120000);
  }

  function processNext() {
    while (activeWorkers < CONCURRENCY && pendingIds.length > 0) {
      const subId = pendingIds.shift();
      if (!subId) continue;

      const checkbox = document.querySelector(`input[data-sub-id="${subId}"]`);
      const card = checkbox ? checkbox.closest(SELECTOR_CARD) : null;
      if (card) card.classList.add('bc-processing');

      createWorkerFrame(subId);
      activeWorkers++;
      log(`Starting ${subId}...`);
      updateCount();
    }

    if (activeWorkers === 0 && pendingIds.length === 0) {
      finishBatch();
    }
  }

  function createWorkerFrame(subId) {
    const iframe = document.createElement('iframe');
    iframe.id = 'frame_' + subId;
    iframe.style.width = '1px'; iframe.style.height = '1px';
    iframe.style.position = 'fixed'; iframe.style.bottom = '0';
    iframe.style.opacity = '0';
    iframe.src = `${window.location.origin}/auto-deliveries/cancelSubscription?subscriptionId=${subId}`;
    document.body.appendChild(iframe);
  }

  function handleMessage(event) {
    if (event.origin !== window.location.origin) return;
    const data = event.data;

    if (data.type === 'BULK_DONE') {
      const subId = data.subId;
      const status = data.status;

      if (completedSubs.has(subId)) return;
      completedSubs.add(subId);

      if (status === 'success') {
        successTotal++;
        log(`✅ ${subId} Done`, 'green');
      } else {
        log(`❌ ${subId} Timeout`, 'red');
      }

      const checkbox = document.querySelector(`input[data-sub-id="${subId}"]`);
      if (checkbox) {
        const card = checkbox.closest(SELECTOR_CARD);
        if (card) {
          card.classList.remove('bc-processing');
          if (status === 'success') {
            const wrap = checkbox.closest('.bulk-cancel-checkbox-wrapper');
            if (wrap) wrap.remove();
            card.classList.add('bc-success');
          } else {
            card.classList.add('bc-error');
          }
        }
      }

      const frame = document.getElementById('frame_' + subId);
      if (frame) frame.remove();

      activeWorkers--;
      updateCount();
      processNext();
    }
  }

  function hardRefresh() {
    if (bcRefreshTimer) {
      clearInterval(bcRefreshTimer);
      bcRefreshTimer = null;
    }
    log("Performing Hard Refresh...", "blue");
    const url = new URL(window.location.href);
    url.searchParams.set('_bc', Date.now().toString());
    window.location.replace(url.toString());
  }

  function finishBatch() {
    if (bcFinished) return;
    bcFinished = true;

    if (bcSafetyTimer) { clearTimeout(bcSafetyTimer); bcSafetyTimer = null; }
    window.removeEventListener('message', handleMessage);
    document.querySelectorAll('iframe[id^="frame_"]').forEach(f => f.remove());

    const bar = document.getElementById('bc_progress_bar');
    const countEl = document.getElementById('bc_count');
    if (bar) bar.style.width = "100%";
    if (countEl) countEl.innerText = `${totalBatchSize} / ${totalBatchSize}`;

    const btn = document.getElementById('bc_run');
    log(`<b>Batch Complete. Success: ${successTotal}</b>`, "blue");

    btn.disabled = false;
    btn.style.opacity = "1";
    btn.style.background = "#28a745";
    btn.onclick = () => hardRefresh();

    let count = 6;
    btn.innerText = `Refreshing in ${count}... (Click to Skip)`;

    if (bcRefreshTimer) clearInterval(bcRefreshTimer);

    bcRefreshTimer = setInterval(() => {
      count--;
      if (count <= 0) {
        btn.innerText = "Refreshing Now...";
        hardRefresh();
      } else {
        btn.innerText = `Refreshing in ${count}... (Click to Skip)`;
      }
    }, 1000);
  }

  // --- INIT ---
  injectUI();
  scanCards();
  new MutationObserver(() => scanCards()).observe(document.body, { childList: true, subtree: true });
})();
