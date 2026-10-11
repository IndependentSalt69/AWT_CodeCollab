# Stage 1: Dependencies installation
FROM node:20-alpine AS dependencies
WORKDIR /app

# Copy root workspace manifests
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install backend production dependencies cleanly
RUN npm ci --omit=dev --workspace=codecollab-backend

# Stage 2: Runtime image
FROM node:20-alpine AS runner
WORKDIR /app

# Install wget for container health checks
RUN apk add --no-cache wget

ENV NODE_ENV=production
ENV PORT=5000

# Copy workspace dependencies and application files
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY backend ./backend
COPY realtime ./realtime
COPY execution ./execution
COPY database ./database

# Run as non-root user (built-in alpine node user, uid 1000)
USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:5000/health || exit 1

CMD ["node", "backend/src/index.js"]
