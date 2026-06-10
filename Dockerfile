FROM node:20-alpine

RUN apk add --no-cache docker-cli-compose git

WORKDIR /app

COPY backend/package.json ./backend/
RUN cd backend && npm install --production

COPY backend/src ./backend/src
COPY frontend    ./frontend
COPY CHANGELOG.md ./

EXPOSE 3000

CMD ["node", "backend/src/server.js"]
