require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDatabase } = require('./schema');
const auth = require('./auth');
const db = require('./database');

const app = express();

// Atrás do nginx na VPS: sem isso o cookie Secure e o IP do cliente saem errados.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const PUBLIC_DIR = path.join(__dirname, '../public');

// --- Rotas públicas de autenticação ---
const rotasAuth = express.Router();
auth.registrarRotas(rotasAuth);
app.use('/api', rotasAuth);

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'SaaS Calhas rodando liso!' });
});

// Pública de propósito: o login.html precisa do nome/logo da empresa antes
// de o usuário entrar. Nada sensível aqui — os mesmos dados já aparecem no
// PDF de orçamento que vai pro cliente final.
app.get('/api/settings', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM settings WHERE id = 1`);
        res.json(r.rows[0] || {});
    } catch (err) {
        console.error('[API ERROR] GET /settings (pública):', err.message);
        res.status(500).json({ error: 'Não foi possível carregar as configurações.' });
    }
});

// --- Webhook: servidor-para-servidor, autenticado por token, nunca por cookie ---
app.use('/api/webhook', auth.exigirTokenWebhook);

// --- Todo o resto da API exige sessão ---
app.use('/api', (req, res, next) => {
    if (req.path === '/webhook') return next();
    return auth.exigirAuthApi(req, res, next);
});

app.use('/api', require('./routes/api'));

// --- Front ---
// index:false para a shell do painel não escapar pelo static sem passar pela sessão.
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get(['/', '/index.html'], auth.exigirAuthPagina, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3001;

async function startServer() {
    try {
        await initDatabase();
        await auth.garantirUsuarioInicial();
        await auth.limparSessoesVencidas();

        if (!process.env.WEBHOOK_TOKEN) {
            console.warn('[AVISO] WEBHOOK_TOKEN não definido: o webhook da Evolution vai recusar tudo.');
        }

        // Uma vez por dia basta para não deixar a tabela de sessões crescer à toa.
        setInterval(() => auth.limparSessoesVencidas(), 24 * 60 * 60 * 1000).unref();

        app.listen(PORT, () => {
            console.log(`[SERVER] Sistema rodando na porta ${PORT}`);
        });
    } catch (error) {
        // Sem sair do processo o PM2 acha que está tudo bem e nunca reinicia:
        // o app fica "online" sem atender ninguém.
        console.error('[SERVER ERROR] Falha ao iniciar o sistema:', error);
        process.exit(1);
    }
}

startServer();
