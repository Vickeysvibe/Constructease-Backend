# syntax=docker/dockerfile:1
# One image runs both processes: `node dist/server.js` (API) and `node dist/worker.js` (jobs).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# Chromium renders PO / return PDFs. Noto covers ₹ and Indian scripts (e.g. Tamil product names).
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=true
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
