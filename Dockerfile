# Multi-stage: build the whole workspace, ship only the API and the built SPA.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/requirements/package.json packages/requirements/
COPY packages/connectors/package.json packages/connectors/
COPY packages/underwriting/package.json packages/underwriting/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run db:generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]
