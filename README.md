# calhas-crm

CRM para empresa de instalação de calhas: funil de leads, orçamentos, obras e financeiro. Node + Express + Postgres.

Painel único para uma empresa de instalação de calhas, que antes vivia de caderno e conversa solta no WhatsApp: da chegada do lead até o dinheiro entrar no caixa.

O objetivo é o dono responder três perguntas sem ligar para ninguém: em que pé está cada obra, quanto tem para receber e quanto entrou hoje.

## O que faz
- Funil de leads e clientes.
- Orçamentos com os termos da empresa (pagamento, garantia e prazo).
- Acompanhamento de obras e recebimentos.
- Integração com WhatsApp (Evolution API) por webhook.
- Pensado para dois contextos: o dono no celular, na rua, e a recepção no desktop (veja `PRODUCT.md` e `DESIGN.md`).
- Scripts de monitoramento e backup (`scripts/`).

## Stack
Node.js, Express, PostgreSQL e frontend em HTML/CSS/JS puro.

## Rodar
```bash
npm install
# configure DATABASE_URL no .env
node src/server.js
```

---
Feito por [Gabriel Ferreira](https://github.com/GABRIELFERR9).
