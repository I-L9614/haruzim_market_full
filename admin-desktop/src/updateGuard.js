// Reports in-flight mutating requests to the desktop main process so an
// approved update install never closes the app in the middle of a save
// (a half-written product or a partial image upload must never be discarded).
// Read-only GET traffic is not tracked. No-op outside the packaged desktop
// app (the bridge only exists there).
const bridge = window.haruzimDesktop;

if (bridge?.reportUpdateGuard && typeof window.fetch === 'function') {
  let pendingWrites = 0;
  const report = () => {
    try { bridge.reportUpdateGuard({ pendingWrites }); } catch { /* guard must never break the app */ }
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return originalFetch(input, init);
    pendingWrites += 1;
    report();
    try {
      return await originalFetch(input, init);
    } finally {
      pendingWrites = Math.max(0, pendingWrites - 1);
      report();
    }
  };
  report();
}
