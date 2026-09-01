# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nestjs -G nodejs
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Kept for the LOCAL driver (spec 012 T070): development and the e2e suites run
# STORAGE_DRIVER=local and write a real `sys_storge` directory — the
# constitution's name, retained. Under STORAGE_DRIVER=gcs nothing writes here
# and the directory is simply unused; it costs nothing and removing it would
# make one image unable to run the other configuration.
RUN mkdir -p sys_storge && chown -R nestjs:nodejs sys_storge
USER nestjs
EXPOSE 3000
CMD ["node", "dist/server.js"]
