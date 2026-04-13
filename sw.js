// Minimal service worker required for PWA installability.
// No caching — the dashboard is always localhost and needs live data.
self.addEventListener("fetch", () => {});
