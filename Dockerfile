FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY lib/ ./lib/
COPY server.js ./

ENTRYPOINT ["node", "index.js"]
