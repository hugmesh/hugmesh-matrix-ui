# hugmesh-matrix-ui — builds the Matrix native-federation REMOTE
# (projects/matrix → dist/matrix) and serves it via nginx with CORS so the
# hugmesh.systems host can fetch its remoteEntry.json cross-origin.
# Deployed to the hugmesh-frontend namespace, fronted by the fe-gateway at
# /social/matrix. (projects/host is a local dev/E2E shell only, not deployed.)
# Angular CLI 22 requires Node >= 24.15.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# --base-href is LOAD-BEARING: the remote is served under /social/matrix/, and
# without it the built assets resolve at / and fall through to the SPA
# catch-all (200 text/html instead of JS) — the app renders blank. Every UI in
# the stack carries its own mount-path flag (cf. login-ui's /login/).
RUN npm run build:matrix -- --base-href=/social/matrix/

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/matrix/browser /usr/share/nginx/html
EXPOSE 80
