# Use official Node.js LTS image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first (for better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm install --only=production

# Copy source code
COPY src/ ./src/

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "src/index.js"]
