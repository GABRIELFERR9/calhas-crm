const express = require('express');
const router = express.Router();
const db = require('../database');
const { TICKET_STATUS } = require('../schema');

// Métodos que caem no caixa no mesmo dia x métodos que ficam pendentes de compensação.
const IMMEDIATE_METHODS = ['dinheiro', 'pix'];

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

// Erro para o log, mensagem genérica para o cliente (não expõe estrutura do banco).
function fail(res, err, contexto) {
    console.error(`[API ERROR] ${contexto}:`, err.message);
    res.status(500).json({ error: 'Não foi possível concluir a operação. Tente novamente.' });
}

// --- CONFIGURAÇÕES DA EMPRESA (white-label) ---
// GET /settings é pública e fica registrada em server.js (o login.html
// precisa dela antes do usuário entrar). Aqui só a escrita, que exige sessão.
router.put('/settings', async (req, res) => {
    const campos = ['company_name', 'cnpj', 'phone', 'email', 'address', 'logo_url',
        'budget_validity_days', 'terms_payment', 'terms_warranty', 'terms_execution'];
    const informados = campos.filter(c => req.body[c] !== undefined);

    if (informados.length === 0) {
        return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    }

    try {
        const sets = informados.map((c, i) => `${c} = $${i + 1}`).join(', ');
        const valores = informados.map(c => req.body[c]);
        const result = await db.query(
            `UPDATE settings SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = 1 RETURNING *`,
            valores
        );
        res.json(result.rows[0]);
    } catch (err) {
        fail(res, err, 'PUT /settings');
    }
});

// --- CLIENTES ---
router.get('/clients', async (req, res) => {
    try {
        const result = await db.query(`SELECT * FROM clients ORDER BY name ASC`);
        res.json(result.rows);
    } catch (err) {
        fail(res, err, 'GET /clients');
    }
});

router.post('/clients', async (req, res) => {
    const { name, phone, address } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
    }
    try {
        const result = await db.query(
            `INSERT INTO clients (name, phone, address) VALUES ($1, $2, $3) RETURNING *`,
            [name.trim(), phone || null, address || null]
        );
        res.json(result.rows[0]);
    } catch (err) {
        fail(res, err, 'POST /clients');
    }
});

// Ficha do cliente: cadastro + histórico de obras e do que ele já pagou.
router.get('/clients/:id', async (req, res) => {
    try {
        const cliente = await db.query(`SELECT * FROM clients WHERE id = $1`, [req.params.id]);
        if (cliente.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });

        const obras = await db.query(`
            SELECT t.*,
                   COALESCE(pago.total, 0)     AS total_pago,
                   COALESCE(pendente.total, 0) AS total_pendente
            FROM tickets t
            LEFT JOIN (SELECT ticket_id, SUM(amount) total FROM transactions WHERE status='cleared' GROUP BY ticket_id) pago
                   ON pago.ticket_id = t.id
            LEFT JOIN (SELECT ticket_id, SUM(amount) total FROM transactions WHERE status='pending' GROUP BY ticket_id) pendente
                   ON pendente.ticket_id = t.id
            WHERE t.client_id = $1
            ORDER BY t.created_at DESC
        `, [req.params.id]);

        const orcamentos = await db.query(
            `SELECT id, number, total, created_at FROM budgets WHERE client_id = $1 ORDER BY created_at DESC`,
            [req.params.id]
        );

        res.json({ ...cliente.rows[0], obras: obras.rows, orcamentos: orcamentos.rows });
    } catch (err) {
        fail(res, err, 'GET /clients/:id');
    }
});

