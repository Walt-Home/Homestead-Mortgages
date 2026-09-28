# Multi-stage: build the whole workspace, ship only the API and the built SPA.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY turbo.json tsconfig.base.json ./
# Every workspace's manifest, so `npm ci` sees the same tree the lockfile
# describes. apps/servicing is Doug's runtime and never ships in this image —
# it is its own service — but its manifest is in the lockfile like the rest.
COPY packages/shared/package.json packages/shared/
COPY packages/kernel/package.json packages/kernel/
COPY packages/partner-book/package.json packages/partner-book/
COPY packages/refi-review/package.json packages/refi-review/
COPY packages/requirements/package.json packages/requirements/
COPY packages/connectors/package.json packages/connectors/
COPY packages/underwriting/package.json packages/underwriting/
COPY packages/du-schema/package.json packages/du-schema/
COPY packages/du/package.json packages/du/
COPY packages/brand/package.json packages/brand/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/console/package.json apps/console/
COPY apps/servicing/package.json apps/servicing/
RUN npm ci

COPY . .
RUN npm run db:generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules

# The root package.json has no "type" field, so Node treats the bundled ESM
# entrypoint as ambiguous, warns MODULE_TYPELESS_PACKAGE_JSON, and reparses it
# as ESM on every cold start. A three-line manifest declaring the module type
# is enough — the runtime stage needs nothing else from the root manifest.
RUN printf '{\n  "name": "homestead-mortgages-runtime",\n  "private": true,\n  "type": "module"\n}\n' > package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/console/dist ./apps/console/dist

EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]
