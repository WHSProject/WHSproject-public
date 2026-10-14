# =========================
# Build stage
# =========================
FROM node:26-alpine AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build


# =========================
# Runtime stage
# =========================
FROM node:26-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=80
ENV HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# 첫 Admin 생성 스크립트: docker compose exec dashboard node create-admin.js <username>
# standalone에 들어 있는 pg를 씁니다.
COPY --from=builder --chown=node:node /app/scripts/create-admin.js ./create-admin.js

USER node

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/api/health || exit 1

CMD ["node", "server.js"]
