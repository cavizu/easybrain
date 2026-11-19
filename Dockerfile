FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
COPY skills ./skills

RUN npm run build

VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV STORAGE_PROVIDER=auto

EXPOSE 3000

CMD ["node", "dist/api/server.js"]
