import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom n'implémente pas `matchMedia` — requis par les composants AntDesign
// responsive (Steps, Grid, Card…). Polyfill no-op pour que RTL puisse monter
// les composants AntD du dossier veridian (onboarding `welcome`, etc.).
// AntD appelle `matchMedia(q)` PUIS `listener(mql)` qui déstructure `{ matches }`
// → le retour doit TOUJOURS exposer `matches` (jamais undefined).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList,
});
