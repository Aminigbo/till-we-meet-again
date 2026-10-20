# For Google Cloud Run (or any container host). Cloud Run gives the container Firebase
# credentials automatically when it runs in the same Google Cloud project.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
