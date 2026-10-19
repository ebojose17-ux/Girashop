// Função serverless da Vercel: envia ao vendedor um e-mail a avisar de um novo pedido.
//
// Segurança:
//  - exige o token de login Firebase do COMPRADOR (Authorization: Bearer <idToken>);
//  - só envia para pedidos em que buyerUid == uid do token;
//  - o destinatário vem SEMPRE da base de dados (sellers/{sellerId}.email), nunca do pedido HTTP;
//  - idempotente: um pedido só gera um e-mail (campo emailStatus no pedido).
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//  FIREBASE_SERVICE_ACCOUNT  JSON completo da conta de serviço Firebase (Admin SDK)
//  RESEND_API_KEY            chave da API do Resend (https://resend.com)
//  MAIL_FROM                 remetente verificado no Resend, ex.: "GiraShop <avisos@teu-dominio.com>"
//  SITE_URL                  (opcional) por omissão https://girashop.vercel.app

const { admin, init, sendPush } = require('./_push');

const SITE = (process.env.SITE_URL || 'https://girashop.vercel.app').replace(/\/$/, '');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STALE_SENDING_MS = 2 * 60 * 1000;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendMail(to, subject, html, text) {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) throw new Error('mail-not-configured');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, html, text })
  });
  if (!r.ok) throw new Error('resend ' + r.status);
}

async function handleOne(db, uid, id) {
  const ref = db.collection('orders').doc(id);
  // reserva o envio de forma atómica (evita duplicados com pedidos em paralelo)
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { out: { id, status: 'not-found', final: true } };
    const o = snap.data();
    if (o.buyerUid !== uid) return { out: { id, status: 'forbidden', final: true } };
    if (o.emailStatus === 'sent' || o.emailStatus === 'skipped') return { out: { id, status: o.emailStatus, final: true } };
    const t = o.emailSendingAt ? Date.parse(o.emailSendingAt) : 0;
    if (o.emailStatus === 'sending' && Date.now() - t < STALE_SENDING_MS) return { out: { id, status: 'sending', final: false } };
    tx.update(ref, { emailStatus: 'sending', emailSendingAt: new Date().toISOString(), emailAttempts: (o.emailAttempts || 0) + 1 });
    return { order: o };
  });
  if (claim.out) return claim.out;
  const o = claim.order;

  try {
    // push no Chrome ao vendedor (a etiqueta 'order-<id>' evita notificações repetidas)
    try {
      const its = Array.isArray(o.items) ? o.items : [];
      const nm = its.length ? String(its[0].name || 'Produto') + (its.length > 1 ? ' +' + (its.length - 1) : '') : 'Produto';
      await sendPush(db, o.sellerId, { title: 'Novo pedido no GiraShop', body: nm.slice(0, 60) + ' · ' + (o.code || id), url: SITE + '/?abrir=pedidos', tag: 'order-' + id });
    } catch (e) { console.warn('push falhou', e && e.code); }
    if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
      await ref.update({ emailStatus: 'skipped', emailNote: 'e-mail não configurado' });
      return { id, status: 'skipped', final: true };
    }
    // e-mail do vendedor vem da base de dados
    let to = '';
    const sv = await db.collection('sellers').doc(o.sellerId).get();
    if (sv.exists && sv.data().email) to = String(sv.data().email);
    if (!to) {
      const us = await db.collection('users').doc(o.sellerId).get();
      if (us.exists && us.data().email) to = String(us.data().email);
    }
    if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(to)) {
      await ref.update({ emailStatus: 'skipped', emailNote: 'vendedor sem e-mail' });
      return { id, status: 'skipped', final: true };
    }
    const items = Array.isArray(o.items) ? o.items : [];
    const product = items.length ? String(items[0].name || 'Produto') + (items.length > 1 ? ' +' + (items.length - 1) : '') : 'Produto';
    const date = new Date(o.date || Date.now()).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Luanda' });
    const link = SITE + '/?abrir=pedidos';
    const subject = 'Novo pedido no GiraShop: ' + product.slice(0, 60);
    const html = '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#10201A">'
      + '<h2 style="color:#0A7B58;margin:0 0 12px">Novo pedido no GiraShop</h2>'
      + '<p>Recebeste um pedido para o produto <strong>' + esc(product) + '</strong>.</p>'
      + '<p style="color:#51635B">Pedido ' + esc(o.code || id) + ' · ' + esc(date) + '</p>'
      + '<p><a href="' + esc(link) + '" style="display:inline-block;background:#0A7B58;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Ver pedido</a></p>'
      + '<p style="color:#51635B;font-size:13px">Entra no GiraShop e abre Área do vendedor → Pedidos para aceitar ou recusar.</p></div>';
    const text = 'Novo pedido no GiraShop: ' + product + ' (' + (o.code || id) + ', ' + date + '). Abre ' + link + ' e vai a Área do vendedor > Pedidos.';
    await sendMail(to, subject, html, text);
    await ref.update({ emailStatus: 'sent', emailSentAt: new Date().toISOString() });
    return { id, status: 'sent', final: true };
  } catch (e) {
    await ref.update({ emailStatus: 'error', emailError: String(e.message || e).slice(0, 120) }).catch(() => {});
    return { id, status: 'error', final: false };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method' }); }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    return res.status(503).json({ error: 'not-configured' });
  }
  try {
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'auth' });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const ids = (Array.isArray(body.orderIds) ? body.orderIds : []).filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 10);
    if (!ids.length) return res.status(400).json({ error: 'orderIds' });
    const db = admin.firestore();
    const results = [];
    for (const id of ids) results.push(await handleOne(db, decoded.uid, id));
    return res.status(200).json({ results });
  } catch (e) {
    const code = e && e.code && String(e.code).startsWith('auth/') ? 401 : 500;
    return res.status(code).json({ error: code === 401 ? 'auth' : 'server' });
  }
};
