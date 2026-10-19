// Push de nova mensagem de chat (como o WhatsApp): chega ao telemóvel da outra pessoa mesmo com o site fechado.
// Segurança: exige o login de quem escreveu; só envia se essa pessoa é membro do chat e foi ela a última a escrever;
// o pedido tem de estar 'aceite' (chat aberto); uma só notificação por mensagem (pushedAt == lastAt).
const { admin, init, sendPush } = require('./_push');

const SITE = (process.env.SITE_URL || 'https://girashop.vercel.app').replace(/\/$/, '');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
    const id = body.chatId;
    if (typeof id !== 'string' || !ID_RE.test(id)) return res.status(400).json({ error: 'chatId' });
    const db = admin.firestore();
    const cref = db.collection('chats').doc(id);
    const [cs, os] = await Promise.all([cref.get(), db.collection('orders').doc(id).get()]);
    if (!cs.exists || !os.exists) return res.status(404).json({ error: 'not-found' });
    const c = cs.data();
    const uid = decoded.uid;
    if (!Array.isArray(c.members) || !c.members.includes(uid)) return res.status(403).json({ error: 'forbidden' });
    if (c.lastFrom !== uid || !c.lastMsg) return res.status(200).json({ status: 'ignored' });
    if (os.data().status !== 'aceite') return res.status(200).json({ status: 'closed' });
    if (c.pushedAt === c.lastAt) return res.status(200).json({ status: 'already' });
    await cref.update({ pushedAt: c.lastAt });
    const to = c.members.find((x) => x !== uid);
    const fromName = uid === c.buyerUid ? (c.buyerName || 'Comprador') : (c.sellerName || 'Vendedor');
    const r = await sendPush(db, to, { title: fromName + ' · ' + String(c.productName || 'GiraShop').slice(0, 40), body: String(c.lastMsg).slice(0, 120), url: SITE + '/?abrir=chat&id=' + id, tag: 'chat-' + id });
    return res.status(200).json({ status: 'ok', sent: r.sent });
  } catch (e) {
    const code = e && e.code && String(e.code).startsWith('auth/') ? 401 : 500;
    return res.status(code).json({ error: code === 401 ? 'auth' : 'server' });
  }
};
