/**
 * Push Notifications PWA — bridge Veridian (B2).
 *
 * Port de `veridian-analytics/lib/web-push.ts` + `lib/push-subscribe.ts`
 * vers le bridge polyrepo. Stockage Postgres via Prisma.
 *
 * Use case : un tenant peut envoyer une notif push à ses utilisateurs
 * PWA abonnés ("Nouvelle promo", "Devis prêt", etc.).
 *
 * Modèle :
 *   - PushSubscription (tenantId, endpoint unique, keys p256dh/auth, active)
 *   - PushNotification (audit log : targetCount / success / failure)
 *
 * VAPID : clés réutilisées du legacy `~/credentials/.all-creds.env` pour
 * ne PAS invalider les abonnements existants côté browser (cf. D2 migration).
 */

import type { PrismaClient } from "@prisma/client";
import webpush from "web-push";

// ─── Config VAPID ─────────────────────────────────────────────────────────

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export class PushConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushConfigError";
  }
}

let configured = false;
let cachedPublicKey = "";

/**
 * Configure web-push avec les clés VAPID. Idempotent — peut être appelé
 * plusieurs fois (utile pour les tests qui réinitialisent l'env).
 */
export function configureWebPush(cfg: VapidConfig): void {
  if (!cfg.publicKey || !cfg.privateKey) {
    throw new PushConfigError("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY required");
  }
  if (!cfg.subject.startsWith("mailto:") && !cfg.subject.startsWith("http")) {
    throw new PushConfigError(
      "VAPID_SUBJECT must start with mailto: or http(s)://",
    );
  }
  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  cachedPublicKey = cfg.publicKey;
  configured = true;
}

/**
 * Lit la config VAPID depuis process.env. Throw PushConfigError si manquant.
 */
export function readVapidConfigFromEnv(): VapidConfig {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  const subject =
    process.env.VAPID_SUBJECT ?? "mailto:robert.brunon@veridian.site";
  if (!publicKey || !privateKey) {
    throw new PushConfigError(
      "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY missing in env",
    );
  }
  return { publicKey, privateKey, subject };
}

/**
 * Retourne la clé publique VAPID. Vide si jamais configuré (mode dev).
 */
export function getVapidPublicKey(): string {
  return cachedPublicKey;
}

export function isConfigured(): boolean {
  return configured;
}

// Pour tests : reset
export function _resetForTests(): void {
  configured = false;
  cachedPublicKey = "";
}

// ─── Types payloads ───────────────────────────────────────────────────────

export interface SubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  siteId?: string;
  userAgent?: string;
  visitorId?: string;
}

export interface NotificationPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  tag?: string;
  sentBy?: string;
}

export interface SendResult {
  targetCount: number;
  successCount: number;
  failureCount: number;
  cleanedCount: number; // subs marquées active=false suite à 410 Gone
  notificationId: string;
}

// ─── Push sender abstraction (mockable) ───────────────────────────────────

/**
 * Type du sender. On l'injecte pour pouvoir mocker dans les tests sans
 * patcher le module `web-push` global.
 */
export type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options?: { TTL?: number },
) => Promise<{ statusCode: number }>;

let _sender: PushSender = async (subscription, payload, options) => {
  // Wrapper sur webpush.sendNotification qui peut throw avec statusCode 410.
  // On normalise en retour `{ statusCode }` capturé.
  try {
    const res = await webpush.sendNotification(subscription, payload, options);
    return { statusCode: res.statusCode ?? 201 };
  } catch (err) {
    const e = err as { statusCode?: number; body?: string };
    if (typeof e.statusCode === "number") {
      return { statusCode: e.statusCode };
    }
    throw err;
  }
};

export function setPushSenderForTests(sender: PushSender | null): void {
  if (sender) {
    _sender = sender;
  } else {
    // restore default (re-wrap webpush)
    _sender = async (subscription, payload, options) => {
      try {
        const res = await webpush.sendNotification(
          subscription,
          payload,
          options,
        );
        return { statusCode: res.statusCode ?? 201 };
      } catch (err) {
        const e = err as { statusCode?: number };
        if (typeof e.statusCode === "number") {
          return { statusCode: e.statusCode };
        }
        throw err;
      }
    };
  }
}

// ─── Subscribe / unsubscribe ──────────────────────────────────────────────

/**
 * Enregistre une PushSubscription côté browser pour un tenant.
 *
 * Idempotent par endpoint :
 *   - si endpoint déjà connu et tenantId match → met à jour keys + lastSeenAt + active=true
 *   - si endpoint déjà connu et tenantId DIFFÉRENT → re-attribue au nouveau tenant
 *     (cas browser réutilisé par un autre user sur un autre site Veridian)
 *   - sinon → INSERT
 */
export async function subscribePushClient(
  prisma: PrismaClient,
  tenantId: string,
  payload: SubscribePayload,
): Promise<{ id: string; created: boolean }> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    throw new Error(`tenant_not_found:${tenantId}`);
  }

  const existing = await prisma.pushSubscription.findUnique({
    where: { endpoint: payload.endpoint },
  });

  if (existing) {
    await prisma.pushSubscription.update({
      where: { endpoint: payload.endpoint },
      data: {
        tenantId,
        keys: payload.keys,
        siteId: payload.siteId ?? existing.siteId,
        userAgent: payload.userAgent ?? existing.userAgent,
        visitorId: payload.visitorId ?? existing.visitorId,
        lastSeenAt: new Date(),
        active: true,
      },
    });
    return { id: existing.id, created: false };
  }

  const created = await prisma.pushSubscription.create({
    data: {
      tenantId,
      endpoint: payload.endpoint,
      keys: payload.keys,
      siteId: payload.siteId,
      userAgent: payload.userAgent,
      visitorId: payload.visitorId,
    },
  });
  return { id: created.id, created: true };
}

