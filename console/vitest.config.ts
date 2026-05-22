/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Config Vitest dédiée — SCOPÉE STRICTEMENT sur src/veridian/**.
// On n'embarque pas Tailwind (pas nécessaire pour Vitest+RTL : on teste
// la structure DOM + les data-testid, pas le rendu CSS visuel) ni TanStack
// Router (qui a besoin de tsr generate avant tsc). Vitest reste isolé du
// build console upstream — `npm run build` continue d'utiliser vite.config.ts.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/veridian/__tests__/**/*.test.{ts,tsx}',
      'src/veridian/pages/__tests__/**/*.test.{ts,tsx}',
    ],
    exclude: ['node_modules', 'dist', 'scripts/**'],
    setupFiles: ['./src/veridian/__tests__/setup.ts'],
    css: false,
  },
});
