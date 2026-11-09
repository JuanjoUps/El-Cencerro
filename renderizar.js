'use strict';
/* El Cencerro de la Sede — abre periodico.html con los datos reales y guarda cada página como PNG 1080x1350 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const RAIZ = path.join(__dirname, '..');
const SALIDA = path.join(RAIZ, 'salida');

(async () => {
  const navegador = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const pagina = await navegador.newPage({ viewport: { width: 1112, height: 1400 }, deviceScaleFactor: 1 });
  const errores = [];
  pagina.on('pageerror', e => errores.push(e.message));
  pagina.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('consola:', m.text()); });

  await pagina.goto('file://' + path.join(RAIZ, 'periodico.html'));
  if (!(await pagina.evaluate(() => !!window.EDICION_REAL))) throw new Error('No se cargó salida/edicion.js');

  // Fuentes de Google cargadas y montaje final con ellas
  await pagina.evaluate(() => document.fonts.ready);
  await pagina.waitForTimeout(1500);
  await pagina.evaluate(() => montar());
  // Esperar a que carguen fotos y escudos (las que fallan se sustituyen solas)
  await pagina.evaluate(() => Promise.race([
    Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))),
    new Promise(r => setTimeout(r, 15000))
  ]));
  await pagina.waitForTimeout(800);

  fs.mkdirSync(SALIDA, { recursive: true });
  listarPNG().forEach(f => fs.unlinkSync(path.join(SALIDA, f)));
  const marcos = await pagina.$$('.marco');
  for (let i = 0; i < marcos.length; i++) {
    await marcos[i].screenshot({ path: path.join(SALIDA, `pagina-${String(i + 1).padStart(2, '0')}.png`) });
  }
  const resultado = await pagina.evaluate(() => window.__resultado);
  fs.writeFileSync(path.join(SALIDA, 'resultado.json'), JSON.stringify(resultado, null, 2));
  await navegador.close();

  if (errores.length) { console.error('❌ Errores en la página:\n' + errores.join('\n')); process.exit(1); }
  console.log(`🖨️  ${marcos.length} páginas guardadas en salida/ · portada: ${resultado?.portada}`);
})().catch(e => { console.error('❌', e); process.exit(1); });

function listarPNG() { try { return fs.readdirSync(SALIDA).filter(f => /^pagina-\d+\.png$/.test(f)); } catch { return []; } }
