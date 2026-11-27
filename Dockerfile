FROM node:24.21.0-bookworm
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
CMD ["npm", "test"]
