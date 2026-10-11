FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json index.html server.mjs ./
COPY src src
RUN npm run build

FROM node:22-alpine
LABEL org.opencontainers.image.source=https://github.com/raviautar/reviewlution
LABEL org.opencontainers.image.title=reviewlution
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist
COPY server.mjs hub.mjs ./
EXPOSE 8090
CMD ["node", "server.mjs"]
