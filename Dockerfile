FROM node:18-alpine

WORKDIR /usr/src/app

# Copy only package files first (better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy rest of the project
COPY . .

# Render injects PORT automatically
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/index.js"]
