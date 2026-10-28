#!/usr/bin/env bash
# monitor.sh — checa /api/health a cada 2 min. Se cair: reinicia o PM2 e avisa
# no WhatsApp (uma vez, não fica repetindo). Quando volta, avisa que voltou.
# Cron: */2 * * * * /root/gestao-calhas/scripts/monitor.sh >> /root/gestao-calhas/scripts/monitor.log 2>&1
#
# Reaproveita a instância Evolution "cbro" (a única conectada nesta VPS no
# momento) só pra mandar o alerta pro número do administrador — não mistura
# nenhum dado do projeto da clínica, só usa o envio de mensagem já pronto.

set -uo pipefail

URL="http://localhost:3002/api/health"
NUMERO_ALERTA="${NUMERO_ALERTA:?defina o número que recebe o alerta}"
EVOLUTION_ENV="/root/evolution-api/.env"
EVOLUTION_URL="http://localhost:8080"
EVOLUTION_INSTANCIA="cbro"
STATE_FILE="/root/gestao-calhas/scripts/.monitor_state"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"

enviar_whatsapp() {
    local texto="$1"
    [ -f "$EVOLUTION_ENV" ] || { echo "$LOG_PREFIX aviso: $EVOLUTION_ENV não encontrado, alerta não enviado"; return; }
    local apikey
    apikey=$(grep '^AUTHENTICATION_API_KEY=' "$EVOLUTION_ENV" | cut -d= -f2-)
    curl -s -X POST "${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCIA}" \
        -H "apikey: ${apikey}" \
        -H "Content-Type: application/json" \
        -d "{\"number\":\"${NUMERO_ALERTA}\",\"text\":\"${texto}\"}" > /dev/null
}

STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL")
ESTADO_ANTERIOR="up"
[ -f "$STATE_FILE" ] && ESTADO_ANTERIOR=$(cat "$STATE_FILE")

if [ "$STATUS" != "200" ]; then
    echo "$LOG_PREFIX FALHA: /api/health retornou '$STATUS'. Reiniciando pm2 gestao-calhas..."
    pm2 restart gestao-calhas > /dev/null 2>&1

    # Só avisa na PRIMEIRA queda — evita mandar mensagem a cada 2 min
    # enquanto o problema persiste (ex: banco fora do ar por horas).
    if [ "$ESTADO_ANTERIOR" = "up" ]; then
        enviar_whatsapp "⚠️ Painel Costa & Silva fora do ar (health check falhou). Reiniciando automaticamente — se não voltar em alguns minutos, precisa olhar direto na VPS."
        echo "$LOG_PREFIX alerta de queda enviado"
    fi
    echo "down" > "$STATE_FILE"
else
    if [ "$ESTADO_ANTERIOR" = "down" ]; then
        enviar_whatsapp "✅ Painel Costa & Silva voltou ao normal."
        echo "$LOG_PREFIX alerta de recuperação enviado"
    fi
    echo "up" > "$STATE_FILE"
fi
