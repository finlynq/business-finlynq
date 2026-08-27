FROM node:24-alpine AS dependencies

RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS builder

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM dependencies AS migrator

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

FROM node:24-alpine AS worker-dependencies

RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:24-alpine AS worker

RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=worker-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=worker-builder --chown=node:node /worker/auth-email-worker.mjs ./auth-email-worker.mjs
USER node
CMD ["node", "auth-email-worker.mjs"]

FROM postgres:16-alpine AS operations

RUN apk add --no-cache age bash coreutils curl jq openssl rclone util-linux
COPY --chmod=0555 deploy/backup/run-backup.sh /usr/local/bin/business-finlynq-backup
COPY --chmod=0555 deploy/backup/verify-restore.sh /usr/local/bin/business-finlynq-verify-restore
COPY --chmod=0555 deploy/backup/verify-restored-runtime.sh /usr/local/bin/business-finlynq-verify-restored-runtime
COPY --chmod=0555 deploy/rollback/verify-legacy-app.sh /usr/local/bin/business-finlynq-verify-legacy-app
COPY --chmod=0555 deploy/backup/reconcile-restored-role.sh /usr/local/bin/business-finlynq-reconcile-restored-role
COPY --chmod=0555 deploy/postgres/010-runtime-role.sh /usr/local/bin/business-finlynq-reconcile-runtime-role
COPY --chmod=0555 deploy/postgres/015-auth-worker-role.sh /usr/local/bin/business-finlynq-provision-auth-worker-role
COPY --chmod=0555 deploy/postgres/020-backup-role.sh /usr/local/bin/business-finlynq-provision-backup-role
USER 70:70

FROM node:24-alpine AS runner

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
