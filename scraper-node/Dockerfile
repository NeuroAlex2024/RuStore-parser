FROM node:20-bookworm

WORKDIR /app
COPY package*.json ./
RUN npm install
# Устанавливаем только Chromium и все его системные зависимости
RUN npx playwright install chromium --with-deps
COPY src/ ./src/
COPY public/ ./public/
EXPOSE 3000
CMD ["node", "src/app.js"]
