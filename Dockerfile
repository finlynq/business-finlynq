FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS dependencies

RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS builder

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM dependencies AS migrator

ARG BUSINESS_FINLYNQ_IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision=$BUSINESS_FINLYNQ_IMAGE_REVISION

COPY --chown=node:node . .
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "db:migrate"]

FROM dependencies AS worker-builder

COPY . .
RUN npx --no-install esbuild src/workers/auth-email-worker.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node24 \
  --packages=external \
  --outfile=/worker/auth-email-worker.mjs

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS worker-dependencies

RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS worker

ARG BUSINESS_FINLYNQ_IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision=$BUSINESS_FINLYNQ_IMAGE_REVISION

RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=worker-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=worker-builder --chown=node:node /worker/auth-email-worker.mjs ./auth-email-worker.mjs
USER node
CMD ["node", "auth-email-worker.mjs"]

FROM postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685 AS database

ARG BUSINESS_FINLYNQ_IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision=$BUSINESS_FINLYNQ_IMAGE_REVISION

# Keep first-cluster initialization inside the immutable image. Release
# snapshots may live on a noexec filesystem and are deleted after acceptance,
# so a host bind here would be both fragile and non-restartable.
COPY --chmod=0555 deploy/postgres/010-runtime-role.sh /docker-entrypoint-initdb.d/010-runtime-role.sh
COPY --chmod=0555 deploy/postgres/database-entrypoint.sh /usr/local/bin/business-finlynq-database-entrypoint
ENTRYPOINT ["business-finlynq-database-entrypoint"]
CMD ["postgres"]

FROM postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685 AS operations

ARG BUSINESS_FINLYNQ_IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision=$BUSINESS_FINLYNQ_IMAGE_REVISION

RUN apk add --no-cache age bash coreutils curl jq openssl rclone util-linux
COPY --chmod=0555 deploy/backup/run-backup.sh /usr/local/bin/business-finlynq-backup
COPY --chmod=0555 deploy/backup/check-latest-backup.sh /usr/local/bin/business-finlynq-check-latest-backup
COPY --chmod=0555 deploy/backup/verify-restore.sh /usr/local/bin/business-finlynq-verify-restore
COPY --chmod=0555 deploy/backup/verify-restored-runtime.sh /usr/local/bin/business-finlynq-verify-restored-runtime
COPY --chmod=0555 deploy/backup/verify-accounting-evidence.sh /usr/local/bin/business-finlynq-verify-accounting-evidence
COPY --chmod=0555 deploy/backup/record-restore-evidence.sh /usr/local/bin/business-finlynq-record-restore-evidence
COPY --chmod=0444 scripts/operations/accounting-evidence-query.sql /usr/local/share/business-finlynq/accounting-evidence-query.sql
COPY --chmod=0555 deploy/rollback/verify-legacy-app.sh /usr/local/bin/business-finlynq-verify-legacy-app
COPY --chmod=0555 deploy/backup/reconcile-restored-role.sh /usr/local/bin/business-finlynq-reconcile-restored-role
COPY --chmod=0555 deploy/postgres/010-runtime-role.sh /usr/local/bin/business-finlynq-reconcile-runtime-role
COPY --chmod=0555 deploy/postgres/015-auth-worker-role.sh /usr/local/bin/business-finlynq-provision-auth-worker-role
COPY --chmod=0555 deploy/postgres/020-backup-role.sh /usr/local/bin/business-finlynq-provision-backup-role
USER 70:70

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS acceptance

ARG BUSINESS_FINLYNQ_IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision=$BUSINESS_FINLYNQ_IMAGE_REVISION

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
  && npm cache clean --force
COPY --chown=pwuser:pwuser playwright.config.ts tsconfig.json ./
COPY --chown=pwuser:pwuser e2e ./e2e

ENV HOME=/tmp/playwright-home
ENV npm_config_cache=/tmp/npm-cache
USER pwuser
CMD ["./node_modules/.bin/playwright", "test"]

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runner

ARG BUSINESS_FINLYNQ_IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision=$BUSINESS_FINLYNQ_IMAGE_REVISION

RUN apk add --no-cache curl libc6-compat \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/live > /dev/null || exit 1

CMD ["node", "server.js"]
