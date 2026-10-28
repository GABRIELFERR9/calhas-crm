const db = require('./database');

// Vocabulário único de status do Kanban. As colunas do front usam exatamente estes ids.
const TICKET_STATUS = ['aguardando', 'orcamento', 'instalacao', 'concluido'];

async function initDatabase() {
    console.log('[DB] Iniciando verificação do banco de dados...');
    try {
        // Tabela de Clientes/Leads
        await db.query(`
            CREATE TABLE IF NOT EXISTS clients (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                address TEXT,
                status VARCHAR(50) DEFAULT 'lead', -- lead, active, inactive
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Tabela de Tickets (Kanban)
        await db.query(`
            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                client_id INTEGER REFERENCES clients(id),
                title VARCHAR(255) NOT NULL,
                description TEXT,
                status VARCHAR(50) DEFAULT 'aguardando',
                value DECIMAL(10, 2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Tabela de Transações Financeiras (Lançamento Inteligente)
        await db.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                ticket_id INTEGER REFERENCES tickets(id),
                type VARCHAR(50),
                amount DECIMAL(10, 2) NOT NULL,
                payment_method VARCHAR(100),
                status VARCHAR(50) DEFAULT 'pending', -- pending, cleared
                due_date DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Dados da empresa (white-label). Logo e dados reais entram aqui depois,
        // sem precisar tocar em uma linha de código.
        await db.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                company_name VARCHAR(255) NOT NULL DEFAULT 'Sua Empresa',
                cnpj VARCHAR(50) DEFAULT '',
                phone VARCHAR(50) DEFAULT '',
                email VARCHAR(255) DEFAULT '',
                address TEXT DEFAULT '',
                logo_url TEXT DEFAULT '',
                budget_validity_days INTEGER DEFAULT 15,
                terms_payment TEXT DEFAULT '',
                terms_warranty TEXT DEFAULT '',
                terms_execution TEXT DEFAULT '',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT settings_singleton CHECK (id = 1)
            );
        `);

        // Orçamentos gerados (o PDF é a renderização deste registro)
        await db.query(`
            CREATE TABLE IF NOT EXISTS budgets (
                id SERIAL PRIMARY KEY,
                ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
                client_id INTEGER REFERENCES clients(id),
                number VARCHAR(30),
                total DECIMAL(10, 2) NOT NULL DEFAULT 0,
                notes TEXT,
                valid_until DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS budget_items (
                id SERIAL PRIMARY KEY,
                budget_id INTEGER REFERENCES budgets(id) ON DELETE CASCADE,
                description TEXT NOT NULL,
                quantity VARCHAR(50) DEFAULT '1',
                unit_price DECIMAL(10, 2) NOT NULL DEFAULT 0,
                total DECIMAL(10, 2) NOT NULL DEFAULT 0,
                position INTEGER DEFAULT 0
            );
        `);

        // Login único do dono (Fase 2). A recepção usa o mesmo acesso.
        await db.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                username VARCHAR(80) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS sessoes (
                token VARCHAR(128) PRIMARY KEY,
                usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                expira_em TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await db.query(`CREATE INDEX IF NOT EXISTS sessoes_expira_idx ON sessoes (expira_em)`);

        await runMigrations();

        console.log('[DB] Tabelas criadas ou já existem.');
    } catch (error) {
        console.error('[DB ERROR] Erro ao criar tabelas:', error);
        throw error;
    }
}

// Postgres não tem "ADD CONSTRAINT IF NOT EXISTS" para CHECK — sem isso,
// toda reinicialização do PM2 tentaria recriar a constraint e falharia.
async function addCheckConstraintIfMissing(tabela, nome, expressao) {
    await db.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = '${nome}'
            ) THEN
                ALTER TABLE ${tabela} ADD CONSTRAINT ${nome} CHECK (${expressao});
            END IF;
        END $$;
    `);
}

// Ajustes em bancos que já rodaram a versão anterior do schema.
async function runMigrations() {
    // O protótipo criava tickets com status 'lead'/'visit'/'quote'/'production'/'install'/'done',
    // que não batiam com nenhuma coluna do Kanban — os cards ficavam invisíveis.
    const legacyStatus = {
        lead: 'aguardando',
        visit: 'aguardando',
        quote: 'orcamento',
        production: 'instalacao',
        install: 'instalacao',
        done: 'concluido'
    };

    for (const [from, to] of Object.entries(legacyStatus)) {
        await db.query(`UPDATE tickets SET status = $1 WHERE status = $2`, [to, from]);
    }

    // Qualquer status desconhecido volta para a primeira coluna em vez de sumir da tela.
    await db.query(
        `UPDATE tickets SET status = 'aguardando' WHERE status IS NULL OR status <> ALL($1::text[])`,
        [TICKET_STATUS]
    );

    // Endereço e tipo de serviço aparecem no card e no PDF.
    await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS address TEXT`);
    await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS service_type VARCHAR(100)`);
    await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP`);

    // Descrição do lançamento financeiro (aparece na tabela do caixa).
    await db.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description VARCHAR(255)`);

    // O webhook antigo podia gravar o mesmo telefone duas vezes. Junta os duplicados
    // antes de criar o índice único — senão o CREATE INDEX falha e o sistema não sobe.
    await db.query(`
        WITH duplicados AS (
            SELECT id, phone,
                   MIN(id) OVER (PARTITION BY phone) AS manter
            FROM clients
            WHERE phone IS NOT NULL
        )
        UPDATE tickets t
        SET client_id = d.manter
        FROM duplicados d
        WHERE t.client_id = d.id AND d.id <> d.manter
    `);

    await db.query(`
        WITH duplicados AS (
            SELECT id, phone,
                   MIN(id) OVER (PARTITION BY phone) AS manter
            FROM clients
            WHERE phone IS NOT NULL
        )
        UPDATE budgets b
        SET client_id = d.manter
        FROM duplicados d
        WHERE b.client_id = d.id AND d.id <> d.manter
    `);

    await db.query(`
        DELETE FROM clients c
        WHERE c.phone IS NOT NULL
          AND c.id > (SELECT MIN(c2.id) FROM clients c2 WHERE c2.phone = c.phone)
    `);

    // Busca por telefone no webhook: sem índice vira scan a cada mensagem recebida.
    await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS clients_phone_unique
         ON clients (phone) WHERE phone IS NOT NULL`
    );

    // Índices nas colunas usadas em JOIN/WHERE toda vez que a tela de Obras carrega.
    // Sem eles, cada abertura do Kanban faz varredura completa de transactions/budgets
    // à medida que o histórico cresce — hoje é rápido só porque o banco está quase vazio.
    await db.query(`CREATE INDEX IF NOT EXISTS tickets_client_id_idx ON tickets (client_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS tickets_updated_at_idx ON tickets (updated_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS tickets_client_status_idx ON tickets (client_id, status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS transactions_ticket_status_idx ON transactions (ticket_id, status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS budgets_ticket_id_idx ON budgets (ticket_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS budget_items_budget_id_idx ON budget_items (budget_id)`);
    await db.query(`
        CREATE INDEX IF NOT EXISTS tickets_scheduled_at_idx
        ON tickets (scheduled_at) WHERE scheduled_at IS NOT NULL
    `);
    // Índice funcional: POST /tickets e /budgets buscam cliente por lower(name).
    await db.query(`CREATE INDEX IF NOT EXISTS clients_name_lower_idx ON clients (lower(name))`);

    // Integridade financeira reforçada no próprio banco, não só na API — uma parcela
    // ou obra com valor negativo furaria o caixa sem que nenhuma tela avisasse.
    await addCheckConstraintIfMissing('transactions', 'transactions_amount_positive', 'amount > 0');
    await addCheckConstraintIfMissing('transactions', 'transactions_status_valido', `status IN ('pending', 'cleared')`);
    await addCheckConstraintIfMissing('tickets', 'tickets_value_nao_negativo', '(value IS NULL OR value >= 0)');
    await addCheckConstraintIfMissing('tickets', 'tickets_status_valido', `status IN ('aguardando', 'orcamento', 'instalacao', 'concluido')`);
    await addCheckConstraintIfMissing('budget_items', 'budget_items_valores_nao_negativos', '(unit_price >= 0 AND total >= 0)');
    await addCheckConstraintIfMissing('budgets', 'budgets_total_nao_negativo', 'total >= 0');

    // Garante a linha única de configuração da empresa (placeholder até chegarem os dados reais).
    await db.query(`
        INSERT INTO settings (id, company_name, cnpj, phone, email, address,
                              terms_payment, terms_warranty, terms_execution)
        VALUES (1, 'Sua Empresa', '00.000.000/0001-00', '(61) 00000-0000',
                'contato@exemplo.com.br', 'Brasília / DF',
                '50% de sinal no aceite (PIX), 50% na conclusão da instalação. Aceitamos cartão (taxas a consultar).',
                '12 meses contra vazamentos na instalação e defeitos de fabricação dos materiais.',
                '2 a 3 dias úteis após a confirmação do sinal.')
        ON CONFLICT (id) DO NOTHING
    `);
}

module.exports = { initDatabase, TICKET_STATUS };
