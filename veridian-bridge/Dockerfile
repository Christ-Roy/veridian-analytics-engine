FROM node:22-alpine

WORKDIR /app

RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src

USER app

EXPOSE 3002

CMD ["npx", "tsx", "src/index.ts"]
