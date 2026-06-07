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

  /* ─────────────────────────────────────────────────────────────────────────
   * State
   * ───────────────────────────────────────────────────────────────────────── */

  // ── Data Stores state ────────────────────────────────────────────────────
  /** @type {{ id: string, storeName: string, qualifier: string, messageId: string | null } | null} */
  let selectedEntry = null;

  /** WeakSet so we never double-attach click listeners to a table element */
  const tablesWatched = new WeakSet();

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

  /** Most-recently clicked queue name from the left panel */
  let jmsQueueName = null;

  const jmsTablesWatched  = new WeakSet();
  let   jmsToolbarObserver = null;

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
    btn.disabled  = !selectedEntry;
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
    // SAPUI5 renders its list/table items inside elements with these classes
    const containers = document.querySelectorAll(
      'table[class*="sapMList"], .sapMList, [class*="sapUiTableCnt"], ' +
      '[class*="sapMListItems"]'
    );
    containers.forEach(container => {
      if (tablesWatched.has(container)) return;
      tablesWatched.add(container);
      // Use capture=true so we get the event before SAPUI5 can stop propagation
      container.addEventListener('click', onTableRowClick, { capture: true, passive: true });
    });
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
      btn.disabled = false;
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

  /* ─────────────────────────────────────────────────────────────────────────
   * View button click handler
   * ───────────────────────────────────────────────────────────────────────── */
  async function onViewClick(e) {
    // Stop SAPUI5 from reacting to clicks on our injected toolbar button,
    // which would trigger a toolbar re-render and nullify our btn reference.
    e?.stopPropagation();
    if (!selectedEntry) return;

    // Use e.currentTarget — always the clicked element even if detached from DOM.
    const btn = e?.currentTarget ?? document.getElementById(BTN_ID);
    if (!btn) return;
    const origText = btn.textContent;
    btn.disabled   = true;
    btn.textContent = '⏳ Loading…';

    try {
      const origin = `${location.protocol}//${location.host}`;

      // 1. Obtain CSRF token (SAP requires this for POST requests)
      const csrfToken = await fetchCsrfToken(origin);

      // 2. Call the payload API
      const xmlText = await fetchPayload(origin, csrfToken, selectedEntry);

      // 3. Extract the base64-encoded zip from the XML response
      const base64 = extractBase64FromXml(xmlText);
      if (!base64) throw new Error('No <payload> element found in the API response.');

      // 4. Decode base64 → Uint8Array → JSZip
      const files = await decodeAndUnzip(base64);
      if (files.length === 0) throw new Error('Zip archive is empty.');

      // 5. Show the overlay
      showOverlay(files, selectedEntry);

    } catch (err) {
      alert(`SAP CPI Workmate\n\n${err.message}`);
      console.error('[DS Viewer]', err);
    } finally {
      btn.disabled    = false;
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
      codeEl.style.whiteSpace = isWrapped ? 'pre-wrap' : 'pre';
      wrapBtn.textContent     = isWrapped ? 'No Wrap' : 'Wrap';
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
            <div class="ds-id-row">
              <span id="ds-entry-id" title="${h(id)}">${h(id)}</span>
              <button class="ds-mini-copy" id="ds-copy-entry-id" title="Copy ID">Copy</button>
            </div>
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
    btn.disabled  = !jmsSelectedEntry;
    btn.title     = jmsSelectedEntry
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
    const containers = document.querySelectorAll(
      'table[class*="sapMList"], .sapMList, [class*="sapUiTableCnt"], [class*="sapMListItems"]'
    );
    containers.forEach(container => {
      if (jmsTablesWatched.has(container)) return;
      jmsTablesWatched.add(container);
      container.addEventListener('click', onJmsRowClick, { capture: true, passive: true });
    });
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
          oldBtn.disabled = true;
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
    const name = jmsQueueName || readJmsQueueNameFromDom() || '';

    jmsSelectedEntry = { msgId, name, failed, messageId };

    const btn = document.getElementById(JMS_BTN_ID);
    if (btn) {
      btn.disabled = false;
      btn.title    = name
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
   * Extracts the JMS Message ID (e.g. "ID:10.157.178.781f719e478df7a80:53").
   *
   * Uses a TreeWalker over raw text nodes so it works in both layouts:
   *   • Table layout  — ID text sits inside a <td>
   *   • Responsive list layout — ID text sits inside a <span> or <bdi>
   */
  function extractJmsMsgId(row) {
    // Older tenants use "ID:10.157.178.78:..." format
    // Newer tenants use "x-hex-000000000000001a" format (SAP updated ~2026)
    const JMS_ID_RE = /^ID:\d+\.\d+|^x-hex-[0-9a-f]+/i;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim() || '';
      if (JMS_ID_RE.test(text)) return text;
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

  /* ── View button click ────────────────────────────────────────────────── */
  async function onJmsViewClick(e) {
    e?.stopPropagation();
    if (!jmsSelectedEntry) return;

    // Resolve queue name if not already captured (e.g. queue selected via > arrow)
    if (!jmsSelectedEntry.name) {
      jmsSelectedEntry.name = jmsQueueName || readJmsQueueNameFromDom() || '';
    }
    if (!jmsSelectedEntry.name) {
      alert('SAP CPI Workmate\n\nCould not determine the queue name.\nPlease click directly on the queue name text in the left panel, then select a message row.');
      return;
    }

    const btn = e?.currentTarget ?? document.getElementById(JMS_BTN_ID);
    if (!btn) return;
    const origText = btn.textContent;
    btn.disabled    = true;
    btn.textContent = '⏳ Loading…';

    try {
      const origin = `${location.protocol}//${location.host}`;
      const buffer = await fetchJmsPayload(origin, jmsSelectedEntry);
      const files  = await unzipFromBuffer(buffer);
      if (files.length === 0) throw new Error('Zip archive is empty.');

      // Prefer the clean Message ID column value for filenames;
      // fall back to sanitized JMS Message ID if the column was empty.
      const safeJmsId = jmsSelectedEntry.msgId.replace(/[:\\/?*|"<>\s]/g, '_');
      showOverlay(files, {
        storeName: jmsSelectedEntry.name,
        id:        jmsSelectedEntry.msgId,
        messageId: jmsSelectedEntry.messageId || safeJmsId,
      });
    } catch (err) {
      alert(`SAP CPI Workmate\n\n${err.message}`);
      console.error('[JMS Viewer]', err);
    } finally {
      btn.disabled    = false;
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

})();
