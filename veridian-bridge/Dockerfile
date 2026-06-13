FROM node:22-alpine

# Patch the alpine base openssl ahead of node:22-alpine rebumping its base:
# CVE-2026-45447 (HIGH) in libssl3/libcrypto3 3.5.6-r0 is fixed in 3.5.7-r0.
# Trivy Étage 2 (image scan, bloquant) fails the staging deploy otherwise.
# Real fix (a patched version exists) — NOT a .trivyignore exception.
# Remove once node:22-alpine ships a base with openssl >= 3.5.7-r0.
RUN apk upgrade --no-cache libssl3 libcrypto3

WORKDIR /app

RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app

COPY package.json package-lock.json tsconfig.json ./
COPY prisma ./prisma

# `npm ci` lance le postinstall script qui fait `prisma generate`.
# On reste --omit=dev pour ne pas inclure prisma CLI en image finale (sauf
# si on en a besoin pour `migrate deploy` au boot — voir CMD).
RUN npm ci --omit=optional && npm cache clean --force

COPY src ./src

# Optionally chown for non-root
RUN chown -R app:app /app

USER app

EXPOSE 3002

# Au boot : applique les migrations si nécessaires puis démarre le bridge.
# `migrate deploy` est idempotent, safe à lancer même sans migration en attente.
CMD ["sh", "-c", "npx prisma migrate deploy --schema=./prisma/schema.prisma && npx tsx src/index.ts"]
