FROM node:20-alpine

RUN apk add --no-cache docker-cli-compose git

WORKDIR /app

# The server only needs the runtime dependencies. Prettier and ESLint are
# development tools and are left out of the image.
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY backend/src ./backend/src
COPY frontend    ./frontend
COPY CHANGELOG.md ./

EXPOSE 3000

CMD ["node", "backend/src/server.js"]
