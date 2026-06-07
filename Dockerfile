FROM node:20-alpine

RUN apk add --no-cache docker-cli-compose

WORKDIR /app

COPY backend/package.json ./backend/
RUN cd backend && npm install --production

COPY backend/src ./backend/src
COPY frontend    ./frontend

EXPOSE 3000

CMD ["node", "backend/src/server.js"]
