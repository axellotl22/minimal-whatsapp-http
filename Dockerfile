FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./

CMD ["sh", "-c", "npm install && node src/index.js"]
