# Use the latest Long-Term Support (LTS) slim image for a small and stable base.
# Node 20 is also a great choice. Using 18 is just a common practice for stability.
FROM node:18-slim

# Install FFmpeg and then clean up the package manager cache to keep the image small.
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Set the working directory for all subsequent commands.
WORKDIR /app

# Copy package files first. Docker caches this layer, so `npm install` only
# runs again if your package*.json files have changed, speeding up builds.
COPY package*.json ./

# Install ONLY production dependencies to keep the final image size down.
RUN npm install --omit=dev

# Copy the rest of your source code into the container.
COPY . .

# Build your TypeScript code. `npx` will use the `tsc` from your devDependencies
# which were available during the `npm install` before `COPY . .`.
# We need the full install for the build step. Let's correct this.

# Let's refine the installation steps for clarity and correctness.
FROM node:18-slim AS base
WORKDIR /app
COPY package*.json ./

FROM base AS builder
RUN npm install
COPY . .
RUN npm run build

FROM base
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

# Expose the port that your Express server listens on.
EXPOSE 3001

# ✅ THE CRITICAL FIX: The command to start your server.
# This MUST point to your compiled entry file: `dist/index.js`.
CMD ["node", "dist/index.js"]