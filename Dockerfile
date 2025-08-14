# Use pre-built image with Puppeteer!
FROM ghcr.io/puppeteer/puppeteer:21.11.0

WORKDIR /app

# Copy only server.js and package.json
COPY package.json ./
COPY server.js ./

# Install only express (Puppeteer already installed!)
RUN npm install express

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
