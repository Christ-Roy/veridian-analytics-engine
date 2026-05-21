import { useEffect } from 'react';

/**
 * Composant client minimal qui enregistre le Service Worker au mount.
 * À injecter dans le layout racine — ne rend rien visuellement.
 *
 * V1 stub : enregistre simplement `/sw.js` avec scope `/`. La logique push
 * (subscribe via pushManager + persistance backend) sera ajoutée par le
 * ticket B2 (push-pwa-port).
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[PWA] Erreur enregistrement Service Worker:', error);
      });
  }, []);

  return null;
}
