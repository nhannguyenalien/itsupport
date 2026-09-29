# Backend: multi-tenant API (Fastify + pg). See docs/v0.1-spec.md.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# registry.json is read at runtime relative to the compiled file — tsc doesn't
# copy non-TS assets, so place it next to dist/tool-registry/index.js.
RUN mkdir -p dist/tool-registry && cp src/tool-registry/registry.json dist/tool-registry/registry.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
