FROM node:22-alpine AS runtime

# Patch the alpine base ahead of node:22-alpine rebumping its base.
# Historiquement ciblé sur libssl3/libcrypto3 (CVE-2026-45447), désormais
# ÉLARGI À TOUS LES PAQUETS : nommer les paquets à corriger un par un oblige à
# repasser derrière chaque nouvelle CVE, et la liste est toujours en retard
# d'une publication. `apk upgrade` sans argument remonte tout ce qui a un
# correctif, ce qui est exactement l'intention.
#
# 🔴 Cette couche n'a d'effet que si elle est RÉELLEMENT EXÉCUTÉE : `--no-cache`
# est une option d'apk, elle ne désactive PAS le cache de couches de buildkit.
# Tant que le digest de node:22-alpine ne bouge pas, la clé de cache est stable
# et `cache-from: type=gha` resservait cette couche sans jamais la jouer
# (mesuré sur notifuse-veridian, run 33254429451 : `RUN apk upgrade … CACHED`).
# D'où le nom de stage `runtime` et `no-cache-filters: runtime` + `pull: true`
# dans les workflows. Ne PAS renommer ce stage sans les corriger.
RUN apk upgrade --no-cache

WORKDIR /app

RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app

COPY package.json package-lock.json tsconfig.json ./
COPY prisma ./prisma

# `npm ci` lance le postinstall script qui fait `prisma generate`.
# On reste --omit=dev pour ne pas inclure prisma CLI en image finale (sauf
# si on en a besoin pour `migrate deploy` au boot — voir CMD).
RUN npm ci --omit=optional && npm cache clean --force

COPY src ./src

# npm et npx ne sont pas nécessaires au runtime : Prisma et tsx sont installés
# localement. Les retirer supprime aussi les dépendances vulnérables embarquées
# dans le npm global de l'image Node officielle.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    && chown -R app:app /app

USER app

EXPOSE 3002

# Au boot : applique les migrations si nécessaires puis démarre le bridge.
# `migrate deploy` est idempotent, safe à lancer même sans migration en attente.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma && exec ./node_modules/.bin/tsx src/index.ts"]
