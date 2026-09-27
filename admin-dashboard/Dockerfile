FROM node:24-alpine AS deps
WORKDIR /app
COPY admin-dashboard/package.json admin-dashboard/package-lock.json* ./
RUN npm ci || npm install

FROM node:24-alpine AS builder
WORKDIR /app
# Build-time embedding policy: exact HTTPS origin of the Headmaster admin host,
# or empty for same-origin-only framing. NEXT_PUBLIC_* is inlined by the
# Next.js production build, so it must be present here — a runtime env value
# alone does not affect the compiled bundle.
ARG NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN=""
ENV NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN=$NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN
COPY tsconfig.base.json /tsconfig.base.json
COPY --from=deps /app/node_modules ./node_modules
COPY admin-dashboard/ ./
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --chown=node:node --from=builder /app/.next/standalone/app/ ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
RUN --mount=from=builder,source=/app,target=/build \
    cp -r /build/public ./public 2>/dev/null || true \
    && chown -R node:node /app
EXPOSE 3000
USER node
CMD ["node", "server.js"]
