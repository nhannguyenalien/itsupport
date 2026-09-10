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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
