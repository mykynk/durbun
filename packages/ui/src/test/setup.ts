// jsdom gaps used by the UI (kept minimal; tests that need specific behavior stub it themselves).
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
  (globalThis as { CSS?: { escape(s: string): string } }).CSS = { escape: (s: string) => s.replace(/["\\\]\[]/g, '\\$&') };
}
