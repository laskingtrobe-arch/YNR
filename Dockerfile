# Runs the whole shop as one container: API, admin panel and storefront.
# Works on Fly.io, Railway, Google Cloud Run, or any Docker host.
FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached between code changes.
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/ ./server/
COPY storefront/ ./storefront/

# Database and uploads belong on a mounted volume, not the container layer,
# or every redeploy wipes the shop's orders.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    UPLOADS_DIR=/data/uploads \
    PORT=4000
VOLUME /data

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["npm", "start"]
