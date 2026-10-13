FROM node:24-bookworm-slim AS build

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/scanner/package.json apps/scanner/package.json

RUN pnpm install --filter scanner --frozen-lockfile

COPY apps/scanner apps/scanner

RUN pnpm --filter scanner build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ARG SEMGREP_VERSION=1.172.0
ARG GUARDDOG_VERSION=3.1.0
ENV GUARDDOG_TOP_PACKAGES_CACHE_LOCATION=/opt/guarddog-cache

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && python3 -m venv /opt/semgrep \
  && /opt/semgrep/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" \
  && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep \
  && python3 -m venv /opt/guarddog \
  && /opt/guarddog/bin/pip install --no-cache-dir "guarddog==${GUARDDOG_VERSION}" \
  && ln -s /opt/guarddog/bin/guarddog /usr/local/bin/guarddog \
  && mkdir -p "${GUARDDOG_TOP_PACKAGES_CACHE_LOCATION}" \
  && cp /opt/guarddog/lib/python3.11/site-packages/guarddog/analyzer/metadata/resources/top_npm_packages.json "${GUARDDOG_TOP_PACKAGES_CACHE_LOCATION}/top_npm_packages.json" \
  && cp /opt/guarddog/lib/python3.11/site-packages/guarddog/analyzer/metadata/resources/top_pypi_packages.json "${GUARDDOG_TOP_PACKAGES_CACHE_LOCATION}/top_pypi_packages.json" \
  && cp /opt/guarddog/lib/python3.11/site-packages/guarddog/analyzer/metadata/resources/top_rubygems_packages.json "${GUARDDOG_TOP_PACKAGES_CACHE_LOCATION}/top_rubygems_packages.json" \
  && cp /opt/guarddog/lib/python3.11/site-packages/guarddog/analyzer/metadata/resources/top_go_packages.json "${GUARDDOG_TOP_PACKAGES_CACHE_LOCATION}/top_go_packages.json" \
  && /opt/guarddog/bin/python -c 'import guarddog.analyzer.metadata' \
  && /opt/guarddog/bin/python -c 'import json, os, time; root=os.environ["GUARDDOG_TOP_PACKAGES_CACHE_LOCATION"]; names=("top_npm_packages.json", "top_pypi_packages.json", "top_rubygems_packages.json"); stale=[name for name in names if (lambda d: not isinstance(d.get("downloaded_timestamp"), int) or time.time() - d["downloaded_timestamp"] > 30 * 86400)(json.load(open(os.path.join(root, name))))]; assert not stale, "GuardDog metadata cache prewarm incomplete: " + ", ".join(stale)' \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /workspace/apps/scanner/package.json ./apps/scanner/package.json
COPY --from=build /workspace/apps/scanner/dist ./apps/scanner/dist
COPY --from=build /workspace/apps/scanner/rules ./apps/scanner/rules

ENV SCANNER_TEMP_DIR=/tmp/scanner

RUN mkdir -p "${SCANNER_TEMP_DIR}" \
  && chmod 1777 "${SCANNER_TEMP_DIR}"

RUN pnpm install --filter scanner --prod --frozen-lockfile

ENV NODE_ENV=production
ENV SCANNER_PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["pnpm", "--filter", "scanner", "start"]

# Local-static external artifact backend. The production runtime stage above
# remains unchanged; callers must build and address this target by digest.
FROM runtime AS external-guarddog

USER 65532:65532
ENTRYPOINT ["guarddog"]
