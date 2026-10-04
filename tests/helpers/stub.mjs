// Shared stubs for running the extra_bypasses modules outside a real browser.
// The modules are IIFEs that reference `unsafeWindow`, `window`, `document`,
// `sessionStorage`, GM_* etc. We build a sandbox where:
//   - `document` is a real jsdom document (real DOM queries)
//   - `window`/`unsafeWindow` are one plain fake object we fully control
//     (location.assign/reload/open are spies we can assert on)

export function makeFakeWindow(opts = {}) {
  const loc = {
    hostname: opts.hostname || "example.com",
    pathname: opts.pathname || "/",
    href: opts.href || `https://${opts.hostname || "example.com"}${opts.pathname || "/"}`,
    search: opts.search || "",
    protocol: "https:",
    assign: opts.onAssign || (() => {}),
    reload: opts.onReload || (() => {}),
    replace: opts.onReplace || (() => {}),
  };
  const store = new Map();
  const fakeSession = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const w = {
    location: loc,
    sessionStorage: fakeSession,
    localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0", vendor: "", language: "en-US" },
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ display: "", visibility: "visible" }),
    alert: () => {},
    open: opts.onOpen || (() => ({})),
    app_vars: undefined,
    vhit: undefined,
  };
  w.self = w;
  w.top = w;
  return { window: w, session: fakeSession, loc };
}

export function makeSandbox({ document, fakeWindow, extra = {} }) {
  // The modules access the DOM both via the bare `document` global and via
  // `W.document` — give the fake window the same jsdom document.
  fakeWindow.document = document;
  return {
    document,
    unsafeWindow: fakeWindow,
    window: fakeWindow,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    WeakSet,
    Object,
    JSON,
    Math,
    fetch: async () => { throw new Error("no network in tests"); },
    FormData: class {},
    ...extra,
  };
}

export function gmStubs(overrides = {}) {
  const stored = new Map();
  return {
    GM_setValue: (k, v) => stored.set(k, v),
    GM_getValue: (k, d) => (stored.has(k) ? stored.get(k) : d),
    GM_setClipboard: overrides.onClipboard || (() => {}),
    GM_registerMenuCommand: () => {},
    GM_addStyle: () => {},
    GM_openInTab: () => ({}),
    _stored: stored,
  };
}
