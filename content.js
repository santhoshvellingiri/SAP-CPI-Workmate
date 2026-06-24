/**
 * SAP CPI Workmate — content.js
 *
 * Injects a "View Data" button next to the "Filter by ID" search box on
 * the SAP Integration Suite  ▸ Monitor ▸ Data Stores and JMS Queue pages.
 *
 * Works generically on any *.hana.ondemand.com tenant (CF /shell/... and
 * Neo /itspaces/shell/... landscapes).
 *
 * Depends on: jszip.min.js  (loaded before this file via manifest.json)
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
   * Constants
   * ───────────────────────────────────────────────────────────────────────── */
  // ── Data Stores ──────────────────────────────────────────────────────────
  const BTN_ID     = 'sap-ds-view-btn';
  const OVERLAY_ID = 'sap-ds-overlay';

  // POST endpoint (path only — host is read from window.location at runtime)
  const API_PATH =
    '/Operations/com.sap.esb.monitoring.datastore.access.command' +
    '.GetDataStorePayloadCommand';

  // ── JMS Message Queues ───────────────────────────────────────────────────
  const JMS_BTN_ID   = 'sap-jms-view-btn';
  const JMS_API_PATH = '/odata/api/v1/JmsMessages';

  // ── Message Processing Logs ──────────────────────────────────────────────
  const MSG_BTN_ID           = 'sap-msg-corr-btn';
  const MSG_LOG_OVERLAY_ID   = 'sap-msg-log-overlay';
  const MSG_LOG_API_PATH     = '/odata/api/v1/MessageProcessingLogs';
  const ATTACH_OPEN_BTN_CLASS = 'cpi-attach-open-btn';
  const ATTACH_API_PATH       = '/odata/api/v1/MessageProcessingLogAttachments';

  /* ─────────────────────────────────────────────────────────────────────────
   * State
   * ───────────────────────────────────────────────────────────────────────── */

  // ── Data Stores state ────────────────────────────────────────────────────
  /** @type {{ id: string, storeName: string, qualifier: string, messageId: string | null } | null} */
  let selectedEntry = null;

  /** True once we've attached the document-level row-click delegate for datastores */
  let dsRowListenerAttached = false;

  /**
   * Dedicated observer on the entries toolbar.
   * SAPUI5's OverflowToolbar re-renders its children whenever data or
   * selection state changes, wiping any foreign DOM node we injected.
   * This observer watches the toolbar and immediately re-injects our
   * button via requestAnimationFrame each time SAPUI5 removes it.
   * @type {MutationObserver | null}
   */
  let toolbarObserver = null;

  // ── JMS Message Queues state ─────────────────────────────────────────────
  /** @type {{ msgId: string, name: string, failed: boolean } | null} */
  let jmsSelectedEntry = null;
  /** True once we've attached the document-level row-click delegate for JMS */
  let jmsRowListenerAttached = false;

  // ── Correlated Messages retry + properties observer ──────────────────────
  /** Timer handle for the next retry attempt */
  let corrIdRetryTimer = null;
  /** How many retries have been attempted in the current navigation cycle */
  let corrIdRetryCount = 0;
  /** Max retries — covers up to ~5 s of SAPUI5 async rendering after a cold page load */
  const CORR_ID_MAX_RETRIES = 5;
  /**
   * Dedicated observer on the SAP Properties sub-section (#mpl_properties_id).
   * SAPUI5 re-renders this section after navigation, wiping our injected button.
   * This observer re-injects instantly whenever the button disappears.
   */
  let msgPropertiesObserver = null;
  /** The DOM element currently being observed, so we can detect if SAP recreates it */
  let msgPropertiesObservedEl = null;
  /** True while the breadcrumb click listener is attached on the MessageDetails page */
  let breadcrumbListenerAttached = false;

  /** Most-recently clicked queue name from the left panel */
  let jmsQueueName = null;

  let jmsToolbarObserver = null;

  /* ─────────────────────────────────────────────────────────────────────────
   * User settings  (size + theme, persisted via chrome.storage.local)
   * ───────────────────────────────────────────────────────────────────────── */
  const overlaySettings = { size: 'm', theme: 'dark', font: 'm', autoFormat: true };

  chrome.storage.local.get({ overlaySize: 'm', overlayTheme: 'dark', overlayFont: 'm', autoFormat: true }, s => {
    overlaySettings.size       = s.overlaySize;
    overlaySettings.theme      = s.overlayTheme;
    overlaySettings.font       = s.overlayFont;
    overlaySettings.autoFormat = s.autoFormat;
  });

  // Keep in sync when user changes settings in the popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.overlaySize)  overlaySettings.size       = changes.overlaySize.newValue;
    if (changes.overlayTheme) overlaySettings.theme      = changes.overlayTheme.newValue;
    if (changes.overlayFont)  overlaySettings.font       = changes.overlayFont.newValue;
    if (changes.autoFormat)   overlaySettings.autoFormat = changes.autoFormat.newValue;
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * Boot — MutationObserver watches for SAPUI5 rendering its DOM
   * ───────────────────────────────────────────────────────────────────────── */
  const domObserver = new MutationObserver(debounce(onDomChanged, 300));
  domObserver.observe(document.body, { childList: true, subtree: true });
  onDomChanged(); // also run once immediately

  // SAPUI5 SPA navigation changes the hash/history without causing new DOM
  // mutations visible to the observer, so also listen for URL changes.
  const onNavChange = debounce(() => {
    corrIdRetryCount = 0; // reset retry counter on every navigation
    onDomChanged();
    // Give SAPUI5 extra time to finish its async render after navigation
    clearTimeout(corrIdRetryTimer);
    corrIdRetryTimer = setTimeout(onDomChanged, 800);
  }, 200);
  window.addEventListener('hashchange', onNavChange);
  window.addEventListener('popstate',   onNavChange);

  // SAPUI5 breadcrumb navigation calls history.pushState directly — neither
  // hashchange nor popstate fire. Patch pushState to catch these transitions.
  const _origPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _origPushState(...args);
    onNavChange();
  };

  // Polling safety net — SAPUI5 fully destroys and recreates the Messages DOM
  // when navigating to MessageDetails, so observer/retry timing is unreliable.
  // This lightweight poll (2 getElementById calls per tick) guarantees the button
  // is re-injected as soon as the corrLink reappears, regardless of how SAPUI5
  // renders the page on return navigation.
  setInterval(() => {
    const url = location.href.toLowerCase();
    if (url.includes('/monitoring/messages') && !url.includes('messagequeues')) {
      if (!document.getElementById(MSG_BTN_ID) &&
          (document.getElementById('MESSAGES_INFO_CORRELATION_ID') ||
           document.querySelector('a[id*="CORRELATION_ID"][class*="sapMLnk"]'))) {
        injectCorrIdButton();
      }
    }
  }, 500);

  function onDomChanged() {
    const url = location.href.toLowerCase();
    if (url.includes('datastores')) {
      injectViewButton();
      attachTableListeners();
    }
    if (url.includes('messagequeues')) {
      injectJmsViewButton();
      attachJmsTableListeners();
    }
    // Messages monitoring page — inject Correlated Messages button next to Correlation ID
    if (url.includes('/monitoring/messages') && !url.includes('messagequeues')) {
      // If we just returned from MessageDetails (flagged via sessionStorage), run
      // an aggressive retry loop to cover slow SAPUI5 re-renders after full reload.
      const returnFlag = sessionStorage.getItem('cpi-workmate-return-from-details');
      if (returnFlag) {
        sessionStorage.removeItem('cpi-workmate-return-from-details');
        startReturnInjection();
      }
      injectCorrIdButton();
      startMsgPropertiesObserver();
      injectAttachmentOpenButtons();
    } else {
      stopMsgPropertiesObserver();
    }

    // MessageDetails page — listen for the "Monitor Message Processing" breadcrumb
    // so we know when the user is about to return to the Messages page.
    if (url.includes('/monitoring/messagedetails')) {
      attachMessageDetailsBreadcrumbListener();
    }
  }

  /**
   * On the MessageDetails page, adds a one-time delegated click listener that
   * sets a sessionStorage flag when "Monitor Message Processing" breadcrumb is clicked.
   * The flag survives the full page reload and tells the Messages page to inject aggressively.
   */
  function attachMessageDetailsBreadcrumbListener() {
    if (breadcrumbListenerAttached) return;
    breadcrumbListenerAttached = true;
    document.body.addEventListener('click', function onBreadcrumbClick(e) {
      const target = e.target.closest('button, a, [role="link"], [role="button"]');
      if (target && target.textContent?.trim().includes('Monitor Message Processing')) {
        sessionStorage.setItem('cpi-workmate-return-from-details', '1');
        document.body.removeEventListener('click', onBreadcrumbClick);
        breadcrumbListenerAttached = false;
      }
    }, true /* capture phase — fires before SAPUI5 can swallow it */);
  }

  /**
   * Aggressive injection loop used after returning from MessageDetails.
   * SAPUI5 re-renders the Properties section several times after a full page reload,
   * so we poll every 300 ms for up to 15 s to guarantee the button appears.
   */
  function startReturnInjection() {
    let attempts = 0;
    const max = 50; // 50 × 300 ms = 15 s
    const t = setInterval(() => {
      attempts++;
      const corrLink = document.getElementById('MESSAGES_INFO_CORRELATION_ID') ||
        document.querySelector('a[id*="CORRELATION_ID"][class*="sapMLnk"]');
      if (corrLink && !document.getElementById(MSG_BTN_ID)) {
        injectCorrIdButton();
      }
      if (attempts >= max || (corrLink && document.getElementById(MSG_BTN_ID))) {
        clearInterval(t);
      }
    }, 300);
  }

  /**
   * Sets up a MutationObserver on SAP's stable #mpl_properties_id element.
   * SAPUI5 re-renders the Properties section after navigation, wiping our button.
   * This observer re-injects instantly whenever the section mutates and the button is gone.
   */
  function startMsgPropertiesObserver() {
    const propertiesEl = document.getElementById('mpl_properties_id');
    if (!propertiesEl) return;

    // Already observing this exact element — nothing to do
    if (msgPropertiesObserver && msgPropertiesObservedEl === propertiesEl) return;

    // Element changed (SAP recreated it) or first time — reconnect
    if (msgPropertiesObserver) msgPropertiesObserver.disconnect();

    msgPropertiesObservedEl = propertiesEl;
    msgPropertiesObserver = new MutationObserver(() => {
      // Re-inject immediately if our button disappeared but the corrLink is still there
      if (!document.getElementById(MSG_BTN_ID) &&
          (document.getElementById('MESSAGES_INFO_CORRELATION_ID') ||
           document.querySelector('a[id*="CORRELATION_ID"][class*="sapMLnk"]'))) {
        injectCorrIdButton();
      }
    });
    msgPropertiesObserver.observe(propertiesEl, { childList: true, subtree: true });
  }

  function stopMsgPropertiesObserver() {
    if (msgPropertiesObserver) {
      msgPropertiesObserver.disconnect();
      msgPropertiesObserver    = null;
      msgPropertiesObservedEl  = null;
    }
    breadcrumbListenerAttached = false;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Button injection
   * ───────────────────────────────────────────────────────────────────────── */
  /**
   * Injects "View Data" into the entries toolbar, immediately BEFORE the
   * "Filter by ID" search field.
   * Result order: [Entries (30)] [spacer] [View Data] [Filter by ID] [Delete] …
   *
   * SAPUI5's OverflowToolbar can wipe injected nodes on re-renders.
   * A dedicated toolbarObserver watches for that and re-injects immediately
   * via requestAnimationFrame so the button always comes back.
   */
  function injectViewButton() {
    if (document.getElementById(BTN_ID)) return; // already present

    // Locate the "Filter by ID" input inside the entries panel toolbar
    const filterInput = Array.from(document.querySelectorAll('input[placeholder]'))
      .find(el => el.placeholder.toLowerCase().includes('filter by id'));
    if (!filterInput) return;

    // Walk up to the SAPUI5 toolbar element.
    // Key: use role="toolbar" — the actual toolbar div has this attribute,
    // whereas child items (sapMBarChild, sapMSF, etc.) do not.
    // Class-based matching fails because sapMBarChild contains "sapMBar"
    // and would incorrectly match __field0 before reaching __toolbar1.
    const toolbar = (function findToolbar(el) {
      let node = el.parentElement;
      for (let i = 0; i < 12 && node; i++) {
        if (node.getAttribute('role') === 'toolbar') return node;
        node = node.parentElement;
      }
      return null;
    })(filterInput);
    if (!toolbar) return;

    // Find the direct toolbar child that wraps the search field
    const searchWrapper = (function directChild(parent, descendant) {
      let node = descendant;
      while (node && node.parentElement !== parent) node = node.parentElement;
      return node || null;
    })(toolbar, filterInput);
    if (!searchWrapper) return;

    // If the user switched to a different data store, the old row selection is
    // stale — clear it so the button injects as disabled.
    if (selectedEntry) {
      const { storeName } = readDataStoreInfo();
      if (storeName && storeName !== selectedEntry.storeName) {
        selectedEntry = null;
      }
    }

    const btn = document.createElement('button');
    btn.id        = BTN_ID;
    btn.className = 'sap-ds-btn sapMBarChild';
    btn.textContent = 'View Data';
    btn.dataset.cpiEmpty = selectedEntry ? 'false' : 'true';
    btn.title     = selectedEntry
      ? `View payload — ${selectedEntry.storeName} / ${selectedEntry.id}`
      : 'Select a row first, then click to view its data';
    btn.addEventListener('click', onViewClick);

    // Insert BEFORE the search field wrapper
    toolbar.insertBefore(btn, searchWrapper);

    // ── Survive SAPUI5 toolbar re-renders ─────────────────────────────────
    // Watch the toolbar's direct children; as soon as our button disappears,
    // re-inject it in the very next animation frame (after SAPUI5 is done).
    if (toolbarObserver) toolbarObserver.disconnect();
    toolbarObserver = new MutationObserver(() => {
      if (!toolbar.querySelector(`#${BTN_ID}`)) {
        requestAnimationFrame(injectViewButton);
      }
    });
    toolbarObserver.observe(toolbar, { childList: true });
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Table row click detection
   * ───────────────────────────────────────────────────────────────────────── */
  function attachTableListeners() {
    // Use a single document-level delegate in capture mode so we never miss
    // a row click due to SAP not having rendered the list containers yet.
    // onTableRowClick returns early via .closest() for any non-row click.
    if (dsRowListenerAttached) return;
    dsRowListenerAttached = true;
    document.addEventListener('click', onTableRowClick, { capture: true, passive: true });
  }

  function onTableRowClick(e) {
    // Find the row element that was (or contains) the click target
    let row = e.target.closest(
      'tr[class*="sapMLIB"], tr[class*="sapMListTblRow"], li[class*="sapMLIB"]'
    );

    // Click landed in a sub-row (responsive expanded detail area).
    // SAP links sub-rows back to the main row via data-sap-ui-related.
    if (!row) {
      const related =
        e.target.closest('[data-sap-ui-related]')
          ?.getAttribute('data-sap-ui-related');
      if (related) row = document.getElementById(related);
    }

    if (!row) return;

    // Locate a UUID-formatted value anywhere in the row cells
    const id = extractUuidFromRow(row);
    if (!id) return;

    // Get store name + qualifier from the page heading area
    const { storeName, qualifier } = readDataStoreInfo();
    if (!storeName) return;

    // Extract the Message ID (non-UUID column, e.g. AGoQTWYDs8d3YJPFn6ka193a6s_U)
    const messageId = extractMessageIdFromRow(row, id);

    selectedEntry = { id, storeName, qualifier, messageId };

    // Enable button
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.dataset.cpiEmpty = 'false';
      btn.title = `View payload  |  store: ${storeName}  |  id: ${id}`;
    }

  }

  /**
   * Extracts the entry ID from a DS table row.
   *
   * SAP Data Store entry IDs are not always UUIDs — they can be dates
   * ("2026-05-25"), plain strings, or descriptive keys like
   * "2. CSV sent to Cegid SFTP for Price Type [SRP]…".
   *
   * DOM layout (confirmed from DevTools):
   *   <td class="sapMListTblHighlightCell"></td>          ← skip
   *   <td class="sapMListTblCell sapMTblCell1Focusable">  ← ID column
   *     <span class="sapMLabel…">
   *       <bdi class="sapUISelectable">ACTUAL ID TEXT</bdi>
   *       <span class="sapMLabelColonAndRequired"></span>  ← colon decoration
   *     </span>
   *   </td>
   *
   * Strategy:
   *   1. UUID fast-path  — scan data cells for a UUID (most common case).
   *   2. Header alignment — find the <th> with text "ID", use its sibling
   *      index to read the matching <td> in the data row.
   *   3. Fallback         — first data cell (ID is always the leftmost column).
   *
   * Text is read from <bdi> when present to avoid picking up colon/icon nodes.
   */
  function extractUuidFromRow(row) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // All <td> siblings in this row (preserves column alignment with the header)
    const allTds = Array.from(row.querySelectorAll('td'));

    // 1. UUID fast-path
    for (const td of allTds) {
      const text = tdText(td);
      if (UUID_RE.test(text)) return text;
    }

    if (!allTds.length) return null;

    // 2. Match by header column index.
    //    Header <th> elements use class "sapMListTblHeaderCell" (NOT "sapMListTblCell"),
    //    so we query all <th> in the header row and find the one labelled "ID".
    //    Its sibling index in the <tr> matches the corresponding <td> sibling index.
    const table = row.closest('table');
    if (table) {
      const headerRow = table.querySelector(
        'thead tr, tr[class*="sapMListTblHeaderRow"]'
      );
      if (headerRow) {
        const ths     = Array.from(headerRow.querySelectorAll('th'));
        const idThIdx = ths.findIndex(th => th.textContent?.trim() === 'ID');
        if (idThIdx >= 0 && idThIdx < allTds.length) {
          const text = tdText(allTds[idThIdx]);
          if (text) return text;
        }
      }
    }

    // 3. Fallback — first sapMListTblCell (not the highlight/nav cells)
    const dataTds = allTds.filter(td => td.className.includes('sapMListTblCell'));
    for (const td of dataTds) {
      const text = tdText(td);
      if (text) return text;
    }

    return null;
  }

  /**
   * Reads cell text, preferring the <bdi> child when present.
   * The <bdi class="sapUISelectable"> holds the raw value; sibling spans
   * add colons and required-field markers that we want to exclude.
   */
  function tdText(td) {
    const bdi = td.querySelector('bdi');
    return (bdi ?? td).textContent?.trim() ?? '';
  }

  /**
   * Extracts the Message ID from a DS row.
   *
   * In the Data Stores responsive table the Message ID is NOT in the main <tr>
   * cells — it lives in the sibling sub-row (<tr class="sapMListTblSubRow"
   * data-sap-ui-related="<mainRowId>">), rendered as a link:
   *   <a class="sapMLnk …"><span class="sapMLnkText">AGoQS8If…</span></a>
   *
   * We first look there; then fall back to a TreeWalker over the main row for
   * any other layout variant.
   */
  function extractMessageIdFromRow(row, uuid) {
    const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const MSG_ID_RE = /^[A-Za-z0-9_\-+/=]{8,64}$/;

    // ── Primary: check the sub-row sibling ──────────────────────────────────
    // SAP stores the Message ID link inside tr.sapMListTblSubRow which is a
    // sibling of the main row and carries data-sap-ui-related="<mainRowId>".
    if (row.id) {
      const subRow = document.querySelector(`[data-sap-ui-related="${row.id}"]`);
      if (subRow) {
        // The link text is in .sapMLnkText or inside an <a class*="sapMLnk">
        const linkEl =
          subRow.querySelector('.sapMLnkText') ||
          subRow.querySelector('a[class*="sapMLnk"] span') ||
          subRow.querySelector('a[class*="sapMLnk"]');
        const text = linkEl?.textContent?.trim() || '';
        if (text && text !== uuid && MSG_ID_RE.test(text)) return text;
      }
    }

    // ── Fallback: TreeWalker over main row ──────────────────────────────────
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim() || '';
      if (!text)                               continue;
      if (text === uuid)                       continue;
      if (UUID_RE.test(text))                  continue;
      if (/^\d{4}-\d{2}-\d{2}/.test(text))    continue;
      if (/^\d+$/.test(text))                  continue;
      if (MSG_ID_RE.test(text))                return text;
    }
    return null;
  }

  /**
   * Reads the store name and qualifier from the ObjectPage header.
   *
   * Confirmed DOM structure (from DevTools inspection):
   *
   *   <h2 class="sapUxAPObjectPageHeaderIdentifierTitle …">
   *     <span class="sapUxAPObjectPageHeaderTitleText …">FlowWebhookTest</span>
   *   </h2>
   *   <div class="sapUxAPObjectPageHeaderIdentifierDescription …">FlowWebhookTest</div>
   *                                                               ↑ "Global" when scope = Global
   *
   * qualifier === "Global"  →  omit qualifier from the API request body (see fetchPayload).
   * qualifier !== "Global"  →  include qualifier in the API request body.
   */
  function readDataStoreInfo() {

    // ── Primary: exact classes confirmed from DevTools ───────────────────────
    const titleEl = document.querySelector(
      '[class*="sapUxAPObjectPageHeaderTitleText"]'
    );
    const subtitleEl = document.querySelector(
      '[class*="sapUxAPObjectPageHeaderIdentifierDescription"]'
    );

    if (titleEl) {
      const storeName = titleEl.textContent?.trim() || '';
      const qualifier = subtitleEl?.textContent?.trim() || storeName;
      if (storeName) return { storeName, qualifier };
    }

    // ── Fallback: any title element NOT inside a button or toolbar ───────────
    // Guards against future layout changes or different SAPUI5 versions.
    const seen = new Set();
    const collected = [];
    document.querySelectorAll('.sapMTitleText, .sapMTitle > bdi, h2 > span').forEach(el => {
      if (el.closest('button, [class*="sapMBtn"], [class*="sapMBar"], [class*="sapMTB"], [class*="sapMToolbar"]')) return;
      const t = el.textContent?.trim();
      if (t && t.length > 0 && !seen.has(t)) { seen.add(t); collected.push(t); }
    });

    return {
      storeName: collected[0] || '',
      qualifier: collected[1] || collected[0] || '',
    };
  }

  /**
   * Reads the currently selected datastore entry directly from the DOM.
   * SAP marks selected rows with aria-selected="true" — this is always set
   * regardless of whether our click listener fired, so it works as a reliable
   * fallback when the first-click race condition occurs.
   */
  function readSelectedDsEntry() {
    for (const row of document.querySelectorAll(
      'tr.sapMListTblRow[aria-selected="true"], tr.sapMListTblRow.sapMLIBSelected'
    )) {
      const id = extractUuidFromRow(row);
      if (!id) continue;
      const { storeName, qualifier } = readDataStoreInfo();
      if (!storeName) continue;
      const messageId = extractMessageIdFromRow(row, id);
      return { id, storeName, qualifier, messageId };
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * View button click handler
   * ───────────────────────────────────────────────────────────────────────── */
  async function onViewClick(e) {
    // Stop SAPUI5 from reacting to clicks on our injected toolbar button,
    // which would trigger a toolbar re-render and nullify our btn reference.
    e?.stopPropagation();

    // Primary: use cached selection from click listener.
    // Fallback: read SAP's aria-selected row directly from the DOM — covers the
    // first-click race where the row-click listener hadn't fired yet.
    const entry = selectedEntry ?? readSelectedDsEntry();
    if (!entry) return;

    // Use e.currentTarget — always the clicked element even if detached from DOM.
    const btn = e?.currentTarget ?? document.getElementById(BTN_ID);
    if (!btn) return;
    const origText = btn.textContent;
    btn.dataset.cpiEmpty = 'false';
    btn.textContent = '⏳ Loading…';

    try {
      const origin = `${location.protocol}//${location.host}`;

      // 1. Obtain CSRF token (SAP requires this for POST requests)
      const csrfToken = await fetchCsrfToken(origin);

      // 2. Call the payload API
      const xmlText = await fetchPayload(origin, csrfToken, entry);

      // 3. Extract the base64-encoded zip from the XML response
      const base64 = extractBase64FromXml(xmlText);
      if (!base64) throw new Error('No <payload> element found in the API response.');

      // 4. Decode base64 → Uint8Array → JSZip
      const files = await decodeAndUnzip(base64);
      if (files.length === 0) throw new Error('Zip archive is empty.');

      // 5. Show the overlay
      showOverlay(files, entry);

    } catch (err) {
      alert(`SAP CPI Workmate\n\n${err.message}`);
      console.error('[DS Viewer]', err);
    } finally {
      btn.textContent = origText;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * API helpers
   * ───────────────────────────────────────────────────────────────────────── */

  /**
   * Fetches a CSRF token by making GET requests with "X-CSRF-Token: Fetch".
   * Tries several common SAP Integration Suite endpoints in order.
   * All requests use credentials:'include' so the existing session cookies
   * are sent automatically — no login prompt needed.
   */
  async function fetchCsrfToken(origin) {
    // /itspaces/ tenants mount all APIs under /itspaces/…
    const pfx = location.pathname.startsWith('/itspaces/') ? '/itspaces' : '';
    // Endpoints to probe, in preference order
    const probeUrls = [
      `${origin}${pfx}/Operations/`,
      `${origin}${pfx}/api/v1/$metadata`,
      origin + '/',
    ];

    for (const url of probeUrls) {
      try {
        // Try HEAD first (lighter), then GET if HEAD doesn't carry the header
        for (const method of ['HEAD', 'GET']) {
          const res = await fetch(url, {
            method,
            headers: { 'X-CSRF-Token': 'Fetch' },
            credentials: 'include',
          });
          const token =
            res.headers.get('X-CSRF-Token') ||
            res.headers.get('x-csrf-token');
          if (token && token !== 'Required' && token !== 'Fetch') {
            return token;
          }
        }
      } catch {
        // Try next endpoint
      }
    }
    throw new Error(
      'Could not obtain a CSRF token from any endpoint.\n' +
      'Make sure you are logged in and on a *.hana.ondemand.com page.'
    );
  }

  /**
   * POSTs to GetDataStorePayloadCommand and returns the raw XML response text.
   *
   * qualifier is included in the body ONLY when it is not "Global".
   * When the scope is Global, SAP expects the key to be absent entirely.
   *
   *   Non-global:  { storeName, id, qualifier }
   *   Global:      { storeName, id }
   */
  async function fetchPayload(origin, csrfToken, { storeName, id, qualifier }) {
    const body = { storeName, id };
    if (qualifier && qualifier !== 'Global') {
      body.qualifier = qualifier;
    }

    const pfx = location.pathname.startsWith('/itspaces/') ? '/itspaces' : '';
    const res = await fetch(origin + pfx + API_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept':        'application/xml, text/xml, */*; q=0.01',
        'X-CSRF-Token':  csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `API request failed: HTTP ${res.status} ${res.statusText}\n` +
        `URL: ${res.url}`
      );
    }
    return res.text();
  }

  /**
   * Parses the XML response and returns the text content of <payload>.
   * The XML root tag is a long class name so we use getElementsByTagName
   * which ignores namespace prefixes and root element names.
   */
  function extractBase64FromXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) {
      throw new Error(
        'API response is not valid XML.\n' + parseErr.textContent?.slice(0, 200)
      );
    }
    const payloadEl =
      doc.querySelector('payload') ||
      doc.getElementsByTagName('payload')[0];
    return payloadEl?.textContent?.trim() || null;
  }

  /**
   * Decodes a base64 string to a Uint8Array, then uses JSZip to extract files.
   * Returns an array of { name, content, isBinary } objects.
   */
  async function decodeAndUnzip(base64) {
    // base64 → binary string → Uint8Array
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const zip = await JSZip.loadAsync(bytes);
    const results = [];

    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;

      // Try reading as UTF-8 text first
      let content;
      let isBinary = false;
      try {
        content = await entry.async('string');
        // If the string contains null bytes it's actually binary
        if (content.includes('\x00')) {
          content   = await entry.async('base64');
          isBinary  = true;
        }
      } catch {
        content  = await entry.async('base64');
        isBinary = true;
      }

      results.push({ name, content, isBinary });
    }

    // Sort: directories-first by path depth, then alphabetically
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Overlay UI
   * ───────────────────────────────────────────────────────────────────────── */
  function showOverlay(files, { storeName, id, messageId = null }) {
    document.getElementById(OVERLAY_ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = buildOverlayHTML(files, storeName, id, messageId);
    document.body.appendChild(overlay);

    // Apply size, theme, and font from saved settings
    const panel = overlay.querySelector('#ds-panel');
    if (overlaySettings.size  !== 'm') panel.classList.add(`ds-size-${overlaySettings.size}`);
    if (overlaySettings.theme === 'light') panel.classList.add('ds-theme-light');
    if (overlaySettings.font  !== 'm') panel.classList.add(`ds-font-${overlaySettings.font}`);
    // Hide the file sidebar when there is only one file (e.g. single attachment)
    if (files.length === 1) panel.classList.add('ds-single-file');

    // ── DOM refs ────────────────────────────────────────────────────────────
    const codeEl      = overlay.querySelector('#ds-code');
    const lineNumsEl  = overlay.querySelector('#ds-line-nums');
    const filenameEl  = overlay.querySelector('#ds-content-filename');
    const typeTagEl   = overlay.querySelector('#ds-type-tag');
    const wrapBtn     = overlay.querySelector('#ds-wrap-btn');
    const formatBtn   = overlay.querySelector('#ds-format-btn');
    const copyBtn     = overlay.querySelector('#ds-copy-btn');
    const searchInput = overlay.querySelector('#ds-search-input');
    const searchCount = overlay.querySelector('#ds-search-count');
    const searchPrev  = overlay.querySelector('#ds-search-prev');
    const searchNext  = overlay.querySelector('#ds-search-next');

    // ── Header ID copy buttons ──────────────────────────────────────────────
    function miniCopy(btn, text) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓';
        btn.classList.add('ds-copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('ds-copied'); }, 1500);
      });
    }
    overlay.querySelector('#ds-copy-entry-id')
      ?.addEventListener('click', e => { e.stopPropagation(); miniCopy(e.currentTarget, id); });
    overlay.querySelector('#ds-copy-msg-id')
      ?.addEventListener('click', e => { e.stopPropagation(); miniCopy(e.currentTarget, messageId); });

    // ── Line numbers ────────────────────────────────────────────────────────
    function updateLineNums() {
      const lines = codeEl.textContent.split('\n');
      // Ignore a single trailing empty line produced by the final \n
      const count = (lines.length > 1 && lines[lines.length - 1] === '')
        ? lines.length - 1
        : lines.length;
      lineNumsEl.innerHTML = Array.from(
        { length: Math.max(count, 1) },
        (_, i) => `<span>${i + 1}</span>`
      ).join('');
    }

    // ── Search ──────────────────────────────────────────────────────────────
    let searchMatches = [];   // collected <mark> elements
    let searchCurrent = -1;   // index of the currently focused match

    function clearSearchMarks() {
      // Replace each <mark> with its own text content, then normalise
      codeEl.querySelectorAll('mark.hl-search, mark.hl-current').forEach(m => {
        m.replaceWith(...m.childNodes);
      });
      codeEl.normalize();
    }

    function applySearch(query) {
      clearSearchMarks();
      searchMatches = [];
      searchCurrent = -1;
      searchInput.classList.remove('ds-no-match');

      if (!query) { searchCount.textContent = ''; return; }

      const lower = query.toLowerCase();

      // Walk every text node inside #ds-code and inject <mark> wrappers
      const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      textNodes.forEach(tn => {
        const text  = tn.textContent;
        const lower = query.toLowerCase();
        const ltext = text.toLowerCase();
        let idx     = ltext.indexOf(lower);
        if (idx === -1) return;

        const frag = document.createDocumentFragment();
        let last   = 0;
        while (idx !== -1) {
          if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
          const mark = document.createElement('mark');
          mark.className  = 'hl-search';
          mark.textContent = text.slice(idx, idx + query.length);
          searchMatches.push(mark);
          frag.appendChild(mark);
          last = idx + query.length;
          idx  = ltext.indexOf(lower, last);
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        tn.replaceWith(frag);
      });

      if (searchMatches.length === 0) {
        searchInput.classList.add('ds-no-match');
        searchCount.textContent = 'No matches';
      } else {
        searchCurrent = 0;
        focusMatch(0);
      }
    }

    function focusMatch(idx) {
      if (!searchMatches.length) return;
      // Dim all, brighten current
      searchMatches.forEach(m => { m.className = 'hl-search'; });
      searchMatches[idx].className = 'hl-current';
      searchMatches[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      searchCount.textContent = `${idx + 1} / ${searchMatches.length}`;
    }

    function navigateSearch(dir) {
      if (!searchMatches.length) return;
      searchCurrent = (searchCurrent + dir + searchMatches.length) % searchMatches.length;
      focusMatch(searchCurrent);
    }

    searchInput.addEventListener('input', () => applySearch(searchInput.value));
    searchPrev.addEventListener('click',  () => navigateSearch(-1));
    searchNext.addEventListener('click',  () => navigateSearch(+1));
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); navigateSearch(e.shiftKey ? -1 : +1); }
    });

    // ── Per-overlay state ───────────────────────────────────────────────────
    let isWrapped = false;  // word-wrap toggle

    const downloadBtn = overlay.querySelector('#ds-download-btn');

    // ── Load a file into the viewer ─────────────────────────────────────────
    function loadFile(file) {
      const type = detectType(file);
      filenameEl.textContent = file.name;

      // Type badge
      typeTagEl.textContent = type.toUpperCase();
      typeTagEl.className   = `ds-type-tag ds-type-${type}`;

      // "Format" button visible only for JSON / XML
      const isFormattable = (type === 'json' || type === 'xml') && !file.isBinary;
      formatBtn.style.display = isFormattable ? '' : 'none';
      formatBtn.classList.remove('ds-btn-on');

      // Auto-format if enabled and content is JSON/XML; otherwise load raw
      if (isFormattable && overlaySettings.autoFormat) {
        codeEl.innerHTML = syntaxHighlight(prettyPrint(file), type);
        formatBtn.classList.add('ds-btn-on');
      } else {
        codeEl.textContent = file.isBinary
          ? `[Binary file — displayed as base64]\n\n${file.content}`
          : (file.content ?? '');
      }

      updateLineNums();

      // Clear search when switching files
      searchInput.value = '';
      searchCount.textContent = '';
      searchInput.classList.remove('ds-no-match');
      searchMatches = [];
      searchCurrent = -1;
    }

    // Initial load
    loadFile(files[0]);

    // ── Wrap toggle ─────────────────────────────────────────────────────────
    wrapBtn.addEventListener('click', () => {
      isWrapped = !isWrapped;
      codeEl.style.whiteSpace  = isWrapped ? 'pre-wrap' : 'pre';
      // word-break:break-all creates break opportunities at every character
      // boundary, so leading indentation whitespace always stays on the same
      // visual line as the word that follows it — preventing a spurious blank
      // line when a deeply-indented element has a very long text value
      // (e.g. XML <SerialNumberList> with hundreds of comma-separated values).
      codeEl.style.wordBreak   = isWrapped ? 'break-all' : 'normal';
      codeEl.style.overflowWrap = 'normal'; // break-all handles all wrapping
      wrapBtn.textContent        = isWrapped ? 'No Wrap' : 'Wrap';
      wrapBtn.classList.toggle('ds-btn-on', isWrapped);
    });

    // ── Format button — toggles between raw and pretty-printed + highlighted ─
    formatBtn.addEventListener('click', () => {
      const activeItem = overlay.querySelector('.ds-file-item.ds-active');
      const file = files[Number(activeItem?.dataset.i ?? 0)];
      const isOn = formatBtn.classList.contains('ds-btn-on');
      if (isOn) {
        // Revert to raw (use textContent so HTML is not interpreted)
        codeEl.textContent = file.content ?? '';
        formatBtn.classList.remove('ds-btn-on');
      } else {
        // Pretty-print then syntax-highlight (innerHTML for coloured spans)
        const type   = detectType(file);
        const pretty = prettyPrint(file);
        codeEl.innerHTML = syntaxHighlight(pretty, type);
        formatBtn.classList.add('ds-btn-on');
      }
      updateLineNums();
      // Re-apply search if there's an active query
      if (searchInput.value) applySearch(searchInput.value);
    });

    // ── File list selection ─────────────────────────────────────────────────
    overlay.querySelectorAll('.ds-file-item').forEach(item => {
      item.addEventListener('click', () => {
        overlay.querySelectorAll('.ds-file-item').forEach(i => i.classList.remove('ds-active'));
        item.classList.add('ds-active');
        loadFile(files[Number(item.dataset.i)]);
      });
    });

    // ── Copy ────────────────────────────────────────────────────────────────
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(codeEl.textContent).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => (copyBtn.textContent = orig), 2000);
      });
    });

    // ── Download ─────────────────────────────────────────────────────────────
    downloadBtn.addEventListener('click', () => {
      const activeItem = overlay.querySelector('.ds-file-item.ds-active');
      const file    = files[Number(activeItem?.dataset.i ?? 0)];
      const content = codeEl.textContent;    // use what's displayed (formatted)

      // Build filename as "{basename}_{id}.{ext}"
      // Prefer messageId (Message ID column) when available; fall back to
      // the entry id (UUID) which is always present.
      const type    = detectType(file);
      const extMap  = { json: 'json', xml: 'xml', text: 'txt', binary: 'bin' };
      const ext     = extMap[type] ?? 'txt';
      const stem    = basename(file.name).replace(/\.[^.]+$/, ''); // strip existing ext
      const rawId   = messageId || id || '';                        // id = entry UUID fallback
      const safeId  = rawId.replace(/[:\\/?*|"<>\s]/g, '_');
      const filename = safeId
        ? `${stem}_${safeId}.${ext}`
        : `${stem}.${ext}`;

      const blob = new Blob([content], { type: 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });

    // ── Close ───────────────────────────────────────────────────────────────
    function closeOverlay() {
      overlay._removeKeyListener?.();
      overlay.remove();
    }
    overlay.querySelector('#ds-backdrop').addEventListener('click', closeOverlay);
    overlay.querySelector('#ds-close-btn').addEventListener('click', closeOverlay);
    const onKeyDown = e => { if (e.key === 'Escape') closeOverlay(); };
    document.addEventListener('keydown', onKeyDown);
    overlay._removeKeyListener = () => document.removeEventListener('keydown', onKeyDown);
  }

  function buildOverlayHTML(files, storeName, id, messageId = null) {
    const fileListHTML = files.map((f, i) => `
      <div class="ds-file-item${i === 0 ? ' ds-active' : ''}" data-i="${i}" title="${h(f.name)}">
        <span class="ds-file-icon">${fileIcon(f.name)}</span>
        <span class="ds-file-label">${h(basename(f.name))}</span>
        <span class="ds-file-size">${fileSize(f)}</span>
      </div>`).join('');

    return `
      <div id="ds-backdrop"></div>
      <div id="ds-panel">

        <div id="ds-header">
          <div id="ds-header-meta">
            <span id="ds-store-name">${h(storeName)}</span>
            ${id ? `
            <div class="ds-id-row">
              <span id="ds-entry-id" title="${h(id)}">${h(id)}</span>
              <button class="ds-mini-copy" id="ds-copy-entry-id" title="Copy ID">Copy</button>
            </div>` : ''}
            ${messageId ? `
            <div class="ds-id-row">
              <span id="ds-msg-id" title="${h(messageId)}">${h(messageId)}</span>
              <button class="ds-mini-copy" id="ds-copy-msg-id" title="Copy Message ID">Copy</button>
            </div>` : ''}
          </div>
          <button id="ds-close-btn" title="Close (Esc)">✕</button>
        </div>

        <div id="ds-body">

          <div id="ds-sidebar">
            <div id="ds-sidebar-title">FILES (${files.length})</div>
            ${fileListHTML}
          </div>

          <div id="ds-content-area">
            <div id="ds-content-toolbar">
              <div id="ds-toolbar-left">
                <span id="ds-content-filename"></span>
                <span id="ds-type-tag" class="ds-type-tag"></span>
              </div>
              <div id="ds-toolbar-right">
                <button id="ds-format-btn"   class="ds-tool-btn" style="display:none">Format</button>
                <button id="ds-wrap-btn"     class="ds-tool-btn">Wrap</button>
                <button id="ds-copy-btn"     class="ds-tool-btn">📋 Copy</button>
                <button id="ds-download-btn" class="ds-tool-btn">⬇ Download</button>
              </div>
            </div>

            <div id="ds-search-bar">
              <span style="color:#888;font-size:13px;flex-shrink:0">🔍</span>
              <input id="ds-search-input" type="text" placeholder="Search in content…"
                     autocomplete="off" spellcheck="false" />
              <span id="ds-search-count"></span>
              <button class="ds-tool-btn" id="ds-search-prev" title="Previous match (Shift+Enter)">❮</button>
              <button class="ds-tool-btn" id="ds-search-next" title="Next match (Enter)">❯</button>
            </div>

            <div id="ds-code-wrap">
              <div id="ds-line-nums"></div>
              <pre id="ds-code"></pre>
            </div>
          </div>

        </div>
      </div>`;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Pretty-printing helpers
   * ───────────────────────────────────────────────────────────────────────── */

  /**
   * Detects whether a file is json / xml / binary / text.
   * Checks file extension first, then falls back to sniffing the content.
   */
  function detectType(file) {
    if (file.isBinary) return 'binary';
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (['xml', 'xsl', 'xslt', 'xsd', 'wsdl'].includes(ext)) return 'xml';
    if (ext === 'json') return 'json';
    // Sniff content when extension is ambiguous (e.g. files named "body")
    const trimmed = (file.content ?? '').trimStart();
    if (trimmed.startsWith('<'))                        return 'xml';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
    return 'text';
  }

  /** Returns nicely formatted text for a file entry */
  function prettyPrint(file) {
    if (!file) return '';
    if (file.isBinary) return `[Binary file — displayed as base64]\n\n${file.content}`;

    // Use detectType() so files without extensions (e.g. "body") are also pretty-printed
    const type = detectType(file);

    if (type === 'json') {
      try {
        return JSON.stringify(JSON.parse(file.content), null, 2);
      } catch { /* fall through to raw */ }
    }

    if (type === 'xml') {
      return formatXml(file.content);
    }

    return file.content;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Syntax highlighting
   * Takes already-formatted plain text and returns HTML with coloured <span>s.
   * ───────────────────────────────────────────────────────────────────────── */

  function syntaxHighlight(text, type) {
    if (type === 'json') return hlJson(text);
    if (type === 'xml')  return hlXml(text);
    return h(text); // text / binary — just escape
  }

  /**
   * JSON highlighter.
   * Tokenises with a single regex; peeks ahead to distinguish keys from values.
   */
  function hlJson(json) {
    const parts = [];
    const re =
      /"(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[{}\[\]]|[:,]|[\r\n]+[ \t]*|[ \t]+/g;
    let last = 0, m;
    while ((m = re.exec(json)) !== null) {
      if (m.index > last) parts.push(h(json.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('"')) {
        // A string is a key when the next non-space character is ':'
        const after = json.slice(m.index + tok.length).trimStart();
        parts.push(`<span class="${after[0] === ':' ? 'hl-key' : 'hl-string'}">${h(tok)}</span>`);
      } else if (tok === 'true' || tok === 'false') {
        parts.push(`<span class="hl-bool">${h(tok)}</span>`);
      } else if (tok === 'null') {
        parts.push(`<span class="hl-null">${h(tok)}</span>`);
      } else if (tok[0] === '-' || (tok[0] >= '0' && tok[0] <= '9')) {
        parts.push(`<span class="hl-number">${h(tok)}</span>`);
      } else if (tok === '{' || tok === '}' || tok === '[' || tok === ']') {
        parts.push(`<span class="hl-brace">${h(tok)}</span>`);
      } else if (tok === ':' || tok === ',') {
        parts.push(`<span class="hl-punct">${h(tok)}</span>`);
      } else {
        parts.push(h(tok)); // whitespace — preserve as-is
      }
      last = m.index + tok.length;
    }
    if (last < json.length) parts.push(h(json.slice(last)));
    return parts.join('');
  }

  /**
   * XML highlighter.
   * Splits the formatted XML into tags, text nodes, comments, and CDATA
   * sections, then colours each part.
   */
  function hlXml(xml) {
    const parts = [];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+?>|[^<]+/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const tok = m[0];
      if (tok.startsWith('<!--')) {
        parts.push(`<span class="hl-comment">${h(tok)}</span>`);
      } else if (tok.startsWith('<![CDATA[')) {
        parts.push(`<span class="hl-cdata">${h(tok)}</span>`);
      } else if (tok.startsWith('<')) {
        parts.push(hlXmlTag(tok));
      } else {
        // Text node — colour only non-whitespace runs, preserve indent spaces
        parts.push(/\S/.test(tok)
          ? `<span class="hl-xml-text">${h(tok)}</span>`
          : h(tok));
      }
    }
    return parts.join('');
  }

  /**
   * Colourises a single XML tag token, e.g. <ns:Elem attr="val"/>.
   * Handles opening tags, closing tags, self-closing tags, and PIs.
   */
  function hlXmlTag(tag) {
    const P = s => `<span class="hl-punct">${h(s)}</span>`;
    const T = s => `<span class="hl-tag-name">${h(s)}</span>`;
    const A = s => `<span class="hl-attr-name">${h(s)}</span>`;
    const V = s => `<span class="hl-attr-val">${h(s)}</span>`;

    const isClose   = tag.startsWith('</');
    const selfClose = tag.endsWith('/>');
    const isPI      = tag.startsWith('<?');

    let out = P('<');
    if (isClose) out += P('/');
    if (isPI)    out += P('?');

    // Strip the outer < … > (and /> or ?> endings)
    const inner = tag.slice(isClose || isPI ? 2 : 1, selfClose || isPI ? -2 : -1);

    // Tag / PI name
    const nameEnd = inner.search(/[\s\/>]/);
    const name    = nameEnd === -1 ? inner : inner.slice(0, nameEnd);
    out += T(name);

    // Attributes
    const attrStr = nameEnd === -1 ? '' : inner.slice(nameEnd);
    if (attrStr.trim()) {
      out += attrStr.replace(
        /(\s+)([\w:.-]+)(\s*=\s*)(["'])([\s\S]*?)\4/g,
        (_, sp, aname, eq, q, val) =>
          h(sp) + A(aname) + P(eq + q) + V(val) + P(q)
      );
    }

    out += selfClose ? P('/>') : isPI ? P('?>') : P('>');
    return out;
  }

  /**
   * Formats an XML string with 2-space indentation.
   * Uses the browser's DOMParser + a recursive serialiser so it handles
   * namespaces, CDATA, and comments correctly.
   */
  function formatXml(xmlStr) {
    try {
      const doc = new DOMParser().parseFromString(xmlStr.trim(), 'application/xml');
      if (doc.querySelector('parsererror')) return xmlStr; // return raw on parse failure
      return serializeNode(doc.documentElement, 0);
    } catch {
      return xmlStr;
    }
  }

  function serializeNode(node, depth) {
    const pad = '  '.repeat(depth);

    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      return t ? pad + t : '';
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      return `${pad}<!-- ${node.textContent.trim()} -->`;
    }
    if (node.nodeType === Node.CDATA_SECTION_NODE) {
      return `${pad}<![CDATA[${node.textContent}]]>`;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag   = node.tagName;
    const attrs = Array.from(node.attributes)
      .map(a => ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`)
      .join('');

    const children = Array.from(node.childNodes)
      .map(c => serializeNode(c, depth + 1))
      .filter(s => s !== '');

    if (children.length === 0) {
      return `${pad}<${tag}${attrs}/>`;
    }
    if (children.length === 1 && !children[0].includes('\n')) {
      return `${pad}<${tag}${attrs}>${children[0].trim()}</${tag}>`;
    }
    return `${pad}<${tag}${attrs}>\n${children.join('\n')}\n${pad}</${tag}>`;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Small utilities
   * ───────────────────────────────────────────────────────────────────────── */

  /** HTML-escape a string for safe insertion into innerHTML */
  function h(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Last path segment of a file path */
  function basename(path) {
    return path.split('/').pop() || path;
  }

  /**
   * Returns a human-readable file size string for a file entry.
   * Text files: uses Blob to get the true UTF-8 byte count.
   * Binary files: decodes the base64 length back to raw bytes.
   */
  function fileSize(file) {
    let bytes;
    if (file.isBinary) {
      // base64 → raw bytes: strip padding/whitespace, then length * 3/4
      const b64 = (file.content || '').replace(/[^A-Za-z0-9+/]/g, '');
      bytes = Math.floor(b64.length * 3 / 4);
    } else {
      bytes = new Blob([file.content || '']).size;
    }
    if (bytes < 1024)           return `${bytes} B`;
    if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Returns an emoji icon based on file extension */
  function fileIcon(name) {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const map = {
      xml: '📄', xsl: '📄', xslt: '📄', xsd: '📋', wsdl: '📋',
      json: '{}', txt: '📝', csv: '📊', groovy: '🔧',
      java: '☕', js: '🟨', properties: '⚙️', mf: '📦',
    };
    return map[ext] ?? '📁';
  }

  /** Debounce: delays fn by ms ms, resets timer on each call */
  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * JMS Message Queues support
   * ─────────────────────────────────────────────────────────────────────────
   * URL:  /shell/monitoring/MessageQueues*
   *
   * API:  GET /odata/api/v1/JmsMessages(Msgid='<encoded>',Name='<queue>',Failed=<bool>)/$value
   * Auth: existing session cookies — no CSRF needed (GET request)
   * Resp: direct zip binary (ArrayBuffer)
   *
   * DOM:  Left panel  — queue list; clicking captures queue name
   *       Right panel — messages table; row click captures Msgid + status
   * ───────────────────────────────────────────────────────────────────────── */

  /* ── Button injection ─────────────────────────────────────────────────── */
  function injectJmsViewButton() {
    if (document.getElementById(JMS_BTN_ID)) return;

    // The messages toolbar has a "Message ID, Correlation ID" search box
    const filterInput = Array.from(document.querySelectorAll('input[placeholder]'))
      .find(el => /message id/i.test(el.placeholder));
    if (!filterInput) return;

    // Walk up to role="toolbar"
    const toolbar = (function findToolbar(el) {
      let node = el.parentElement;
      for (let i = 0; i < 12 && node; i++) {
        if (node.getAttribute('role') === 'toolbar') return node;
        node = node.parentElement;
      }
      return null;
    })(filterInput);
    if (!toolbar) return;

    // Direct toolbar child that wraps the search field
    const searchWrapper = (function directChild(parent, desc) {
      let node = desc;
      while (node && node.parentElement !== parent) node = node.parentElement;
      return node || null;
    })(toolbar, filterInput);
    if (!searchWrapper) return;

    const btn = document.createElement('button');
    btn.id        = JMS_BTN_ID;
    btn.className = 'sap-ds-btn sapMBarChild';
    btn.textContent = 'View Data';
    // Use data-cpi-empty instead of disabled so clicks always fire
    // (disabled prevents the click event, causing the first-click race)
    const hasSelection = !!jmsSelectedEntry;
    btn.dataset.cpiEmpty = hasSelection ? 'false' : 'true';
    btn.title = hasSelection
      ? `View JMS payload — ${jmsSelectedEntry.name} / ${jmsSelectedEntry.msgId}`
      : 'Select a message row first, then click to view its data';
    btn.addEventListener('click', onJmsViewClick);

    toolbar.insertBefore(btn, searchWrapper);

    if (jmsToolbarObserver) jmsToolbarObserver.disconnect();
    jmsToolbarObserver = new MutationObserver(() => {
      if (!toolbar.querySelector(`#${JMS_BTN_ID}`)) {
        requestAnimationFrame(injectJmsViewButton);
      }
    });
    jmsToolbarObserver.observe(toolbar, { childList: true });
  }

  /* ── Table / list listeners ───────────────────────────────────────────── */
  function attachJmsTableListeners() {
    // Use a single document-level delegate in capture mode so we never miss
    // a row click due to SAP not having rendered the list containers yet.
    // onJmsRowClick returns early via .closest() for any non-row click.
    if (jmsRowListenerAttached) return;
    jmsRowListenerAttached = true;
    document.addEventListener('click', onJmsRowClick, { capture: true, passive: true });
  }

  function onJmsRowClick(e) {
    let row = e.target.closest(
      'tr[class*="sapMLIB"], tr[class*="sapMListTblRow"], li[class*="sapMLIB"]'
    );

    // Click landed in the sub-row (expanded detail area — Due At, Correlation ID etc.)
    // SAP marks sub-rows with data-sap-ui-related pointing to the parent main row id.
    if (!row) {
      const related =
        e.target.closest('[data-sap-ui-related]')
          ?.getAttribute('data-sap-ui-related');
      if (related) row = document.getElementById(related);
    }

    if (!row) return;

    // ── Left panel: queue row ────────────────────────────────────────────
    // Queue rows use sapMObjectIdentifier to render the queue name.
    if (isJmsQueueRow(row)) {
      const name = extractQueueNameFromRow(row);
      if (name && name !== jmsQueueName) {
        // User switched to a different queue — clear the stale message selection
        jmsSelectedEntry = null;
        const oldBtn = document.getElementById(JMS_BTN_ID);
        if (oldBtn) {
          oldBtn.dataset.cpiEmpty = 'true';
          oldBtn.title = 'Select a message row first, then click to view its data';
        }
      }
      if (name) jmsQueueName = name;
      return; // don't enable button yet — user must click a message row
    }

    // ── Right panel: message row ─────────────────────────────────────────
    const msgId = extractJmsMsgId(row);
    if (!msgId) return;

    const failed    = extractJmsFailed(row);
    const messageId = extractJmsMessageId(row);  // Message ID column (AGoO1-…)
    // Queue name resolved now if possible; if not, we retry at button-click time
    const name = readJmsQueueNameFromDom() || jmsQueueName || '';

    jmsSelectedEntry = { msgId, name, failed, messageId };

    const btn = document.getElementById(JMS_BTN_ID);
    if (btn) {
      btn.dataset.cpiEmpty = 'false';
      btn.title = name
        ? `View JMS payload  |  queue: ${name}  |  ${msgId}`
        : `View JMS payload  |  ${msgId}`;
    }
  }

  /**
   * Distinguishes left-panel queue rows from right-panel message rows.
   * Message rows always contain a JMS Message ID starting with "ID:\d",
   * so we check for that text first — if found it's definitively a message row.
   * Only if no "ID:" text is found do we fall back to the sapMObjectIdentifier check.
   */
  function isJmsQueueRow(row) {
    // Walk text nodes in the row — fastest way to check raw text in any layout
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent?.trim() || '';
      // SAP uses "ID:\d..." format (older tenants) and "x-hex-..." (newer tenants)
      if (/^ID:\d/.test(t) || /^x-hex-/i.test(t)) return false; // message row
    }
    return !!row.querySelector('[class*="sapMObjectIdentifier"]');
  }

  /** Extracts the queue name from a left-panel queue row. */
  function extractQueueNameFromRow(row) {
    // Try structured SAP ObjectIdentifier selectors first
    const el =
      row.querySelector('[class*="sapMObjectIdentifierText"] .sapMText') ||
      row.querySelector('[class*="sapMObjectIdentifierText"] span')      ||
      row.querySelector('[class*="sapMObjectIdentifier"] .sapMText')     ||
      row.querySelector('[class*="sapMTitleText"]');
    const structured = el?.textContent?.trim();
    if (structured) return structured;

    // Fallback: walk text nodes and return the first that looks like a queue name
    // (not a label like "Access Type", "Usage", status value, or a number)
    const SKIP = /^(Access Type|Usage|State|Entries|OK|Started|Stopped|Non-Exclusive|Exclusive|Unknown|Actions|:\s*)/i;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim() || '';
      if (text.length > 1 && !/^\d+$/.test(text) && !SKIP.test(text)) {
        return text;
      }
    }
    return null;
  }

  /**
   * Extracts the JMS Message ID (e.g. "ID:10.157.178.781f719e478df7a80:53"
   * or "x-hex-49443a31302e...").
   *
   * The ID is always in the first visible cell (td.sapMTblFirstVisibleCell).
   * SAP stores the full untruncated value in that cell's child element's
   * `title` attribute even when the visible text is clipped with an ellipsis.
   *
   * We scan ALL titled elements in the cell and validate against the JMS ID
   * pattern — some row layouts have other titled elements (e.g. search links)
   * before the actual ID span.
   */
  function extractJmsMsgId(row) {
    const JMS_ID_RE = /^(ID:\d|x-hex-[0-9a-f])/i;
    const firstCell = row.querySelector('td.sapMTblFirstVisibleCell');
    if (!firstCell) return null;
    for (const el of firstCell.querySelectorAll('[title]')) {
      const t = el.title?.trim() || '';
      if (JMS_ID_RE.test(t)) return t;
    }
    return null;
  }

  /**
   * Status cell → Failed=true only when the VISIBLE status label is "Failed" or "Error".
   * "Overdue" → Failed=false.
   *
   * SAP injects invisible accessibility spans (sapUiPseudoInvisibleText) like
   * "Invalid entry" inside the same status element — those must be ignored.
   * We read only the visible .sapMObjStatusText child.
   */
  function extractJmsFailed(row) {
    // Primary: read the visible status label text only
    const statusTextEl = row.querySelector('[class*="sapMObjStatusText"]');
    if (statusTextEl) {
      const text = statusTextEl.textContent?.trim().toLowerCase() || '';
      return text === 'failed' || text === 'error';
    }
    // Fallback: class on the status wrapper tells us severity
    // sapMObjStatusError = error/failed, sapMObjStatusWarning = overdue
    const statusWrapper = row.querySelector('[class*="sapMObjStatus"]');
    if (statusWrapper) {
      return statusWrapper.classList.contains('sapMObjStatusError') ||
             statusWrapper.classList.contains('sapUiObjStatusError');
    }
    return false;
  }

  /**
   * Extracts the Message ID from a JMS message row.
   * The Message ID column renders as a link in the main row:
   *   <a class="sapMLnk …"><span class="sapMLnkText">AGoO1-roJWwBWdy3…</span></a>
   * Also checks the sub-row sibling (data-sap-ui-related) as a fallback.
   */
  function extractJmsMessageId(row) {
    // Primary: link text inside the main row
    const el = row.querySelector('.sapMLnkText') ||
               row.querySelector('a[class*="sapMLnk"] span') ||
               row.querySelector('a[class*="sapMLnk"]');
    const text = el?.textContent?.trim();
    if (text) return text;

    // Fallback: sub-row sibling
    if (row.id) {
      const subRow = document.querySelector(`[data-sap-ui-related="${row.id}"]`);
      if (subRow) {
        const subEl = subRow.querySelector('.sapMLnkText') ||
                      subRow.querySelector('a[class*="sapMLnk"] span');
        const subText = subEl?.textContent?.trim();
        if (subText) return subText;
      }
    }
    return null;
  }

  /**
   * Reads queue name from the DOM at call time.
   * Checks sapMLIBSelected FIRST (the actively loaded queue), then sapMLIBFocus
   * as a fallback (the last keyboard-focused item, which may differ).
   */
  function readJmsQueueNameFromDom() {
    // Priority order: Selected (active queue) → Focus (may be stale)
    for (const cls of ['sapMLIBSelected', 'sapMLIBFocus']) {
      for (const item of document.querySelectorAll(`[class*="${cls}"]`)) {
        if (!isJmsQueueRow(item)) continue;
        const name = extractQueueNameFromRow(item);
        if (name) return name;
      }
    }
    return null;
  }

  /**
   * Reads the currently selected JMS message row directly from the DOM.
   * SAP marks selected rows with aria-selected="true" — this is always set
   * regardless of whether our click listener fired, so it works as a reliable
   * fallback when the first-click race condition occurs.
   */
  function readSelectedJmsEntry() {
    for (const row of document.querySelectorAll(
      'tr.sapMListTblRow[aria-selected="true"], tr.sapMListTblRow.sapMLIBSelected'
    )) {
      const msgId = extractJmsMsgId(row);
      if (!msgId) continue; // queue rows have no valid JMS ID
      return {
        msgId,
        name:      readJmsQueueNameFromDom() || jmsQueueName || '',
        failed:    extractJmsFailed(row),
        messageId: extractJmsMessageId(row),
      };
    }
    return null;
  }

  /* ── View button click ────────────────────────────────────────────────── */
  async function onJmsViewClick(e) {
    e?.stopPropagation();

    // Primary: use cached selection from click listener.
    // Fallback: read SAP's aria-selected row directly from the DOM — covers the
    // first-click race where the row-click listener hadn't fired yet.
    const entry = jmsSelectedEntry ?? readSelectedJmsEntry();
    if (!entry) return;

    // Always re-read the queue name from DOM right before the API call.
    // The cached entry.name (or jmsQueueName) may be stale if the user switched
    // queues without triggering a queue-row click (e.g. scroll, arrow, keyboard).
    entry.name = readJmsQueueNameFromDom() || entry.name || jmsQueueName || '';
    if (!entry.name) {
      alert('SAP CPI Workmate\n\nCould not determine the queue name.\nPlease click directly on the queue name text in the left panel, then select a message row.');
      return;
    }

    const btn = e?.currentTarget ?? document.getElementById(JMS_BTN_ID);
    if (!btn) return;
    const origText = btn.textContent;
    btn.dataset.cpiEmpty = 'false';
    btn.textContent = '⏳ Loading…';

    try {
      const origin = `${location.protocol}//${location.host}`;
      const buffer = await fetchJmsPayload(origin, entry);
      const files  = await unzipFromBuffer(buffer);
      if (files.length === 0) throw new Error('Zip archive is empty.');

      // Prefer the clean Message ID column value for filenames;
      // fall back to sanitized JMS Message ID if the column was empty.
      const safeJmsId = entry.msgId.replace(/[:\\/?*|"<>\s]/g, '_');
      showOverlay(files, {
        storeName: entry.name,
        id:        entry.msgId,
        messageId: entry.messageId || safeJmsId,
      });
    } catch (err) {
      alert(`SAP CPI Workmate\n\n${err.message}`);
      console.error('[JMS Viewer]', err);
    } finally {
      btn.textContent = origText;
    }
  }

  /**
   * Fetches the JMS message zip directly via GET.
   * No CSRF token needed — this is a plain authenticated GET.
   * Response is a raw zip (ArrayBuffer).
   */
  async function fetchJmsPayload(origin, { msgId, name, failed }) {
    // Colons in Msgid must be percent-encoded (:  →  %3A)
    const encodedMsgId = encodeURIComponent(msgId);
    // /itspaces/ tenants expose the OData API under /itspaces/odata/…
    // /shell/    tenants expose it directly under /odata/…
    const apiBase = location.pathname.startsWith('/itspaces/')
      ? '/itspaces' + JMS_API_PATH
      : JMS_API_PATH;
    // Name is passed as-is — SAP expects the queue name unencoded in the OData key
    const url =
      `${origin}${apiBase}` +
      `(Msgid='${encodedMsgId}',Name='${name}',Failed=${failed})/$value`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream, */*' },
      credentials: 'include',
    });

    if (!res.ok) {
      throw new Error(
        `JMS API request failed: HTTP ${res.status} ${res.statusText}\n` +
        `URL: ${res.url}`
      );
    }
    return res.arrayBuffer();
  }

  /**
   * Unzips directly from an ArrayBuffer.
   * Used for JMS responses (raw zip) as opposed to the DS base64-inside-XML path.
   */
  async function unzipFromBuffer(buffer) {
    const zip     = await JSZip.loadAsync(buffer);
    const results = [];

    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;

      let content;
      let isBinary = false;
      try {
        content = await entry.async('string');
        if (content.includes('\x00')) {
          content  = await entry.async('base64');
          isBinary = true;
        }
      } catch {
        content  = await entry.async('base64');
        isBinary = true;
      }

      results.push({ name, content, isBinary });
    }

    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Message Processing Logs — Correlated Messages Viewer
   * ─────────────────────────────────────────────────────────────────────────
   * URL:  /shell/monitoring/Messages/*
   *
   * Injects a small button next to the Correlation ID on the Properties tab.
   * Clicking it fetches all messages sharing that Correlation ID via OData and
   * shows them in a table overlay. Clicking a row opens the message detail page
   * in a new tab.
   *
   * API:  GET /odata/api/v1/MessageProcessingLogs?$format=json
   *            &$orderby=LogEnd desc&$top=50
   *            &$filter=CorrelationId eq '<id>'
   * Auth: existing session cookies — no CSRF needed (GET request)
   * ───────────────────────────────────────────────────────────────────────── */

  /**
   * Finds the Correlation ID link rendered by SAPUI5 on the Properties tab
   * and injects a small "View Correlated" button immediately after it.
   * Safe to call repeatedly — skips re-injection if the same Correlation ID
   * is already present; removes and re-injects when the ID changes.
   */
  function injectCorrIdButton() {
    // SAP renders the Correlation ID as a link with a stable element id
    const corrLink =
      document.getElementById('MESSAGES_INFO_CORRELATION_ID') ||
      document.querySelector('a[id*="CORRELATION_ID"][class*="sapMLnk"]');

    if (!corrLink) {
      document.getElementById(MSG_BTN_ID)?.remove();
      // Correlation ID link not in DOM yet (SAPUI5 still rendering).
      // Retry up to CORR_ID_MAX_RETRIES times, 1 s apart, to handle both
      // SPA async renders and cold page-load scenarios (e.g. returning from
      // /shell/monitoring/MessageDetails which does a full page navigation).
      const url = location.href.toLowerCase();
      if (url.includes('/monitoring/messages') && !url.includes('messagequeues')
          && corrIdRetryCount < CORR_ID_MAX_RETRIES) {
        corrIdRetryCount++;
        clearTimeout(corrIdRetryTimer);
        corrIdRetryTimer = setTimeout(injectCorrIdButton, 1000);
      }
      return;
    }
    // Found — cancel any pending retry and reset counter
    clearTimeout(corrIdRetryTimer);
    corrIdRetryCount = 0;

    const corrId = corrLink.querySelector('.sapMLnkText')?.textContent?.trim();
    if (!corrId) return;

    // Skip if already injected for this exact Correlation ID
    const existing = document.getElementById(MSG_BTN_ID);
    if (existing && existing.dataset.corrId === corrId) return;
    existing?.remove();

    const btn = document.createElement('button');
    btn.id             = MSG_BTN_ID;
    btn.dataset.corrId = corrId;
    btn.className = 'sap-msg-corr-btn';
    btn.title     = `View all correlated messages (${corrId})`;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    btn.addEventListener('click', e => { e.stopPropagation(); onCorrIdClick(corrId); });

    corrLink.insertAdjacentElement('afterend', btn);

    // Start the Properties observer now that we know the section exists,
    // so SAPUI5 re-renders don't silently wipe our button.
    startMsgPropertiesObserver();
  }

  /** Fetches correlated messages and shows them in the table overlay. */
  async function onCorrIdClick(corrId) {
    const btn      = document.getElementById(MSG_BTN_ID);
    const origHTML = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }

    try {
      const origin = `${location.protocol}//${location.host}`;
      const pfx    = location.pathname.startsWith('/itspaces/') ? '/itspaces' : '';
      const filter = `CorrelationId eq '${corrId}'`;
      const url    =
        `${origin}${pfx}${MSG_LOG_API_PATH}` +
        `?$format=json&$orderby=LogStart desc&$top=50` +
        `&$filter=${encodeURIComponent(filter)}`;

      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`API error: HTTP ${res.status} ${res.statusText}`);

      const json     = await res.json();
      const messages = json?.d?.results ?? [];

      if (messages.length === 0) {
        alert(`SAP CPI Workmate\n\nNo messages found for Correlation ID:\n${corrId}`);
        return;
      }

      showMsgLogOverlay(messages, corrId);
    } catch (err) {
      alert(`SAP CPI Workmate\n\n${err.message}`);
      console.error('[Correlated Messages]', err);
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.blur(); }
    }
  }

  /**
   * Parses SAP OData date format /Date(milliseconds)/ into a
   * human-readable local datetime string.
   */
  function parseSapDate(dateStr) {
    const m = /\/Date\((\d+)\)\//.exec(dateStr ?? '');
    if (!m) return dateStr ?? '—';
    return new Date(parseInt(m[1])).toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  /** Returns a CSS class name for a given SAP message status string. */
  function msgStatusClass(status) {
    const s = (status ?? '').toUpperCase();
    if (s === 'COMPLETED')  return 'msg-status-completed';
    if (s === 'FAILED')     return 'msg-status-failed';
    if (s === 'RETRY')      return 'msg-status-retry';
    if (s === 'PROCESSING') return 'msg-status-processing';
    if (s === 'ESCALATED')  return 'msg-status-escalated';
    return 'msg-status-other';
  }

  /**
   * Renders the correlated-messages table overlay.
   * Each row is clickable and opens the message detail page in a new tab.
   */
  function showMsgLogOverlay(messages, corrId) {
    document.getElementById(MSG_LOG_OVERLAY_ID)?.remove();

    const origin    = `${location.protocol}//${location.host}`;
    const baseShell = location.pathname.startsWith('/itspaces/') ? '/itspaces/shell' : '/shell';
    const msgBase   = `${origin}${baseShell}/monitoring/Messages/`;

    const thStyle = () => '';

    // Column definitions: [label, sortKey, sortType]
    // sortType: 'str' | 'date' | 'duration'
    const COLS = [
      ['Status',           'Status',              'str'],
      ['Integration Flow', 'IntegrationFlowName', 'str'],
      ['Custom Status',    'CustomStatus',        'str'],
      ['App Message ID',   'ApplicationMessageId','str'],
      ['Sender',           'Sender',              'str'],
      ['Receiver',         'Receiver',            'str'],
      ['Start Time',       'LogStart',            'date'],
      ['End Time',         'LogEnd',              'date'],
      ['Duration',         '_duration',           'duration'],
      ['Message GUID',     'MessageGuid',         'str'],
    ];

    // Sort state — default: Start Time descending (matches API order)
    let sortCol = 'LogStart', sortDir = 'desc';

    function sapDateMs(val) {
      const m = /\/Date\((\d+)\)\//.exec(val ?? '');
      return m ? parseInt(m[1]) : 0;
    }

    function durationMs(msg) {
      const start = sapDateMs(msg.LogStart);
      const end   = sapDateMs(msg.LogEnd);
      return (start && end) ? end - start : 0;
    }

    function formatDuration(ms) {
      if (!ms || ms < 0) return '—';
      if (ms < 1000)          return `${ms} ms`;
      const s = Math.floor(ms / 1000),   rem1 = ms % 1000;
      if (s < 60)             return `${s}s ${rem1}ms`;
      const m = Math.floor(s / 60),      rem2 = s % 60;
      if (m < 60)             return `${m}m ${rem2}s`;
      const hh = Math.floor(m / 60),     rem3 = m % 60;
      if (hh < 24)            return `${hh}h ${rem3}m`;
      const d  = Math.floor(hh / 24),    rem4 = hh % 24;
      return `${d}d ${rem4}h`;
    }

    function sortedMessages() {
      return [...messages].sort((a, b) => {
        const col  = COLS.find(c => c[1] === sortCol);
        const type = col?.[2] ?? 'str';
        let cmp;
        if (type === 'date') {
          cmp = sapDateMs(a[sortCol]) - sapDateMs(b[sortCol]);
        } else if (type === 'duration') {
          cmp = durationMs(a) - durationMs(b);
        } else {
          cmp = String(a[sortCol] ?? '').localeCompare(String(b[sortCol] ?? ''));
        }
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }

    function buildRowsHtml(sorted) {
      return sorted.map(m => {
        const url = msgBase + JSON.stringify({ identifier: m.MessageGuid });
        return `
          <tr class="msg-log-row" data-url="${h(url)}">
            <td><span class="msg-status-badge ${msgStatusClass(m.Status)}">${h(m.Status ?? '—')}</span></td>
            <td class="msg-flow-cell" title="${h(m.IntegrationFlowName ?? '')}">${h(m.IntegrationFlowName ?? '—')}</td>
            <td>${h(m.CustomStatus ?? '—')}</td>
            <td class="msg-id-cell" title="${h(m.ApplicationMessageId ?? '')}">${h(m.ApplicationMessageId ?? '—')}</td>
            <td class="msg-meta-cell" title="${h(m.Sender ?? '')}">${h(m.Sender ?? '—')}</td>
            <td class="msg-meta-cell" title="${h(m.Receiver ?? '')}">${h(m.Receiver ?? '—')}</td>
            <td class="msg-time-cell">${h(parseSapDate(m.LogStart))}</td>
            <td class="msg-time-cell">${h(parseSapDate(m.LogEnd))}</td>
            <td class="msg-duration-cell">${h(formatDuration(durationMs(m)))}</td>
            <td class="msg-guid-cell">
              <div class="msg-guid-wrap">
                <span class="msg-guid-text">${h(m.MessageGuid ?? '—')}</span>
                <button class="msg-guid-copy-btn" data-guid="${h(m.MessageGuid ?? '')}" title="Copy Message GUID"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
              </div>
            </td>
          </tr>`;
      }).join('');
    }

    const rowsHtml = buildRowsHtml(sortedMessages());

    const themeClass = overlaySettings.theme === 'light' ? 'ds-theme-light' : '';
    const sizeClass  = overlaySettings.size !== 'm' ? `ds-size-${overlaySettings.size}` : '';

    const overlay = document.createElement('div');
    overlay.id    = MSG_LOG_OVERLAY_ID;
    overlay.innerHTML = `
      <div id="msg-log-backdrop"></div>
      <div id="msg-log-panel" class="${themeClass} ${sizeClass}">
        <div id="msg-log-header">
          <div id="msg-log-header-meta">
            <span id="msg-log-title">Correlated Messages</span>
            <span id="msg-log-corr-id" title="${h(corrId)}">${h(corrId)}</span>
            <button id="msg-log-corr-open-btn" title="Open correlated messages in new tab">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
            <span id="msg-log-count">${messages.length} message${messages.length !== 1 ? 's' : ''}</span>
          </div>
          <button id="msg-log-close-btn" title="Close (Esc)">✕</button>
        </div>
        <div id="msg-log-body">
          <table id="msg-log-table">
            <thead>
              <tr>
                ${COLS.map(([label, key], i) => `
                  <th class="msg-col-resizable msg-col-sortable${key === sortCol ? ' msg-col-sorted' : ''}"
                      data-sort-key="${key}" ${thStyle(i)}>
                    <span class="msg-col-label">${label}</span>
                    <span class="msg-sort-icon">${key === sortCol ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                  </th>`).join('')}
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // ── Attach row + copy handlers (called after every sort re-render) ───────
    function attachRowHandlers() {
      overlay.querySelectorAll('.msg-log-row').forEach(row => {
        row.addEventListener('click', () => window.open(row.dataset.url, '_blank'));
      });
      overlay.querySelectorAll('.msg-guid-copy-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          navigator.clipboard.writeText(btn.dataset.guid).then(() => {
            const orig = btn.innerHTML;
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            btn.classList.add('msg-guid-copied');
            setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('msg-guid-copied'); }, 1500);
          });
        });
      });
    }
    attachRowHandlers();

    // ── Column sort ───────────────────────────────────────────────────────────
    overlay.querySelectorAll('th.msg-col-sortable').forEach(th => {
      th.addEventListener('click', e => {
        // Ignore clicks on the resize handle itself
        if (e.target.closest('.msg-col-resize-handle')) return;
        // Ignore clicks that followed a resize drag — flag is set in onMove below
        if (th._cpiResized) { th._cpiResized = false; return; }
        const key = th.dataset.sortKey;
        if (sortCol === key) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = key;
          sortDir = 'asc';
        }
        // Re-render tbody
        overlay.querySelector('#msg-log-table tbody').innerHTML = buildRowsHtml(sortedMessages());
        attachRowHandlers();
        // Update header indicators
        overlay.querySelectorAll('th.msg-col-sortable').forEach(t => {
          const isActive = t.dataset.sortKey === sortCol;
          t.classList.toggle('msg-col-sorted', isActive);
          t.querySelector('.msg-sort-icon').textContent = isActive ? (sortDir === 'asc' ? '▲' : '▼') : '';
        });
      });
    });

    // ── Resizable columns ─────────────────────────────────────────────────────
    // Widths already baked into HTML from storage read above.
    // Inject drag handles and save on release using column index as key.
    const ths = Array.from(overlay.querySelectorAll('th.msg-col-resizable'));

    ths.forEach((th, idx) => {
      const handle = document.createElement('span');
      handle.className = 'msg-col-resize-handle';
      th.appendChild(handle);

      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        th._cpiResized = false;
        const startX = e.clientX;
        const startW = th.offsetWidth;

        const tip = document.createElement('div');
        tip.className   = 'msg-col-resize-tip';
        tip.textContent = `${startW}px`;
        tip.style.left  = `${e.clientX + 12}px`;
        tip.style.top   = `${e.clientY + 12}px`;
        document.body.appendChild(tip);

        const onMove = ev => {
          // Mark that a real drag happened — click handler will skip sorting
          if (Math.abs(ev.clientX - startX) > 3) th._cpiResized = true;
          const newW = Math.max(60, startW + ev.clientX - startX);
          th.style.width    = `${newW}px`;
          th.style.minWidth = `${newW}px`;
          tip.textContent   = `${newW}px`;
          tip.style.left    = `${ev.clientX + 12}px`;
          tip.style.top     = `${ev.clientY + 12}px`;
        };
        const onUp = () => {
          tip.remove();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });

    // Correlation ID header icon → open SAP messages page using correlation ID as identifier
    overlay.querySelector('#msg-log-corr-open-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      window.open(msgBase + JSON.stringify({ identifier: corrId }), '_blank');
    });

    // Close handlers
    function closeMsgOverlay() {
      overlay._removeKeyListener?.();
      overlay.remove();
    }
    overlay.querySelector('#msg-log-backdrop').addEventListener('click', closeMsgOverlay);
    overlay.querySelector('#msg-log-close-btn').addEventListener('click', closeMsgOverlay);
    const onKeyDown = e => { if (e.key === 'Escape') closeMsgOverlay(); };
    document.addEventListener('keydown', onKeyDown);
    overlay._removeKeyListener = () => document.removeEventListener('keydown', onKeyDown);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Message Attachment Viewer
   * ─────────────────────────────────────────────────────────────────────────
   * Injects an "Open" (eye) icon button next to every "Download attachment"
   * button in the Attachments tab of the Messages detail panel.
   *
   * Strategy — uses the same API SAP calls when loading the Attachments tab:
   *   GET /odata/api/v1/MessageProcessingLogs('<guid>')/Attachments?$format=json
   * This returns each attachment's Id (hex key) and ContentType.  We then
   * fetch the content via:
   *   GET /odata/api/v1/MessageProcessingLogAttachments('<Id>')/$value
   * and display it in the existing overlay with auto-formatting (XML/JSON/text).
   *
   * The MessageGuid is read from #MESSAGES_INFO_MESSAGE_GUID — a stable DOM
   * element SAP renders in the Properties panel.  No SAPUI5 model access or
   * script injection required.
   * ───────────────────────────────────────────────────────────────────────── */

  /**
   * Appends a file extension to an attachment name based on its MIME type,
   * so detectType() can identify the content even without a file extension.
   * SAP attachment names often lack extensions (e.g. "ODataV2_Request_Headers").
   */
  function attachExtension(name, contentType) {
    if (!contentType || /\.(xml|json|txt|html|csv)$/i.test(name)) return name;
    const ct = contentType.toLowerCase();
    if (ct.includes('xml'))  return name + '.xml';
    if (ct.includes('json')) return name + '.json';
    if (ct.includes('html')) return name + '.html';
    if (ct.includes('text')) return name + '.txt';
    return name;
  }

  /**
   * Reads the currently-selected message's GUID from the Properties panel.
   * SAP renders this in a stable element: id="MESSAGES_INFO_MESSAGE_GUID".
   */
  function readMessageGuid() {
    const el = document.getElementById('MESSAGES_INFO_MESSAGE_GUID');
    return el?.textContent?.trim() || null;
  }

  /**
   * Calls the OData Attachments navigation property for the given MessageGuid
   * and returns the array of attachment metadata objects.
   * Each object has: Id (hex key), Name, ContentType, PayloadSize, TimeStamp.
   */
  async function fetchAttachmentList(messageGuid) {
    const pfx    = location.pathname.startsWith('/itspaces/') ? '/itspaces' : '';
    const origin = `${location.protocol}//${location.host}`;
    const url    =
      `${origin}${pfx}/odata/api/v1/MessageProcessingLogs('${messageGuid}')` +
      `/Attachments?$format=json`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      throw new Error(
        `Attachment list API failed: HTTP ${res.status} ${res.statusText}`
      );
    }
    const json = await res.json();
    return json?.d?.results ?? [];
  }

  /**
   * Finds all "Download attachment" buttons in the Attachments table and
   * injects an "Open" eye icon button immediately after each one.
   * Safe to call repeatedly — skips buttons that already have an open button.
   */
  function injectAttachmentOpenButtons() {
    const dlButtons = document.querySelectorAll(
      'button[id*="MESSAGECONTENT_TABLE_ATTACHMENTS"][title="Download attachment"]'
    );
    if (!dlButtons.length) return;

    dlButtons.forEach(dlBtn => {
      const tr       = dlBtn.closest('tr');
      const nameCell = tr?.querySelectorAll('td')[1]; // Name column

      // Skip if already injected into the name cell
      if (nameCell?.querySelector(`.${ATTACH_OPEN_BTN_CLASS}`)) return;

      // Extract the zero-based row index from the SAP button id (ends in "-0", "-1", …)
      const idxMatch = dlBtn.id.match(/-(\d+)$/);
      const rowIdx   = idxMatch ? parseInt(idxMatch[1], 10) : -1;

      // Capture the visible attachment name NOW (before we mutate the cell by
      // appending our button), so the click handler can match by name rather
      // than by index — API response order ≠ UI table display order.
      const visibleName = nameCell?.textContent?.trim() || '';

      const openBtn = document.createElement('button');
      openBtn.className = ATTACH_OPEN_BTN_CLASS;
      openBtn.title = 'Open attachment in viewer';
      openBtn.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" ` +
        `viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
        `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>` +
        `<circle cx="12" cy="12" r="3"/></svg>`;

      openBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const origHTML        = openBtn.innerHTML;
        openBtn.disabled      = true;
        openBtn.style.opacity = '0.4';

        try {
          // 1. Get MessageGuid from the stable Properties-panel element
          const messageGuid = readMessageGuid();
          if (!messageGuid) {
            throw new Error(
              'Could not find Message GUID on this page.\n' +
              'Make sure the Properties tab is visible and a message is selected.'
            );
          }

          // 2. Fetch the attachment list for this message
          const attachments = await fetchAttachmentList(messageGuid);
          if (!attachments.length) {
            throw new Error('No attachments returned by the API for this message.');
          }

          // 3. Match by the visible name captured at injection time — most reliable
          //    because API response order does not match UI table display order.
          //    Fall back to row index, then first entry, if no name match found.
          const attachment =
            (visibleName && attachments.find(a => a.Name === visibleName)) ||
            (rowIdx >= 0 && rowIdx < attachments.length ? attachments[rowIdx] : null) ||
            attachments[0];

          const attachId    = attachment.Id;
          const name        = attachment.Name        || 'attachment';
          const contentType = attachment.ContentType || '';

          // 4. Fetch the raw attachment content
          const pfx    = location.pathname.startsWith('/itspaces/') ? '/itspaces' : '';
          const origin = `${location.protocol}//${location.host}`;
          const url    = `${origin}${pfx}${ATTACH_API_PATH}('${attachId}')/$value`;

          const res = await fetch(url, {
            method:      'GET',
            headers:     { Accept: '*/*' },
            credentials: 'include',
          });
          if (!res.ok) {
            throw new Error(
              `Content fetch failed: HTTP ${res.status} ${res.statusText}`
            );
          }

          const text = await res.text();

          // 5. Display in overlay with auto-formatting
          //    id:'' → no entry-ID row in header; download filename = name.ext
          const displayName = attachExtension(name, contentType);
          showOverlay(
            [{ name: displayName, content: text, isBinary: false }],
            { storeName: name, id: '', messageId: null }
          );

        } catch (err) {
          alert(`SAP CPI Workmate\n\nFailed to load attachment:\n${err.message}`);
          console.error('[Attachment Viewer]', err);
        } finally {
          openBtn.disabled      = false;
          openBtn.style.opacity = '';
          openBtn.innerHTML     = origHTML;
        }
      });

      // Append inside the SAP HLayout div that wraps the attachment name link.
      // The <td> has overflow:clip so we must inject inside the existing layout
      // container — appending directly to the <td> gets clipped invisibly.
      const nameLayout = nameCell?.querySelector('.sapUiHLayout') || nameCell;
      if (nameLayout) {
        // Allow the layout to grow to accommodate the button without bleeding
        // into adjacent table columns.
        nameLayout.style.overflow   = 'visible';
        nameLayout.style.display    = 'inline-flex';
        nameLayout.style.alignItems = 'center';
        if (nameCell) {
          nameCell.style.overflow  = 'visible';
          nameCell.style.whiteSpace = 'nowrap';
        }
        nameLayout.appendChild(openBtn);
      } else {
        dlBtn.insertAdjacentElement('afterend', openBtn);
      }
    });
  }

})();
