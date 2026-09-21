# Doug's servicing runtime, as a container of its own.
#
# One image, the modes his `src/runtime/main.ts` has, driven through our
# `scripts/run.mjs` so the environment vocabulary in the container is the one
# the rest of this repo uses (SERVICING_DATABASE_URL, SERVICING_API_TOKEN,
# SERVICING_PORT …) rather than his (DATABASE_URL, API_TOKEN, PORT):
#
#   docker run IMAGE serve       the API, the sweep endpoint and the ops console
#   docker run IMAGE migrate     apply db/migrations through his migrate.sh, then exit
#   docker run IMAGE sweep       one pass of every scheduled job, then exit
#   docker run IMAGE seed-demo   the 100-loan batch, the entry demo, the 12-loan book
#
# Built from the REPOSITORY ROOT (`docker build -f apps/servicing/Dockerfile .`)
# so the workspace lockfile resolves his three dependencies; nothing of ours
# is installed into it. The shape follows his own Dockerfile at the vendored
# commit: node 22 on bookworm-slim running the TypeScript sources with type
# stripping, psql present for db/migrate.sh, xmllint present because his DU
# schema module shells out to it and throws without it — the same gap that
# failed 235 of his tests in CI once.
#
# Nothing under apps/servicing/src is edited to know about any of this; see
# apps/servicing/README.md.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates libxml2-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# The root manifest and lockfile plus the one workspace manifest, so `npm ci`
# can install exactly that workspace's dependency tree and nothing else's.
COPY package.json package-lock.json ./
COPY apps/servicing/package.json apps/servicing/
RUN npm ci --workspace=@hm/servicing --omit=dev && npm cache clean --force

# His whole tree, as vendored: the runtime reads spec/, db/, docs/ux/12 and
# fixtures/ at run time, and tools/ is what one of his tests imports.
COPY apps/servicing apps/servicing
RUN chmod +x apps/servicing/db/migrate.sh && chown -R node:node /app

USER node
WORKDIR /app/apps/servicing

# Cloud Run sets PORT; run.mjs reads SERVICING_PORT and defaults to 8090, so
# the service pins SERVICING_PORT=8080 and Cloud Run listens there.
ENV SERVICING_PORT=8080 SERVICING_LOG_FORMAT=json SERVICING_INTEGRATIONS=fake SERVICING_ENVIRONMENT=nonprod
EXPOSE 8080

ENTRYPOINT ["node", "scripts/run.mjs"]
CMD ["serve"]
