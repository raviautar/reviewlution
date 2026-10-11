FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts vite.lib.config.ts tsconfig.json tsconfig.lib.json index.html server.mjs ./
COPY src src
RUN npm run build && npm run build:lib

FROM node:22-alpine
LABEL org.opencontainers.image.source=https://github.com/raviautar/reviewlution
LABEL org.opencontainers.image.title=reviewlution
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist
COPY --from=build /app/dist-lib dist-lib
COPY server.mjs hub.mjs ./
EXPOSE 8090
CMD ["node", "server.mjs"]
