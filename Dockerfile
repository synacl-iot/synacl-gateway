# syntax=docker/dockerfile:1
#
# synacl-gateway as a container. State lives in the /data volume:
#   docker run --rm -it -v synacl:/data ghcr.io/synacl-iot/synacl-gateway init --broker … --tenant … --gateway … --user … --pass …
#   docker run -d --init --restart unless-stopped -v synacl:/data --name synacl-gateway ghcr.io/synacl-iot/synacl-gateway
# Add --network host for the machine's real network counters (net.rx_bps / net.tx_bps).

FROM node:24-alpine

LABEL org.opencontainers.image.title="synacl-gateway" \
      org.opencontainers.image.description="Reference gateway for the Synacl IoT platform: host metrics, local MQTT bridge, Modbus TCP" \
      org.opencontainers.image.source="https://github.com/synacl-iot/synacl-gateway" \
      org.opencontainers.image.url="https://synacl.com/protocol/" \
      org.opencontainers.image.documentation="https://github.com/synacl-iot/synacl-gateway#readme" \
      org.opencontainers.image.vendor="Synacl Labs" \
      org.opencontainers.image.licenses="Apache-2.0"

# SYNACL_HOST_DISK_PATH: the host driver's disk.used_pct reports the /data volume, not the
# container's overlay root.
ENV NODE_ENV=production \
    SYNACL_GATEWAY_HOME=/data \
    SYNACL_HOST_DISK_PATH=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY bin ./bin
COPY src ./src
COPY protocol ./protocol
COPY LICENSE NOTICE README.md CHANGELOG.md ./

# /data owned by `node` so a new named volume inherits it; the symlink makes
# `docker exec <container> synacl-gateway status` work.
RUN mkdir -p /data \
 && chown node:node /data \
 && chmod 0700 /data \
 && chmod 0755 /app/bin/synacl-gateway.js \
 && ln -s /app/bin/synacl-gateway.js /usr/local/bin/synacl-gateway

USER node
VOLUME /data
ENTRYPOINT ["node", "/app/bin/synacl-gateway.js"]
CMD ["run"]
