/* =========================================================
   Painel de Gestão de Calhas — camada de front
   Tudo que aparece na tela vem do banco. Sem dado de exemplo.
   ========================================================= */

const ETAPAS = [
    { id: 'aguardando', numero: '01', nome: 'Aguardando visita', curto: 'Visita' },
    { id: 'orcamento',  numero: '02', nome: 'Orçamento enviado', curto: 'Orçam.' },
    { id: 'instalacao', numero: '03', nome: 'Instalação agendada', curto: 'Instal.' },
    { id: 'concluido',  numero: '04', nome: 'Concluído', curto: 'Pronto' }
];

const METODOS = {
    dinheiro: { label: 'Dinheiro (entra na gaveta)', imediato: true },
    pix:      { label: 'PIX (cai na conta na hora)', imediato: true },
    cartao:   { label: 'Cartão (compensa depois)', imediato: false },
    boleto:   { label: 'Boleto bancário', imediato: false }
};

// Ícones próprios em SVG — nada de emoji nem glifo Unicode solto.
const ICONE = {
    fechar: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    lixeira: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 6H16M8 6V4.5C8 4 8.4 3.5 9 3.5H11C11.6 3.5 12 4 12 4.5V6M14.5 6L14 15.5C14 16 13.6 16.5 13 16.5H7C6.4 16.5 6 16 6 15.5L5.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 9V13.5M11.5 9V13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
};

const state = {
    settings: {},
    clients: [],
    tickets: [],
    agenda: [],
    ticketsConhecidos: new Set(),
    primeiraCarga: true,
    etapaVisivel: 'aguardando',
    clienteEditando: null
};

let agendaCalendar = null;
let graficoReceita = null;

/* ---------------------------------------------------------
   Utilidades
   --------------------------------------------------------- */