router.put('/clients/:id', async (req, res) => {
    const { name, phone, address } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
    try {
        const r = await db.query(
            `UPDATE clients SET name = $1, phone = $2, address = $3 WHERE id = $4 RETURNING *`,
            [name.trim(), phone || null, address || null, req.params.id]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
        res.json(r.rows[0]);
    } catch (err) {
        fail(res, err, 'PUT /clients/:id');
    }
});

// --- AGENDA ---
// Só obras com data marcada. O painel mostra a semana; o dono confere de pé.
router.get('/agenda', async (req, res) => {
    const inicio = req.query.from || hoje();
    const fim = req.query.to || null;
    try {
        const r = await db.query(`
            SELECT t.id, t.title, t.status, t.value, t.scheduled_at, t.service_type,
                   c.name AS client_name, c.phone AS client_phone,
                   COALESCE(t.address, c.address) AS full_address
            FROM tickets t
            JOIN clients c ON t.client_id = c.id
            WHERE t.scheduled_at IS NOT NULL
              AND t.scheduled_at >= $1::date
              AND ($2::date IS NULL OR t.scheduled_at < ($2::date + 1))
            ORDER BY t.scheduled_at ASC
        `, [inicio, fim]);
        res.json(r.rows);
    } catch (err) {
        fail(res, err, 'GET /agenda');
    }
});

// Marcar/desmarcar data da obra. Marcar já move o card para "Instalação Agendada".
router.patch('/tickets/:id/schedule', async (req, res) => {
    const { scheduled_at } = req.body;
    try {
        const r = await db.query(
            `UPDATE tickets
             SET scheduled_at = $1,
                 status = CASE WHEN $1::timestamp IS NOT NULL AND status IN ('aguardando','orcamento')
                               THEN 'instalacao' ELSE status END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 RETURNING *`,
            [scheduled_at || null, req.params.id]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Serviço não encontrado.' });
        res.json(r.rows[0]);
    } catch (err) {
        fail(res, err, 'PATCH /tickets/:id/schedule');
    }
});

// --- DASHBOARD ---
router.get('/dashboard', async (req, res) => {
    try {
        // 1. Faturamento do mês (transações cleared, pelo dia em que o dinheiro
        // realmente entrou — due_date quando existe, não a data em que foi digitado.
        // Mesma convenção do /cashflow: uma parcela de cartão lançada em julho mas
        // só confirmada em agosto conta como faturamento de agosto, não de julho.
        const faturamentoRes = await db.query(`
            SELECT SUM(amount) as total
            FROM transactions
            WHERE status = 'cleared'
              AND EXTRACT(MONTH FROM COALESCE(due_date, created_at::date)) = EXTRACT(MONTH FROM CURRENT_DATE)
              AND EXTRACT(YEAR FROM COALESCE(due_date, created_at::date)) = EXTRACT(YEAR FROM CURRENT_DATE)
        `);
        const faturamentoMes = faturamentoRes.rows[0]?.total || 0;

        // 2. Taxa de conversão e Ticket Médio
        const obrasRes = await db.query(`
            SELECT 
                COUNT(*) as total_obras,
                SUM(CASE WHEN status = 'concluido' THEN 1 ELSE 0 END) as concluidas,
                SUM(CASE WHEN status = 'concluido' THEN value ELSE 0 END) as valor_concluido
            FROM tickets
        `);
        const stats = obrasRes.rows[0];
        const totalObras = Number(stats.total_obras) || 0;
        const concluidas = Number(stats.concluidas) || 0;
        const valorConcluido = Number(stats.valor_concluido) || 0;
        
        const taxaConversao = totalObras > 0 ? (concluidas / totalObras) * 100 : 0;
        const ticketMedio = concluidas > 0 ? valorConcluido / concluidas : 0;

        // 3. Gráfico de Receita dos últimos 6 meses — mesma convenção do item 1.
        const graficoRes = await db.query(`
            SELECT
                TO_CHAR(COALESCE(due_date, created_at::date), 'YYYY-MM') as mes,
                SUM(amount) as total
            FROM transactions
            WHERE status = 'cleared'
              AND COALESCE(due_date, created_at::date) >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
            GROUP BY TO_CHAR(COALESCE(due_date, created_at::date), 'YYYY-MM')
            ORDER BY mes ASC
        `);

        res.json({
            faturamentoMes,
            taxaConversao: taxaConversao.toFixed(1),
            ticketMedio,
            historico: graficoRes.rows
        });

    } catch (err) {
        fail(res, err, 'GET /dashboard');
    }
});

// --- TICKETS (KANBAN) ---
// Traz o ticket já com o quanto foi recebido, para o card mostrar a situação real.
router.get('/tickets', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT t.*,
                   c.name  AS client_name,
                   c.phone AS client_phone,
                   COALESCE(t.address, c.address) AS full_address,
                   COALESCE(pago.total, 0)      AS total_pago,
                   COALESCE(pendente.total, 0)  AS total_pendente,
                   COALESCE(vencido.total, 0)   AS total_vencido,
                   b.id AS budget_id
            FROM tickets t
            JOIN clients c ON t.client_id = c.id
            LEFT JOIN (
                SELECT ticket_id, SUM(amount) AS total FROM transactions
                WHERE status = 'cleared' GROUP BY ticket_id
            ) pago ON pago.ticket_id = t.id
            LEFT JOIN (
                SELECT ticket_id, SUM(amount) AS total FROM transactions
                WHERE status = 'pending' GROUP BY ticket_id
            ) pendente ON pendente.ticket_id = t.id
            -- Parcela pendente com vencimento no passado: é isso que merece alarme.
            LEFT JOIN (
                SELECT ticket_id, SUM(amount) AS total FROM transactions
                WHERE status = 'pending' AND due_date IS NOT NULL AND due_date < CURRENT_DATE
                GROUP BY ticket_id
            ) vencido ON vencido.ticket_id = t.id
            LEFT JOIN LATERAL (
                SELECT id FROM budgets WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1
            ) b ON true
            ORDER BY t.updated_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        fail(res, err, 'GET /tickets');
    }
});

