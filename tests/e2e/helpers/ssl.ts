/**
 * SSL certificate checks — via openssl/tls socket Node.
 *
 * Pas de dépendance externe : on utilise `tls.connect` (built-in node) pour
 * récupérer le peerCertificate, puis on vérifie issuer + notAfter.
 *
 * Pourquoi pas du `curl --cert-status` ? Parce qu'on veut une assertion claire
 * dans Playwright avec retry/timeout normal.
 */

import tls from "node:tls";

export interface CertInfo {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  daysUntilExpiry: number;
  isLetsEncrypt: boolean;
}

/**
 * Récupère les infos du cert TLS pour un hostname (port 443).
 */
export function getCertInfo(hostname: string, port = 443): Promise<CertInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        // On veut le cert même si la chaîne a un souci local
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate(true);
        socket.end();
        if (!cert || Object.keys(cert).length === 0) {
          return reject(new Error(`No peer cert for ${hostname}`));
        }
        const issuerCN = cert.issuer?.CN ?? "";
        const issuerO = cert.issuer?.O ?? "";
        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const daysUntilExpiry = Math.floor(
          (validTo.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );
        const isLetsEncrypt =
          /Let.?s Encrypt/i.test(issuerO) ||
          /^R\d+$/.test(issuerCN) || // Let's Encrypt R10/R11/R12/R13
          /^E\d+$/.test(issuerCN); // Let's Encrypt E5/E6
        resolve({
          subject: cert.subject?.CN ?? hostname,
          issuer: `${issuerO} (${issuerCN})`,
          validFrom,
          validTo,
          daysUntilExpiry,
          isLetsEncrypt,
        });
      },
    );
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error(`TLS connect timeout for ${hostname}`));
    });
    socket.on("error", reject);
  });
}
