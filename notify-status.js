// Avisa o COMPRADOR (push no Chrome) quando o vendedor aceita, recusa ou entrega um pedido.
// Exige o token do VENDEDOR; só envia se orders/{id}.sellerId == uid e o estado do pedido é o indicado.
const { admin, init, sendPush } = require('./_push');

const SITE = (process.env.SITE_URL || 'https://girashop.vercel.app').replace(/\/$/, '');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MSG = {
  aceite: (n) => ['Pedido aceite', n + ' foi aceite. Abre o chat para combinar a entrega.'],
  recusado: (n) => ['Pedido recusado', 'O vendedor não pôde aceitar ' + n + '. Procura outro produto na loja.'],
  entregue: (n) => ['Pedido entregue', n + ' foi marcado como entregue.']
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method' }); }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'not-configured' });
  try {
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'auth' });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = body.orderId;
    if (typeof id !== 'string' || !ID_RE.test(id)) return res.status(400).json({ error: 'orderId' });
    const db = admin.firestore();
    const ref = db.collection('orders').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'not-found' });
    const o = snap.data();
    if (o.sellerId !== decoded.uid) return res.status(403).json({ error: 'forbidden' });
    if (!MSG[o.status]) return res.status(200).json({ status: 'ignored' });
    // idempotente por estado
    if (o.pushStatus === o.status) return res.status(200).json({ status: 'already' });
    await ref.update({ pushStatus: o.status });
    const item = Array.isArray(o.items) && o.items.length ? String(o.items[0].name || 'O teu pedido') : 'O teu pedido';
    const [title, text] = MSG[o.status](item);
    const r = await sendPush(db, o.buyerUid, { title, body: text, url: SITE + '/?abrir=compras', tag: 'order-' + id + '-' + o.status });
    return res.status(200).json({ status: 'ok', sent: r.sent });
  } catch (e) {
    const code = e && e.code && String(e.code).startsWith('auth/') ? 401 : 500;
    return res.status(code).json({ error: code === 401 ? 'auth' : 'server' });
  }
};
