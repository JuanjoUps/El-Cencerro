'use strict';
/*
 * El Cencerro de la Sede — construye los datos de la edición (salida/edicion.js)
 *
 * Lee SIN modificar:
 *   fuentes/actas      → repo Actas-Villa (resultados-partidos/*.json, escudo, mascota)
 *   fuentes/carteles   → repo Pruebas-carteles-partidos (calendarios-categorias.json, veteranos-calendario.json, escudos-cache/)
 *   fuentes/telediario → repo del telediario (lesionados.json)
 * Y de este repo:
 *   datos/cronicas.json, datos/noticias.json, fotos/, estado.json
 * Además consulta la web de la RFFM (calendario y clasificación) para próximo partido y tabla.
 *
 * Con DIAGNOSTICO=1 vuelca en el log cómo vienen los datos reales, para ajustar nombres de campos.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const R = (...p) => path.join(RAIZ, ...p);
const FUENTES = { actas: R('fuentes', 'actas'), carteles: R('fuentes', 'carteles'), telediario: R('fuentes', 'telediario') };
const TEMPORADA = process.env.TEMPORADA || '22';
const DIAG = process.env.DIAGNOSTICO === '1';
const DIAS_PRIMERA_EDICION = 7;

/* Códigos de equipo del club en la RFFM conocidos (se completan con los de calendarios-categorias.json) */
const CODIGOS_CONOCIDOS = ['846904', '2276659', '3082888', '3088877', '24710895', '17138002', '23996978'];

