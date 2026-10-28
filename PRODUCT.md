# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Dois operadores compartilhando **um único login**, em dois contextos muito diferentes:

1. **O dono da empresa de calhas — celular, na rua.** Passa o dia em visita técnica e obra. Consulta e atualiza de pé, com uma mão, tela pequena, frequentemente sob sol forte. É ele quem fecha preço na frente do cliente e quem recebe o dinheiro.
2. **Recepção/secretária — desktop, sentada.** Uso contínuo ao longo do dia: acompanha o funil, lança orçamento, registra recebimento. Densidade de informação e velocidade de digitação importam.

Os dois veem tudo, inclusive o financeiro — foi decisão explícita do usuário manter um login só nesta etapa.

## Product Purpose

Tirar a gestão de uma empresa de instalação de calhas de cadernos e conversas soltas de WhatsApp e colocar num painel único: da chegada do lead até o dinheiro entrar no caixa.

Sucesso é o dono conseguir responder três perguntas sem ligar para ninguém: *em que pé está cada obra*, *quanto eu tenho pra receber*, e *quanto entrou de verdade hoje*.

## Positioning

O diferencial não é o Kanban — é a **divisão do recebimento no momento do lançamento**. O sistema separa o que é dinheiro físico que entra na gaveta hoje do que é cartão/boleto que só compensa depois, para que o caixa do dia bata com a realidade. Quem trata pagamento como um número só não consegue copiar isso sem refazer o modelo financeiro.

Segundo diferencial: o lead entra sozinho pelo WhatsApp (webhook da Evolution API) e vira card no funil sem ninguém digitar.

## Operating Context

- Leads chegam **por WhatsApp**, quase nunca por formulário ou telefone.
- O ciclo real da obra: contato → visita técnica para medir → orçamento → instalação agendada → concluído.
- O orçamento é entregue como **proposta em papel/PDF A4**, impressa ou mandada no WhatsApp, com assinatura de aceite. É documento comercial, visto pelo cliente final da empresa.
- Pagamento quase sempre é **dividido**: sinal no aceite (dinheiro/PIX) e o restante na conclusão (cartão/boleto), em datas diferentes.
- Quantidades de material são medidas em **metros lineares** ("30m de calha", "10m de rufo"), não em unidades.
- Região de atuação: Brasília/DF e entorno.

## Capabilities and Constraints

**Funcionando hoje (validado em 10/08/2026):** login único com sessão, Kanban de 4 etapas com persistência (arraste no desktop, seletor de etapa no celular), orçamento com itens gerando PDF A4 numerado, lançamento financeiro dividido em N parcelas com classificação automática entre caixa e a compensar, caixa do dia, agenda por dia, ficha de cliente com histórico, webhook de leads do WhatsApp autenticado por token.

**Stack (constraint técnico firme):** Node.js + Express, PostgreSQL com `pg` em query direta, front SPA em HTML/CSS/JS puro **sem framework e sem build step**. Mesmo molde do sistema da clínica (CBRO) do mesmo autor, por escolha do cliente. Deploy via PM2 na VPS, porta 3001.

**Ainda não existe:** multi-tenant (`company_id`) — hoje uma instância serve uma empresa. Também não há perfis de acesso: dono e recepção compartilham o mesmo login, por decisão explícita do usuário.

**Indefinido — não inventar:** nome fantasia, CNPJ, telefone, e-mail e logo da empresa do cliente. Hoje são placeholders na tabela `settings` (linha id=1) e devem ser trocados por dados reais quando o cliente enviar. Nenhum material pode exibir esses valores como se fossem verdadeiros.

## Brand Commitments

- **A empresa é a Costa & Silva — Calhas, Rufos e Pingadeiras.** Marca em **preto e amarelo**, logo com casa estilizada e monograma CS. Confirmado pelo usuário em 10/08/2026.
- **O painel segue o molde do sistema da clínica (CBRO).** Decisão explícita do usuário em 10/08/2026, depois de ver e recusar uma direção autoral. A referência de craft é `Desktop/Projetos/cbro-redesign/css/site.css`: sidebar escura fixa, cabeçalho de página sticky, cards brancos com sombra em camadas e elevação no hover, botões compactos com bevel, rótulos em caixa-alta de 10px, números em fonte mono. Executar esse cânone com fidelidade, sem ironia e sem enfeite autoral contrabandeado.
- O PDF de orçamento carrega a marca da **empresa do cliente** (via `settings`), não a do painel.
- Interface em português do Brasil.

## Evidence on Hand

- Código funcional em `C:\Users\CBRO\Desktop\Projetos\gestao-calhas`.
- Briefing original do cliente registrado em `Desktop/contexto/servidor/Projetos/Gestão Calhas.md`.
- **Não existem:** logo, fotos de obra, depoimentos, números de faturamento ou carteira de clientes reais. Nada disso pode ser fabricado em tela ou em documento.

## Product Principles

1. **O caixa tem que bater com a gaveta.** Toda decisão financeira na tela responde a "esse dinheiro está aqui agora ou ainda não?".
2. **O mesmo painel serve de pé e sentado.** Nada essencial pode depender de mouse, hover ou tela larga.
3. **Digitação é do jeito que o operador fala.** "30m", "1.500", "R$ 2.450,00" — o sistema entende, não corrige o usuário.
4. **O documento que sai é comercial.** O PDF é visto pelo cliente final e representa a empresa; não pode parecer tela de sistema impressa.
5. **Nada de dado de exemplo em tela.** Se não veio do banco, mostra estado vazio honesto.

## Accessibility & Inclusion

Uso ao ar livre sob sol forte exige contraste alto de verdade nos números e status. Alvos de toque confortáveis no celular, já que o dono opera de pé e com uma mão.
