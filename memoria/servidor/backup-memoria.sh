#!/bin/bash
# Backup noturno da memória compartilhada (ai-memory) do Atena para o Google Drive.
# Roda pelo /etc/cron.d/backup-memoria. Log: /var/log/backup-memoria.log
# Situação para a tela de Monitoramento do board: /var/lib/backup-memoria/{ULTIMO_OK,ULTIMO_FALHOU}
set -uo pipefail
source /etc/backup-remoto.env   # BOARD_DATA: o espelho do board do Mac; BOARD_DATA_SERVIDOR: o data/ do board daqui
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
ls -1t "$DIR"/memoria-*.tar.gz | tail -n +15 | xargs -r rm --          # 14 dias aqui no Atena
rclone copy "$DIR" gdrive_backup:ai-memory-atena --log-level NOTICE >> "$LOG" 2>&1 || falha "envio ao Drive"
rclone delete gdrive_backup:ai-memory-atena --min-age 90d --log-level NOTICE >> "$LOG" 2>&1 || true   # 90 dias no Drive
date -Iseconds > "$EST/ULTIMO_OK"; echo "$(basename "$ARQ") $(du -h "$ARQ" | cut -f1)" > "$EST/ULTIMO_ARQUIVO"
echo "== $(agora) ok: $ARQ" >> "$LOG"

# Dados do board. Desde 29/10 (#246) o board PRINCIPAL roda no próprio servidor: BOARD_DATA_SERVIDOR aponta o data/
# dele, que vai a board-backup. Antes, uma fotografia local (rsync): o board grava o tempo todo, e o rclone recusa
# arquivo que muda no meio do envio. As capturas do navegador (navegador/) mostram páginas logadas: não saem daqui.
# O espelho que o board do Mac (reserva) mantém em BOARD_DATA continua como está e vai a board-backup-mac.
# Sem BOARD_DATA_SERVIDOR, o de antes: o espelho do Mac vai a board-backup.
# Falha aqui não derruba o estado da memória: tem o seu próprio ULTIMO_BOARD_*.
if [ -n "${BOARD_DATA_SERVIDOR:-}" ]; then
  FOTO=/var/lib/backup-memoria/board-data
  install -d -m700 "$FOTO"
  if [ -d "$BOARD_DATA_SERVIDOR" ] \
     && rsync -a --delete --exclude navegador/ --exclude board.lock "$BOARD_DATA_SERVIDOR/" "$FOTO/" >> "$LOG" 2>&1 \
     && rclone sync "$FOTO" gdrive_backup:board-backup --log-level NOTICE >> "$LOG" 2>&1; then
    date -Iseconds > "$EST/ULTIMO_BOARD_OK"; echo "== $(agora) board: ok (servidor: $BOARD_DATA_SERVIDOR)" >> "$LOG"
  else
    date -Iseconds > "$EST/ULTIMO_BOARD_FALHOU"; echo "!! $(agora) board: FALHOU (servidor: $BOARD_DATA_SERVIDOR)" >> "$LOG"
  fi
  if [ -d "$BOARD_DATA" ]; then
    if rclone sync "$BOARD_DATA" gdrive_backup:board-backup-mac --exclude navegador/ --log-level NOTICE >> "$LOG" 2>&1; then
      date -Iseconds > "$EST/ULTIMO_BOARD_MAC_OK"; echo "== $(agora) board-mac: ok" >> "$LOG"
    else
      date -Iseconds > "$EST/ULTIMO_BOARD_MAC_FALHOU"; echo "!! $(agora) board-mac: FALHOU" >> "$LOG"
    fi
  fi
elif [ -d "$BOARD_DATA" ] && rclone sync "$BOARD_DATA" gdrive_backup:board-backup --log-level NOTICE >> "$LOG" 2>&1; then
  date -Iseconds > "$EST/ULTIMO_BOARD_OK"; echo "== $(agora) board: ok" >> "$LOG"
else
  date -Iseconds > "$EST/ULTIMO_BOARD_FALHOU"; echo "!! $(agora) board: FALHOU" >> "$LOG"
fi
