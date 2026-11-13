FROM node:22-alpine

LABEL org.opencontainers.image.title="wififree" \
      org.opencontainers.image.description="Proxy, DNS-over-HTTPS resolver and fast built-in browser for restrictive Wi-Fi" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# No dependencies: copying the sources is the whole install step.
COPY package.json README.md LICENSE ./
COPY bin ./bin
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    WIFIFREE_HOST=0.0.0.0 \
    WIFIFREE_SOCKS_HOST=0.0.0.0

EXPOSE 8085 1080

# Health endpoint is also handy for orchestrators.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8085/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

ENTRYPOINT ["node", "bin/wififree.js"]
CMD ["serve", "--lan"]
