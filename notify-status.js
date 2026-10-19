// Avisa a outra pessoa (push no telemóvel/Chrome) quando o estado de um pedido muda.
//  - vendedor aceita / recusa / entrega  -> aviso ao COMPRADOR
//  - comprador ou vendedor cancela       -> aviso à outra pessoa
// Também repõe o stock quando o COMPRADOR cancela um pedido que o vendedor já tinha aceite
// (o comprador não tem permissão para escrever nos produtos, por isso é o servidor que o faz).
const { admin, init, sendPush } = require('./_push');

const SITE = (process.env.SITE_URL || 'https://girashop.vercel.app').replace(/\/$/, '');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MSG = {
  aceite: (n) => ['Pedido aceite ✅', n + ' foi aceite. Abre o chat para combinar a entrega.'],
  recusado: (n) => ['Pedido recusado', 'O vendedor não pôde aceitar ' + n + '. Procura outro produto na loja.'],
  entregue: (n) => ['Pedido entregue', n + ' foi marcado como entregue.'],
  cancelado: (n) => ['Pedido cancelado', 'O pedido de ' + n + ' foi cancelado. A conversa foi encerrada.']
};

async function restoreStock(db, id) {
  await db.runTransaction(async (tx) => {
    const ref = db.collection('orders').doc(id);
    const snap = await tx.get(ref);
    const o = snap.data();
    if (!o || o.stockRestored || !o.acceptedAt || o.status !== 'cancelado' || o.cancelledBy !== o.buyerUid) return;
    const items = Array.isArray(o.items) ? o.items : [];
    const prods = [];
    for (const it of items) prods.push(await tx.get(db.collection('products').doc(String(it.id))));
    prods.forEach((ps, i) => {
      if (ps.exists && ps.data().sellerId === o.sellerId) tx.update(ps.ref, { qty: (Number(ps.data().qty) || 0) + (Number(items[i].qty) || 0) });
    });
    tx.update(ref, { stockRestored: true });
  });
}

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
    const uid = decoded.uid;
    if (!MSG[o.status]) return res.status(200).json({ status: 'ignored' });

    let to;
    if (o.status === 'cancelado') {
      const by = o.cancelledBy || o.buyerUid; // cancelamento antes de aceitar não guarda cancelledBy: foi o comprador
      if (uid !== by || (uid !== o.buyerUid && uid !== o.sellerId)) return res.status(403).json({ error: 'forbidden' });
      to = uid === o.buyerUid ? o.sellerId : o.buyerUid;
      if (uid === o.buyerUid && o.acceptedAt) await restoreStock(db, id).catch((e) => console.warn('stock', e && e.message));
    } else {
      if (o.sellerId !== uid) return res.status(403).json({ error: 'forbidden' });
      to = o.buyerUid;
    }
    if (o.pushStatus === o.status) return res.status(200).json({ status: 'already' });
    await ref.update({ pushStatus: o.status });
    const item = Array.isArray(o.items) && o.items.length ? String(o.items[0].name || 'O pedido') : 'O pedido';
    const [title, text] = MSG[o.status](item);
    const toSeller = to === o.sellerId;
    const r = await sendPush(db, to, { title, body: text, url: SITE + (toSeller ? '/?abrir=pedidos' : '/?abrir=compras'), tag: 'order-' + id + '-' + o.status });
    return res.status(200).json({ status: 'ok', sent: r.sent });
  } catch (e) {
    const code = e && e.code && String(e.code).startsWith('auth/') ? 401 : 500;
    return res.status(code).json({ error: code === 401 ? 'auth' : 'server' });
  }
};
