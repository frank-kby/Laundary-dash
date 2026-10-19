# Portable image for moving off the free tier (any container host). Not required for Render's native Node runtime.
FROM node:22-slim AS build
WORKDIR /app
COPY server/package*.json server/
COPY web/package*.json web/
RUN npm ci --prefix server && npm ci --prefix web
COPY server server
COPY web web
RUN npm run build --prefix web && npm run build --prefix server && npm prune --omit=dev --prefix server

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/server/package.json /app/server/openapi.yaml server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
