# ZenithCore FMIS 4.0 – one image for the API and the CBS payment sandbox.
FROM node:22-alpine

# PostgreSQL 16 client tools and bash for scripts/backup.sh and scripts/restore.sh
RUN apk add --no-cache postgresql16-client bash coreutils

WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force

COPY . .
RUN npm run build:web \
 && mkdir -p /app/backups \
 && chown -R node:node /app/backups

# Never run as root
USER node
ENV PORT=8080 BACKUP_DIR=/app/backups
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["npm", "start"]
