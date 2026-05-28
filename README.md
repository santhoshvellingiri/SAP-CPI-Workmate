# SAP CPI Workmate

> A Chrome extension for SAP Integration Suite that lets you inspect **Data Store** and **JMS Queue** message payloads directly in your browser — no Postman, no copy-pasting, no manual API calls.

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-SAP%20Integration%20Suite-orange)

---

## Features

- **View Data** button injected into the Data Stores and Message Queues monitoring pages
- Fetches payloads using your existing browser session — no extra login
- Unzips the response in-browser and shows all files in a VS Code-style overlay
- Syntax highlighting for JSON and XML
- Line numbers, full-text search (with Prev / Next navigation)
- Configurable overlay size, theme (dark / light), and font size
- Works on any `*.hana.ondemand.com` tenant — both Cloud Foundry (`/shell/`) and Neo (`/itspaces/shell/`) landscapes

---

## Supported pages

| Page | URL pattern |
|------|-------------|
| Data Stores | `.../shell/monitoring/DataStores` |
| Data Stores (Neo) | `.../itspaces/shell/monitoring/DataStores` |
| Message Queues | `.../shell/monitoring/MessageQueues` |
| Message Queues (Neo) | `.../itspaces/shell/monitoring/MessageQueues` |

---

## Installation

### From Chrome Web Store *(recommended)*

Search for **SAP CPI Workmate** on the [Chrome Web Store](https://chrome.google.com/webstore) and click **Add to Chrome**.

### Manual (Developer mode)

1. Clone or download this repository
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository folder
5. The extension is now active — no restart needed

---

## How to use

### Data Stores

1. Navigate to **Monitor → Data Stores** in SAP Integration Suite
2. Click a data store in the left panel to open its entries
3. Click any row in the **Entries** table to select it
4. Click the **View Data** button (appears next to *Filter by ID*)
5. Browse files in the left sidebar — use **Format**, **Wrap**, **Copy**, or **Download** as needed

### JMS Message Queues

1. Navigate to **Monitor → Message Queues**
2. Click a queue in the left panel
3. Click any message row in the right panel to select it
4. Click the **View Data** button
5. Inspect the message payload in the overlay

---

## How it works

| Step | Detail |
|------|--------|
| Auth | Uses your existing browser session cookies (`credentials: 'include'`). No credentials are stored or transmitted outside your tenant. |
| CSRF (Data Stores) | `GET /Operations/` with `X-CSRF-Token: Fetch` — token is read from the response header and used for the POST request. |
| DS API | `POST /Operations/com.sap.esb.monitoring.datastore.access.command.GetDataStorePayloadCommand` |
| DS Response | XML containing a base64-encoded zip — decoded and unzipped in-browser via JSZip. |
| JMS API | `GET /odata/api/v1/JmsMessages(MessageId='...',QueueName='...')/$value` |
| JMS Response | Raw zip binary (ArrayBuffer) — unzipped in-browser via JSZip. |
| Hostname | Always derived from `window.location.host` — nothing is hardcoded. |

---

## Settings

Open the extension popup (click the toolbar icon) → **Settings** tab:

| Setting | Options |
|---------|---------|
| Overlay Size | Small (72%) · **Medium (86%)** · Large (95%) |
| Theme | **Dark** · Light |
| Code Font Size | Small (11px) · **Medium (12.5px)** · Large (14.5px) |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Button doesn't appear | Reload the page — SAPUI5 may still be rendering. |
| Button stays greyed out | Click a row in the entries table first, then click View Data. |
| "Could not obtain a CSRF token" | Ensure you are fully logged in on a `*.hana.ondemand.com` page. |
| HTTP 403 on API call | Your session may have expired — refresh the page and try again. |
| "No `<payload>` element" | Unexpected API response — check DevTools → Network for details. |
| Binary / garbled content | The file is binary (e.g. an image) — shown as base64 text by design. |

---

## Project structure

```
├── manifest.json      Chrome MV3 extension manifest
├── content.js         Core logic — button injection, API calls, overlay
├── overlay.css        Overlay and button styles
├── popup.html         Extension popup UI
├── popup.js           Popup settings logic
├── jszip.min.js       JSZip library (in-browser zip extraction)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Privacy

This extension does not collect, store, or transmit any user data. All API calls are made directly to your SAP Integration Suite tenant using your existing browser session. No data leaves your browser beyond what is necessary to call the SAP APIs on your own tenant.

---

## License

MIT © 2025–2026 Santhosh Kumar Vellingiri

This extension is not affiliated with or endorsed by SAP SE.
"# SAP-CPI-Workmate" 
