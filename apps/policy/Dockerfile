FROM node:24-bookworm-slim AS build

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/policy/package.json apps/policy/tsconfig.json apps/policy/
COPY apps/scanner/package.json apps/scanner/package.json
RUN pnpm install --filter policy --frozen-lockfile

COPY apps/policy/src apps/policy/src
RUN pnpm --filter policy build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/policy/package.json apps/policy/package.json

RUN pnpm install --filter policy --prod --frozen-lockfile

COPY --from=build /workspace/apps/policy/dist ./apps/policy/dist

WORKDIR /app/apps/policy

ENV NODE_ENV=production
ENV POLICY_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
