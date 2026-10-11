# Stage 1: Build the frontend bundle
FROM node:20-alpine AS builder
WORKDIR /app

# Copy root workspace manifests
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/

# Install dependencies for building frontend
RUN npm ci --workspace=codecollab-frontend

# Copy frontend and shared realtime client source code
COPY frontend ./frontend
COPY realtime ./realtime

# Build production distribution
WORKDIR /app/frontend
RUN npm run build

# Stage 2: Serve static bundle via Nginx
FROM nginx:alpine AS runner

# Remove default static files
RUN rm -rf /usr/share/nginx/html/*

# Copy built artifacts from builder stage
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy custom Nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
