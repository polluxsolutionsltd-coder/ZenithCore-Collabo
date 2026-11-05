FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build:web
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
