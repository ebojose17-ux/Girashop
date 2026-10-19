// Envia uma notificação de teste ao próprio utilizador (para confirmar que o telemóvel/Chrome está ligado).
const { admin, init, sendPush } = require('./_push');
const SITE = (process.env.SITE_URL || 'https://girashop.vercel.app').replace(/\/$/, '');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method' }); }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'not-configured' });
  try {
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'auth' });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    const r = await sendPush(admin.firestore(), decoded.uid, { title: 'GiraShop', body: 'Teste: as notificações estão a funcionar ✅', url: SITE + '/', tag: 'test' });
    return res.status(200).json({ sent: r.sent });
  } catch (e) {
    const code = e && e.code && String(e.code).startsWith('auth/') ? 401 : 500;
    return res.status(code).json({ error: code === 401 ? 'auth' : 'server' });
  }
};
