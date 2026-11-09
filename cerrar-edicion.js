'use strict';
/*
 * El Cencerro de la Sede — tras enviar la edición:
 *  - actualiza estado.json (número, fechas, qué fue portada, frases usadas en los últimos números)
 *  - mueve crónicas, noticias y fotos usadas a archivo/<número>/ para que no se repitan la semana siguiente
 *    (si se regenera el mismo número, construir-edicion.js las vuelve a leer de ahí)
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const R = (...p) => path.join(RAIZ, ...p);
const leer = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
const SEMANAS_SIN_REPETIR_FRASES = 3;

const meta = leer(R('salida', 'meta.json'), null);
const res = leer(R('salida', 'resultado.json'), {});
if (!meta) { console.log('ℹ️ Sin meta.json: nada que cerrar'); process.exit(0); }

const estado = leer(R('estado.json'), {});
const recientes = (estado.frasesRecientes || []).filter(Array.isArray);
if (meta.esNueva) recientes.push(res.frases || []);
else if (recientes.length) recientes[recientes.length - 1] = res.frases || [];
else recientes.push(res.frases || []);

const nuevo = {
  numero: meta.numero,
  desde: meta.desde,
  hasta: meta.hasta,
  portada: res.portada || null,
  portadasAnteriores: meta.portadasAnteriores || [],
  frasesRecientes: recientes.slice(-SEMANAS_SIN_REPETIR_FRASES),
  actualizado: new Date().toISOString()
};
fs.writeFileSync(R('estado.json'), JSON.stringify(nuevo, null, 2) + '\n');

// Archivar lo usado en este número
const destino = R('archivo', String(meta.numero));
fs.mkdirSync(path.join(destino, 'fotos'), { recursive: true });
for (const f of ['cronicas.json', 'noticias.json']) {
  const lista = leer(R('datos', f), []);
  if (!Array.isArray(lista) || !lista.length) continue;
  const previo = leer(path.join(destino, f), []);
  fs.writeFileSync(path.join(destino, f), JSON.stringify([...previo, ...lista], null, 2) + '\n');
  fs.writeFileSync(R('datos', f), '[]\n');
}
let fotos = 0;
for (const f of (fs.existsSync(R('fotos')) ? fs.readdirSync(R('fotos')) : [])) {
  if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
  fs.renameSync(R('fotos', f), path.join(destino, 'fotos', f));
  fotos++;
}
console.log(`📁 Nº ${meta.numero} cerrado · portada: ${nuevo.portada} · fotos archivadas: ${fotos}`);
