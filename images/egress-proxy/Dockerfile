# Shira egress proxy. Build from the repo root:
#   pnpm build:egress && docker build -f images/egress-proxy/Dockerfile -t shira-egress-proxy .
FROM node:22-slim
COPY dist/egress-proxy.mjs /app/egress-proxy.mjs
USER node
EXPOSE 3128 8080
ENTRYPOINT ["node", "/app/egress-proxy.mjs"]