// Cria um ticket. Reaproveita o cliente existente em vez de duplicar o cadastro.
router.post('/tickets', async (req, res) => {
    const { client_id, client_name, client_phone, title, value, address, service_type } = req.body;
    try {
        let clientId = client_id;

        if (!clientId) {
            if (!client_name || !client_name.trim()) {
                return res.status(400).json({ error: 'Informe um cliente existente ou o nome do novo cliente.' });
            }
            const existente = await db.query(
                `SELECT id FROM clients WHERE lower(name) = lower($1) OR (phone IS NOT NULL AND phone = $2) LIMIT 1`,
                [client_name.trim(), client_phone || null]
            );
            if (existente.rows.length > 0) {
                clientId = existente.rows[0].id;
            } else {
                const novo = await db.query(
                    `INSERT INTO clients (name, phone, address) VALUES ($1, $2, $3) RETURNING id`,
                    [client_name.trim(), client_phone || null, address || null]
                );
                clientId = novo.rows[0].id;
            }
        }

        const ticket = await db.query(
            `INSERT INTO tickets (client_id, title, value, status, address, service_type)
             VALUES ($1, $2, $3, 'aguardando', $4, $5) RETURNING *`,
            [clientId, title || 'Novo serviço', toNumber(value), address || null, service_type || null]
        );

        res.json(ticket.rows[0]);
    } catch (err) {
        fail(res, err, 'POST /tickets');
    }
});

