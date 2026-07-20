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
RUN mkdir -p sys_storge && chown -R nestjs:nodejs sys_storge
USER nestjs
EXPOSE 3000
CMD ["node", "dist/server.js"]