// O nome do cliente vem do pushName do WhatsApp — texto de terceiro.
// Nunca vai para innerHTML sem passar por aqui.
function escapeHtml(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatBRL(valor) {
    return Number(valor || 0).toLocaleString('pt-BR', {
        style: 'currency', currency: 'BRL', minimumFractionDigits: 2
    });
}

// Aceita "3.500,00", "3500.00", "R$ 1.200" e devolve número.
// Cuidado com o caso "1.500": no Brasil é mil e quinhentos, não um e meio.
function parseBRL(texto) {
    if (typeof texto === 'number') return texto;
    if (!texto) return 0;

    let limpo = String(texto).replace(/[^\d,.-]/g, '');

    if (limpo.includes(',')) {
        // Vírgula presente = separador decimal; os pontos são de milhar.
        limpo = limpo.replace(/\./g, '').replace(',', '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(limpo)) {
        // Só pontos, todos separando grupos de 3 dígitos: "1.500", "1.000.000".
        limpo = limpo.replace(/\./g, '');
    }
    // Sobra "2500.75", que já é decimal com ponto.

    const n = parseFloat(limpo);
    return Number.isFinite(n) ? n : 0;
}

function formatDate(valor) {
    if (!valor) return '—';

    // Coluna DATE do Postgres chega como "2026-08-25". new Date() lê isso como
    // meia-noite UTC, que em UTC-3 volta para o dia anterior — a validade do
    // orçamento sairia um dia mais cedo no documento do cliente.
    const soData = /^\d{4}-\d{2}-\d{2}$/.test(String(valor));
    const d = new Date(soData ? `${valor}T12:00:00` : valor);

    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

function hojeISO() {
    const agora = new Date();
    agora.setMinutes(agora.getMinutes() - agora.getTimezoneOffset());
    return agora.toISOString().slice(0, 10);
}

function toast(mensagem, tipo = 'info') {
    const pilha = document.getElementById('toast-stack');
    if (!pilha) return;

    const rotulos = { sucesso: 'Feito', erro: 'Não deu', info: 'Aviso' };
    const el = document.createElement('div');
    el.className = `toast ${tipo}`;
    el.innerHTML = `
        <span class="toast-dot" aria-hidden="true"></span>
        <span class="toast-corpo">
            <span class="rot">${rotulos[tipo] || 'Aviso'}</span>
        </span>
        <button type="button" class="toast-fechar" aria-label="Fechar aviso">${ICONE.fechar}</button>
    `;
    el.querySelector('.toast-corpo').appendChild(document.createTextNode(mensagem));
    pilha.appendChild(el);

    // Pausa o descarte automático enquanto o mouse ou o foco estão em cima —
    // ninguém devia perder um erro importante só porque estava lendo devagar.
    let restante = 4800;
    let iniciadoEm = Date.now();
    let temporizador = setTimeout(remover, restante);

    function remover() { el.remove(); }
    function pausar() { clearTimeout(temporizador); restante -= Date.now() - iniciadoEm; }
    function retomar() { iniciadoEm = Date.now(); temporizador = setTimeout(remover, Math.max(restante, 600)); }

    el.addEventListener('mouseenter', pausar);
    el.addEventListener('mouseleave', retomar);
    el.addEventListener('focusin', pausar);
    el.addEventListener('focusout', retomar);
    el.querySelector('.toast-fechar').addEventListener('click', remover);
}

async function api(caminho, opcoes = {}) {
    const resposta = await fetch(`/api${caminho}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opcoes
    });

    // Sessão caiu: volta para o portão em vez de mostrar erro solto.
    if (resposta.status === 401) {
        window.location.href = '/login.html';
        throw new Error('Sessão expirada.');
    }

    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(corpo.error || 'Falha na comunicação com o servidor.');
    return corpo;
}

function el(id) { return document.getElementById(id); }

/* ---------------------------------------------------------
   Funil
   --------------------------------------------------------- */

async function carregarFunil({ silencioso = false } = {}) {
    try {
        state.tickets = await api('/tickets');
        renderFunil();
        detectarNovosLeads(state.tickets);
    } catch (erro) {
        if (!silencioso) toast(`Não foi possível carregar o funil: ${erro.message}`, 'erro');
        console.error('[carregarFunil]', erro);
    }
}

function renderFunil() {
    ETAPAS.forEach(etapa => {
        const coluna = el(`col-${etapa.id}`);
        if (!coluna) return;

        const container = coluna.querySelector('.coluna-body');
        const daEtapa = state.tickets.filter(t => t.status === etapa.id);

        container.innerHTML = daEtapa.length
            ? daEtapa.map(cartaoHTML).join('')
            : `<div class="empty-state">Nenhuma obra nesta etapa</div>`;

        coluna.querySelector('.coluna-contagem').textContent = daEtapa.length;
    });

    el('cont-funil').textContent = state.tickets.filter(t => t.status !== 'concluido').length;
    renderSeletorEtapa();
    ligarArraste();
}

// No celular só uma etapa cabe por vez.
function renderSeletorEtapa() {
    const seletor = el('tabs-etapa');
    seletor.innerHTML = ETAPAS.map(etapa => {
        const total = state.tickets.filter(t => t.status === etapa.id).length;
        const ativa = etapa.id === state.etapaVisivel ? ' ativa' : '';
        return `<button class="${ativa.trim()}" data-etapa-btn="${etapa.id}"
                        aria-current="${etapa.id === state.etapaVisivel ? 'true' : 'false'}">
                    ${escapeHtml(etapa.curto)} (${total})
                </button>`;
    }).join('');

    ETAPAS.forEach(etapa => {
        el(`col-${etapa.id}`).classList.toggle('visivel', etapa.id === state.etapaVisivel);
    });
}

function cartaoHTML(ticket) {
    const valor = Number(ticket.value || 0);
    const pago = Number(ticket.total_pago || 0);
    const pendente = Number(ticket.total_pendente || 0);

    const vencido = Number(ticket.total_vencido || 0);
    let selo = '';

    // Vermelho é só para vencido. "Ainda não recebeu" é o estado normal de
    // metade do funil — pintar isso de alarme é perder o alarme.
    if (vencido > 0) {
        selo = `<span class="badge vencido">Vencido ${formatBRL(vencido)}</span>`;
    } else if (valor > 0 && pago >= valor) {
        selo = '<span class="badge pago">Pago</span>';
    } else if (pendente > 0) {
        selo = `<span class="badge compensar">A compensar ${formatBRL(pendente)}</span>`;
    } else if (pago > 0) {
        const pct = valor > 0 ? Math.round((pago / valor) * 100) : 0;
        selo = `<span class="badge parcial">Recebido ${pct}%</span>`;
    } else if (valor > 0) {
        selo = '<span class="badge neutro">Nada recebido</span>';
    }

    const servico = ticket.service_type
        ? `<div class="obra-servico">${escapeHtml(ticket.service_type)}</div>`
        : '<div class="obra-servico">Lead do WhatsApp</div>';

    const endereco = ticket.full_address
        ? `<div class="obra-endereco">${escapeHtml(ticket.full_address)}</div>`
        : '';

    const data = ticket.scheduled_at
        ? `<div class="obra-data">${formatDataHora(ticket.scheduled_at)}</div>`
        : '';

    // Arrastar não existe em tela de toque: o seletor de etapa é o caminho
    // principal no celular e o atalho de teclado no desktop.
    const seletor = `
        <label class="obra-etapa">
            <span class="sr">Etapa da obra ${escapeHtml(ticket.client_name)}</span>
            <select data-mudar-etapa data-id="${ticket.id}">
                ${ETAPAS.map(e => `<option value="${e.id}"${e.id === ticket.status ? ' selected' : ''}>${e.numero} ${escapeHtml(e.curto)}</option>`).join('')}
            </select>
        </label>`;

    return `
    <article class="card-obra" draggable="true" data-id="${ticket.id}">
        <div class="obra-topo">
            <span class="obra-os">OS ${String(ticket.id).padStart(4, '0')}</span>
            ${seletor}
        </div>
        ${servico}
        <h3 class="obra-cliente">${escapeHtml(ticket.client_name)}</h3>
        ${endereco}
        ${data}
        <div class="obra-rodape">
            <span class="obra-valor${valor > 0 ? '' : ' aorcar'}">${valor > 0 ? formatBRL(valor) : 'A orçar'}</span>
            ${selo}
        </div>
        <div class="obra-acoes">${acoesCartao(ticket)}</div>
    </article>`;
}

// Só as ações que fazem sentido na etapa. Card estreito não comporta quatro
// botões, e oferecer "receber" numa obra sem valor é ruído.
function acoesCartao(ticket) {
    const valor = Number(ticket.value || 0);
    const pago = Number(ticket.total_pago || 0);
    const quitado = valor > 0 && pago >= valor;
    const botoes = [];

    if (ticket.budget_id) {
        botoes.push(`<button class="btn btn-ghost btn-xs" data-acao="ver-doc" data-doc="${ticket.budget_id}">Ver doc.</button>`);
    } else {
        botoes.push(`<button class="btn btn-ghost btn-xs" data-acao="orcar" data-id="${ticket.id}">Orçamento</button>`);
    }

    if (!quitado && ticket.status !== 'aguardando') {
        botoes.push(`<button class="btn btn-ghost btn-xs" data-acao="receber" data-id="${ticket.id}">Receber</button>`);
    }

    if (ticket.status !== 'concluido') {
        botoes.push(`<button class="btn btn-ghost btn-xs" data-acao="agendar" data-id="${ticket.id}">Agendar</button>`);
    }

    botoes.push(`<button class="btn btn-danger-ghost btn-xs" data-acao="apagar" data-id="${ticket.id}">${ICONE.lixeira} Apagar</button>`);

    return botoes.join('');
}

function formatDataHora(valor) {
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
         + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function ligarArraste() {
    document.querySelectorAll('.card-obra').forEach(cartao => {
        cartao.addEventListener('dragstart', () => cartao.classList.add('arrastando'));
        cartao.addEventListener('dragend', () => cartao.classList.remove('arrastando'));
    });

    document.querySelectorAll('.coluna-body').forEach(container => {
        container.addEventListener('dragover', evento => {
            evento.preventDefault();
            container.classList.add('alvo');

            const arrastando = document.querySelector('.card-obra.arrastando');
            if (!arrastando) return;

            container.querySelector('.empty-state')?.remove();

            const depois = cartaoAposPosicao(container, evento.clientY);
            if (depois) container.insertBefore(arrastando, depois);
            else container.appendChild(arrastando);
        });

        container.addEventListener('dragleave', () => container.classList.remove('alvo'));

        container.addEventListener('drop', async evento => {
            evento.preventDefault();
            container.classList.remove('alvo');

            const arrastando = document.querySelector('.card-obra.arrastando');
            if (!arrastando) return;

            await mudarEtapa(arrastando.dataset.id, container.closest('.coluna').dataset.etapa);
        });
    });
}

// Um caminho só para mudar etapa, usado pelo arraste e pelo seletor.
async function mudarEtapa(ticketId, novaEtapa) {
    try {
        await api(`/tickets/${ticketId}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: novaEtapa })
        });
        await carregarFunil({ silencioso: true });
        return true;
    } catch (erro) {
        toast(`Não foi possível mover a obra: ${erro.message}`, 'erro');
        await carregarFunil({ silencioso: true });
        return false;
    }
}

async function apagarTicket(ticketId) {
    if (!confirm('Tem certeza que deseja apagar esta obra? Essa ação não pode ser desfeita e apagará orçamentos e lançamentos vinculados.')) return;
    try {
        await api(`/tickets/${ticketId}`, { method: 'DELETE' });
        await carregarFunil({ silencioso: true });
        await carregarCaixa();
        toast('Obra apagada com sucesso.', 'sucesso');
    } catch (erro) {
        toast(`Não foi possível apagar a obra: ${erro.message}`, 'erro');
    }
}

