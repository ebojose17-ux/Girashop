// Utilitários partilhados (o prefixo "_" impede a Vercel de o expor como rota).
const admin = require('firebase-admin');

function init() {
  if (admin.apps.length) return;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

// Envia uma notificação push (Chrome/Android/Edge/Firefox) a todos os dispositivos do utilizador.
// Mensagem só de dados: o service worker (firebase-messaging-sw.js) mostra a notificação.
async function sendPush(db, uid, p) {
  if (!uid) return { sent: 0 };
  const ref = db.collection('pushTokens').doc(String(uid));
  const snap = await ref.get();
  const tokens = snap.exists && Array.isArray(snap.data().tokens) ? snap.data().tokens.filter((t) => typeof t === 'string').slice(0, 10) : [];
  if (!tokens.length) return { sent: 0 };
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title: String(p.title).slice(0, 80), body: String(p.body).slice(0, 160), url: String(p.url || '/'), tag: String(p.tag || 'girashop') },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } },
    android: { priority: 'high' }
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    const c = r.error && r.error.code;
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') dead.push(tokens[i]);
  });
  if (dead.length) await ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) }).catch(() => {});
  return { sent: res.successCount };
}

module.exports = { admin, init, sendPush };
