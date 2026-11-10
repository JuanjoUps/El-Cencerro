'use strict';
/*
 * El Cencerro de la Sede — construye los datos de la edición (salida/edicion.js)
 *
 * Lee SIN modificar:
 *   fuentes/actas      → repo Actas-Villa (resultados-partidos/*.json, escudo, mascota)
 *   fuentes/carteles   → (opcional) repo Pruebas-carteles-partidos (veteranos-calendario.json, escudos-cache/)
 *   fuentes/telediario → (opcional) repo del telediario (lesionados.json)
 * Las URLs de calendario de cada categoría están en datos/calendarios.json de este repo.
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
const recortar = (k, v) => (typeof v === 'string' && v.length > 160 ? v.slice(0, 60) + `…[${v.length} caracteres]` : Array.isArray(v) && v.length > 4 ? [...v.slice(0, 4), `…y ${v.length - 4} más`] : v);
const diag = (titulo, dato) => { if (DIAG) log(`\n🔎 [DIAGNÓSTICO] ${titulo}:\n` + (typeof dato === 'string' ? dato : JSON.stringify(dato, recortar, 2)).slice(0, 6000)); };
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
/* Escudos que trae la propia web de la RFFM (calendario y clasificación), por nombre de equipo: respaldo si no hay caché */
const ESCUDOS_WEB = new Map();
function urlEscudo(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^https?:\/\//.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return 'https://appweb.rffm.es' + u;
  return '';
}
function apuntarEscudo(nombre, u) { const url = urlEscudo(u); if (nombre && url && !ESCUDOS_WEB.has(slug(nombre))) ESCUDOS_WEB.set(slug(nombre), url); }
/* "CD TRES CANTOS" → "CD Tres Cantos" (siglas y abreviaturas se quedan en mayúsculas) */
function nombreEquipo(n) {
  n = String(n || '').trim().replace(/\s+/g, ' ');
  if (n !== n.toUpperCase()) return n;
  const SIGLAS = /^(CD|CF|AD|UD|EF|SD|CP|AT|RC|CDE|ACD|AD|SAD|FC|CDF|EMF|EFF)$/;
  return n.split(' ').map(w => /\./.test(w) || SIGLAS.test(w) || /^["'“”]?[A-D]["'“”]?$/.test(w) ? w
    : /^(DE|DEL|LA|LAS|LOS|Y)$/.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}
const equipo = (nombre, escudo) => ({ nombre: nombreEquipo(nombre) || '¿?', escudo: esNuestro(nombre) ? ESCUDO_CLUB : buscarEscudo(nombre, escudo) });
const nombrePie = n => esNuestro(n) ? 'Villa' : nombreEquipo(n).replace(/^(C\.?\s?D\.?\s?E?\.?|A\.?\s?D\.?|C\.?\s?F\.?|U\.?\s?D\.?|E\.?\s?F\.?|S\.?\s?D\.?)\s+/i, '');

/* ---------------- 1. Resultados (Actas-Villa) ---------------- */
/* Busca dentro del resultado el primer array cuya clave encaje (goles, alineacion…), esté donde esté */
function arrayPorClave(o, re, prof = 0) {
  if (!o || typeof o !== 'object' || prof > 4) return null;
  for (const [k, v] of Object.entries(o)) if (Array.isArray(v) && re.test(k)) return v;
  for (const v of Object.values(o)) { if (v && typeof v === 'object' && !Array.isArray(v)) { const a = arrayPorClave(v, re, prof + 1); if (a) return a; } }
  return null;
}
const limpiarEscudo = u => (typeof u === 'string' && !u.startsWith('data:') ? u : undefined);
const competicionBonita = t => String(t || '').toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/\bF-?(\d)\b/gi, 'F-$1');

function normalizarResultado(r, archivo) {
  const res = (r.resultado && typeof r.resultado === 'object') ? r.resultado : {};
  // Formato de Actas-Villa: resultado.{local, visitante, propioLocal, equipoPropio, rival, escudoPropioUrl, escudoRivalUrl…}
  let somosLocal = val(res, 'propioLocal', 'esLocal') ?? val(r, 'somosLocal', 'esLocal', 'localEsPropio', 'propioLocal');
  const nomPropio = nombreDe(val(res, 'equipoPropio') ?? val(r, 'equipoPropio'));
  const nomRival = nombreDe(val(res, 'rival', 'equipoRival') ?? val(r, 'rival', 'equipoRival'));
  let nomLocal = nombreDe(val(r, 'local.nombre', 'equipoLocal.nombre', 'equipo_local', 'equipoLocal', 'nombreLocal'));
  let nomVisit = nombreDe(val(r, 'visitante.nombre', 'equipoVisitante.nombre', 'equipo_visitante', 'equipoVisitante', 'nombreVisitante'));
  if (typeof r.local === 'string') nomLocal = nomLocal || r.local;
  if (typeof r.visitante === 'string') nomVisit = nomVisit || r.visitante;
  if (somosLocal === undefined) {
    const codP = String(val(res, 'codigoEquipoPropio') || '');
    const codL = String(val(r, 'codigoEquipoLocal', 'codigo_equipo_local', 'local.codigo') || '');
    somosLocal = codL ? (CODIGOS.has(codL) || codL === codP) : nomLocal ? esNuestro(nomLocal) : true;
  }
  somosLocal = !!somosLocal;
  if (nomPropio || nomRival) {
    nomLocal = somosLocal ? (nomPropio || 'C.D. Villa Buitrago del Lozoya') : nomRival;
    nomVisit = somosLocal ? nomRival : (nomPropio || 'C.D. Villa Buitrago del Lozoya');
  }
  const codPropio = String(val(res, 'codigoEquipoPropio') || '');
  if (codPropio) CODIGOS.add(codPropio);

  let gl = num(val(res, 'local', 'golesLocal')) ?? num(val(r, 'golesLocal', 'goles_local', 'marcador.local', 'local.goles'));
  let gv = num(val(res, 'visitante', 'golesVisitante')) ?? num(val(r, 'golesVisitante', 'goles_visitante', 'marcador.visitante', 'visitante.goles'));
  const textoRes = typeof r.resultado === 'string' ? r.resultado : typeof r.marcador === 'string' ? r.marcador : '';
  if ((gl === undefined || gv === undefined) && textoRes) { const m = textoRes.match(/(\d+)\s*[-–]\s*(\d+)/); if (m) { gl = +m[1]; gv = +m[2]; } }

  const nombrePropioLado = somosLocal ? nomLocal : nomVisit;
  const fecha = fechaISO(val(r, 'fecha', 'fechaPartido', 'fecha_partido', 'dia')) || fechaISO(archivo);
  const textoCat = [val(r, 'categoria', 'categoriaMostrar', 'categoria_nombre'), val(r, 'competicion', 'nombreCompeticion', 'nombre_competicion'), archivo].filter(Boolean).join(' ');
  const categoria = categoriaDe(textoCat, nombrePropioLado);

  // Goles
  const golesLista = val(r, 'goles', 'goleadores', 'listaGoles') || arrayPorClave(r, /gol/i) || [];
  const goles = Array.isArray(golesLista) ? golesLista.map(g => {
    if (typeof g === 'string') return { jugador: nombrePersona(g), propio: true };
    let propio = val(g, 'propio', 'esPropio', 'nuestro', 'deEquipoPropio');
    if (propio === undefined) {
      const lado = String(val(g, 'equipo', 'lado', 'tipo', 'team') || '');
      if (esNuestro(lado) || /propio|nuestro|villa/i.test(lado)) propio = true;
      else if (/rival|contrario/i.test(lado)) propio = false;
      else if (/local/i.test(lado)) propio = somosLocal; else if (/visit/i.test(lado)) propio = !somosLocal;
      else if (lado.trim().length > 3) propio = false;   // trae el nombre de otro equipo: es del rival
    }
    return {
      jugador: nombrePersona(nombreDe(val(g, 'jugador', 'nombre', 'goleador'))) || undefined,
      minuto: num(val(g, 'minuto', 'min')),
      propio: propio === undefined ? true : !!propio,
      propiaMeta: !!val(g, 'propiaMeta', 'enPropiaMeta', 'autogol', 'pp')
    };
  }) : [];

  // Alineación, cambios y expulsiones
  const alin = val(r, 'alineacion', 'titulares', 'alineacionPropia') || arrayPorClave(r, /alinea|titular/i) || [];
  const alineacion = Array.isArray(alin) ? alin.map(j => ({
    dorsal: val(j, 'dorsal', 'numero', 'num') ?? '',
    nombre: nombrePersona(nombreDe(val(j, 'nombre', 'jugador') || j)),
    portero: !!(val(j, 'portero', 'esPortero') || /^por/i.test(String(val(j, 'posicion', 'demarcacion') || ''))),
    capitan: !!val(j, 'capitan', 'esCapitan')
  })).filter(j => j.nombre) : [];
  const part = val(r, 'tambienParticiparon', 'participaron', 'suplentes', 'cambios') || arrayPorClave(r, /particip|suplente|cambio/i) || [];
  const participaron = Array.isArray(part) ? [...new Set(part.map(x => nombrePersona(nombreDe(val(x, 'entra', 'jugadorEntra', 'nombre', 'jugador') || x))).filter(Boolean))] : [];
  const exp = val(r, 'expulsiones', 'rojas', 'tarjetasRojas') || arrayPorClave(r, /expuls|roja/i) || [];
  const expulsiones = Array.isArray(exp) ? exp.map(e => ({ propio: val(e, 'propio', 'esPropio') ?? true })) : [];

  let campo = String(val(r, 'campo', 'estadio', 'instalacion', 'terreno') || '');
  if (val(res, 'juegaEnPenalta') && !/pe[ñn]alta/i.test(campo)) campo = (campo ? campo + ' · ' : '') + 'Peñalta';

  const escPropio = limpiarEscudo(val(res, 'escudoPropioUrl')), escRival = limpiarEscudo(val(res, 'escudoRivalUrl', 'escudoRival'));
  const competicion = val(r, 'competicionMostrar', 'competicion', 'nombreCompeticion') || val(r, 'categoria') || categoria || '';
  return {
    id: String(val(r, 'codacta', 'codActa', 'id') || archivo),
    categoria, fecha,
    competicion: competicionBonita(competicion),
    jornada: num(val(r, 'jornada', 'numJornada', 'num_jornada')),
    campo,
    local: equipo(nomLocal, somosLocal ? escPropio : (escRival || limpiarEscudo(val(r, 'local.escudo', 'escudoLocal', 'escudo_local')))),
    visitante: equipo(nomVisit, somosLocal ? (escRival || limpiarEscudo(val(r, 'visitante.escudo', 'escudoVisitante', 'escudo_visitante'))) : escPropio),
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
  const j = leer(R('datos', 'calendarios.json')) || leer(path.join(FUENTES.carteles, 'calendarios-categorias.json'));
  if (!j) { log('⚠️ No se encontró datos/calendarios.json'); return []; }
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
  const lista = buscar(nd, o => 'codigo_equipo_local' in o || 'codigoEquipoLocal' in o).map(({ obj: o, ctx }) => ({
    fecha: fechaISO(val(o, 'fecha', 'fecha_partido', 'fechaPartido')),
    jornada: num(val(o, 'jornada')) ?? ctx.jornada,
    codLocal: String(val(o, 'codigo_equipo_local', 'codigoEquipoLocal') || ''),
    codVisit: String(val(o, 'codigo_equipo_visitante', 'codigoEquipoVisitante') || ''),
    local: nombreDe(val(o, 'equipo_local', 'nombre_equipo_local', 'equipoLocal', 'local')),
    visitante: nombreDe(val(o, 'equipo_visitante', 'nombre_equipo_visitante', 'equipoVisitante', 'visitante')),
    escLocal: val(o, 'escudo_equipo_local', 'escudo_local', 'url_img_local'),
    escVisit: val(o, 'escudo_equipo_visitante', 'escudo_visitante', 'url_img_visitante')
  }));
  lista.forEach(m => { apuntarEscudo(m.local, m.escLocal); apuntarEscudo(m.visitante, m.escVisit); });
  return lista;
}

function filasClasificacion(nd) {
  const filas = buscar(nd, o => 'codequipo' in o).map(({ obj: o }) => o);
  const out = filas.map((o, i) => ({
    pos: num(val(o, 'posicion', 'pos', 'puesto', 'orden')) ?? i + 1,
    codigo: String(o.codequipo),
    equipo: nombreDe(val(o, 'nombre', 'equipo', 'nombre_equipo')),
    escudo: val(o, 'url_img', 'escudo', 'imagen', 'escudo_equipo'),
    pj: num(val(o, 'jugados', 'partidos_jugados', 'pj', 'partidosJugados')) ?? 0,
    gf: num(val(o, 'goles_a_favor', 'gf', 'goles_favor', 'golesFavor')) ?? 0,
    gc: num(val(o, 'goles_en_contra', 'gc', 'goles_contra', 'golesContra')) ?? 0,
    pts: num(val(o, 'puntos', 'pts')) ?? 0
  }));
  out.forEach(f => apuntarEscudo(f.equipo, f.escudo));
  return out;
}

/* ---------------- 3. Veteranos: próximo partido (Sofascore → veteranos-calendario.json) ---------------- */
/* Veteranos (liga privada, sin RFFM): calendario de Sofascore que la app copia a datos/veteranos-calendario.json.
   Devuelve el próximo partido y si había partido en el fin de semana de la edición (para "descansa" o "pendiente"). */
function calendarioVeteranos(iniFinde, finFinde) {
  const j = leer(R('datos', 'veteranos-calendario.json')) || leer(path.join(FUENTES.carteles, 'veteranos-calendario.json'));
  if (!j) { log('ℹ️ Sin veteranos-calendario.json: el Veterano sale sin próximo partido'); return {}; }
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
    const escudos = celdas.filter(c => /^https?:\/\/\S+$/.test(c));
    const jornada = num(Array.isArray(f) ? f[7] : val(f, 'jornada'));
    partidos.push({ fecha, rival, local, jornada, escudoRival: escudos.length >= 2 ? escudos[local ? 1 : 0] : '' });
  }
  const px = partidos.filter(p => p.fecha > finFinde).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  const enFinde = partidos.find(p => p.fecha >= iniFinde && p.fecha <= finFinde);
  return {
    proximo: px ? { rival: equipo(px.rival, px.escudoRival), local: px.local } : null,
    enFinde: enFinde || null,
    hayCalendario: true
  };
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
    const baseCat = categoriaDe(c.nombre);
    const jornadaCal = Math.max(0, ...cal.filter(m => m.fecha && m.fecha <= finFinde && m.jornada).map(m => m.jornada));
    const jornadaActas = Math.max(0, ...todos.filter(p => p.fecha <= finFinde && p.jornada && (p.categoria === baseCat || p.categoria.startsWith(baseCat + ' '))).map(p => p.jornada));
    const jornada = Math.max(jornadaCal, jornadaActas);
    log(`📊 ${c.categoria}: jornada ${jornada || '¿?'} (calendario ${jornadaCal || '-'}, actas ${jornadaActas || '-'})`);
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

  // Partidos sin escudo en la caché: se usa el de la web de la RFFM si apareció en calendario o clasificación
  for (const p of partidos) for (const lado of ['local', 'visitante']) {
    const e = p[lado];
    if (e && !e.escudo) e.escudo = ESCUDOS_WEB.get(slug(e.nombre)) || '';
  }
  for (const c of clasificaciones) for (const f of c.filas) if (!f.escudo) f.escudo = ESCUDOS_WEB.get(slug(f.equipo)) || '';
  for (const px of Object.values(proximos)) if (px.rival && !px.rival.escudo) px.rival.escudo = ESCUDOS_WEB.get(slug(px.rival.nombre)) || '';

  // Veterano: igual que el resto (resultado, próximo partido, y descanso o pendiente si no hay acta)
  const vet = calendarioVeteranos(iniFinde, finFinde);
  if (vet.proximo) proximos['Veterano'] = vet.proximo;
  if (vet.hayCalendario && !partidos.some(p => p.categoria === 'Veterano')) {
    extras.push({ categoria: 'Veterano', competicion: 'Liga Veteranos Madrid Norte', jornada: vet.enFinde?.jornada,
      descansa: true, aviso: vet.enFinde ? 'Resultado pendiente' : 'Descansa esta jornada' });
  }

  // Lesionados (app de Apps Script → lesionados.json del repo del telediario)
  const lesRaw = leer(R('datos', 'lesionados.json')) || leer(path.join(FUENTES.telediario, 'lesionados.json'), []);
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
    // Una sola foto por equipo: la que se llama exactamente como la categoría y, si no, la de número más bajo
    const foto = fotos.find(f => f.s === s) || fotos.filter(f => new RegExp(`^${s}-\\d+$`).test(f.s)).sort((a, b) => a.s.localeCompare(b.s, 'es', { numeric: true }))[0];
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