// Atualiza o status do ticket (mover no Kanban)
router.patch('/tickets/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!TICKET_STATUS.includes(status)) {
        return res.status(400).json({ error: `Status inválido. Use um de: ${TICKET_STATUS.join(', ')}` });
    }

    try {
        const result = await db.query(
            `UPDATE tickets SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
            [status, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket não encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        fail(res, err, 'PATCH /tickets/:id/status');
    }
});

// Apagar ticket e suas transações/orçamentos
router.delete('/tickets/:id', async (req, res) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        // Transações não têm ON DELETE CASCADE, então removemos manualmente
        await client.query(`DELETE FROM transactions WHERE ticket_id = $1`, [req.params.id]);
        // Orçamentos têm ON DELETE CASCADE e removem seus itens, então só apagar o ticket
        const result = await client.query(`DELETE FROM tickets WHERE id = $1 RETURNING *`, [req.params.id]);
        
        await client.query('COMMIT');
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket não encontrado.' });
        }
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        fail(res, err, 'DELETE /tickets/:id');
    } finally {
        client.release();
    }
});

// --- ORÇAMENTOS (PDF) ---
// Grava o orçamento com os itens digitados no painel e devolve tudo que o PDF precisa.
router.post('/budgets', async (req, res) => {
    const { ticket_id, client_id, client_name, client_phone, address, items, notes, service_type } = req.body;
    const linhas = Array.isArray(items) ? items.filter(i => i && i.description && i.description.trim()) : [];

    if (linhas.length === 0) {
        return res.status(400).json({ error: 'Inclua pelo menos um serviço ou material no orçamento.' });
    }

    // Preço negativo furaria o total do orçamento silenciosamente. O banco também
    // rejeita (CHECK), mas aqui devolvemos uma mensagem que a recepção entende.
    const itemInvalido = linhas.find(item => toNumber(item.unit_price) < 0);
    if (itemInvalido) {
        return res.status(400).json({ error: `Valor unitário não pode ser negativo: "${itemInvalido.description}".` });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Resolve o cliente
        let clientId = client_id;
        if (!clientId) {
            if (!client_name || !client_name.trim()) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Informe o cliente do orçamento.' });
            }
            const existente = await client.query(
                `SELECT id FROM clients WHERE lower(name) = lower($1) LIMIT 1`,
                [client_name.trim()]
            );
            clientId = existente.rows.length > 0
                ? existente.rows[0].id
                : (await client.query(
                    `INSERT INTO clients (name, phone, address) VALUES ($1, $2, $3) RETURNING id`,
                    [client_name.trim(), client_phone || null, address || null]
                )).rows[0].id;
        }

        const total = linhas.reduce(
            (soma, item) => soma + toNumber(item.unit_price) * toNumber(item.quantity_number ?? 1),
            0
        );

        // Resolve o ticket: usa o existente ou abre um novo já na coluna de orçamento
        let ticketId = ticket_id;
        if (ticketId) {
            await client.query(
                `UPDATE tickets SET value = $1, status = 'orcamento', updated_at = CURRENT_TIMESTAMP,
                        address = COALESCE($2, address), service_type = COALESCE($3, service_type)
                 WHERE id = $4`,
                [total, address || null, service_type || null, ticketId]
            );
        } else {
            const novoTicket = await client.query(
                `INSERT INTO tickets (client_id, title, value, status, address, service_type)
                 VALUES ($1, $2, $3, 'orcamento', $4, $5) RETURNING id`,
                [clientId, service_type || 'Orçamento de calhas', total, address || null, service_type || null]
            );
            ticketId = novoTicket.rows[0].id;
        }

        const config = await client.query(`SELECT budget_validity_days FROM settings WHERE id = 1`);
        const validade = config.rows[0]?.budget_validity_days ?? 15;

        const budget = await client.query(
            `INSERT INTO budgets (ticket_id, client_id, total, notes, valid_until)
             VALUES ($1, $2, $3, $4, CURRENT_DATE + $5::int) RETURNING *`,
            [ticketId, clientId, total, notes || null, validade]
        );
        const budgetId = budget.rows[0].id;

        await client.query(`UPDATE budgets SET number = $1 WHERE id = $2`,
            [String(budgetId).padStart(4, '0'), budgetId]);

        for (const [i, item] of linhas.entries()) {
            const qtdNum = toNumber(item.quantity_number ?? 1);
            const unit = toNumber(item.unit_price);
            await client.query(
                `INSERT INTO budget_items (budget_id, description, quantity, unit_price, total, position)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [budgetId, item.description.trim(), String(item.quantity ?? qtdNum), unit, unit * qtdNum, i]
            );
        }

        await client.query('COMMIT');
        res.json(await carregarOrcamento(budgetId));
    } catch (err) {
        await client.query('ROLLBACK');
        fail(res, err, 'POST /budgets');
    } finally {
        client.release();
    }
});

