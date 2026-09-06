FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV SHELL=/bin/bash
ENV TERM=xterm-256color
ENV HERDR_E2E=1
ENV HERDR_SESSION=canvas-e2e
ENV PATH="/usr/local/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    libasound2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    util-linux \
    unzip \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash

RUN curl -fsSL https://herdr.dev/install.sh | sh

RUN install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
    && install -m 0755 /root/.local/bin/herdr /usr/local/bin/herdr \
    && useradd --create-home --shell /bin/bash canvas

RUN curl -fsSL https://terminal-browser.sh/install \
    | XDG_DATA_HOME=/opt XDG_BIN_HOME=/usr/local/bin AGENT_SKILLS_HOME=/tmp/terminal-browser-skills TERMINAL_BROWSER_SKIP_EDITOR_SETUP=1 bash

WORKDIR /src
COPY package.json bun.lock tsconfig.json herdr-plugin.toml ./
COPY src ./src
COPY e2e ./e2e
COPY examples ./examples
COPY skills ./skills

RUN bun install --frozen-lockfile

ENV HOME=/home/canvas
USER canvas

CMD ["bun", "e2e/inside.ts"]
