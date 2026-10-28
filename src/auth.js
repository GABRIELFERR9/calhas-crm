const crypto = require('crypto');
const db = require('./database');

const COOKIE = 'calhas_sess';
const DURACAO_DIAS = 14;

/* ---------- hash de senha (scrypt nativo, sem dependência externa) ---------- */

function hashSenha(senha) {
    const sal = crypto.randomBytes(16).toString('hex');
    const derivada = crypto.scryptSync(senha, sal, 64).toString('hex');
    return `scrypt$${sal}$${derivada}`;
}

function conferirSenha(senha, guardado) {
    try {
        const [algoritmo, sal, esperado] = String(guardado).split('$');
        if (algoritmo !== 'scrypt' || !sal || !esperado) return false;

        const derivada = crypto.scryptSync(senha, sal, 64);
        const alvo = Buffer.from(esperado, 'hex');
        // Comprimentos diferentes fazem timingSafeEqual lançar em vez de retornar false.
        if (derivada.length !== alvo.length) return false;
        return crypto.timingSafeEqual(derivada, alvo);
    } catch {
        return false;
    }
}

/* ---------- cookies (sem cookie-parser) ---------- */

function lerCookies(req) {
    const cru = req.headers.cookie;
    if (!cru) return {};
    return Object.fromEntries(
        cru.split(';').map(parte => {
            const i = parte.indexOf('=');
            if (i < 0) return [parte.trim(), ''];
            return [parte.slice(0, i).trim(), decodeURIComponent(parte.slice(i + 1).trim())];
        })
    );
}

function definirCookieSessao(res, token) {
    const partes = [
        `${COOKIE}=${token}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Lax',
        `Max-Age=${DURACAO_DIAS * 24 * 60 * 60}`
    ];
    if (process.env.COOKIE_SECURE === 'true') partes.push('Secure');
    res.setHeader('Set-Cookie', partes.join('; '));
}

function limparCookieSessao(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/* ---------- sessões ---------- */

async function criarSessao(usuarioId) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
        `INSERT INTO sessoes (token, usuario_id, expira_em)
         VALUES ($1, $2, CURRENT_TIMESTAMP + ($3 || ' days')::interval)`,
        [token, usuarioId, String(DURACAO_DIAS)]
    );
    return token;
}

async function buscarSessao(token) {
    if (!token) return null;
    const r = await db.query(
        `SELECT s.token, s.usuario_id, u.username
         FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.token = $1 AND s.expira_em > CURRENT_TIMESTAMP`,
        [token]
    );
    return r.rows[0] || null;
}

async function encerrarSessao(token) {
    if (token) await db.query(`DELETE FROM sessoes WHERE token = $1`, [token]);
}

/* ---------- middlewares ---------- */

// Para /api/*: responde 401 em JSON para o front tratar.
async function exigirAuthApi(req, res, next) {
    try {
        const sessao = await buscarSessao(lerCookies(req)[COOKIE]);
        if (!sessao) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
        req.usuario = sessao;
        next();
    } catch (err) {
        console.error('[AUTH ERROR]', err.message);
        res.status(500).json({ error: 'Falha ao validar a sessão.' });
    }
}

// Para páginas: manda para a tela de login.
async function exigirAuthPagina(req, res, next) {
    try {
        const sessao = await buscarSessao(lerCookies(req)[COOKIE]);
        if (!sessao) return res.redirect('/login.html');
        req.usuario = sessao;
        next();
    } catch {
        res.redirect('/login.html');
    }
}

// O webhook não usa cookie: é servidor-para-servidor, autenticado por token fixo.
function exigirTokenWebhook(req, res, next) {
    const esperado = process.env.WEBHOOK_TOKEN;

    if (!esperado) {
        console.error('[WEBHOOK] Recusado: WEBHOOK_TOKEN não configurado no .env');
        return res.status(503).json({ error: 'Webhook não configurado.' });
    }

    const recebido = req.get('apikey') || req.get('x-webhook-token') || req.query.token || '';
    const a = Buffer.from(String(recebido));
    const b = Buffer.from(esperado);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.warn('[WEBHOOK] Token inválido recusado.');
        return res.status(401).json({ error: 'Token inválido.' });
    }
    next();
}

/* ---------- rotas ---------- */

function registrarRotas(router) {
    router.post('/auth/login', async (req, res) => {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Informe usuário e senha.' });
        }

        try {
            const r = await db.query(`SELECT * FROM usuarios WHERE lower(username) = lower($1)`, [username]);
            const usuario = r.rows[0];

            // Mensagem única para não revelar se o usuário existe.
            if (!usuario || !conferirSenha(password, usuario.password_hash)) {
                return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
            }

            const token = await criarSessao(usuario.id);
            definirCookieSessao(res, token);
            res.json({ success: true, username: usuario.username });
        } catch (err) {
            console.error('[LOGIN ERROR]', err.message);
            res.status(500).json({ error: 'Não foi possível entrar. Tente novamente.' });
        }
    });

    router.post('/auth/logout', async (req, res) => {
        await encerrarSessao(lerCookies(req)[COOKIE]).catch(() => {});
        limparCookieSessao(res);
        res.json({ success: true });
    });

    router.get('/auth/me', async (req, res) => {
        const sessao = await buscarSessao(lerCookies(req)[COOKIE]).catch(() => null);
        if (!sessao) return res.status(401).json({ error: 'Não autenticado.' });
        res.json({ username: sessao.username });
    });
}

/* ---------- primeiro acesso ---------- */

// Cria o login do dono na primeira subida. Sem ADMIN_PASSWORD no .env,
// gera uma senha e imprime UMA vez no log do PM2.
async function garantirUsuarioInicial() {
    const usuario = process.env.ADMIN_USER || 'dono';
    const existe = await db.query(`SELECT id FROM usuarios LIMIT 1`);
    if (existe.rows.length > 0) return;

    const senha = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
    await db.query(
        `INSERT INTO usuarios (username, password_hash) VALUES ($1, $2)`,
        [usuario, hashSenha(senha)]
    );

    console.log('\n' + '='.repeat(58));
    console.log('  ACESSO CRIADO — anote agora, não aparece de novo:');
    console.log(`  usuário: ${usuario}`);
    console.log(`  senha:   ${senha}`);
    if (!process.env.ADMIN_PASSWORD) {
        console.log('  (defina ADMIN_PASSWORD no .env para escolher a senha)');
    }
    console.log('='.repeat(58) + '\n');
}

// Sessões vencidas não servem para nada e só incham a tabela.
async function limparSessoesVencidas() {
    await db.query(`DELETE FROM sessoes WHERE expira_em < CURRENT_TIMESTAMP`).catch(() => {});
}

module.exports = {
    exigirAuthApi,
    exigirAuthPagina,
    exigirTokenWebhook,
    registrarRotas,
    garantirUsuarioInicial,
    limparSessoesVencidas,
    hashSenha
};
