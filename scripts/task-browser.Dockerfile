# Preload this image on the PSM host. Browser packages are never installed by project code.
FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/psm-browsers
RUN npm install --prefix /opt/psm-browser --ignore-scripts --no-audit --no-fund playwright@1.64.0 \
    && /opt/psm-browser/node_modules/.bin/playwright install --with-deps chromium \
    && chmod -R a+rX /opt/psm-browser /opt/psm-browsers \
    && rm -rf /var/lib/apt/lists/*
