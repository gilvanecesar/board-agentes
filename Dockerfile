# board — imagem com tudo para rodar: Node, git, tmux e o Claude Code.
#   docker run -d --name board -p 127.0.0.1:4488:4488 \
#     -e CLAUDE_CODE_OAUTH_TOKEN=... \
#     -v ~/projetos:/projetos -v board-data:/app/data \
#     ghcr.io/gilvanecesar/board-agentes:latest
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tmux openssh-client procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force \
 # os projetos vêm montados do host, com outro dono: sem isto o git recusa ("dubious ownership")
 && git config --system --add safe.directory '*'

WORKDIR /app
COPY --chown=node:node . /app
RUN mkdir -p /app/data /projetos && chown -R node:node /app/data /projetos

# Dentro do container a tela escuta em todas as interfaces; publique a porta SÓ no 127.0.0.1 do host.
# As rotinas de fundo (cópia para um servidor, espelho da memória) ficam desligadas: ligue com BOARD_SEM_ROTINAS=0.
ENV BOARD_HOST=0.0.0.0 \
    BOARD_PORT=4488 \
    BOARD_PROJETOS=/projetos \
    BOARD_SEM_ROTINAS=1

USER node
VOLUME ["/app/data"]
EXPOSE 4488
LABEL org.opencontainers.image.title="board" \
      org.opencontainers.image.description="Bancada local para agentes de IA: fila, esteira de conferência e memória em galpão" \
      org.opencontainers.image.source="https://github.com/gilvanecesar/board-agentes" \
      org.opencontainers.image.licenses="MIT"
ENTRYPOINT []
CMD ["bash", "./board.sh"]
