// Apply the saved light/dark choice before the page paints (no flash). Browser storage is only a
// per-viewer convenience here; without it the OS setting is used.
try {
  const t = localStorage.getItem("factory-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch { /* storage blocked: follow the OS */ }
