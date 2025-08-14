# Multi-stage build לבנייה מהירה יותר
FROM node:20-slim AS base

# התקנת Chromium בלבד (לא Chrome!) - הרבה יותר קל ומהיר
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/*

# Stage 2: Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json ./

# התקנת dependencies עם cache טוב יותר
RUN npm install --production --no-audit --no-fund

# Stage 3: Final
FROM base AS runner
WORKDIR /app

# העתקת dependencies מ-stage קודם
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# יצירת user (מהיר יותר)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

# Chromium paths
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