router.get('/budgets/:id', async (req, res) => {
    try {
        const orcamento = await carregarOrcamento(req.params.id);
        if (!orcamento) return res.status(404).json({ error: 'Orçamento não encontrado.' });
        res.json(orcamento);
    } catch (err) {
        fail(res, err, 'GET /budgets/:id');
    }
});

async function carregarOrcamento(id) {
    const budget = await db.query(`
        SELECT b.*, c.name AS client_name, c.phone AS client_phone,
               COALESCE(t.address, c.address) AS client_address,
               t.service_type
        FROM budgets b
        JOIN clients c ON b.client_id = c.id
        LEFT JOIN tickets t ON b.ticket_id = t.id
        WHERE b.id = $1
    `, [id]);

    if (budget.rows.length === 0) return null;

    const items = await db.query(
        `SELECT * FROM budget_items WHERE budget_id = $1 ORDER BY position ASC, id ASC`, [id]
    );
    const settings = await db.query(`SELECT * FROM settings WHERE id = 1`);

    return { ...budget.rows[0], items: items.rows, settings: settings.rows[0] || {} };
}

// --- FINANCEIRO (LANÇAMENTO INTELIGENTE) ---
// Aceita N parcelas. Dinheiro/PIX com vencimento até hoje entram no caixa;
// cartão e boleto ficam pendentes até a data de compensação.
router.post('/transactions', async (req, res) => {
    const { ticket_id, payments } = req.body;
    const parcelas = Array.isArray(payments) ? payments.filter(p => toNumber(p.amount) > 0) : [];

    if (!ticket_id) return res.status(400).json({ error: 'Informe o serviço do lançamento.' });
    if (parcelas.length === 0) return res.status(400).json({ error: 'Informe pelo menos um valor recebido.' });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const ticket = await client.query(`SELECT id FROM tickets WHERE id = $1`, [ticket_id]);
        if (ticket.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Serviço não encontrado.' });
        }

        const gravadas = [];
        for (const parcela of parcelas) {
            const metodo = String(parcela.method || 'dinheiro').toLowerCase();
            const vencimento = parcela.due_date || null;
            const imediato = IMMEDIATE_METHODS.includes(metodo);
            // Só entra no caixa se for método imediato E não estiver agendado para o futuro.
            const status = imediato && (!vencimento || vencimento <= hoje()) ? 'cleared' : 'pending';

            const inserida = await client.query(
                `INSERT INTO transactions (ticket_id, type, amount, payment_method, status, due_date, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [
                    ticket_id,
                    status === 'cleared' ? 'entrada_caixa' : 'a_compensar',
                    toNumber(parcela.amount),
                    metodo,
                    status,
                    vencimento || (imediato ? hoje() : null),
                    parcela.description || null
                ]
            );
            gravadas.push(inserida.rows[0]);
        }

        await client.query(
            `UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [ticket_id]
        );

        await client.query('COMMIT');
        res.json({ success: true, transactions: gravadas });
    } catch (err) {
        await client.query('ROLLBACK');
        fail(res, err, 'POST /transactions');
    } finally {
        client.release();
    }
});