/**
 * Marque une PushSubscription comme inactive (active=false).
 * No-op si l'endpoint n'est pas connu — pas d'erreur, le client a peut-être
 * déjà été cleané côté serveur via cleanup auto 410 Gone.
 */
export async function unsubscribePushClient(
  prisma: PrismaClient,
  endpoint: string,
): Promise<{ updated: boolean }> {
  const existing = await prisma.pushSubscription.findUnique({
    where: { endpoint },
  });
  if (!existing) {
    return { updated: false };
  }
  await prisma.pushSubscription.update({
    where: { endpoint },
    data: { active: false },
  });
  return { updated: true };
}

// ─── Send notification ────────────────────────────────────────────────────

/**
 * Envoie une notification push à toutes les subscriptions actives d'un
 * tenant. Log le résultat dans PushNotification.
 *
 * Cleanup auto : si le push provider retourne 410 Gone (browser
 * désinstallé) ou 404, la PushSubscription est marquée `active=false`
 * pour ne plus l'essayer.
 */
export async function sendNotificationToTenant(
  prisma: PrismaClient,
  tenantId: string,
  notification: NotificationPayload,
): Promise<SendResult> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    throw new Error(`tenant_not_found:${tenantId}`);
  }

  const subs = await prisma.pushSubscription.findMany({
    where: { tenantId, active: true },
  });

  // On insère d'abord le row PushNotification (targetCount), puis on
  // update success/failure à la fin. Permet d'avoir l'id à retourner même
  // si l'envoi crash entre-temps (audit complet).
  const log = await prisma.pushNotification.create({
    data: {
      tenantId,
      title: notification.title,
      body: notification.body,
      url: notification.url,
      icon: notification.icon,
      sentBy: notification.sentBy,
      targetCount: subs.length,
    },
  });

  if (subs.length === 0) {
    return {
      targetCount: 0,
      successCount: 0,
      failureCount: 0,
      cleanedCount: 0,
      notificationId: log.id,
    };
  }

  const payloadStr = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url,
    icon: notification.icon,
    tag: notification.tag,
  });

  let successCount = 0;
  let failureCount = 0;
  const goneIds: string[] = [];

  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      const keys = sub.keys as unknown as { p256dh: string; auth: string };
      const r = await _sender(
        { endpoint: sub.endpoint, keys },
        payloadStr,
        { TTL: 24 * 60 * 60 },
      );
      return { sub, statusCode: r.statusCode };
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      const code = r.value.statusCode;
      if (code >= 200 && code < 300) {
        successCount++;
      } else {
        failureCount++;
        if (code === 410 || code === 404) {
          goneIds.push(r.value.sub.id);
        }
      }
    } else {
      failureCount++;
    }
  }

  if (goneIds.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: goneIds } },
      data: { active: false },
    });
  }

  await prisma.pushNotification.update({
    where: { id: log.id },
    data: { successCount, failureCount },
  });

  return {
    targetCount: subs.length,
    successCount,
    failureCount,
    cleanedCount: goneIds.length,
    notificationId: log.id,
  };
}

// ─── Admin helpers (dashboard) ────────────────────────────────────────────

/**
 * Liste les subscribers actifs d'un tenant + count total (actif/inactif).
 */
export async function listSubscribers(
  prisma: PrismaClient,
  tenantId: string,
): Promise<{
  active: number;
  inactive: number;
  total: number;
  recent: Array<{
    id: string;
    endpoint: string;
    userAgent: string | null;
    visitorId: string | null;
    createdAt: Date;
    lastSeenAt: Date;
    active: boolean;
  }>;
}> {
  const all = await prisma.pushSubscription.findMany({
    where: { tenantId },
    orderBy: { lastSeenAt: "desc" },
    take: 200,
  });
  const active = all.filter((s) => s.active).length;
  const inactive = all.length - active;
  return {
    active,
    inactive,
    total: all.length,
    recent: all.map((s) => ({
      id: s.id,
      // tronque l'endpoint pour ne pas leaker l'URL complète
      endpoint: s.endpoint.slice(0, 80) + (s.endpoint.length > 80 ? "..." : ""),
      userAgent: s.userAgent,
      visitorId: s.visitorId,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      active: s.active,
    })),
  };
}

/**
 * Historique des notifications envoyées par un tenant (les 100 dernières).
 */
export async function listNotificationHistory(
  prisma: PrismaClient,
  tenantId: string,
): Promise<
  Array<{
    id: string;
    title: string;
    body: string;
    url: string | null;
    icon: string | null;
    targetCount: number;
    successCount: number;
    failureCount: number;
    sentAt: Date;
    sentBy: string | null;
  }>
> {
  const rows = await prisma.pushNotification.findMany({
    where: { tenantId },
    orderBy: { sentAt: "desc" },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    url: r.url,
    icon: r.icon,
    targetCount: r.targetCount,
    successCount: r.successCount,
    failureCount: r.failureCount,
    sentAt: r.sentAt,
    sentBy: r.sentBy,
  }));
}
