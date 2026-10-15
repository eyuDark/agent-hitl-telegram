# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps ./apps

RUN npm ci --no-audit --no-fund
RUN npx prisma generate
RUN npx tsc -b

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG APP=gateway-api
ENV HITL_APP=${APP}
COPY --from=build /app ./
EXPOSE 3000
CMD ["sh", "-c", "node apps/${HITL_APP}/dist/index.js"]