// Caixa do dia: o que está na gaveta, o que cai depois e a lista de lançamentos.
router.get('/cashflow', async (req, res) => {
    const data = req.query.date || hoje();
    try {
        const caixaHoje = await db.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
             WHERE status = 'cleared' AND COALESCE(due_date, created_at::date) = $1::date`,
            [data]
        );

        const aCompensar = await db.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE status = 'pending'`
        );

        const proximos = await db.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
             WHERE status = 'pending' AND due_date IS NOT NULL AND due_date > $1::date`,
            [data]
        );

        const lancamentos = await db.query(`
            SELECT tr.*, c.name AS client_name, t.title AS ticket_title
            FROM transactions tr
            JOIN tickets t ON tr.ticket_id = t.id
            JOIN clients c ON t.client_id = c.id
            WHERE COALESCE(tr.due_date, tr.created_at::date) = $1::date
               OR tr.created_at::date = $1::date
            ORDER BY tr.created_at DESC
        `, [data]);

        res.json({
            date: data,
            caixa_hoje: Number(caixaHoje.rows[0].total),
            a_compensar: Number(aCompensar.rows[0].total),
            previsao: Number(proximos.rows[0].total),
            lancamentos: lancamentos.rows
        });
    } catch (err) {
        fail(res, err, 'GET /cashflow');
    }
});

function hoje() {
    return new Date().toISOString().slice(0, 10);
}

// Toda parcela 'pending' (cartão/boleto) fica assim para sempre a menos que
// alguém confirme aqui. Sem isso, "ainda não é seu" só cresce mesmo depois
// do dinheiro já ter caído na conta — o sistema nunca assume sozinho.
router.get('/transactions/pendentes', async (req, res) => {
    try {
        const r = await db.query(`
            SELECT tr.*, c.name AS client_name, t.title AS ticket_title
            FROM transactions tr
            JOIN tickets t ON tr.ticket_id = t.id
            JOIN clients c ON t.client_id = c.id
            WHERE tr.status = 'pending'
            ORDER BY tr.due_date ASC NULLS LAST, tr.created_at ASC
        `);
        res.json(r.rows);
    } catch (err) {
        fail(res, err, 'GET /transactions/pendentes');
    }
});

router.patch('/transactions/:id/confirmar', async (req, res) => {
    try {
        const r = await db.query(
            `UPDATE transactions
             SET status = 'cleared', due_date = CURRENT_DATE
             WHERE id = $1 AND status = 'pending'
             RETURNING *`,
            [req.params.id]
        );
        if (r.rows.length === 0) {
            return res.status(404).json({ error: 'Lançamento não encontrado ou já confirmado.' });
        }
        res.json(r.rows[0]);
    } catch (err) {
        fail(res, err, 'PATCH /transactions/:id/confirmar');
    }
});

// --- WHATSAPP (EVOLUTION API) ---
router.post('/webhook', async (req, res) => {
    try {
        const payload = req.body;
        const dados = payload?.data;

        if (dados?.message && dados?.key && !dados.key.fromMe) {
            const pushName = dados.pushName || 'Lead Sem Nome';
            const from = dados.key.remoteJid;
            const texto = dados.message.conversation
                || dados.message.extendedTextMessage?.text
                || '';

            // Cria o cliente se for a primeira mensagem dele.
            const clientResult = await db.query(
                `INSERT INTO clients (name, phone) VALUES ($1, $2)
                 ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET name = clients.name
                 RETURNING id`,
                [pushName, from]
            );
            const clientId = clientResult.rows[0].id;

            // Só abre ticket novo se o cliente não tiver nenhum serviço em aberto —
            // assim cliente recorrente também gera atendimento, sem duplicar card.
            const emAberto = await db.query(
                `SELECT id FROM tickets WHERE client_id = $1 AND status <> 'concluido' LIMIT 1`,
                [clientId]
            );

            if (emAberto.rows.length === 0) {
                await db.query(
                    `INSERT INTO tickets (client_id, title, description, value, status)
                     VALUES ($1, $2, $3, 0, 'aguardando')`,
                    [clientId, 'Novo contato via WhatsApp', texto.slice(0, 500) || null]
                );
            } else {
                // Já existe atendimento: registra a mensagem e sobe o card na coluna.
                await db.query(
                    `UPDATE tickets SET updated_at = CURRENT_TIMESTAMP,
                            description = COALESCE($1, description)
                     WHERE id = $2`,
                    [texto.slice(0, 500) || null, emAberto.rows[0].id]
                );
            }
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error('[WEBHOOK ERROR]', err.message);
        res.status(200).send('OK'); // nunca faz a Evolution reenfileirar
    }
});

module.exports = router;
