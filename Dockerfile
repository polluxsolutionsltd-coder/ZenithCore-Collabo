FROM node:22-alpine
# PostgreSQL client and bash for the backup and restore scripts
RUN apk add --no-cache postgresql16-client bash coreutils
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build:web
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
