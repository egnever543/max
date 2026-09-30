// Função serverless (Vercel) que ativa o cliente no MaxPlayer.
// Fluxo: (opcional) valida o login no servidor Xtream -> verifica se já existe no MaxPlayer -> cria.
// O servidor usado pelo app é o do domínio cadastrado no painel (MAXPLAYER_DOMAIN_ID).

const API = 'https://api.maxplayer.tv/v3/api/public';
const { MAXPLAYER_TOKEN, MAXPLAYER_DOMAIN_ID, XTREAM_URL, MAX_DEVICES } = process.env;

// Limite simples por IP (por instância). Para tráfego alto, use o Firewall da Vercel ou Upstash.
const tentativas = new Map();
const JANELA_MS = 10 * 60 * 1000;
const MAX_TENTATIVAS = 5;

function bloqueado(ip) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter((t) => agora - t < JANELA_MS);
  lista.push(agora);
  tentativas.set(ip, lista);
  return lista.length > MAX_TENTATIVAS;
}

function responder(res, status, ok, mensagem) {
  return res.status(status).json({ ok, mensagem });
}

async function maxplayer(caminho, opcoes = {}) {
  const r = await fetch(API + caminho, {
    ...opcoes,
    headers: {
      'Api-Token': MAXPLAYER_TOKEN,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  let dados = null;
  try { dados = await r.json(); } catch { /* resposta sem JSON */ }
  return { status: r.status, dados };
}

// Confere o login direto no servidor Xtream (player_api.php)
async function validarNoServidor(usuario, senha) {
  const url = `${XTREAM_URL.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(usuario)}&password=${encodeURIComponent(senha)}`;
  let info;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    info = (await r.json())?.user_info;
  } catch {
    return { ok: false, motivo: 'offline' };
  }
  if (!info || Number(info.auth) !== 1) return { ok: false, motivo: 'invalido' };
  if (info.status && info.status !== 'Active') return { ok: false, motivo: 'inativo' };
  if (info.exp_date && Number(info.exp_date) * 1000 < Date.now()) return { ok: false, motivo: 'vencido' };
  return { ok: true };
}

// Procura o usuário exato no MaxPlayer (a busca é por "contém", então comparamos o nome inteiro)
async function jaExiste(usuario) {
  let cursor = '';
  for (let pagina = 0; pagina < 5; pagina++) {
    const qs = cursor ? `?limit=100&after_id=${cursor}` : '?limit=100';
    const { status, dados } = await maxplayer('/users/search' + qs, {
      method: 'POST',
      body: JSON.stringify({ username: usuario }),
    });
    if (status !== 200 || !dados) throw new Error(`busca falhou (${status})`);
    const lista = dados.users || [];
    if (lista.some((u) => (u.username || '').toLowerCase() === usuario.toLowerCase())) return true;
    if (!dados.has_more || !dados.next_cursor) return false;
    cursor = dados.next_cursor;
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return responder(res, 405, false, 'Método não permitido.');

  if (!MAXPLAYER_TOKEN || !MAXPLAYER_DOMAIN_ID) {
    console.error('Variáveis de ambiente faltando');
    return responder(res, 500, false, 'Ativação indisponível no momento. Fale com o suporte.');
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'sem-ip';
  if (bloqueado(ip)) {
    return responder(res, 429, false, 'Muitas tentativas. Aguarde 10 minutos e tente de novo.');
  }

  let corpo = req.body;
  if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch { corpo = {}; } }
  const { usuario: u, senha: s, site } = corpo || {};

  // Campo invisível: robôs preenchem, pessoas não
  if (site) return responder(res, 200, true, 'Recebido.');

  const usuario = typeof u === 'string' ? u.trim() : '';
  const senha = typeof s === 'string' ? s.trim() : '';
  if (!usuario || !senha || usuario.length > 128 || senha.length > 128 || /\s/.test(usuario)) {
    return responder(res, 400, false, 'Preencha o login e a senha exatamente como recebeu, sem espaços.');
  }

  // 1. Login existe e está ativo no servidor? (só se XTREAM_URL estiver configurada)
  const v = XTREAM_URL ? await validarNoServidor(usuario, senha) : { ok: true };
  if (!v.ok) {
    const msgs = {
      invalido: 'Login ou senha não conferem. Confira as letras maiúsculas e minúsculas.',
      inativo: 'Esse acesso está bloqueado. Fale com quem vendeu sua assinatura.',
      vencido: 'Essa assinatura venceu. Renove para ativar o app.',
      offline: 'Não conseguimos conferir seu login agora. Tente de novo em alguns minutos.',
    };
    return responder(res, v.motivo === 'offline' ? 503 : 400, false, msgs[v.motivo]);
  }

  try {
    // 2. Já foi ativado antes?
    if (await jaExiste(usuario)) {
      return responder(res, 200, true, 'Esse login já está ativado. É só abrir o MaxPlayer e entrar.');
    }

    // 3. Cria o cliente (login e senha do app = login e senha do servidor)
    const payload = { domain_id: MAXPLAYER_DOMAIN_ID, iptv_user: usuario, iptv_pass: senha };
    const telas = parseInt(MAX_DEVICES, 10);
    if (telas > 0) payload.max_devices = telas;

    const { status, dados } = await maxplayer('/users', { method: 'POST', body: JSON.stringify(payload) });

    if (status === 200 && dados?.success === 1) {
      console.log('Ativado:', usuario, 'id', dados.user_id);
      return responder(res, 200, true, 'Pronto! Seu app foi ativado.');
    }

    console.error('MaxPlayer recusou', status, dados?.error);
    if (status === 429) return responder(res, 503, false, 'Muitas ativações agora. Tente em 1 minuto.');
    if (status === 409) return responder(res, 409, false, 'Não foi possível ativar esse login automaticamente. Fale com o suporte.');
    return responder(res, 502, false, 'A ativação falhou. Tente de novo ou fale com o suporte.');
  } catch (e) {
    console.error('Erro na ativação:', e.message);
    return responder(res, 503, false, 'Não conseguimos falar com o MaxPlayer agora. Tente em alguns minutos.');
  }
}
