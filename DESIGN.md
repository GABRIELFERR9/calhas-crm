# Design

<!-- impeccable:design-schema 1 -->

## Decisão de direção

O usuário viu uma direção autoral (mundo de sinalização de canteiro de obra) e **recusou**. A decisão dele, registrada em 10/08/2026, é explícita: *"quero parecido com o da clínica, pode ser na cor amarelo e preto"*.

Isso não é um meio-termo. O cânone escolhido é o painel da clínica CBRO, executado com fidelidade, sem ironia e sem enfeite autoral contrabandeado. A direção anterior foi descartada por completo — não sobrou faixa zebrada, letreiro condensado, placa de canteiro nem fundo de concreto.

**Referência de craft:** `Desktop/Projetos/cbro-redesign/css/site.css` e `clinica.html`. Quando houver dúvida sobre um componente novo, a pergunta é "como a clínica faz isso?".

### Evolução de 10/08/2026: mais moderno, sem parecer feito por IA

Depois do clone fiel acima, o usuário pediu explicitamente: *"deixa o painel mais intuitivo e moderno, arredondado, que não pareça feito por IA"*, usando as skills `impeccable` (crítica com dois assessments em paralelo), `redesign-skill` (checklist de padrões genéricos de IA) e `emil-design-eng` (motion).

Isto **não** reabre a decisão de 10/08/2026 acima — sidebar preta, amarelo de marca e estrutura geral continuam sendo o molde da clínica. O que mudou foi a execução visual, nos pontos que a crítica marcou como datados ou genéricos:

- **Raios maiores** (ver tabela de tokens abaixo): cantos mais arredondados em cards, botões e modais — o pedido explícito de "arredondado".
- **Bevel removido.** `--bevel`/`--bevel-soft` (inset highlight tipo Web 2.0) saíram de todo `box-shadow`. Sombras agora são só elevação para fora, sem o brilho interno que datava a interface.
- **Easing sem bounce.** `--ease-spring` trocou de uma curva com overshoot (`cubic-bezier(.34,1.3,.64,1)`) para `cubic-bezier(.16,1,.3,1)` — ease-out forte, sem "elástico". Efeito de mola em UI de painel financeiro lê como brinquedo, não como ferramenta séria.
- **Ícones próprios em SVG.** Os glifos Unicode/emoji da sidebar e dos botões (▤▦▣▩📊, ☰, ✕) viraram SVGs autorais e específicos do produto (o ícone de "Obras" é um telhado com calha, não um ícone genérico de dashboard).
- **Indicador de alerta por ponto, não por `border-left`.** `.alerta-erro`, `.aviso-conferencia`, `.toast` e `.erro-login` trocaram a barra colorida na lateral por um `::before` de ponto colorido — o `border-left` grosso em card é um dos padrões mais reconhecíveis de "feito por IA" apontados pela `redesign-skill` e pelo `craft-floor` da `impeccable`.
- **Contraste corrigido com matemática, não a olho.** `--ink-3` e as cores de badge de sucesso/perigo foram escurecidas até passar em WCAG AA (4.5:1) contra branco — o tom anterior media 3.07:1.
- **Indicador de página ativa na sidebar continua com um traço lateral fino** (`.sidebar-link.ativa::before`), mas isso é diferente do `border-left` banido: é um indicador de navegação flutuante fora do pílula (`left: -8px`), não uma borda colada num card ou alerta.

## Marca

Costa & Silva — Calhas, Rufos e Pingadeiras. Preto e amarelo, conforme a logo (casa estilizada com monograma CS).

O arquivo da logo deve ficar em `public/logo.png`. Ele aparece na sidebar, no login e no favicon. Enquanto não existir, o sistema mostra o fallback textual `C&S` — nada quebra. Para o **documento de orçamento**, a logo vem de `settings.logo_url` (pode apontar para `/logo.png`).

## Tokens

Mesma estrutura da clínica, com duas trocas de marca: navy → preto, teal → amarelo.

