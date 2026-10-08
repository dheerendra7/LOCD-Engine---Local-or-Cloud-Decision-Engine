FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV PORT=8787

USER node

EXPOSE 8787

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["npm", "start"]
