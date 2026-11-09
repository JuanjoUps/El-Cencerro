'use strict';
/* El Cencerro de la Sede — manda las páginas (como archivos, sin pérdida de calidad) y el pie sugerido a Telegram */
const fs = require('fs');
const path = require('path');

const SALIDA = path.join(__dirname, '..', 'salida');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const TEMA = process.env.TELEGRAM_TEMA_ID;   // opcional: id del tema del grupo

async function api(metodo, cuerpo) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, { method: 'POST', body: cuerpo });
  const j = await r.json();
  if (!j.ok) throw new Error(`${metodo}: ${j.description}`);
  return j;
}

(async () => {
  if (!TOKEN || !CHAT) { console.log('ℹ️ Sin TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: no se envía nada'); return; }
  const meta = JSON.parse(fs.readFileSync(path.join(SALIDA, 'meta.json'), 'utf8'));
  const paginas = fs.readdirSync(SALIDA).filter(f => /^pagina-\d+\.png$/.test(f)).sort();
  const pie = fs.existsSync(path.join(SALIDA, 'pie-instagram.txt')) ? fs.readFileSync(path.join(SALIDA, 'pie-instagram.txt'), 'utf8') : '';

  // Telegram admite hasta 10 archivos por grupo
  for (let i = 0; i < paginas.length; i += 10) {
    const lote = paginas.slice(i, i + 10);
    const form = new FormData();
    form.append('chat_id', CHAT);
    if (TEMA) form.append('message_thread_id', TEMA);
    form.append('media', JSON.stringify(lote.map((f, k) => ({
      type: 'document', media: `attach://p${k}`,
      ...(k === lote.length - 1 ? { caption: `🔔 El Cencerro de la Sede · Nº ${meta.numero}${meta.esNueva ? '' : ' (regenerado)'}` } : {})
    }))));
    lote.forEach((f, k) => form.append(`p${k}`, new Blob([fs.readFileSync(path.join(SALIDA, f))], { type: 'image/png' }), f));
    await api('sendMediaGroup', form);
  }
  if (pie) {
    const form = new FormData();
    form.append('chat_id', CHAT);
    if (TEMA) form.append('message_thread_id', TEMA);
    form.append('text', `✍️ Pie sugerido para Instagram:\n\n${pie}`);
    await api('sendMessage', form);
  }
  console.log(`📨 Enviadas ${paginas.length} páginas a Telegram`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
