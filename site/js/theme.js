/** Toggle light/dark for this page only (no cookies or storage). */
(function () {
  const root = document.documentElement;
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  function systemDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function effectiveDark() {
    const explicit = root.getAttribute('data-theme');
    if (explicit === 'dark') return true;
    if (explicit === 'light') return false;
    return systemDark();
  }

  function syncLabel() {
    const dark = effectiveDark();
    toggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
    toggle.textContent = dark ? 'Light theme' : 'Dark theme';
  }

  toggle.addEventListener('click', () => {
    const dark = effectiveDark();
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
    syncLabel();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (root.getAttribute('data-theme') === 'light' || root.getAttribute('data-theme') === 'dark') {
      return;
    }
    syncLabel();
  });

  syncLabel();
})();
