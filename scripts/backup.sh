#!/usr/bin/env bash
# backup.sh — Backup diário PostgreSQL (gestao_calhas) + upload Google Drive
# Cron: 0 3 * * * /root/gestao-calhas/scripts/backup.sh >> /root/backups/backup-calhas.log 2>&1
# Mesmo padrão do backup.sh da clínica (/root/botwhatapp/scripts/backup.sh).

set -euo pipefail

PG_HOST="localhost"
PG_DB="gestao_calhas"
PG_USER="cbrobot"
# Senha: lida de ~/.pgpass (chmod 600) pelo próprio pg_dump — nada de senha no script.
BACKUP_DIR="/root/backups"
GDRIVE_FOLDER="${GDRIVE_FOLDER:-backups}"
KEEP_LOCAL=7
KEEP_CLOUD=30
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/calhas_pg_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# 1) Backup local via pg_dump (formato SQL, comprimido). Senha via ~/.pgpass.
pg_dump -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" | gzip > "$BACKUP_FILE"
echo "[$(date)] Backup local criado: ${BACKUP_FILE} ($(du -h "$BACKUP_FILE" | cut -f1))"

# 2) Upload pro Google Drive
if command -v rclone &> /dev/null; then
  rclone copy "${BACKUP_FILE}" "gdrive:${GDRIVE_FOLDER}/" --log-level NOTICE
  echo "[$(date)] Upload Google Drive OK: ${GDRIVE_FOLDER}/calhas_pg_${TIMESTAMP}.sql.gz"

  # Limpar backups antigos no Drive (manter últimos KEEP_CLOUD)
  CLOUD_TOTAL=$(rclone ls "gdrive:${GDRIVE_FOLDER}/" 2>/dev/null | grep -c 'calhas_pg_' || true)
  if [ "$CLOUD_TOTAL" -gt "$KEEP_CLOUD" ]; then
    rclone ls "gdrive:${GDRIVE_FOLDER}/" 2>/dev/null | grep 'calhas_pg_' | sort -t_ -k3 | head -n "$(($CLOUD_TOTAL - $KEEP_CLOUD))" | awk '{print $2}' | while read -r old; do
      rclone deletefile "gdrive:${GDRIVE_FOLDER}/${old}" 2>/dev/null
      echo "[$(date)] Drive: removido antigo ${old}"
    done
  fi
else
  echo "[$(date)] AVISO: rclone não instalado, backup apenas local"
fi

# 3) Limpar backups locais antigos (manter últimos KEEP_LOCAL)
LOCAL_TOTAL=$(ls -1t "$BACKUP_DIR"/calhas_pg_*.sql.gz 2>/dev/null | wc -l)
if [ "$LOCAL_TOTAL" -gt "$KEEP_LOCAL" ]; then
  ls -1t "$BACKUP_DIR"/calhas_pg_*.sql.gz | tail -n +"$(($KEEP_LOCAL + 1))" | while read -r old; do
    rm -f "$old"
    echo "[$(date)] Local: removido antigo ${old}"
  done
fi

echo "[$(date)] Backup completo. Local: ${KEEP_LOCAL} | Drive: ${KEEP_CLOUD}"
