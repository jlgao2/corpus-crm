FROM node:22-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# serve.js statically imports ./lib/redactions.js and lazily imports the rest
# of pipeline/lib — all of it must be present or Node exits at startup.
COPY pipeline/serve.js pipeline/serve.js
COPY pipeline/lib pipeline/lib
COPY pipeline/output-demo pipeline/output-demo

ENV DATA_DIR=/app/pipeline/output-demo
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "pipeline/serve.js"]
