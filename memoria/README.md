# Memória compartilhada: servidor, backup, reserva e espelho

A memória que os agentes do board compartilham roda num servidor [ai-memory](https://github.com/akitaonrails/ai-memory),
de **Fabio Akita** ([@akitaonrails](https://github.com/akitaonrails)), licença MIT (release oficial, sem alteração). Esta pasta tem a **montagem** em volta dele: o serviço, o backup noturno, a reserva
para quando o servidor cair e o espelho que alimenta o grafo e o galpão do board.

```
 Máquina local: Claude Code · Codex · agy · opencode · board
   │  MCP + ganchos de captura, com token
   ▼  https://SEU-SERVIDOR.tailnet.ts.net:8443      (tailscale serve: só dentro da sua rede, nunca público)
 Servidor sempre ligado
   ai-memory serve · systemd, usuário próprio, só em 127.0.0.1
   │  toda madrugada (cron)
   └─ backup-memoria.sh ──▶ Google Drive (rclone, escopo drive.file)
 Máquina local, se o servidor cair:  memoria-reserva ligar
 Board: menu Memória (grafo e galpão) · menu Controle (backups e alertas)
```

| Arquivo | Onde roda | O que faz |
|---|---|---|
| `servidor/ai-memory.service` | servidor, systemd | o ai-memory com usuário próprio, só no loopback, com o sistema de arquivos travado |
| `servidor/backup-memoria.sh` | servidor, cron | instantâneo consistente, 14 no servidor, 90 dias no Drive; depois leva os dados do board |
| `mac/memoria-reserva` | máquina local | liga e desliga a memória local a partir do Drive e troca os 4 motores de servidor |
| `mac/memoria-obsidian` | máquina local (o board roda a cada 10 min) | espelha o wiki do servidor num cofre (`~/Documents/Memoria`), que também alimenta o grafo do board |
| `*.exemplo` | — | os arquivos de configuração, sem valores |

## Instalação

**No servidor** (Linux com systemd e Tailscale):

```bash
sudo install -m 755 ai-memory /usr/local/bin/ai-memory          # binário do release oficial
sudo useradd --system --home /var/lib/ai-memory ai-memory
sudo install -d -o ai-memory -g ai-memory -m 750 /var/lib/ai-memory /var/lib/ai-memory-backups
# /etc/ai-memory/env (640, root:ai-memory) a partir de servidor/ai-memory.env.exemplo; o token sai de:
ai-memory generate-auth-token
sudo cp servidor/ai-memory.service /etc/systemd/system/ && sudo systemctl enable --now ai-memory
sudo tailscale serve --bg --https=8443 http://127.0.0.1:49374     # só na tailnet
sudo cp servidor/backup-memoria.sh /usr/local/sbin/ && sudo cp servidor/cron.d/backup-memoria /etc/cron.d/
```

**Na máquina local:**

```bash
# ~/.ai-memory-env.sh (600) a partir de mac/ai-memory-env.exemplo
cp mac/memoria-reserva mac/memoria-obsidian ~/.local/bin/
source ~/.ai-memory-env.sh
for c in claude-code codex antigravity-cli open-code; do ai-memory install-mcp --client $c --server-url "$AI_MEMORY_SERVER_URL" --auth-token "$AI_MEMORY_AUTH_TOKEN" --apply; done
for a in claude-code codex antigravity-cli opencode; do ai-memory install-hooks --agent $a --server-url "$AI_MEMORY_SERVER_URL" --auth-token "$AI_MEMORY_AUTH_TOKEN" --apply; done
```

## O que aprendemos

- **Um servidor por pasta de dados, nunca dois.**
- **Nunca publique a memória na internet** (nada de Funnel/porta aberta): só dentro da sua rede, e com token.
- **O cron do macOS não lê `~/Documents`.** Por isso o backup roda no servidor, e o board é quem leva os dados dele até lá.
- **Use um client ID próprio no rclone**, com escopo `drive.file`: ele só enxerga as pastas de backup que criou.
- **Nenhum token nos scripts.** Eles leem de arquivos `600`/`640` fora do git.
- **Prove antes de confiar:** grave com um motor e procure com outro; restaure um backup do Drive de verdade.
