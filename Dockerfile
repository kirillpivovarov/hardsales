FROM node:22-bookworm-slim AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY server/seeds/exchange_data/ /build/server/seeds/exchange_data/
RUN npm run build

FROM node:22-bookworm-slim AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
ENV PORT=3001
ENV SERVE_WEB_DIR=/app/web
COPY --chown=node:node --from=server-build /build/server/package.json /build/server/package-lock.json ./
COPY --chown=node:node --from=server-build /build/server/node_modules/ ./node_modules/
COPY --chown=node:node --from=server-build /build/server/dist/ ./dist/
COPY --chown=node:node --from=server-build /build/server/migrations/ ./migrations/
COPY --chown=node:node --from=server-build /build/server/seeds/ ./seeds/
COPY --chown=node:node --from=web-build /build/web/dist/ /app/web/
USER node
EXPOSE 3001
CMD ["node", "--enable-source-maps", "dist/main.js"]
