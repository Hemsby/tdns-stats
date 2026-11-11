FROM node:20-alpine

RUN apk add --no-cache docker-cli-compose git

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY backend/src ./backend/src
COPY frontend/index.html ./frontend/index.html
COPY frontend/js          ./frontend/js
COPY frontend/css         ./frontend/css
COPY CHANGELOG.md ./

EXPOSE 3000

CMD ["node", "backend/src/server.js"]
