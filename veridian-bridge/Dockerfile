FROM node:22-alpine

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
