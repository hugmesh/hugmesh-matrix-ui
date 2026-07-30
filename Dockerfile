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
RUN npm run build:matrix

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/matrix/browser /usr/share/nginx/html
EXPOSE 80
