// ── Version (read from manifest so it never needs manual updating) ────────────
const { version } = chrome.runtime.getManifest();
document.getElementById('header-version').textContent = `v ${version}`;
document.getElementById('about-version').textContent  = `🔖 ${version}`;

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

/** Marks the active segment button in a segmented control. */
function setActive(ctrlId, dataAttr, value) {
  document.querySelectorAll(`#${ctrlId} .seg-btn`).forEach(btn => {
    btn.classList.toggle('seg-active', btn.dataset[dataAttr] === value);
  });
}

// Load saved settings and reflect them in the UI
chrome.storage.local.get({ overlaySize: 'm', overlayTheme: 'dark', overlayFont: 'm', autoFormat: true }, s => {
  setActive('size-ctrl',  'size',  s.overlaySize);
  setActive('theme-ctrl', 'theme', s.overlayTheme);
  setActive('font-ctrl',  'font',  s.overlayFont);
  document.getElementById('auto-format-toggle').checked = s.autoFormat;
});

// Size buttons
document.getElementById('size-ctrl').addEventListener('click', e => {
  const btn = e.target.closest('[data-size]');
  if (!btn) return;
  setActive('size-ctrl', 'size', btn.dataset.size);
  chrome.storage.local.set({ overlaySize: btn.dataset.size });
});

// Theme buttons
document.getElementById('theme-ctrl').addEventListener('click', e => {
  const btn = e.target.closest('[data-theme]');
  if (!btn) return;
  setActive('theme-ctrl', 'theme', btn.dataset.theme);
  chrome.storage.local.set({ overlayTheme: btn.dataset.theme });
});

// Font size buttons
document.getElementById('font-ctrl').addEventListener('click', e => {
  const btn = e.target.closest('[data-font]');
  if (!btn) return;
  setActive('font-ctrl', 'font', btn.dataset.font);
  chrome.storage.local.set({ overlayFont: btn.dataset.font });
});

// Auto Format toggle
document.getElementById('auto-format-toggle').addEventListener('change', e => {
  chrome.storage.local.set({ autoFormat: e.target.checked });
});
