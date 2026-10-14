
FROM node:22-alpine

WORKDIR /app/backend

COPY backend/package*.json ./

RUN npm ci

COPY backend/ ./

COPY frontend/ /app/frontend/

EXPOSE 3000

CMD ["node", "server.js"]
