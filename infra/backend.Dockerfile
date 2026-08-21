# =====================================================================
# Backend Node.js + frontend compilado, en una imagen multi-etapa.
# =====================================================================

# ---------- Etapa 1: dependencias y compilacion ----------
FROM node:20-alpine AS constructor
WORKDIR /app

COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --no-audit --no-fund

COPY backend ./backend
COPY frontend ./frontend
COPY database ./database
COPY docs ./docs

RUN npm run --workspace backend build \
 && npm run --workspace frontend build

# ---------- Etapa 2: dependencias de produccion ----------
FROM node:20-alpine AS dependencias
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
RUN npm ci --omit=dev --no-audit --no-fund --workspace backend

# ---------- Etapa 3: imagen final ----------
FROM node:20-alpine AS final
ENV NODE_ENV=production TZ=America/Guatemala
WORKDIR /app

RUN apk add --no-cache tzdata mysql-client \
 && cp /usr/share/zoneinfo/America/Guatemala /etc/localtime \
 && echo "America/Guatemala" > /etc/timezone

COPY --from=dependencias /app/node_modules ./node_modules
COPY --from=constructor  /app/backend/dist ./dist
COPY --from=constructor  /app/frontend/dist ./frontend/dist
COPY --from=constructor  /app/database ./database
COPY --from=constructor  /app/docs ./docs
COPY backend/package.json ./package.json

# Principio de minimo privilegio: el servicio no corre como root.
RUN mkdir -p /datos/uploads && chown -R node:node /app /datos
USER node

EXPOSE 4000
CMD ["node", "dist/server.js"]
