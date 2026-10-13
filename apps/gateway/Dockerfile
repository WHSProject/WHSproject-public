# =========================
# Build stage
# =========================
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build


# =========================
# Runtime stage
# =========================
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV GATEWAY_PORT=3000

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.GATEWAY_PORT || 3000; fetch('http://127.0.0.1:' + p + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start:prod"]
