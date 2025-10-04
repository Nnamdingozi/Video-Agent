FROM node:20

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Set working dir
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install

# Copy rest of the code
COPY . .

# Build TypeScript
RUN npx tsc

# Start server
CMD ["node", "dist/server.js"]
