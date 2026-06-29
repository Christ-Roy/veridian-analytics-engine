/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Config Vitest console. Historiquement scopée STRICTEMENT sur src/veridian/**,
// ce qui laissait TOUT le code hérité staminads (src/lib, src/components,
// src/hooks) sans aucun filet de test — d'où l'incident prod 2026-06-29 où un
// crash `undefined.toFixed()` dans un widget dashboard a planté tous les
// workspaces sans qu'aucun test ne le détecte. On ramasse désormais aussi les
// tests co-localisés (`<dir>/__tests__/*.test.*`) du code partagé.
//
// On n'embarque pas Tailwind (pas nécessaire pour Vitest+RTL : on teste la
// structure DOM + les data-testid, pas le rendu CSS visuel) ni TanStack Router
// (qui a besoin de tsr generate avant tsc). Vitest reste isolé du build console
// upstream — `npm run build` continue d'utiliser vite.config.ts.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/veridian/__tests__/**/*.test.{ts,tsx}',
      'src/veridian/pages/__tests__/**/*.test.{ts,tsx}',
      // Code hérité staminads — tests co-localisés (lib de formatage, widgets
      // dashboard, hooks). Ajouté après l'incident prod 2026-06-29.
      'src/lib/**/__tests__/**/*.test.{ts,tsx}',
      'src/components/**/__tests__/**/*.test.{ts,tsx}',
      'src/hooks/**/__tests__/**/*.test.{ts,tsx}',
    ],
    // Ne ramasse JAMAIS les tests des dossiers gelés/archivés (features
    // débranchées commercialement, cf. CLAUDE.md VISION SCOPE).
    exclude: [
      'node_modules',
      'dist',
      'scripts/**',
      'src/veridian/_archive/**',
      'src/veridian/_optional-features/**',
    ],
    setupFiles: ['./src/veridian/__tests__/setup.ts'],
    css: false,
  },
});