| Papel | Token | Valor |
|---|---|---|
| Tinta | `--ink` | `#16181d` |
| Tinta secundária | `--ink-2` | `#4b5563` |
| Tinta terciária | `--ink-3` | `#8a94a3` |
| Borda | `--border` | `#dde3ea` |
| Fundo da página | `--bg` | `#eef1f5` |
| Superfície | `--surface` | `#ffffff` |
| Sidebar | `--sidebar` | `#131313` |
| Acento (amarelo da logo) | `--accent` | `#f5c518` |
| Acento claro | `--accent-2` | `#ffd54a` |
| Dourado escuro (texto sobre claro) | `--accent-dk` | `#8a6d00` |
| Acento de fundo | `--accent-lt` | `#fffbea` |

Raios `16 / 10 / 22` (evolução de 10/08/2026 — eram `12 / 8 / 16`). Sombras em camadas (`--shadow-sm` a `--shadow-xl`), sem bevel (removido na mesma passada), `--ls-caps: 0.06em`.

**Por que `--accent-dk` existe:** amarelo puro como cor de texto sobre branco reprova em contraste. Todo texto "amarelo" sobre fundo claro usa `#8a6d00`. O `--accent` puro só aparece como preenchimento, com tinta escura por cima.

## Tipografia

**Inter** para interface, **JetBrains Mono** para todo número de dinheiro, hora e contagem. É o par que a clínica usa.

O detector de design marca Inter como fonte batida. **Mantida de propósito:** o pedido é parecer com a clínica, e a clínica é Inter. Trocar a fonte quebraria o único requisito que o usuário deu.

## Componentes

- **Sidebar fixa** de 210px, gradiente escuro, logo em badge branco, rótulo de seção em caixa-alta 9px, links com estado ativo em amarelo translúcido + trilho luminoso à esquerda, contador em pílula, rodapé com usuário e "Sair".
- **Page header sticky** por seção: título 18px, subtítulo 11.5px, ações à direita.
- **Stat cards** para o caixa: rótulo caixa-alta 10px com um quadradinho de estado, valor em mono 21px, dica 10.5px.
- **Kanban** em 4 colunas; cabeçalho de coluna com nome em caixa-alta e contagem em pílula. A coluna "Aguardando visita" ganha topo amarelo porque é a que cobra ação.
- **Card de obra**: chapa de OS em mono, seletor de etapa, tipo de serviço em caixa-alta 9.5px, nome do cliente 13px bold, endereço, valor em mono, badge de situação, até três botões contextuais.
- **Modais** com header em gradiente claro, corpo e rodapé de ações.
- **Tabelas** `data-table` com cabeçalho em gradiente e caixa-alta 10px.

## Regras que sobreviveram da fase anterior

Estas não são estéticas — são de produto, e valem em qualquer visual:

- **Vermelho é só vencimento.** Parcela pendente com `due_date` no passado (`total_vencido`). "Nada recebido" é o estado normal de metade do funil e usa badge neutro.
- **Dinheiro nunca afirma zero por falta de resposta.** Se a leitura do caixa falhar, os três valores viram `—` e sobe a `.alerta-erro`.
- **Arrastar não existe em toque.** Todo card tem seletor de etapa; o arraste é atalho de desktop.
- **Ações do card são contextuais, no máximo três.** Sem orçamento → *Orçamento* + *Agendar*; com orçamento → *Ver doc.* + *Receber* + *Agendar*; concluída e quitada → só *Ver doc.*
- **Alvos de toque de 40px** abaixo de 900px.

## Documento de orçamento (PDF)

Não herda a interface. Documento comercial assinado pelo cliente final: branco, tinta preta, sem amarelo, sem sidebar. Cabeçalho com logo (ou nome + tagline), tabela de itens com fio preto, condições e assinaturas.

## Responsivo

- Sidebar vira gaveta abaixo de 900px, aberta pelo botão ☰ da topbar mobile, com overlay; fecha ao trocar de seção e no Esc.
- Kanban: 4 colunas → 2 (≤1100px) → 1 com abas de etapa (≤900px).
- Stat cards empilham abaixo de 560px.
