FROM node:20-alpine

LABEL maintainer="ckpool-webui"
LABEL description="WebUI for CKPool Solo Mining Pool"

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Note: Running as root to access ckpool socket (owned by root)
# Container isolation provides security

# Expose port
EXPOSE 3000

# Install curl for healthcheck
RUN apk add --no-cache curl

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# Start application
CMD ["node", "server.js"]