/* ---------------- utilidades ---------------- */
const log = (...a) => console.log(...a);
const diag = (titulo, dato) => { if (DIAG) log(`\n🔎 [DIAGNÓSTICO] ${titulo}:\n` + (typeof dato === 'string' ? dato : JSON.stringify(dato, null, 2)).slice(0, 2500)); };
const existe = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const leer = (p, def = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
const listar = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

/* Busca el primer valor no vacío entre varias rutas posibles ("local.nombre", "equipoLocal"…) */
function val(o, ...rutas) {
  for (const r of rutas) {
    const v = r.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
const nombreDe = x => (typeof x === 'string' ? x : (x && (x.nombre || x.name || x.equipo || x.jugador)) || '');
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = v => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? undefined : Number(v));

/* "MARTIN GARCIA, DANIEL" → "Daniel Martin Garcia" */
function nombrePersona(n) {
  n = String(n || '').trim();
  if (!n) return '';
  if (n.includes(',')) { const [ap, no] = n.split(',').map(s => s.trim()); n = `${no} ${ap}`; }
  if (n === n.toUpperCase()) {
    n = n.toLowerCase().replace(/(^|[\s-])([^\s-])/g, (m, a, b) => a + b.toUpperCase())
      .replace(/\b(De|Del|La|Las|Los|Y)\b/g, w => w.toLowerCase());
  }
  return n.replace(/\s+/g, ' ');
}

/* Fechas: "2026-11-08", "08/11/2026", "08-11-2026" → "2026-11-08" */
function fechaISO(x) {
  if (!x) return undefined;
  const s = String(x);
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return undefined;
}
const hoyISO = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const sumarDias = (iso, d) => { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

/* Categoría con los nombres del club (no los de la federación). Se retocan aquí, en un solo sitio. */
const REGLAS_CATEGORIA = [
  [/prebenj/i, 'Prebenjamín'], [/benjam/i, 'Benjamín'], [/alev/i, 'Alevín'], [/infantil/i, 'Infantil'],
  [/cadete/i, 'Cadete'], [/juvenil/i, 'Juvenil'], [/femen/i, 'Femenino'], [/veteran/i, 'Veterano'],
  [/aficionad|senior|preferente|regional|primera|segunda|tercera/i, 'Senior']
];
function letraEquipo(t) { const m = String(t || '').match(/["'“”\s]([AB])["'“”]?\s*$/); return m ? m[1] : ''; }
function categoriaDe(texto, nombreEquipoPropio = '') {
  const t = String(texto || '');
  const base = (REGLAS_CATEGORIA.find(([re]) => re.test(t)) || [null, null])[1];
  if (!base) return null;
  if (base === 'Benjamín') { const l = letraEquipo(nombreEquipoPropio) || letraEquipo(t); return l ? `Benjamín ${l}` : 'Benjamín'; }
  return base;
}
const esNuestro = nombre => /VILLA\s+(DE\s+)?BUITRAGO/i.test(String(nombre || ''));

/* Recorre un objeto buscando todos los sub-objetos que cumplan una condición */
function buscar(o, cond, out = [], ctx = {}) {
  if (Array.isArray(o)) o.forEach(x => buscar(x, cond, out, ctx));
  else if (o && typeof o === 'object') {
    const ctx2 = { ...ctx };
    const j = num(val(o, 'jornada', 'codjornada', 'numero_jornada', 'num_jornada'));
    if (j !== undefined) ctx2.jornada = j;
    if (cond(o)) out.push({ obj: o, ctx: ctx2 });
    Object.values(o).forEach(v => buscar(v, cond, out, ctx2));
  }
  return out;
}

/* ---------------- escudos ---------------- */
let CACHE_ESCUDOS = null;
function buscarEscudo(nombre, candidato) {
  // 1) ruta que ya trae el dato (relativa a algún repo) o URL
  if (candidato) {
    const c = String(candidato);
    if (/^https?:\/\//.test(c)) return c;
    const limpio = c.replace(/^\/+/, '');
    for (const base of [FUENTES.actas, FUENTES.carteles]) {
      if (existe(path.join(base, limpio))) return path.relative(RAIZ, path.join(base, limpio)).split(path.sep).join('/');
    }
  }
  // 2) caché de escudos del repo de carteles, por nombre
  if (!CACHE_ESCUDOS) {
    CACHE_ESCUDOS = [];
    for (const base of [FUENTES.carteles, FUENTES.actas]) {
      const dir = path.join(base, 'escudos-cache');
      listar(dir).filter(f => /\.(png|jpe?g|webp|svg)$/i.test(f))
        .forEach(f => CACHE_ESCUDOS.push({ s: slug(f.replace(/\.[^.]+$/, '')), ruta: path.relative(RAIZ, path.join(dir, f)).split(path.sep).join('/') }));
    }
  }
  const s = slug(nombre);
  if (!s) return '';
  const exacto = CACHE_ESCUDOS.find(e => e.s === s) || CACHE_ESCUDOS.find(e => e.s.includes(s) || s.includes(e.s));
  return exacto ? exacto.ruta : '';
}
const ESCUDO_CLUB = 'escudo-club.png';
/* "CD TRES CANTOS" → "CD Tres Cantos" (siglas y abreviaturas se quedan en mayúsculas) */
function nombreEquipo(n) {
  n = String(n || '').trim().replace(/\s+/g, ' ');
  if (n !== n.toUpperCase()) return n;
  return n.split(' ').map(w => /\./.test(w) || w.replace(/["'“”]/g, '').length <= 2 ? w
    : /^(DE|DEL|LA|LAS|LOS|Y)$/.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}
const equipo = (nombre, escudo) => ({ nombre: nombreEquipo(nombre) || '¿?', escudo: esNuestro(nombre) ? ESCUDO_CLUB : buscarEscudo(nombre, escudo) });
const nombrePie = n => esNuestro(n) ? 'Villa' : nombreEquipo(n).replace(/^(C\.?\s?D\.?\s?E?\.?|A\.?\s?D\.?|C\.?\s?F\.?|U\.?\s?D\.?|E\.?\s?F\.?|S\.?\s?D\.?)\s+/i, '');

/* ---------------- 1. Resultados (Actas-Villa) ---------------- */
function normalizarResultado(r, archivo) {
  const nomLocal = nombreDe(val(r, 'local.nombre', 'equipoLocal.nombre', 'equipo_local', 'equipoLocal', 'nombreLocal', 'local'));
  const nomVisit = nombreDe(val(r, 'visitante.nombre', 'equipoVisitante.nombre', 'equipo_visitante', 'equipoVisitante', 'nombreVisitante', 'visitante'));
  let gl = num(val(r, 'golesLocal', 'goles_local', 'marcador.local', 'resultado.local', 'local.goles'));
  let gv = num(val(r, 'golesVisitante', 'goles_visitante', 'marcador.visitante', 'resultado.visitante', 'visitante.goles'));
  const textoRes = val(r, 'resultado', 'marcador');
  if ((gl === undefined || gv === undefined) && typeof textoRes === 'string') {
    const m = textoRes.match(/(\d+)\s*[-–]\s*(\d+)/); if (m) { gl = +m[1]; gv = +m[2]; }
  }
  let somosLocal = val(r, 'somosLocal', 'esLocal', 'localEsPropio');
  if (somosLocal === undefined) {
    const codL = String(val(r, 'codigoEquipoLocal', 'codigo_equipo_local', 'local.codigo') || '');
    somosLocal = codL ? CODIGOS.has(codL) : esNuestro(nomLocal);
  }
  somosLocal = !!somosLocal;
  const nomPropio = somosLocal ? nomLocal : nomVisit;
  const fecha = fechaISO(val(r, 'fecha', 'fechaPartido', 'fecha_partido', 'dia')) || fechaISO(archivo);
  const textoCat = [val(r, 'categoria', 'categoriaMostrar', 'categoria_nombre'), val(r, 'competicion', 'nombreCompeticion', 'nombre_competicion'), val(r, 'grupo', 'nombreGrupo'), archivo].filter(Boolean).join(' ');
  const categoria = categoriaDe(textoCat, nomPropio);

  const golesLista = (val(r, 'goles', 'goleadores', 'listaGoles') || []);
  const goles = Array.isArray(golesLista) ? golesLista.map(g => {
    let propio = val(g, 'propio', 'esPropio', 'nuestro');
    if (propio === undefined) {
      const lado = String(val(g, 'equipo', 'lado', 'tipo') || '').toLowerCase();
      if (lado.includes('local')) propio = somosLocal; else if (lado.includes('visit')) propio = !somosLocal;
    }
    return {
      jugador: nombrePersona(nombreDe(val(g, 'jugador', 'nombre', 'goleador'))) || undefined,
      minuto: num(val(g, 'minuto', 'min')),
      propio: propio === undefined ? true : !!propio,
      propiaMeta: !!val(g, 'propiaMeta', 'enPropiaMeta', 'autogol', 'pp')
    };
  }) : [];

  const alin = val(r, 'alineacion', 'titulares', 'alineacionPropia') || [];
  const alineacion = Array.isArray(alin) ? alin.map(j => ({
    dorsal: val(j, 'dorsal', 'numero', 'num') ?? '',
    nombre: nombrePersona(nombreDe(val(j, 'nombre', 'jugador') || j)),
    portero: !!(val(j, 'portero', 'esPortero') || /^por/i.test(String(val(j, 'posicion', 'demarcacion') || ''))),
    capitan: !!val(j, 'capitan', 'esCapitan')
  })).filter(j => j.nombre) : [];
  const part = val(r, 'tambienParticiparon', 'participaron', 'suplentes', 'cambios') || [];
  const participaron = Array.isArray(part) ? [...new Set(part.map(x => nombrePersona(nombreDe(val(x, 'entra', 'jugadorEntra', 'nombre', 'jugador') || x))).filter(Boolean))] : [];
  const exp = val(r, 'expulsiones', 'rojas', 'tarjetasRojas') || [];
  const expulsiones = Array.isArray(exp) ? exp.map(e => ({ propio: val(e, 'propio', 'esPropio') ?? true })) : [];

  return {
    id: String(val(r, 'codacta', 'codActa', 'id') || archivo),
    categoria, fecha,
    competicion: String(val(r, 'competicionMostrar', 'competicion', 'nombreCompeticion', 'grupo') || categoria || ''),
    jornada: num(val(r, 'jornada', 'numJornada', 'num_jornada')),
    campo: String(val(r, 'campo', 'estadio', 'instalacion', 'terreno') || ''),
    local: equipo(nomLocal, val(r, 'local.escudo', 'escudoLocal', 'equipoLocal.escudo', 'escudo_local')),
    visitante: equipo(nomVisit, val(r, 'visitante.escudo', 'escudoVisitante', 'equipoVisitante.escudo', 'escudo_visitante')),
    somosLocal, golesLocal: gl ?? 0, golesVisitante: gv ?? 0,
    goles, alineacion, participaron, expulsiones
  };
}

function leerResultados() {
  const dir = path.join(FUENTES.actas, 'resultados-partidos');
  const archivos = listar(dir).filter(f => f.endsWith('.json'));
  log(`📂 Resultados encontrados en Actas-Villa: ${archivos.length}`);
  if (archivos.length) diag(`Primer resultado tal cual (${archivos[0]})`, leer(path.join(dir, archivos[0])));
  const lista = [];
  for (const f of archivos) {
    const r = leer(path.join(dir, f));
    if (!r) { log(`⚠️ No se pudo leer ${f}`); continue; }
    const p = normalizarResultado(r, f);
    if (!p.fecha) { log(`⚠️ ${f}: sin fecha reconocible, se ignora`); continue; }
    if (!p.categoria) { log(`⚠️ ${f}: categoría no reconocida, se ignora`); continue; }
    lista.push(p);
  }
  lista.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return lista;
}

const golesPropios = p => (p.somosLocal ? p.golesLocal : p.golesVisitante);
const golesRival = p => (p.somosLocal ? p.golesVisitante : p.golesLocal);
const resultado = p => (golesPropios(p) > golesRival(p) ? 'V' : golesPropios(p) < golesRival(p) ? 'D' : 'E');

/* ---------------- 2. Calendarios y clasificación (RFFM) ---------------- */
let CODIGOS = new Set(CODIGOS_CONOCIDOS);

function leerCategoriasCalendario() {
  const j = leer(path.join(FUENTES.carteles, 'calendarios-categorias.json'));
  if (!j) { log('⚠️ No se encontró calendarios-categorias.json en el repo de carteles'); return []; }
  diag('calendarios-categorias.json', j);
  const entradas = Array.isArray(j) ? j : Object.entries(j).map(([k, v]) => (typeof v === 'object' ? { ...v, _clave: k } : { _clave: k, url: v }));
  const out = [];
  for (const e of entradas) {
    const textos = [], codigos = [];
    (function rec(o, clave) {
      if (typeof o === 'string') { textos.push(o); if (/codigo/i.test(clave || '') && /^\d+$/.test(o)) codigos.push(o); }
      else if (typeof o === 'number' && /codigo/i.test(clave || '')) codigos.push(String(o));
      else if (Array.isArray(o)) o.forEach(x => rec(x, clave));
      else if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => rec(v, k));
    })(e);
    const urls = textos.filter(t => /rffm\.es\/competicion\/calendario/.test(t));
    const url = urls.find(u => new RegExp(`temporada=${TEMPORADA}\\b`).test(u)) || null;
    const nombre = val(e, 'categoriaMostrar', 'categoria', 'nombre', '_clave');
    const categoria = categoriaDe(nombre);
    codigos.forEach(c => CODIGOS.add(c));
    if (url && categoria) out.push({ categoria, nombre, url, codigos });
  }
  log(`📅 Categorías con calendario de la temporada ${TEMPORADA}: ${out.map(c => c.categoria).join(', ') || 'ninguna'}`);
  return out;
}

async function nextData(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (El Cencerro de la Sede)' } });
    const h = await r.text();
    const m = h.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    return m ? JSON.parse(m[1]) : null;
  } catch (e) { log(`⚠️ No se pudo leer ${url}: ${e.message}`); return null; }
}

function partidosCalendario(nd) {
  return buscar(nd, o => 'codigo_equipo_local' in o || 'codigoEquipoLocal' in o).map(({ obj: o, ctx }) => ({
    fecha: fechaISO(val(o, 'fecha', 'fecha_partido', 'fechaPartido')),
    jornada: num(val(o, 'jornada')) ?? ctx.jornada,
    codLocal: String(val(o, 'codigo_equipo_local', 'codigoEquipoLocal') || ''),
    codVisit: String(val(o, 'codigo_equipo_visitante', 'codigoEquipoVisitante') || ''),
    local: nombreDe(val(o, 'equipo_local', 'nombre_equipo_local', 'equipoLocal', 'local')),
    visitante: nombreDe(val(o, 'equipo_visitante', 'nombre_equipo_visitante', 'equipoVisitante', 'visitante')),
    escLocal: val(o, 'escudo_equipo_local', 'escudo_local', 'url_img_local'),
    escVisit: val(o, 'escudo_equipo_visitante', 'escudo_visitante', 'url_img_visitante')
  }));
}

function filasClasificacion(nd) {
  const filas = buscar(nd, o => 'codequipo' in o).map(({ obj: o }) => o);
  return filas.map((o, i) => ({
    pos: num(val(o, 'posicion', 'pos', 'puesto', 'orden')) ?? i + 1,
    codigo: String(o.codequipo),
    equipo: nombreDe(val(o, 'nombre', 'equipo', 'nombre_equipo')),
    escudo: val(o, 'url_img', 'escudo', 'imagen', 'escudo_equipo'),
    pj: num(val(o, 'jugados', 'partidos_jugados', 'pj', 'partidosJugados')) ?? 0,
    gf: num(val(o, 'goles_a_favor', 'gf', 'goles_favor', 'golesFavor')) ?? 0,
    gc: num(val(o, 'goles_en_contra', 'gc', 'goles_contra', 'golesContra')) ?? 0,
    pts: num(val(o, 'puntos', 'pts')) ?? 0
  }));
}

/* ---------------- 3. Veteranos: próximo partido (Sofascore → veteranos-calendario.json) ---------------- */
function proximoVeteranos(despues) {
  const j = leer(path.join(FUENTES.carteles, 'veteranos-calendario.json'));
  if (!j) return null;
  const filas = Array.isArray(j) ? j : (j.partidos || Object.values(j));
  diag('veteranos-calendario.json (2 primeras filas)', filas.slice(0, 2));
  const partidos = [];
  for (const f of filas) {
    const celdas = Array.isArray(f) ? f.map(String) : Object.values(f || {}).map(String);
    const fecha = celdas.map(fechaISO).find(Boolean);
    const pareceEquipo = c => c && /[a-záéíóúñ]{3,}/i.test(c) && !fechaISO(c) && !/^\d/.test(c) && !/^https?:/.test(c);
    const iN = celdas.findIndex(esNuestro);
    if (!fecha || iN < 0) continue;
    // El rival es la celda de al lado: detrás de nosotros = jugamos de local; delante = de visitante
    const local = pareceEquipo(celdas[iN + 1]);
    const rival = local ? celdas[iN + 1] : celdas[iN - 1];
    if (!pareceEquipo(rival)) continue;
    partidos.push({ fecha, rival, local });
  }
  const px = partidos.filter(p => p.fecha > despues).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  return px ? { rival: equipo(px.rival), local: px.local } : null;
}

/* ---------------- 4. Datos de este repo ---------------- */
function leerListas(nombre, extraDir) {
  const a = leer(R('datos', nombre), []);
  const b = extraDir ? leer(path.join(extraDir, nombre), []) : [];
  return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
}
function fotosDisponibles(extraDir) {
  const out = [];
  for (const dir of [R('fotos'), extraDir && path.join(extraDir, 'fotos')].filter(Boolean)) {
    listar(dir).filter(f => /\.(jpe?g|png|webp)$/i.test(f))
      .forEach(f => out.push({ s: slug(f.replace(/\.[^.]+$/, '')), ruta: path.relative(RAIZ, path.join(dir, f)).split(path.sep).join('/') }));
  }
  return out;
}

/* ---------------- principal ---------------- */
async function main() {
  const estado = leer(R('estado.json'), {}) || {};
  const categoriasCal = leerCategoriasCalendario();
  const todos = leerResultados().filter(p => p.fecha <= hoyISO());

  // ¿Qué partidos entran? Los jugados desde el número anterior. Si no hay nuevos, se rehace el último número.
  let partidos, numero, esNueva, portadasAnteriores;
  const nuevos = estado.hasta ? todos.filter(p => p.fecha > estado.hasta) : todos.filter(p => p.fecha >= sumarDias(hoyISO(), -DIAS_PRIMERA_EDICION));
  if (nuevos.length) {
    partidos = nuevos; numero = (estado.numero || 0) + 1; esNueva = true;
    portadasAnteriores = estado.portada && estado.portada !== 'manual' ? [estado.portada] : [];
  } else if (estado.desde) {
    partidos = todos.filter(p => p.fecha >= estado.desde && p.fecha <= estado.hasta); numero = estado.numero; esNueva = false;
    portadasAnteriores = estado.portadasAnteriores || [];
    log(`ℹ️ No hay partidos nuevos: se regenera el Nº ${numero}`);
  } else partidos = [];

  const salida = R('salida');
  fs.mkdirSync(salida, { recursive: true });
  const avisarGithub = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  if (!partidos.length) { log('🛑 No hay partidos para una edición. Nada que hacer.'); avisarGithub('hay_edicion', 'false'); return; }

  const desde = partidos[0].fecha, hasta = partidos[partidos.length - 1].fecha;
  log(`🗞️  Nº ${numero} (${esNueva ? 'nuevo' : 'regenerado'}): ${partidos.length} partidos del ${desde} al ${hasta}`);

  // Racha sin perder de cada partido (con todo el histórico de su categoría)
  for (const p of partidos) {
    const hist = todos.filter(x => x.categoria === p.categoria && x.fecha <= p.fecha);
    let racha = 0;
    for (let i = hist.length - 1; i >= 0 && resultado(hist[i]) !== 'D'; i--) racha++;
    p.racha = racha;
  }

  // Calendario (próximo partido, descansos) y clasificación de cada categoría
  const clasificaciones = [], proximos = {}, extras = [];
  const finFinde = (() => { const d = new Date(hasta + 'T12:00:00Z'); const dow = d.getUTCDay(); return sumarDias(hasta, dow === 0 ? 0 : 7 - dow); })();
  const iniFinde = sumarDias(finFinde, -2);
  let diagCal = false, diagCla = false;
  for (const c of categoriasCal) {
    const nd = await nextData(c.url);
    if (!nd) continue;
    const cal = partidosCalendario(nd);
    if (!diagCal && cal.length) { diag(`Partido de calendario (${c.categoria})`, cal[0]); diagCal = true; }
    const nuestros = cal.filter(m => CODIGOS.has(m.codLocal) || CODIGOS.has(m.codVisit) || esNuestro(m.local) || esNuestro(m.visitante));
    const catDe = m => categoriaDe(c.nombre, CODIGOS.has(m.codLocal) || esNuestro(m.local) ? m.local : m.visitante);

    // Próximo partido (después de esta edición)
    for (const m of nuestros.filter(m => m.fecha && m.fecha > finFinde).sort((a, b) => a.fecha.localeCompare(b.fecha))) {
      const cat = catDe(m);
      if (proximos[cat]) continue;
      const local = CODIGOS.has(m.codLocal) || esNuestro(m.local);
      proximos[cat] = { rival: equipo(local ? m.visitante : m.local, local ? m.escVisit : m.escLocal), local };
    }
    // Descanso o resultado pendiente en el fin de semana de la edición
    const categoriasGrupo = [...new Set(nuestros.map(catDe))];
    for (const cat of categoriasGrupo) {
      if (partidos.some(p => p.categoria === cat)) continue;
      const jugaba = nuestros.find(m => catDe(m) === cat && m.fecha >= iniFinde && m.fecha <= finFinde);
      extras.push({ categoria: cat, competicion: c.nombre, jornada: jugaba?.jornada, descansa: true, aviso: jugaba ? 'Resultado pendiente del acta' : 'Descansa esta jornada' });
    }

    // Clasificación de la última jornada jugada (y la anterior, para ver si sube o es nuevo líder)
    const jornada = Math.max(0, ...cal.filter(m => m.fecha && m.fecha <= finFinde && m.jornada).map(m => m.jornada));
    if (!jornada) continue;
    const urlCla = c.url.replace('/calendario', '/clasificaciones').replace(/&jornada=\d+/, '');
    const filas = filasClasificacion(await nextData(`${urlCla}&jornada=${jornada}`));
    if (!filas.length) continue;
    if (!diagCla) { diag(`Fila de clasificación (${c.categoria})`, filas[0]); diagCla = true; }
    const previas = jornada > 1 ? filasClasificacion(await nextData(`${urlCla}&jornada=${jornada - 1}`)) : [];
    const tabla = filas.map(f => {
      const propio = CODIGOS.has(f.codigo) || esNuestro(f.equipo) ? categoriaDe(c.nombre, f.equipo) : false;
      return { pos: f.pos, codigo: f.codigo, equipo: f.equipo, escudo: propio ? ESCUDO_CLUB : buscarEscudo(f.equipo, f.escudo), pj: f.pj, gf: f.gf, gc: f.gc, pts: f.pts, propio };
    }).sort((a, b) => a.pos - b.pos);
    clasificaciones.push({ categoria: categoriaDe(c.nombre), competicion: partidos.find(p => p.categoria.startsWith(categoriaDe(c.nombre)))?.competicion || c.nombre, jornada, filas: tabla });
    for (const f of tabla.filter(f => f.propio)) {
      const antes = previas.find(x => x.codigo === f.codigo);
      const p = partidos.find(x => x.categoria === f.propio);
      if (p && antes) p.cambioPosicion = { lider: f.pos === 1 && antes.pos !== 1, sube: f.pos < antes.pos, pos: f.pos };
    }
  }
  if (!categoriasCal.length) log('ℹ️ Sin calendarios: no habrá próximo partido, descansos ni clasificación');

  const pv = proximoVeteranos(finFinde);
  if (pv) proximos['Veterano'] = pv;

  // Lesionados (app de Apps Script → lesionados.json del repo del telediario)
  const lesRaw = leer(path.join(FUENTES.telediario, 'lesionados.json'), []);
  diag('lesionados.json', lesRaw);
  const lesionados = buscar(lesRaw, o => typeof o.nombre === 'string').map(({ obj }) => ({
    nombre: nombrePersona(obj.nombre), categoria: categoriaDe(obj.categoria) || obj.categoria
  })).filter(l => l.nombre && l.categoria);
  log(`🩹 Lesionados: ${lesionados.length}`);

  // Crónicas, noticias y fotos de este repo (en una regeneración, también las ya archivadas de este número)
  const dirArchivo = !esNueva ? R('archivo', String(numero)) : null;
  const cronicas = leerListas('cronicas.json', dirArchivo);
  const noticias = leerListas('noticias.json', dirArchivo).filter(n => n && n.titular);
  const fotos = fotosDisponibles(dirArchivo);
  for (const p of partidos) {
    const cr = cronicas.find(c => (categoriaDe(c.categoria) || c.categoria) === p.categoria && c.texto);
    if (cr) p.cronica = { autor: cr.autor || `Entrenador del ${p.categoria}`, titular: cr.titular || null, texto: cr.texto };
    const s = slug(p.categoria);
    const foto = fotos.find(f => f.s === s || new RegExp(`^${s}-\\d+$`).test(f.s));
    if (foto) p.foto = foto.ruta;
  }
  // La foto de una noticia se busca por nombre de archivo (sirve aunque ya esté archivada)
  for (const n of noticias) if (n.foto && !/^https?:/.test(n.foto)) {
    const f = fotos.find(x => x.s === slug(path.basename(n.foto).replace(/\.[^.]+$/, '')));
    n.foto = f ? f.ruta : null;
  }
  log(`✍️  Crónicas: ${partidos.filter(p => p.cronica).length} · Noticias a mano: ${noticias.length} · Fotos: ${partidos.filter(p => p.foto).length}`);

  const edicion = {
    numero, portadasAnteriores, frasesRecientes: (esNueva ? (estado.frasesRecientes || []) : (estado.frasesRecientes || []).slice(0, -1)).flat(),
    lesionados, noticias, partidos: [...partidos, ...extras], clasificaciones, proximos
  };
  fs.writeFileSync(path.join(salida, 'edicion.js'), `// Generado por construir-edicion.js — no editar a mano\nwindow.EDICION_REAL = ${JSON.stringify(edicion, null, 1)};\n`);
  fs.writeFileSync(path.join(salida, 'meta.json'), JSON.stringify({ numero, esNueva, desde, hasta, portadasAnteriores }, null, 2));

  // Texto sugerido para el pie de la publicación de Instagram
  const sello = p => { const r = resultado(p); return r === 'V' ? 'victoria' : r === 'E' ? 'empate' : 'derrota'; };
  const linea = p => /benjam/i.test(p.categoria)
    ? `${p.categoria}: ${sello(p)} ante ${nombrePie(p.somosLocal ? p.visitante.nombre : p.local.nombre)}`
    : `${p.categoria}: ${nombrePie(p.local.nombre)} ${p.golesLocal}-${p.golesVisitante} ${nombrePie(p.visitante.nombre)}`;
  const pie = [`🔔 El Cencerro de la Sede · Nº ${numero}`, '', 'Toda la jornada del club en un vistazo 👉 desliza', '',
    ...partidos.map(linea).filter(Boolean), '', '#ElCencerroDeLaSede #LaHuellaDelVilla #VillaDeBuitrago'].join('\n');
  fs.writeFileSync(path.join(salida, 'pie-instagram.txt'), pie);

  log(`✅ Edición lista: ${partidos.length} partidos, ${extras.length} descansos/pendientes, ${clasificaciones.length} clasificaciones, ${Object.keys(proximos).length} próximos`);
  avisarGithub('hay_edicion', 'true');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
