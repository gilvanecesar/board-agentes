#!/bin/bash
# Backup noturno da memória compartilhada (ai-memory) do Saturno para o Google Drive.
# Roda pelo /etc/cron.d/backup-memoria. Log: /var/log/backup-memoria.log
# Situação para a tela de Monitoramento do board: /var/lib/backup-memoria/{ULTIMO_OK,ULTIMO_FALHOU}
set -uo pipefail
source /etc/backup-remoto.env   # BOARD_DATA: onde o board espelha a pasta data/
DIR=/var/lib/ai-memory-backups/diarios
EST=/var/lib/backup-memoria
LOG=/var/log/backup-memoria.log
install -d -m750 -o ai-memory -g ai-memory "$DIR"; install -d -m755 "$EST"
agora() { date "+%F %T%z"; }
ARQ="$DIR/memoria-$(date +%Y%m%d-%H%M).tar.gz"
echo "== $(agora) início" >> "$LOG"
falha() { date -Iseconds > "$EST/ULTIMO_FALHOU"; echo "!! $(agora) FALHOU: $1" >> "$LOG"; exit 1; }
sudo -u ai-memory env HOME=/var/lib/ai-memory-backups AI_MEMORY_AUTH_TOKEN="$(sed -n "s/AI_MEMORY_AUTH_TOKEN=//p" /etc/ai-memory/env)" \
  /usr/local/bin/ai-memory --data-dir /var/lib/ai-memory backup --to "$ARQ" >> "$LOG" 2>&1 || falha "instantâneo do ai-memory"
ls -1t "$DIR"/memoria-*.tar.gz | tail -n +15 | xargs -r rm --          # 14 dias aqui no Saturno
rclone copy "$DIR" gdrive_backup:ai-memory-saturno --log-level NOTICE >> "$LOG" 2>&1 || falha "envio ao Drive"
rclone delete gdrive_backup:ai-memory-saturno --min-age 90d --log-level NOTICE >> "$LOG" 2>&1 || true   # 90 dias no Drive
date -Iseconds > "$EST/ULTIMO_OK"; echo "$(basename "$ARQ") $(du -h "$ARQ" | cut -f1)" > "$EST/ULTIMO_ARQUIVO"
echo "== $(agora) ok: $ARQ" >> "$LOG"

# Dados do board: o próprio board (no Mac) espelha a pasta data/ aqui a cada 30 min; daqui vão ao Drive.
# Falha aqui não derruba o estado da memória: tem o seu próprio ULTIMO_BOARD_*.
if [ -d "$BOARD_DATA" ] && rclone sync "$BOARD_DATA" gdrive_backup:board-backup --log-level NOTICE >> "$LOG" 2>&1; then
  date -Iseconds > "$EST/ULTIMO_BOARD_OK"; echo "== $(agora) board: ok" >> "$LOG"
else
  date -Iseconds > "$EST/ULTIMO_BOARD_FALHOU"; echo "!! $(agora) board: FALHOU" >> "$LOG"
fi