function cartaoAposPosicao(container, y) {
    const cartoes = [...container.querySelectorAll('.card-obra:not(.arrastando)')];
    return cartoes.reduce((maisProximo, cartao) => {
        const box = cartao.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        return (offset < 0 && offset > maisProximo.offset)
            ? { offset, element: cartao }
            : maisProximo;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/* ---------------------------------------------------------
   Chegada de lead real
   --------------------------------------------------------- */

function detectarNovosLeads(tickets) {
    if (state.primeiraCarga) {
        tickets.forEach(t => state.ticketsConhecidos.add(t.id));
        state.primeiraCarga = false;
        return;
    }

    const novos = tickets.filter(t => !state.ticketsConhecidos.has(t.id));
    tickets.forEach(t => state.ticketsConhecidos.add(t.id));
    if (novos.length > 0) anunciarLead(novos[0]);
}

function anunciarLead(ticket) {
    const painel = el('lead-popup');
    if (!painel) return;

    painel.innerHTML = `
        <div class="rot">Lead novo no WhatsApp</div>
        <div class="quem">${escapeHtml(ticket.client_name)}</div>
        ${ticket.description ? `<div class="msg">"${escapeHtml(ticket.description)}"</div>` : ''}
        <div class="msg">Entrou em Aguardando visita.</div>
    `;

    painel.classList.add('visivel');
    setTimeout(() => painel.classList.remove('visivel'), 9000);
}

/* ---------------------------------------------------------
   Orçamento e documento
   --------------------------------------------------------- */

function novaLinhaItem(item = {}) {
    const tbody = el('orc-itens');
    const tr = document.createElement('tr');
    tr.className = 'linha-item';
    tr.innerHTML = `
        <td><input type="text" class="input item-desc" placeholder="Ex: calha de alumínio corte 33" value="${escapeHtml(item.description || '')}"></td>
        <td><input type="text" class="input item-qtd" value="${escapeHtml(item.quantity || '1')}" aria-label="Quantidade"></td>
        <td><input type="text" class="input item-valor" inputmode="decimal" placeholder="0,00" aria-label="Valor unitário"></td>
        <td class="item-total dinheiro">R$ 0,00</td>
        <td><button type="button" class="btn-remover" data-remover-item aria-label="Remover item">${ICONE.fechar}</button></td>
    `;
    tbody.appendChild(tr);
    recalcularOrcamento();
}

// Quantidade aceita "30m", "2 un" — o número é extraído para a conta.
function quantidadeNumerica(texto) {
    const n = parseFloat(String(texto || '1').replace(',', '.').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : 1;
}

function coletarItens() {
    return [...document.querySelectorAll('.linha-item')].map(linha => {
        const description = linha.querySelector('.item-desc').value.trim();
        const quantity = linha.querySelector('.item-qtd').value.trim() || '1';
        const unit_price = parseBRL(linha.querySelector('.item-valor').value);
        return { description, quantity, quantity_number: quantidadeNumerica(quantity), unit_price };
    }).filter(item => item.description);
}

function recalcularOrcamento() {
    let total = 0;
    document.querySelectorAll('.linha-item').forEach(linha => {
        const subtotal = quantidadeNumerica(linha.querySelector('.item-qtd').value)
                       * parseBRL(linha.querySelector('.item-valor').value);
        total += subtotal;
        linha.querySelector('.item-total').textContent = formatBRL(subtotal);
    });
    el('orc-total').textContent = formatBRL(total);
    return total;
}

function preencherSelectClientes() {
    const select = el('orc-cliente');
    const atual = select.value;
    select.innerHTML = '<option value="novo">+ Cadastrar novo cliente</option>'
        + state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    if (atual) select.value = atual;
    alternarNovoCliente();
}

function alternarNovoCliente() {
    el('orc-novo-cliente').style.display = el('orc-cliente').value === 'novo' ? 'flex' : 'none';
}

async function abrirModalOrcamento(ticketId = null) {
    await carregarClientes();

    const modal = el('modal-orcamento');
    modal.dataset.ticketId = ticketId || '';

    el('orc-itens').innerHTML = '';
    el('orc-obs').value = '';
    el('orc-nome').value = '';
    el('orc-telefone').value = '';

    const ticket = ticketId ? state.tickets.find(t => String(t.id) === String(ticketId)) : null;
    el('orc-endereco').value = ticket?.full_address || '';
    el('orc-servico').value = ticket?.service_type || '';
    el('orc-cliente').value = ticket ? ticket.client_id : (state.clients.length ? state.clients[0].id : 'novo');
    el('titulo-orcamento').textContent = ticket ? `Orçamento — ${ticket.client_name}` : 'Novo orçamento';

    alternarNovoCliente();
    novaLinhaItem();
    abrirModal('modal-orcamento');
}

async function gerarOrcamento() {
    const modal = el('modal-orcamento');
    const select = el('orc-cliente');
    const itens = coletarItens();

    if (itens.length === 0) {
        toast('Inclua pelo menos um serviço ou material.', 'erro');
        return;
    }

    const payload = {
        ticket_id: modal.dataset.ticketId || null,
        items: itens,
        notes: el('orc-obs').value.trim() || null,
        address: el('orc-endereco').value.trim() || null,
        service_type: el('orc-servico').value.trim() || null
    };

    if (select.value === 'novo') {
        const nome = el('orc-nome').value.trim();
        if (!nome) { toast('Informe o nome do novo cliente.', 'erro'); return; }
        payload.client_name = nome;
        payload.client_phone = el('orc-telefone').value.trim() || null;
    } else {
        payload.client_id = Number(select.value);
    }

    const botao = el('btn-gerar-orcamento');
    botao.disabled = true;

    try {
        const orcamento = await api('/budgets', { method: 'POST', body: JSON.stringify(payload) });
        fecharModais();
        renderizarDocumento(orcamento);
        abrirSecao('pdf');
        await Promise.all([carregarFunil({ silencioso: true }), carregarClientes()]);
        toast(`Orçamento nº ${orcamento.number} salvo.`, 'sucesso');
    } catch (erro) {
        toast(erro.message, 'erro');
    } finally {
        botao.disabled = false;
    }
}

// O documento é comercial: fundo branco, sem amarelo, sem zebrado.
// Não pode parecer tela de sistema impressa.
function renderizarDocumento(orcamento) {
    const cfg = orcamento.settings || {};
    const folha = el('folha-a4');

    const marca = cfg.logo_url
        ? `<img class="doc-logo" src="${escapeHtml(cfg.logo_url)}" alt="${escapeHtml(cfg.company_name || '')}">`
        : `<div class="doc-empresa">${escapeHtml(cfg.company_name || 'Sua Empresa')}<small>Calhas, rufos e pingadeiras</small></div>`;

    const linhas = orcamento.items.map(item => `
        <tr>
            <td>${escapeHtml(item.description)}</td>
            <td class="qtd">${escapeHtml(item.quantity)}</td>
            <td class="num">${formatBRL(item.unit_price)}</td>
            <td class="num">${formatBRL(item.total)}</td>
        </tr>`).join('');

    folha.innerHTML = `
        <header class="doc-cabecalho">
            <div>${marca}</div>
            <div class="doc-contato">
                ${cfg.cnpj ? `<div>CNPJ ${escapeHtml(cfg.cnpj)}</div>` : ''}
                ${cfg.phone ? `<div>${escapeHtml(cfg.phone)}</div>` : ''}
                ${cfg.email ? `<div>${escapeHtml(cfg.email)}</div>` : ''}
                ${cfg.address ? `<div>${escapeHtml(cfg.address)}</div>` : ''}
            </div>
        </header>

        <h1 class="doc-titulo">Proposta de orçamento nº ${escapeHtml(orcamento.number || '')}</h1>

        <div class="doc-cliente">
            <div><span class="rot">Cliente:</span> <strong>${escapeHtml(orcamento.client_name)}</strong></div>
            ${orcamento.client_phone ? `<div><span class="rot">Contato:</span> ${escapeHtml(orcamento.client_phone)}</div>` : ''}
            ${orcamento.client_address ? `<div><span class="rot">Endereço da obra:</span> ${escapeHtml(orcamento.client_address)}</div>` : ''}
            <div><span class="rot">Emissão:</span> ${formatDate(orcamento.created_at)}</div>
            <div><span class="rot">Válido até:</span> ${formatDate(orcamento.valid_until)}</div>
        </div>

        <table class="doc-tabela">
            <thead>
                <tr>
                    <th>Descrição do serviço / material</th>
                    <th class="qtd">Qtd</th>
                    <th class="num">Valor un.</th>
                    <th class="num">Total</th>
                </tr>
            </thead>
            <tbody>${linhas}</tbody>
            <tfoot>
                <tr>
                    <td colspan="3" class="num">Total a pagar</td>
                    <td class="num">${formatBRL(orcamento.total)}</td>
                </tr>
            </tfoot>
        </table>

        <section class="doc-condicoes">
            <h3>Condições</h3>
            <ul>
                ${cfg.terms_payment ? `<li><strong>Pagamento:</strong> ${escapeHtml(cfg.terms_payment)}</li>` : ''}
                ${cfg.terms_warranty ? `<li><strong>Garantia:</strong> ${escapeHtml(cfg.terms_warranty)}</li>` : ''}
                ${cfg.terms_execution ? `<li><strong>Prazo de execução:</strong> ${escapeHtml(cfg.terms_execution)}</li>` : ''}
                ${orcamento.notes ? `<li><strong>Observações:</strong> ${escapeHtml(orcamento.notes)}</li>` : ''}
            </ul>
        </section>

        <div class="doc-assinaturas">
            <div>${escapeHtml(cfg.company_name || 'Responsável')}</div>
            <div>${escapeHtml(orcamento.client_name)} — aceite</div>
        </div>
    `;
}

async function verDocumento(budgetId) {
    try {
        renderizarDocumento(await api(`/budgets/${budgetId}`));
        abrirSecao('pdf');
    } catch (erro) {
        toast(erro.message, 'erro');
    }
}

/* ---------------------------------------------------------
   Dashboard
   --------------------------------------------------------- */
async function carregarDashboard() {
    try {
        const dados = await api('/dashboard');
        
        el('dash-faturamento').textContent = formatBRL(dados.faturamentoMes);
        el('dash-conversao').textContent = dados.taxaConversao + '%';
        el('dash-ticket').textContent = formatBRL(dados.ticketMedio);
        
        const labels = dados.historico.map(h => h.mes.split('-').reverse().join('/'));
        const valores = dados.historico.map(h => Number(h.total));

        const ctx = el('grafico-receita');

        // Canvas é invisível pra leitor de tela — sem isso o gráfico simplesmente
        // não existe pra quem não enxerga. O rótulo resume os mesmos números.
        ctx.setAttribute('role', 'img');
        ctx.setAttribute('aria-label', labels.length
            ? `Receita mensal: ${labels.map((l, i) => `${l}: ${formatBRL(valores[i])}`).join(', ')}.`
            : 'Sem dados de receita para exibir no período.');

        if (graficoReceita) {
            graficoReceita.destroy();
        }
        
        graficoReceita = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Receita',
                    data: valores,
                    borderColor: '#8a6d00',
                    backgroundColor: 'rgba(245, 197, 24, 0.22)',
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { 
                    y: { beginAtZero: true }
                }
            }
        });
    } catch (e) {
        toast('Erro ao carregar Dashboard.', 'erro');
    }
}

/* ---------------------------------------------------------
   Recebimento
   --------------------------------------------------------- */

function novaParcela({ amount = '', method = 'dinheiro', due_date = hojeISO() } = {}) {
    const container = el('rec-parcelas');
    const indice = container.children.length + 1;

    const div = document.createElement('div');
    div.className = 'parcela';
    div.innerHTML = `
        <div class="parcela-cabecalho">
            <span class="titulo">Parcela ${indice}</span>
            <span style="display: flex; align-items: center; gap: 8px;">
                <span class="destino"></span>
                <button type="button" class="btn-remover" data-remover-parcela aria-label="Remover parcela">${ICONE.fechar}</button>
            </span>
        </div>
        <div class="parcela-campos">
            <label class="campo">
                <span class="rotulo-campo">Valor</span>
                <input type="text" class="input pag-valor" inputmode="decimal" placeholder="0,00" value="${amount}">
            </label>
            <label class="campo">
                <span class="rotulo-campo">Forma</span>
                <select class="input pag-forma">
                    ${Object.entries(METODOS).map(([chave, m]) =>
                        `<option value="${chave}" ${chave === method ? 'selected' : ''}>${m.label}</option>`
                    ).join('')}
                </select>
            </label>
            <label class="campo">
                <span class="rotulo-campo">Entra em</span>
                <input type="date" class="input pag-data" value="${due_date}">
            </label>
        </div>
    `;
    container.appendChild(div);
    atualizarResumo();
}

function coletarParcelas() {
    return [...document.querySelectorAll('.parcela')].map(linha => ({
        amount: parseBRL(linha.querySelector('.pag-valor').value),
        method: linha.querySelector('.pag-forma').value,
        due_date: linha.querySelector('.pag-data').value || null
    })).filter(p => p.amount > 0);
}

// Mostra ao vivo o que cai na gaveta hoje e o que fica pendente.
function atualizarResumo() {
    let soma = 0, quantidade = 0;

    document.querySelectorAll('.parcela').forEach(linha => {
        const valor = parseBRL(linha.querySelector('.pag-valor').value);
        const metodo = linha.querySelector('.pag-forma').value;
        const data = linha.querySelector('.pag-data').value;
        const destino = linha.querySelector('.destino');

        const imediato = METODOS[metodo]?.imediato && (!data || data <= hojeISO());
        destino.className = `destino ${imediato ? 'na-gaveta' : 'a-compensar'}`;
        destino.textContent = imediato ? 'Entra na gaveta' : 'Ainda não é seu';

        if (valor > 0) { soma += valor; quantidade++; }
    });

    el('rec-soma').textContent = formatBRL(soma);
    el('rec-qtd').textContent = quantidade;

    // Confere contra o total da obra para o caixa não furar. Isso não é só um
    // aviso decorativo: o botão de confirmar muda de "Lançar" pra "Lançar
    // mesmo assim" quando não bate, pra ninguém apertar sem perceber.
    const total = parseBRL(el('rec-total').value);
    const aviso = el('rec-aviso');
    const botaoConfirmar = el('btn-confirmar-recebimento');
    const diferenca = total - soma;
    const naoBate = total > 0 && Math.abs(diferenca) >= 0.01;

    if (naoBate) {
        aviso.style.display = 'flex';
        aviso.textContent = diferenca > 0
            ? `Faltam ${formatBRL(diferenca)} para fechar o total da obra.`
            : `As parcelas passam ${formatBRL(Math.abs(diferenca))} do total da obra.`;
        botaoConfirmar.textContent = 'Lançar mesmo assim';
        botaoConfirmar.classList.add('btn-aviso');
    } else {
        aviso.style.display = 'none';
        botaoConfirmar.textContent = 'Lançar no caixa';
        botaoConfirmar.classList.remove('btn-aviso');
    }
}

function aplicarDivisao(percentualPrimeira) {
    const total = parseBRL(el('rec-total').value);
    if (total <= 0) {
        toast('Informe o valor total da obra primeiro.', 'erro');
        return;
    }

    el('rec-parcelas').innerHTML = '';

    if (percentualPrimeira >= 100) {
        novaParcela({ amount: total.toFixed(2).replace('.', ','), method: 'dinheiro' });
        return;
    }

    const primeira = Math.round(total * (percentualPrimeira / 100) * 100) / 100;
    const segunda = Math.round((total - primeira) * 100) / 100;

    const opcao = el('rec-obra').selectedOptions[0];
    const dataAgendada = opcao ? opcao.dataset.data : null;
    let dataSegunda = '';

    if (dataAgendada) {
        const d = new Date(dataAgendada);
        if (!Number.isNaN(d.getTime())) {
            d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
            d.setDate(d.getDate() + 1);
            dataSegunda = d.toISOString().slice(0, 10);
        }
    }

    if (!dataSegunda) {
        const amanha = new Date();
        amanha.setDate(amanha.getDate() + 1);
        amanha.setMinutes(amanha.getMinutes() - amanha.getTimezoneOffset());
        dataSegunda = amanha.toISOString().slice(0, 10);
    }

    novaParcela({ amount: primeira.toFixed(2).replace('.', ','), method: 'dinheiro', due_date: hojeISO() });
    novaParcela({ amount: segunda.toFixed(2).replace('.', ','), method: 'cartao', due_date: dataSegunda });
}

function preencherSelectObras(selectId) {
    const select = el(selectId);
    const abertas = state.tickets.filter(t => t.status !== 'concluido' || Number(t.value) > 0);

    select.innerHTML = abertas.length
        ? abertas.map(t =>
            `<option value="${t.id}" data-valor="${t.value || 0}" data-data="${t.scheduled_at || ''}">${escapeHtml(t.client_name)} — ${Number(t.value) > 0 ? formatBRL(t.value) : 'sem valor'}</option>`
          ).join('')
        : '<option value="">Nenhuma obra cadastrada</option>';
}

function abrirModalRecebimento(ticketId = null) {
    preencherSelectObras('rec-obra');
    if (ticketId) el('rec-obra').value = ticketId;

    sincronizarTotalObra();
    el('rec-parcelas').innerHTML = '';
    novaParcela();
    abrirModal('modal-recebimento');
}

function sincronizarTotalObra() {
    const opcao = el('rec-obra').selectedOptions[0];
    const valor = Number(opcao?.dataset.valor || 0);
    el('rec-total').value = valor > 0 ? valor.toFixed(2).replace('.', ',') : '';
    atualizarResumo();
}

async function lancarRecebimento() {
    const ticketId = el('rec-obra').value;
    const parcelas = coletarParcelas();

    if (!ticketId) { toast('Selecione a obra do lançamento.', 'erro'); return; }
    if (parcelas.length === 0) { toast('Informe pelo menos um valor recebido.', 'erro'); return; }

    const botao = el('btn-confirmar-recebimento');
    botao.disabled = true;

    try {
        await api('/transactions', {
            method: 'POST',
            body: JSON.stringify({ ticket_id: Number(ticketId), payments: parcelas })
        });
        fecharModais();
        await Promise.all([carregarCaixa(), carregarFunil({ silencioso: true })]);
        toast(`${parcelas.length} lançamento(s) registrado(s).`, 'sucesso');
    } catch (erro) {
        toast(erro.message, 'erro');
    } finally {
        botao.disabled = false;
    }
}

/* ---------------------------------------------------------
   Caixa
   --------------------------------------------------------- */

const PARES_CAIXA = [
    ['valor-gaveta', 'caixa-gaveta'],
    ['valor-compensar', 'caixa-compensar'],
    ['valor-previsao', 'caixa-previsao']
];

async function carregarCaixa() {
    try {
        const caixa = await api(`/cashflow?date=${hojeISO()}`);

        PARES_CAIXA.forEach(([a, b], i) => {
            const valor = formatBRL([caixa.caixa_hoje, caixa.a_compensar, caixa.previsao][i]);
            el(a).textContent = valor;
            el(b).textContent = valor;
        });
        document.querySelectorAll('.alerta-erro').forEach(a => { a.style.display = 'none'; });

        const tbody = el('tbody-caixa');
        tbody.innerHTML = caixa.lancamentos.length
            ? caixa.lancamentos.map(linhaCaixaHTML).join('')
            : '<tr class="vazia"><td colspan="5">Nenhum lançamento hoje.</td></tr>';
    } catch (erro) {
        console.error('[carregarCaixa]', erro);

        // Nunca afirmar "R$ 0,00" quando a leitura falhou: o dono leria
        // "não entrou nada hoje" e o caixa dele fura.
        PARES_CAIXA.flat().forEach(id => { el(id).textContent = '—'; });

        document.querySelectorAll('.alerta-erro').forEach(aviso => {
            aviso.style.display = 'flex';
            aviso.textContent = 'Não deu para ler o caixa agora. Os valores acima não são confiáveis — toque para tentar de novo.';
        });

        el('tbody-caixa').innerHTML =
            '<tr class="vazia"><td colspan="5">Não foi possível carregar os lançamentos.</td></tr>';
    }
}

function linhaCaixaHTML(lancamento) {
    const entrou = lancamento.status === 'cleared';
    const metodo = METODOS[lancamento.payment_method]?.label || lancamento.payment_method;
    const hora = new Date(lancamento.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    return `
        <tr>
            <td><span class="principal">${escapeHtml(lancamento.client_name)}</span><br>${escapeHtml(lancamento.ticket_title)}</td>
            <td class="num">${hora}</td>
            <td>${escapeHtml(metodo)}</td>
            <td class="num">${formatBRL(lancamento.amount)}</td>
            <td>${entrou
                ? '<span class="badge pago">Na gaveta</span>'
                : `<span class="badge compensar">Cai em ${formatDate(lancamento.due_date)}</span>`}</td>
        </tr>`;
}

// Lista TODA parcela pendente (não só a de hoje) — é aqui que a recepção
// confirma quando o cartão/boleto realmente cai na conta.
async function carregarPendentes() {
    const tbody = el('tbody-pendentes');
    try {
        const pendentes = await api('/transactions/pendentes');
        tbody.innerHTML = pendentes.length
            ? pendentes.map(linhaPendenteHTML).join('')
            : '<tr class="vazia"><td colspan="5">Nada pendente — tudo que foi lançado já compensou.</td></tr>';
    } catch (erro) {
        console.error('[carregarPendentes]', erro);
        tbody.innerHTML = '<tr class="vazia"><td colspan="5">Não foi possível carregar os pendentes.</td></tr>';
    }
}

function linhaPendenteHTML(lancamento) {
    const metodo = METODOS[lancamento.payment_method]?.label || lancamento.payment_method;
    const vencido = lancamento.due_date && lancamento.due_date < hojeISO();

    return `
        <tr>
            <td><span class="principal">${escapeHtml(lancamento.client_name)}</span><br>${escapeHtml(lancamento.ticket_title)}</td>
            <td>${escapeHtml(metodo)}</td>
            <td>${vencido
                ? `<span class="badge vencido">Venceu em ${formatDate(lancamento.due_date)}</span>`
                : formatDate(lancamento.due_date)}</td>
            <td class="num">${formatBRL(lancamento.amount)}</td>
            <td><button class="btn btn-ghost btn-xs" data-confirmar-recebido="${lancamento.id}">Confirmar recebido</button></td>
        </tr>`;
}

async function confirmarRecebido(transactionId) {
    try {
        await api(`/transactions/${transactionId}/confirmar`, { method: 'PATCH' });
        await Promise.all([carregarCaixa(), carregarPendentes(), carregarFunil({ silencioso: true })]);
        toast('Recebimento confirmado — entrou no caixa de hoje.', 'sucesso');
    } catch (erro) {
        toast(erro.message, 'erro');
    }
}

/* ---------------------------------------------------------
   Clientes
   --------------------------------------------------------- */

async function carregarClientes() {
    try {
        state.clients = await api('/clients');
        el('cont-clientes').textContent = state.clients.length;
        preencherSelectClientes();
        renderClientes();
    } catch (erro) {
        console.error('[carregarClientes]', erro);
    }
}

function renderClientes() {
    const termo = (el('busca-cliente')?.value || '').trim().toLowerCase();
    const tbody = el('tbody-clientes');

    const filtrados = state.clients.filter(c =>
        !termo
        || (c.name || '').toLowerCase().includes(termo)
        || (c.phone || '').toLowerCase().includes(termo)
        || (c.address || '').toLowerCase().includes(termo)
    );

    if (filtrados.length === 0) {
        tbody.innerHTML = `<tr class="vazia"><td colspan="5">${
            termo ? 'Nenhum cliente encontrado para essa busca.' : 'Nenhum cliente ainda. Os leads do WhatsApp entram sozinhos aqui.'
        }</td></tr>`;
        return;
    }

    tbody.innerHTML = filtrados.map(cliente => {
        const obras = state.tickets.filter(t => t.client_id === cliente.id).length;
        return `
        <tr>
            <td><span class="principal">${escapeHtml(cliente.name)}</span></td>
            <td>${escapeHtml(formatarTelefone(cliente.phone))}</td>
            <td>${escapeHtml(cliente.address || '—')}</td>
            <td class="num">${obras}</td>
            <td><button class="btn btn-ghost btn-xs" data-cliente="${cliente.id}">Abrir ficha</button></td>
        </tr>`;
    }).join('');
}

// O webhook grava o JID cru da Evolution ("5561999999999@s.whatsapp.net").
function formatarTelefone(valor) {
    if (!valor) return '—';
    const numero = String(valor).split('@')[0].replace(/\D/g, '');
    if (numero.length < 10) return valor;

    const semPais = numero.startsWith('55') ? numero.slice(2) : numero;
    const ddd = semPais.slice(0, 2);
    const resto = semPais.slice(2);
    if (resto.length < 8) return valor;

    return `(${ddd}) ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
}

async function abrirFichaCliente(id) {
    el('titulo-cliente').textContent = 'Ficha do cliente';
    el('cli-historico').innerHTML = '<p style="color: var(--ink-3);">Carregando histórico...</p>';
    abrirModal('modal-cliente');

    try {
        const cliente = await api(`/clients/${id}`);
        state.clienteEditando = cliente.id;

        el('cli-nome').value = cliente.name || '';
        el('cli-telefone').value = cliente.phone || '';
        el('cli-endereco').value = cliente.address || '';
        el('titulo-cliente').textContent = cliente.name;

        const obras = cliente.obras.map(obra => {
            const etapa = ETAPAS.find(e => e.id === obra.status);
            const pago = Number(obra.total_pago || 0);
            const pendente = Number(obra.total_pendente || 0);
            return `
            <tr>
                <td>${escapeHtml(obra.title)}<br><span style="color: var(--ink-3); font-size: 0.82rem;">${etapa ? escapeHtml(etapa.nome) : escapeHtml(obra.status)}</span></td>
                <td class="num">${Number(obra.value) > 0 ? formatBRL(obra.value) : '—'}</td>
                <td class="num">${pago > 0 ? formatBRL(pago) : '—'}</td>
                <td class="num">${pendente > 0 ? formatBRL(pendente) : '—'}</td>
            </tr>`;
        }).join('');

        el('cli-historico').innerHTML = `
            <div class="card" style="margin-top: 16px;">
                <div class="card-header"><span class="card-label">Histórico de obras</span></div>
                <div class="table-wrapper">
                    <table class="data-table" style="min-width: 460px;">
                        <thead>
                            <tr><th>Obra</th><th>Valor</th><th>Recebido</th><th>A compensar</th></tr>
                        </thead>
                        <tbody>
                            ${obras || '<tr class="vazia"><td colspan="4">Nenhuma obra registrada.</td></tr>'}
                        </tbody>
                    </table>
                </div>
            </div>
            ${cliente.orcamentos.length ? `
            <div class="card" style="margin-top: 12px;">
                <div class="card-header"><span class="card-label">Orçamentos emitidos</span></div>
                <div class="table-wrapper">
                    <table class="data-table" style="min-width: 420px;">
                        <thead><tr><th>Nº</th><th>Data</th><th>Total</th><th></th></tr></thead>
                        <tbody>
                            ${cliente.orcamentos.map(o => `
                            <tr>
                                <td class="num">${escapeHtml(o.number || o.id)}</td>
                                <td>${formatDate(o.created_at)}</td>
                                <td class="num">${formatBRL(o.total)}</td>
                                <td><button class="btn btn-ghost btn-xs" data-acao="ver-doc" data-doc="${o.id}">Ver doc.</button></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>` : ''}
        `;
    } catch (erro) {
        el('cli-historico').innerHTML = '';
        toast(erro.message, 'erro');
    }
}

function abrirNovoCliente() {
    state.clienteEditando = null;
    el('titulo-cliente').textContent = 'Novo cliente';
    el('cli-nome').value = '';
    el('cli-telefone').value = '';
    el('cli-endereco').value = '';
    el('cli-historico').innerHTML = '';
    abrirModal('modal-cliente');
}

async function salvarCliente() {
    const nome = el('cli-nome').value.trim();
    if (!nome) { toast('Informe o nome do cliente.', 'erro'); return; }

    const corpo = {
        name: nome,
        phone: el('cli-telefone').value.trim() || null,
        address: el('cli-endereco').value.trim() || null
    };

    const botao = el('btn-salvar-cliente');
    botao.disabled = true;

    try {
        if (state.clienteEditando) {
            await api(`/clients/${state.clienteEditando}`, { method: 'PUT', body: JSON.stringify(corpo) });
        } else {
            await api('/clients', { method: 'POST', body: JSON.stringify(corpo) });
        }
        fecharModais();
        await carregarClientes();
        toast('Cliente salvo.', 'sucesso');
    } catch (erro) {
        toast(erro.message, 'erro');
    } finally {
        botao.disabled = false;
    }
}

/* ---------------------------------------------------------
   Agenda
   --------------------------------------------------------- */

async function carregarAgenda() {
    try {
        state.agenda = await api(`/agenda?from=${hojeISO()}`);
        el('cont-agenda').textContent = state.agenda.length;
        renderAgenda();
    } catch (erro) {
        console.error('[carregarAgenda]', erro);
    }
}

function renderAgenda() {
    const lista = el('lista-agenda');

    const eventos = state.agenda.map(item => ({
        id: item.id,
        title: escapeHtml(item.client_name),
        start: item.scheduled_at,
        extendedProps: { ...item },
        color: '#8a6d00' // --accent-dk: o mesmo amarelo da marca em todo o resto do app
    }));

    if (!agendaCalendar) {
        lista.innerHTML = '';
        agendaCalendar = new FullCalendar.Calendar(lista, {
            initialView: 'dayGridMonth',
            locale: 'pt-br',
            events: eventos,
            editable: true,
            eventDrop: async function(info) {
                const id = info.event.id;
                const d = info.event.start;
                d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
                const newDate = d.toISOString();
                
                try {
                    await api(`/tickets/${id}/schedule`, {
                        method: 'PATCH',
                        body: JSON.stringify({ scheduled_at: newDate })
                    });
                    await carregarAgenda();
                    await carregarFunil({ silencioso: true });
                    toast('Data atualizada!');
                } catch (e) {
                    info.revert();
                    toast('Erro ao alterar a data.', 'erro');
                }
            },
            eventClick: function(info) {
                abrirModalData(info.event.id);
            }
        });
        agendaCalendar.render();
    } else {
        agendaCalendar.removeAllEvents();
        agendaCalendar.addEventSource(eventos);
        agendaCalendar.updateSize();
    }
}

function diasAte(dia) {
    const alvo = new Date(dia + 'T12:00:00');
    const hoje = new Date(hojeISO() + 'T12:00:00');
    const dias = Math.round((alvo - hoje) / 86400000);
    if (dias === 1) return 'Amanhã';
    return `Em ${dias} dias`;
}

function abrirModalData(ticketId = null) {
    preencherSelectObras('data-obra');
    if (ticketId) el('data-obra').value = ticketId;

    const opcao = el('data-obra').selectedOptions[0];
    const atual = opcao?.dataset.data;

    if (atual) {
        const d = new Date(atual);
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        el('data-dia').value = d.toISOString().slice(0, 10);
        el('data-hora').value = d.toISOString().slice(11, 16);
    } else {
        el('data-dia').value = hojeISO();
        el('data-hora').value = '09:00';
    }

    abrirModal('modal-data');
}

async function salvarData(limpar = false) {
    const ticketId = el('data-obra').value;
    if (!ticketId) { toast('Selecione a obra.', 'erro'); return; }

    let scheduled_at = null;
    if (!limpar) {
        const dia = el('data-dia').value;
        const hora = el('data-hora').value || '09:00';
        if (!dia) { toast('Escolha o dia.', 'erro'); return; }
        const d = new Date(`${dia}T${hora}:00`);
        // Mesma correção do eventDrop do calendário: sem isso, toISOString()
        // converte pro fuso UTC e a coluna TIMESTAMP do banco grava esse
        // horário deslocado como se fosse literal — 09:00 vira 12:00, e um
        // horário perto da meia-noite pode até cair no dia seguinte.
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        scheduled_at = d.toISOString();
    }

    try {
        await api(`/tickets/${ticketId}/schedule`, {
            method: 'PATCH',
            body: JSON.stringify({ scheduled_at })
        });
        fecharModais();
        await Promise.all([carregarAgenda(), carregarFunil({ silencioso: true })]);
        toast(limpar ? 'Obra tirada da agenda.' : 'Data marcada.', 'sucesso');
    } catch (erro) {
        toast(erro.message, 'erro');
    }
}

/* ---------------------------------------------------------
   Navegação e modais
   --------------------------------------------------------- */

function abrirSecao(nome) {
    document.querySelectorAll('.secao').forEach(s => s.classList.remove('ativa'));
    document.querySelectorAll('.sidebar-link').forEach(p => {
        p.classList.remove('ativa');
        p.removeAttribute('aria-current');
    });

    el(`secao-${nome}`)?.classList.add('ativa');
    const placa = document.querySelector(`.sidebar-link[data-secao="${nome}"]`);
    if (placa) { placa.classList.add('ativa'); placa.setAttribute('aria-current', 'page'); }

    fecharMenu();

    if (nome === 'caixa') { carregarCaixa(); carregarPendentes(); }
    if (nome === 'funil') carregarFunil({ silencioso: true });
    if (nome === 'agenda') {
        // Primeiro carrega os dados, depois renderiza com delay
        // para que o container já esteja visível (display!=none)
        // quando o FullCalendar calcular as dimensões.
        (async () => {
            try {
                state.agenda = await api(`/agenda?from=${hojeISO()}`);
                el('cont-agenda').textContent = state.agenda.length;
            } catch (e) { console.error('[carregarAgenda]', e); }
            setTimeout(() => renderAgenda(), 50);
        })();
    }
    if (nome === 'clientes') carregarClientes();
    if (nome === 'dashboard') carregarDashboard();

    window.scrollTo({ top: 0, behavior: 'instant' });
}

let focoAnterior = null;

/* Menu lateral no celular */
function abrirMenu() {
    el('sidebar').classList.add('aberta');
    el('overlay-menu').classList.add('aberta');
}
function fecharMenu() {
    el('sidebar').classList.remove('aberta');
    el('overlay-menu').classList.remove('aberta');
}

function abrirModal(id) {
    focoAnterior = document.activeElement;
    const modal = el(id);
    modal.classList.add('aberta');
    // Entra no primeiro campo: a recepção digita o dia inteiro.
    modal.querySelector('.input, button')?.focus();
}

function fecharModais() {
    const tinhaAberto = document.querySelector('.modal-overlay.aberta');
    document.querySelectorAll('.modal-overlay.aberta').forEach(m => m.classList.remove('aberta'));
    if (tinhaAberto && focoAnterior?.isConnected) focoAnterior.focus();
    focoAnterior = null;
}

async function sair() {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}

    // O service worker guarda respostas de /api/* (obras, clientes, caixa,
    // faturamento) em Cache Storage, que não tem controle de acesso próprio.
    // Sem isso, esses dados continuam recuperáveis pelo DevTools num
    // aparelho compartilhado mesmo depois do logout.
    try {
        if (window.caches) {
            const nomes = await caches.keys();
            await Promise.all(nomes.map(nome => caches.delete(nome)));
        }
    } catch {}

    window.location.href = '/login.html';
}

async function carregarSettings() {
    try {
        state.settings = await api('/settings');
        if (state.settings.company_name) {
            document.title = `${state.settings.company_name} — Gestão de obras`;
            el('marca-nome').textContent = state.settings.company_name;
            el('marca-movel').textContent = state.settings.company_name;
        }
        // Logo real da empresa, quando cadastrada em settings.
        if (state.settings.logo_url) {
            document.querySelectorAll('.logo-badge').forEach(badge => {
                badge.innerHTML = `<img src="${escapeHtml(state.settings.logo_url)}" alt="">`;
            });
        }
    } catch (erro) {
        console.error('[carregarSettings]', erro);
    }
}

async function carregarUsuario() {
    try {
        const me = await api('/auth/me');
        el('usuario-ativo').textContent = me.username;
    } catch {}
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
    carregarSettings();
    carregarUsuario();
    carregarFunil();
    carregarCaixa();
    carregarClientes();
    carregarAgenda();

    // Pórtico
    document.querySelectorAll('.sidebar-link').forEach(placa => {
        placa.addEventListener('click', () => abrirSecao(placa.dataset.secao));
    });
    document.querySelectorAll('[data-sair]').forEach(b => b.addEventListener('click', sair));
    el('btn-menu').addEventListener('click', abrirMenu);
    el('overlay-menu').addEventListener('click', fecharMenu);

    // Seletor de etapa do celular
    el('tabs-etapa').addEventListener('click', evento => {
        const botao = evento.target.closest('[data-etapa-btn]');
        if (!botao) return;
        state.etapaVisivel = botao.dataset.etapaBtn;
        renderSeletorEtapa();
    });

    // Ações dos cards e de qualquer tabela (delegação: o HTML é recriado)
    document.querySelector('.conteudo').addEventListener('click', evento => {
        const acao = evento.target.closest('[data-acao]');
        if (acao) {
            if (acao.dataset.acao === 'orcar') abrirModalOrcamento(acao.dataset.id);
            if (acao.dataset.acao === 'ver-doc') verDocumento(acao.dataset.doc);
            if (acao.dataset.acao === 'receber') abrirModalRecebimento(acao.dataset.id);
            if (acao.dataset.acao === 'agendar') abrirModalData(acao.dataset.id);
            if (acao.dataset.acao === 'apagar') apagarTicket(acao.dataset.id);
            return;
        }
        const ficha = evento.target.closest('[data-cliente]');
        if (ficha) abrirFichaCliente(ficha.dataset.cliente);

        const confirmar = evento.target.closest('[data-confirmar-recebido]');
        if (confirmar) confirmarRecebido(confirmar.dataset.confirmarRecebido);
    });

    // Mudar etapa sem arrastar — é o único caminho que existe no celular.
    document.querySelector('.conteudo').addEventListener('change', evento => {
        const seletor = evento.target.closest('[data-mudar-etapa]');
        if (seletor) mudarEtapa(seletor.dataset.id, seletor.value);
    });

    // Ver documento a partir da ficha do cliente (fica dentro do modal)
    el('modal-cliente').addEventListener('click', evento => {
        const acao = evento.target.closest('[data-acao="ver-doc"]');
        if (acao) { fecharModais(); verDocumento(acao.dataset.doc); }
    });

    // --- Orçamento ---
    el('btn-novo-orcamento').addEventListener('click', () => abrirModalOrcamento());
    el('btn-add-item').addEventListener('click', () => novaLinhaItem());
    el('orc-cliente').addEventListener('change', alternarNovoCliente);
    el('btn-gerar-orcamento').addEventListener('click', gerarOrcamento);

    const itens = el('orc-itens');
    itens.addEventListener('input', recalcularOrcamento);
    itens.addEventListener('click', evento => {
        if (evento.target.closest('[data-remover-item]')) {
            evento.target.closest('.linha-item').remove();
            if (!document.querySelector('.linha-item')) novaLinhaItem();
            recalcularOrcamento();
        }
    });

    // --- Recebimento ---
    el('btn-lancar').addEventListener('click', () => abrirModalRecebimento());
    el('btn-add-parcela').addEventListener('click', () => novaParcela());
    el('btn-confirmar-recebimento').addEventListener('click', lancarRecebimento);
    el('rec-obra').addEventListener('change', sincronizarTotalObra);
    el('rec-total').addEventListener('input', atualizarResumo);

    document.querySelectorAll('[data-divisao]').forEach(botao => {
        botao.addEventListener('click', () => aplicarDivisao(Number(botao.dataset.divisao)));
    });

    const parcelas = el('rec-parcelas');
    parcelas.addEventListener('input', atualizarResumo);
    parcelas.addEventListener('change', evento => {
        if (evento.target.classList.contains('pag-forma')) {
            const dataInput = evento.target.closest('.parcela').querySelector('.pag-data');
            const metodo = evento.target.value;
            
            const opcao = el('rec-obra').selectedOptions[0];
            const dataAgendada = opcao ? opcao.dataset.data : null;
            
            let dataServico = hojeISO();
            
            const d1 = new Date();
            d1.setDate(d1.getDate() + 1);
            d1.setMinutes(d1.getMinutes() - d1.getTimezoneOffset());
            let dataServicoMaisUm = d1.toISOString().slice(0, 10);
            
            if (dataAgendada) {
                const dA = new Date(dataAgendada);
                if (!Number.isNaN(dA.getTime())) {
                    dA.setMinutes(dA.getMinutes() - dA.getTimezoneOffset());
                    dataServico = dA.toISOString().slice(0, 10);
                    dA.setDate(dA.getDate() + 1);
                    dataServicoMaisUm = dA.toISOString().slice(0, 10);
                }
            }
            
            const hojePadrao = hojeISO();
            const amanhaPadrao = d1.toISOString().slice(0, 10);
            
            if (metodo === 'cartao' || metodo === 'boleto') {
                if (!dataInput.value || dataInput.value === hojePadrao || dataInput.value === dataServico) {
                    dataInput.value = dataServicoMaisUm;
                }
            } else {
                if (!dataInput.value || dataInput.value === amanhaPadrao || dataInput.value === dataServicoMaisUm) {
                    dataInput.value = dataServico;
                }
            }
        }
        atualizarResumo();
    });
    parcelas.addEventListener('click', evento => {
        if (evento.target.closest('[data-remover-parcela]')) {
            evento.target.closest('.parcela').remove();
            if (!document.querySelector('.parcela')) novaParcela();
            atualizarResumo();
        }
    });

    // --- Clientes ---
    el('btn-novo-cliente').addEventListener('click', abrirNovoCliente);
    el('btn-salvar-cliente').addEventListener('click', salvarCliente);
    el('busca-cliente').addEventListener('input', renderClientes);

    // --- Agenda ---
    el('btn-marcar-data').addEventListener('click', () => abrirModalData());
    el('btn-salvar-data').addEventListener('click', () => salvarData(false));
    el('btn-limpar-data').addEventListener('click', () => salvarData(true));
    el('data-obra').addEventListener('change', () => abrirModalData(el('data-obra').value));

    // --- Fechar modais ---
    document.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', fecharModais));
    document.querySelectorAll('.modal-overlay').forEach(cobertura => {
        cobertura.addEventListener('click', evento => {
            if (evento.target === cobertura) fecharModais();
        });
    });
    document.addEventListener('keydown', evento => {
        if (evento.key === 'Escape') { fecharModais(); fecharMenu(); return; }

        // A recepção digita o dia inteiro: Enter salva, como em qualquer formulário.
        // Textarea e botão ficam de fora, senão Enter perde a quebra de linha.
        if (evento.key !== 'Enter') return;
        const aberto = document.querySelector('.modal-overlay.aberta');
        if (!aberto || !aberto.contains(evento.target)) return;
        if (evento.target.tagName === 'TEXTAREA' || evento.target.tagName === 'BUTTON') return;

        evento.preventDefault();
        aberto.querySelector('.modal-footer .btn-primary')?.click();
    });

    el('btn-voltar-funil').addEventListener('click', () => abrirSecao('funil'));

    // Leads chegam pelo webhook da Evolution; o painel confere a cada 15s.
    setInterval(() => {
        if (el('secao-funil').classList.contains('ativa')) carregarFunil({ silencioso: true });
    }, 15000);
});
