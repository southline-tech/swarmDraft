/** Toggle light/dark for this page only (no cookies or storage). */
(function () {
  const root = document.documentElement;
  const toggles = [
    document.getElementById('theme-toggle'),
    document.getElementById('theme-toggle-mobile'),
  ].filter(Boolean);

  function applyCaptureHints() {
    const hash = location.hash.replace('#', '');
    if (hash === 'dark' || hash === 'light') {
      root.setAttribute('data-theme', hash);
    }
    if (location.search.includes('focus=download')) {
      const target = document.querySelector('.header-download');
      if (target instanceof HTMLElement) {
        requestAnimationFrame(() => target.focus());
      }
    }
  }

  function systemDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function effectiveDark() {
    const explicit = root.getAttribute('data-theme');
    if (explicit === 'dark') return true;
    if (explicit === 'light') return false;
    return systemDark();
  }

  function syncToggle(btn) {
    const dark = effectiveDark();
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.classList.toggle('is-dark', dark);
  }

  function syncAll() {
    for (const btn of toggles) syncToggle(btn);
  }

  function flipTheme() {
    const dark = effectiveDark();
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
    syncAll();
  }

  applyCaptureHints();

  for (const btn of toggles) {
    btn.hidden = false;
    btn.addEventListener('click', flipTheme);
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const explicit = root.getAttribute('data-theme');
    if (explicit === 'light' || explicit === 'dark') return;
    syncAll();
  });

  syncAll();
})();
