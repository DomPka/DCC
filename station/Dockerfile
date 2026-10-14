# Car Counter station in a container:
#   docker build -t car-counter-station -f station/Dockerfile .
#   docker run -d --restart unless-stopped -p 8090:8090 \
#     -v $PWD/station/config.json:/app/station/config.json -v $PWD/station/data:/app/station/data \
#     -e GITHUB_TOKEN=... car-counter-station
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN cd station && npm install --omit=dev --ignore-scripts
EXPOSE 8090
CMD ["node", "station/station.mjs", "station/config.json"]
