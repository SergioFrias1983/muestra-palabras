'use strict';

/* =====================================================================
   Muestra Palabras (versión celular / PWA)
   Datos guardados en IndexedDB del navegador. Sin servidor.
   ===================================================================== */

/* ---------------- Versión ----------------
   En cada cambio: actualizar num (y el mismo valor en CACHE de sw.js) y fecha.
   La etiqueta del menú muestra solo número y fecha (sin descripción del cambio).
   Numeración: el primer cambio de un día sube el entero (21, 22…);
   los siguientes del mismo día agregan subversión (20.1, 20.2…). */
const VERSION = { num: '26.1', fecha: '11/11/26' };

/* ---------------- Utilidades ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const pad = (n, l = 2) => String(n).padStart(l, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
const limpiarNombre = s => s.replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
const contarPalabras = t => (t.trim() ? t.trim().split(/\s+/).length : 0);

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}

function formatoTiempo(ms) {
  const t = Math.floor(ms / 10);
  return `${pad(Math.floor(t / 6000))}:${pad(Math.floor(t / 100) % 60)}.${pad(t % 100)}`;
}
const segs = ms => (ms / 1000).toFixed(2) + ' s';

function ahora() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fechaCorta(f) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (f || '');
}

/** Parte un texto en piezas de espacio / palabra, respetando saltos de línea. */
function tokenizar(texto) {
  const out = [];
  const re = /(\s+)|(\S+)/g;
  let m;
  while ((m = re.exec(texto))) out.push({ esp: !!m[1], t: m[0] });
  return out;
}

let toastT;
function aviso(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2800);
}

/* ---------------- Almacenamiento (IndexedDB) ---------------- */
const DB = {
  db: null,
  abrir() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('muestra-palabras', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async leer() {
    const db = await this.abrir();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get('estado');
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  },
  async guardar(e) {
    const db = await this.abrir();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(e, 'estado');
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
};

/* Estado de la aplicación:
   arbol:     { Área: { Año: { Materia: { Actividad: {} } } } }
   preguntas: [{ id, ruta:[a,b,c,d], num, pregunta, respuesta, archivo? }]
   tiempos:   { idPregunta: [{ f:'YYYY-MM-DD HH:MM:SS', ms, p }] }
   ultima:    última ubicación elegida */
let E = { v: 1, arbol: {}, preguntas: [], tiempos: {}, tiemposTipeo: {}, ultima: [], silencio: false, nube: null, repaso: {} };
const NUBE_BASE = () => ({ url: '', clave: '', disp: '', vistos: [], borrados: [], enviados: {}, ultimaSync: 0, ultima: '' });
let almacenamientoOk = true;

async function guardarEstado() {
  try {
    await DB.guardar(E);
    almacenamientoOk = true;
  } catch (err) {
    almacenamientoOk = false;
    aviso('No se pudo guardar en el teléfono: ' + (err && err.message ? err.message : err));
  }
}

/* ---------------- Árbol de ubicaciones ---------------- */
const NIVELES = ['Área', 'Año / Nivel', 'Materia', 'Actividad'];

function hijos(path) {
  let n = E.arbol;
  for (const p of path) n = n && n[p];
  return n ? Object.keys(n).sort(collator.compare) : [];
}
function agregarRuta(path) {
  let n = E.arbol;
  for (const p of path) { n[p] = n[p] || {}; n = n[p]; }
}
function mergeArbol(dst, src) {
  for (const k of Object.keys(src || {})) {
    dst[k] = dst[k] || {};
    mergeArbol(dst[k], src[k]);
  }
}
const mismaRuta = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const pregs = ruta => E.preguntas.filter(q => mismaRuta(q.ruta, ruta)).sort((a, b) => a.num - b.num);

/* ---------------- Modales ---------------- */
function modal({ titulo = '', mensaje = '', input = null, botones, apilados = false }) {
  return new Promise(resolve => {
    const m = $('#modal'), inp = $('#modal-input'), bs = $('#modal-botones');
    $('#modal-titulo').textContent = titulo;
    $('#modal-msg').textContent = mensaje;
    $('#modal-msg').hidden = !mensaje;
    inp.hidden = input === null;
    inp.value = input || '';
    bs.innerHTML = '';
    bs.className = 'botones' + (apilados ? ' apilados' : '');

    const cerrar = v => {
      m.hidden = true;
      document.removeEventListener('keydown', tecla, true);
      resolve(v);
    };
    const tecla = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // que la tecla no llegue también a la pantalla de atrás
        const c = botones.find(b => b.cancel);
        cerrar(c ? c.valor : null);
      } else if (e.key === 'Enter' && input !== null) {
        e.preventDefault();
        e.stopPropagation();
        cerrar({ ok: true, texto: inp.value });
      }
    };
    const abierto = performance.now();
    botones.forEach(b => {
      const btn = el('button', 'btn ' + (b.clase || ''), b.texto);
      btn.type = 'button';
      btn.onclick = () => { if (performance.now() - abierto < 350) return; cerrar(input !== null && b.valor === 'ok' ? { ok: true, texto: inp.value } : b.valor); };
      bs.appendChild(btn);
    });
    m.hidden = false;
    document.addEventListener('keydown', tecla, true);
    if (input !== null) setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
async function pedirTexto(titulo, def = '') {
  const r = await modal({
    titulo, input: def,
    botones: [{ texto: 'Cancelar', valor: null, cancel: true }, { texto: 'Aceptar', valor: 'ok', clase: 'primary' }]
  });
  return r && r.ok ? r.texto : null;
}
const confirmar = (titulo, mensaje, si = 'Aceptar', clase = 'primary', no = 'Cancelar', claseNo = '') =>
  modal({
    titulo, mensaje,
    botones: [{ texto: no, valor: false, cancel: true, clase: claseNo }, { texto: si, valor: true, clase }]
  });

/** Confirma con el reloj en pausa: si el usuario decide seguir, la espera no cuenta en su tiempo. */
async function confirmarEnPausa(S2, bucleFn, titulo, mensaje, si, clase, no, claseNo) {
  const corriendo = S2.estado === 'corriendo';
  let t = 0;
  if (corriendo) { cancelAnimationFrame(S2.raf); t = performance.now(); }
  const ok = await confirmar(titulo, mensaje + (corriendo ? '\nEl reloj está en pausa.' : ''), si, clase, no, claseNo);
  if (corriendo && S2.estado === 'corriendo' && !ok) {
    S2.t0 += performance.now() - t;          // descuenta el tiempo de espera
    S2.raf = requestAnimationFrame(bucleFn);
  }
  return ok;
}

/* ---------------- Renombrar / eliminar carpetas completas ---------------- */
const NIV_ART = ['el área', 'el año / nivel', 'la materia', 'la actividad'];
const prefijoDe = (ruta, pre) => pre.every((x, i) => ruta[i] === x);
function nodoEn(path) { let n = E.arbol; for (const p of path) n = n && n[p]; return n; }

/** Borra del árbol las carpetas que quedaron vacías (y sin preguntas) siguiendo esta ruta hacia arriba. */
function podarVacias(ruta) {
  for (let i = ruta.length; i >= 1; i--) {
    const pre = ruta.slice(0, i), n = nodoEn(pre);
    if (!n || Object.keys(n).length || E.preguntas.some(q => prefijoDe(q.ruta, pre))) break;
    delete nodoEn(pre.slice(0, -1))[pre[i - 1]];
  }
}

async function renombrarCarpeta(pre, nuevo) {
  const i = pre.length - 1, padre = nodoEn(pre.slice(0, -1));
  if (Object.keys(padre).some(k => k !== pre[i] && k.toLowerCase() === nuevo.toLowerCase())) {
    aviso(`Ya existe "${nuevo}" en ese lugar. Elegí otro nombre.`);
    return false;
  }
  padre[nuevo] = padre[pre[i]];
  delete padre[pre[i]];
  const t = Date.now();
  E.preguntas.forEach(q => {
    if (prefijoDe(q.ruta, pre)) { q.ruta = q.ruta.slice(); q.ruta[i] = nuevo; q.mod = t; }
  });
  if (E.ultima && prefijoDe(E.ultima, pre)) { E.ultima = E.ultima.slice(); E.ultima[i] = nuevo; }
  await guardarEstado();
  aviso('Renombrado');
  return true;
}

async function eliminarCarpeta(pre) {
  const i = pre.length - 1, nombre = pre[i];
  const qs = E.preguntas.filter(q => prefijoDe(q.ruta, pre));
  const nT = qs.reduce((s, q) => s + (E.tiempos[q.id] || []).length + (E.tiemposTipeo[q.id] || []).length, 0);
  const detalle = qs.length
    ? `Tiene ${qs.length} pregunta${qs.length === 1 ? '' : 's'}${nT ? ` y ${nT} tiempo${nT === 1 ? '' : 's'} registrado${nT === 1 ? '' : 's'}` : ''}, y se elimina con todo lo que contiene. No se puede deshacer.`
    : 'No tiene preguntas.';
  if (!(await confirmar('Eliminar carpeta', `Vas a eliminar ${NIV_ART[i]} "${nombre}".\n${detalle}`, 'Eliminar', 'danger'))) return false;
  let borrarHist = false;
  if (nT) {
    borrarHist = await modal({
      titulo: 'Historial de tiempos',
      mensaje: `¿Borrar también los ${nT} tiempo${nT === 1 ? '' : 's'} de esas preguntas?`,
      botones: [
        { texto: 'Conservar', valor: false, cancel: true },
        { texto: 'Borrar historial', valor: true, clase: 'danger' }
      ]
    });
  }
  const ids = new Set(qs.map(q => q.id));
  E.preguntas = E.preguntas.filter(q => !ids.has(q.id));
  if (E.nube && E.nube.url) ids.forEach(id => E.nube.borrados.push(id));
  if (borrarHist) ids.forEach(id => { delete E.tiempos[id]; delete E.tiemposTipeo[id]; });
  delete nodoEn(pre.slice(0, -1))[nombre];
  if (E.ultima && prefijoDe(E.ultima, pre)) E.ultima = pre.slice(0, -1);
  await guardarEstado();
  aviso('Carpeta eliminada');
  return true;
}

/* ---------------- Selector de 4 listas encadenadas ---------------- */
function crearSelector(cont, alCambiar, gestion = false) {
  cont.innerHTML = '';
  const selects = [], btns = [], gests = [];

  const api = {
    get: () => selects.map(s => s.value || ''),
    ruta() { const r = api.get(); return r.every(Boolean) ? r : null; },
    refrescar(pref) {
      const path = [];
      for (let i = 0; i < 4; i++) {
        const sel = selects[i];
        const ok = path.every(Boolean);
        const op = ok ? hijos(path) : [];
        sel.innerHTML = '';
        if (!op.length) sel.add(new Option('(sin elementos)', ''));
        else op.forEach(x => sel.add(new Option(x, x)));
        const quiero = pref && pref[i];
        sel.value = op.includes(quiero) ? quiero : (op[0] || '');
        path.push(sel.value);
        btns[i].disabled = !ok;
        if (gests[i]) gests[i].disabled = !sel.value;
      }
    }
  };

  NIVELES.forEach((nom, i) => {
    const campo = el('div', 'campo');
    campo.append(el('label', '', nom));
    const fila = el('div', 'fila');
    const sel = el('select');
    sel.setAttribute('aria-label', nom);
    const b = el('button', 'btn mas', '+');
    b.type = 'button';
    b.title = 'Nueva carpeta en ' + nom;
    fila.append(sel, b);
    if (gestion) {
      const g = el('button', 'btn mas gest', '⋯');
      g.type = 'button';
      g.title = 'Renombrar o eliminar ' + NIV_ART[i];
      g.setAttribute('aria-label', g.title);
      fila.append(g);
      gests.push(g);
      g.addEventListener('click', async () => {
        const pre = api.get().slice(0, i + 1);
        if (!pre.every(Boolean)) return;
        const accion = await modal({
          titulo: pre[i],
          mensaje: `¿Qué querés hacer con ${NIV_ART[i]}?`,
          botones: [
            { texto: 'Cancelar', valor: null, cancel: true },
            { texto: 'Renombrar', valor: 'ren', clase: 'primary' },
            { texto: 'Eliminar', valor: 'del', clase: 'danger' }
          ]
        });
        if (accion === 'ren') {
          const nuevo = await pedirTexto(`Nuevo nombre para ${NIV_ART[i]}`, pre[i]);
          if (nuevo === null) return;
          const limpio = limpiarNombre(nuevo);
          if (!limpio) { aviso('Ese nombre no es válido.'); return; }
          if (limpio === pre[i]) return;
          if (!(await renombrarCarpeta(pre, limpio))) return;
          api.refrescar([...pre.slice(0, i), limpio, ...api.get().slice(i + 1)]);
        } else if (accion === 'del') {
          if (!(await eliminarCarpeta(pre))) return;
          api.refrescar(pre.slice(0, i));
        } else return;
        if (alCambiar) alCambiar(api.get());
      });
    }
    campo.append(fila);
    cont.append(campo);
    selects.push(sel);
    btns.push(b);

    sel.addEventListener('change', () => {
      api.refrescar(api.get().slice(0, i + 1));
      if (alCambiar) alCambiar(api.get());
    });
    b.addEventListener('click', async () => {
      const nombre = await pedirTexto(`Nueva carpeta en "${nom}"`);
      if (nombre === null) return;
      const limpio = limpiarNombre(nombre);
      if (!limpio) { aviso('Ese nombre no es válido.'); return; }
      const base = api.get().slice(0, i);
      agregarRuta([...base, limpio]);
      await guardarEstado();
      api.refrescar([...base, limpio]);
      if (alCambiar) alCambiar(api.get());
    });
  });
  return api;
}

/* ---------------- Navegación ---------------- */
const PANTALLAS = ['menu', 'act', 'crear', 'sel', 'eval', 'tipeo', 'datos', 'repaso', 'progreso'];
let actual = 'menu';

function mostrar(n) {
  PANTALLAS.forEach(p => ($('#s-' + p).hidden = p !== n));
  actual = n;
  fondoRepaso();
  window.scrollTo(0, 0);
}
/** Fondo violeta mientras se está en «Para repasar» o repitiendo dudosas; el azul de siempre en el resto. */
function fondoRepaso() {
  const rondaRepaso = (actual === 'eval' && enRepaso(V)) || (actual === 'tipeo' && enRepaso(T));
  const on = actual === 'repaso' || !!rondaRepaso;
  if (document.documentElement) document.documentElement.classList.toggle('repaso', on);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m && m.setAttribute) m.setAttribute('content', on ? '#2a1a36' : '#1b2130');
}
function entrar(n) {
  const desdeMenu = actual === 'menu';
  mostrar(n);
  if (desdeMenu) history.pushState({ n }, '');
  else history.replaceState({ n }, '');
}
async function puedeSalir() {
  if (actual === 'crear') return resolverCambios();
  if (actual === 'eval' && V.estado === 'corriendo') {
    const ok = await confirmarEnPausa(V, bucle, 'Intento en curso', '¿Salir sin guardar este intento?', 'Salir', 'danger');
    if (!ok) return false;
    cancelarIntento();
  }
  if (actual === 'tipeo' && T.estado === 'corriendo') {
    const ok = await confirmarEnPausa(T, bucleT, 'Intento en curso', '¿Salir sin guardar este intento?', 'Salir', 'danger');
    if (!ok) return false;
    cancelarTipeo();
  }
  return true;
}
async function volverMenu() {
  if (!(await puedeSalir())) return;
  mostrar('menu');
  refrescarMenu();
  history.back();
}
window.addEventListener('popstate', async () => {
  if (actual === 'menu') return;
  if (await puedeSalir()) {
    mostrar('menu');
    refrescarMenu();
  } else {
    history.pushState({ n: actual }, '');
  }
});

function refrescarMenu() {
  refrescarNube();
  const nRep = itemsRepaso().length;
  $('#m-repaso').textContent = nRep ? `Para repasar (${nRep})` : 'Para repasar';
  const nAct = new Set(E.preguntas.map(q => q.ruta.join('/'))).size;
  $('#m-resumen').textContent = E.preguntas.length
    ? `${E.preguntas.length} pregunta${E.preguntas.length === 1 ? '' : 's'} en ${nAct} actividad${nAct === 1 ? '' : 'es'}`
    : 'Todavía no cargaste preguntas.';
}

/* =====================================================================
   CREAR PREGUNTAS
   ===================================================================== */
const C = { sel: null, ruta: null, editId: null, base: { p: '', r: '' } };

function abrirCrear() {
  if (!C.sel) C.sel = crearSelector($('#c-ubicacion'), onUbicacionCrear, true);
  C.sel.refrescar(E.ultima);
  C.ruta = C.sel.ruta();
  formNuevo();
  renderLista();
  entrar('crear');
}

async function onUbicacionCrear() {
  if (!(await resolverCambios())) { C.sel.refrescar(C.ruta || []); return; }
  C.ruta = C.sel.ruta();
  E.ultima = C.sel.get();
  guardarEstado();
  formNuevo();
  renderLista();
}

const dirty = () => $('#c-pregunta').value !== C.base.p || $('#c-respuesta').value !== C.base.r;

async function resolverCambios() {
  if (!dirty()) return true;
  const r = await modal({
    titulo: 'Cambios sin guardar',
    mensaje: '¿Querés guardar los cambios de esta pregunta?',
    botones: [
      { texto: 'Cancelar', valor: null, cancel: true },
      { texto: 'Descartar', valor: 'no', clase: 'danger' },
      { texto: 'Guardar', valor: 'si', clase: 'primary' }
    ]
  });
  if (r === 'si') return guardarPregunta();
  return r === 'no';
}

function actualizarContador() {
  $('#c-palabras').textContent = `· ${contarPalabras($('#c-respuesta').value)} palabras`;
}

function formNuevo() {
  C.editId = null;
  $('#c-pregunta').value = '';
  $('#c-respuesta').value = '';
  C.base = { p: '', r: '' };
  $('#c-edit-titulo').textContent = 'Pregunta (nueva)';
  $('#c-guardar').textContent = 'Guardar';
  $('#c-eliminar').disabled = true;
  actualizarContador();
  renderLista();
}

function cargarEnForm(q) {
  C.editId = q.id;
  $('#c-pregunta').value = q.pregunta;
  $('#c-respuesta').value = q.respuesta;
  C.base = { p: q.pregunta, r: q.respuesta };
  $('#c-edit-titulo').textContent = `Pregunta (editando la N° ${pad(q.num, 3)})`;
  $('#c-guardar').textContent = 'Guardar cambios';
  $('#c-eliminar').disabled = false;
  actualizarContador();
  renderLista();
}

function resumen(q) {
  const t = q.pregunta.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 70) + '…' : t;
}

function renderLista() {
  const lista = C.ruta ? pregs(C.ruta) : [];
  $('#c-lista-titulo').textContent = `Preguntas (${lista.length})`;
  const cont = $('#c-lista');
  cont.innerHTML = '';
  lista.forEach(q => {
    const b = el('button', 'item' + (q.id === C.editId ? ' activo' : ''));
    b.type = 'button';
    b.append(el('span', 'num', pad(q.num, 3)), document.createTextNode(resumen(q)));
    b.onclick = async () => {
      if (q.id === C.editId) return;
      if (!(await resolverCambios())) return;
      cargarEnForm(q);
    };
    cont.appendChild(b);
  });
}

async function guardarPregunta() {
  const p = $('#c-pregunta').value.trim();
  const r = $('#c-respuesta').value.trim();
  if (!C.ruta) { aviso('Primero elegí o creá (botón +) Área, Año, Materia y Actividad.'); return false; }
  if (!p || !r) { aviso('La pregunta y la respuesta no pueden estar vacías.'); return false; }

  if (C.editId) {
    const q = E.preguntas.find(x => x.id === C.editId);
    q.pregunta = p;
    q.respuesta = r;
    q.mod = Date.now();
    await guardarEstado();
    aviso('Cambios guardados');
    cargarEnForm(q);
  } else {
    const num = pregs(C.ruta).reduce((m, q) => Math.max(m, q.num), 0) + 1;
    E.preguntas.push({ id: uid(), ruta: [...C.ruta], num, pregunta: p, respuesta: r, mod: Date.now() });
    await guardarEstado();
    aviso(`Pregunta ${pad(num, 3)} guardada`);
    formNuevo();
  }
  return true;
}

async function eliminarPregunta() {
  const q = E.preguntas.find(x => x.id === C.editId);
  if (!q) return;
  if (!(await confirmar('Eliminar pregunta', `¿Eliminar la pregunta ${pad(q.num, 3)}?`, 'Eliminar', 'danger'))) return;
  const t = [...(E.tiempos[q.id] || []), ...(E.tiemposTipeo[q.id] || [])];
  let borrarHist = false;
  if (t.length) {
    borrarHist = await modal({
      titulo: 'Historial de tiempos',
      mensaje: `Esta pregunta tiene ${t.length} tiempo${t.length === 1 ? '' : 's'} registrado${t.length === 1 ? '' : 's'}. ¿Borrarlos también?`,
      botones: [
        { texto: 'Conservar', valor: false, cancel: true },
        { texto: 'Borrar historial', valor: true, clase: 'danger' }
      ]
    });
  }
  E.preguntas = E.preguntas.filter(x => x.id !== q.id);
  if (E.nube && E.nube.url) E.nube.borrados.push(q.id);
  if (borrarHist) { delete E.tiempos[q.id]; delete E.tiemposTipeo[q.id]; }
  await guardarEstado();
  aviso('Pregunta eliminada');
  formNuevo();
}

/* =====================================================================
   ELEGIR QUÉ EVALUAR
   ===================================================================== */
const S = { sel: null };

let MODO = 'palabras';
function abrirActividades() { entrar('act'); }
function abrirSeleccion(modo) {
  MODO = modo || MODO;
  $('#sel-modo').textContent = MODO === 'tipeo' ? 'Actividad: escribir letra por letra' : 'Actividad: revelar palabras';
  if (!S.sel) S.sel = crearSelector($('#sel-ubicacion'), onUbicacionSel);
  S.sel.refrescar(E.ultima);
  actualizarCuenta();
  entrar('sel');
}
function onUbicacionSel() {
  E.ultima = S.sel.get();
  guardarEstado();
  actualizarCuenta();
}
function actualizarCuenta() {
  const ruta = S.sel.ruta();
  const n = ruta ? pregs(ruta).length : 0;
  $('#sel-cuenta').textContent = !ruta
    ? 'Elegí Área, Año, Materia y Actividad.'
    : n ? `Esta actividad tiene ${n} pregunta${n === 1 ? '' : 's'}.` : 'Esta actividad todavía no tiene preguntas.';
  $('#sel-continuar').disabled = n === 0;
}

/* =====================================================================
   EVALUACIÓN (modo juego)
   ===================================================================== */
const V = {
  ruta: null, q: null, tokens: [], idxPal: [], n: 0, k: 0,
  estado: 'sinPregunta', // sinPregunta | listo | corriendo | fin | viendo
  t0: 0, raf: 0, bloqueo: 0, ultimoReg: null, wake: null,
  rec: null,            // mejor tiempo (ms) de la pregunta elegida
  pasado: false,        // true si el reloj ya superó el récord durante un intento
  vistaHist: 'ultimos'  // 'ultimos' | 'mejores'
};

function iniciarEval(ruta, alcance, vuelta) {
  V.ruta = ruta;
  V.ronda = nuevaRonda(alcance, vuelta);
  entrar('eval');
  pintarRutaRonda('#e-ruta', ruta, alcance);
  V.q = null;
  V.estado = 'sinPregunta';
  renderListaEval();
  $('#e-pregunta').textContent = 'Elegí una pregunta de la lista';
  setReloj(0);
  setBox('');
  $('#e-resultado').hidden = true;
  $('#e-preguntas').open = true;
  renderScores(CFG.palabras);
  progreso();
  botones();
  if (alcance) { const l = listaRonda(V); if (l.length) { cargarPreguntaEval(l[0]); $('#e-preguntas').open = false; } }
}

function renderListaEval() {
  const lista = listaRonda(V);
  $('#e-preguntas-titulo').textContent = `Preguntas (${lista.length}) — tocá una para elegirla` + textoRonda(V);
  const cont = $('#e-lista');
  cont.innerHTML = '';
  lista.forEach(q => {
    const b = el('button', 'item' + (V.q && V.q.id === q.id ? ' activo' : ''));
    b.type = 'button';
    b.append(el('span', 'num', pad(q.num, 3)), document.createTextNode(resumen(q)));
    b.onclick = async () => {
      if (V.estado === 'corriendo') {
        if (!(await confirmarEnPausa(V, bucle, 'Intento en curso', 'Si cambiás de pregunta, este intento se cancela sin guardarse.', 'Cambiar', 'danger'))) return;
        cancelarIntento();
      }
      cargarPreguntaEval(q);
      $('#e-preguntas').open = false;
    };
    cont.appendChild(b);
  });
}

function cargarPreguntaEval(q) {
  detener();
  if (!V.ronda) V.ronda = nuevaRonda();
  V.q = q;
  V.tokens = tokenizar(q.respuesta);
  V.idxPal = [];
  V.tokens.forEach((t, i) => { if (!t.esp) V.idxPal.push(i); });
  V.n = V.idxPal.length;
  V.k = 0;
  V.estado = 'listo';
  V.bloqueoUI = performance.now() + 700;   // evita que el toque de «Continuar» caiga sobre EMPEZAR / Ver respuesta
  V.calificada = false;
  V.marcaDud = false;
  V.ultimoReg = null;
  $('#e-pregunta').textContent = q.pregunta;
  setReloj(0);
  setBox('Tocá EMPEZAR. Con el reloj corriendo, cada toque revela una palabra.');
  $('#e-resultado').hidden = true;
  renderListaEval();
  renderScores(CFG.palabras);
  progreso();
  botones();
}

function setReloj(ms, clase) {
  const r = $('#e-reloj');
  r.textContent = formatoTiempo(ms);
  r.className = 'reloj' + (clase ? ' ' + clase : '');
}
function setBox(txt) {
  const b = $('#e-respuesta');
  b.textContent = '';
  if (txt) b.append(el('span', 'hint', txt));
  b.scrollTop = 0;
}
function progreso() {
  $('#e-prog-txt').textContent = `Palabra ${V.k} / ${V.n}`;
  $('#e-barra').style.width = (V.n ? (V.k / V.n) * 100 : 0) + '%';
}
function botones() {
  const main = $('#e-main');
  const etiquetas = {
    sinPregunta: 'ELEGÍ UNA PREGUNTA', listo: 'EMPEZAR', viendo: 'EMPEZAR',
    corriendo: 'SIGUIENTE PALABRA', fin: 'REINTENTAR'
  };
  main.textContent = etiquetas[V.estado];
  const pideCalif = V.estado === 'fin' && !V.calificada;
  const rep = enRepaso(V);
  $('#e-calif').hidden = !pideCalif || rep;
  $('#e-rep').hidden = !pideCalif || !rep;
  actualizarDud('palabras');
  main.hidden = pideCalif && rep;   // en el repaso, «Repetir» ocupa el lugar de «Reintentar»
  main.className = V.estado === 'fin' ? 'btn block' : 'btn primary huge';
  $('#e-ver').disabled = V.estado === 'sinPregunta';
  $('#e-cancelar').disabled = V.estado !== 'corriendo';
  $('#e-cancelar').className = 'btn small' + (V.estado === 'corriendo' ? '' : ' oculto');
}

function bucle() {
  if (V.estado !== 'corriendo') return;
  const t = performance.now() - V.t0;
  const r = $('#e-reloj');
  r.textContent = formatoTiempo(t);
  // El reloj cambia de color apenas superás tu récord: ya no se puede batir en este intento.
  const pas = V.rec !== null && t > V.rec;
  if (pas !== V.pasado) { V.pasado = pas; r.className = 'reloj' + (pas ? ' pasado' : ''); }
  V.raf = requestAnimationFrame(bucle);
}
function detener() {
  cancelAnimationFrame(V.raf);
  if (V.wake) { try { V.wake.release(); } catch (e) { /* nada */ } V.wake = null; }
}

function empezar() {
  V.k = 0;
  V.ultimoReg = null;
  setBox('');
  $('#e-resultado').hidden = true;
  V.estado = 'corriendo';
  V.t0 = performance.now();
  V.pasado = false;
  setReloj(0);
  progreso();
  botones();
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then(l => { V.wake = l; }).catch(() => {});
  }
  V.raf = requestAnimationFrame(bucle);
}

function revelar() {
  if (V.estado !== 'corriendo') return;
  V.k++;
  const idx = V.idxPal[V.k - 1];
  const previo = V.tokens.slice(0, idx).map(t => t.t).join('');
  const box = $('#e-respuesta');
  box.textContent = '';
  box.append(document.createTextNode(previo));
  box.append(el('span', 'ultima', V.tokens[idx].t));
  box.scrollTop = box.scrollHeight;
  progreso();
  if (V.k >= V.n) terminar();
}

function evaluar(prev, ms) {
  if (!prev.length) {
    return { clase: 'primero', titulo: '¡PRIMER TIEMPO!', detalle: 'Es tu primer registro para esta pregunta.' };
  }
  const mejor = Math.min(...prev.map(x => x.ms));
  const prom = prev.reduce((s, x) => s + x.ms, 0) / prev.length;
  const todos = [...prev.map(x => x.ms), ms].sort((a, b) => a - b);
  const puesto = todos.indexOf(ms) + 1;
  if (ms < mejor) {
    return { clase: 'record', titulo: '★ ¡NUEVO RÉCORD! ★',
      detalle: `Superaste tu mejor tiempo por ${segs(mejor - ms)}. Récord anterior: ${formatoTiempo(mejor)}.` };
  }
  if (ms < prom) {
    return { clase: 'bueno', titulo: '¡BUEN TIEMPO!',
      detalle: `Mejor que tu nivel habitual. A ${segs(ms - mejor)} del récord. Puesto ${puesto} de ${todos.length}.` };
  }
  return { clase: 'malo', titulo: 'TIEMPO MALO',
    detalle: `Por debajo de tu nivel habitual. A ${segs(ms - mejor)} del récord. Puesto ${puesto} de ${todos.length}.` };
}

async function terminar() {
  const ms = Math.round(performance.now() - V.t0);
  detener();
  V.estado = 'fin';
  V.calificada = false;
  V.bloqueo = performance.now() + 900; // evita reiniciar por un toque de más
  const prev = E.tiempos[V.q.id] ? [...E.tiempos[V.q.id]] : [];
  const res = evaluar(prev, ms);
  const reg = { f: ahora(), ms, p: V.n };
  (E.tiempos[V.q.id] = E.tiempos[V.q.id] || []).push(reg);
  V.ultimoReg = reg;
  setReloj(ms, res.clase);
  const r = $('#e-resultado');
  r.className = 'resultado ' + res.clase;
  r.textContent = '';
  r.append(el('b', '', res.titulo), document.createTextNode(res.detalle));
  r.hidden = false;
  renderScores(CFG.palabras, res.clase === 'record');
  botones();
  verResultado('#e-resultado', '#s-eval .marcador');
  await guardarEstado();
}

function cancelarIntento() {
  if (V.estado !== 'corriendo') return;
  detener();
  V.estado = 'listo';
  V.k = 0;
  setReloj(0);
  setBox('Intento cancelado. Tocá EMPEZAR para volver a intentar.');
  progreso();
  botones();
}

async function pedirCancelar() {
  if (V.estado !== 'corriendo') return;
  const ok = await confirmarEnPausa(V, bucle, '¿Cancelar el intento?', 'Si cancelás, este intento no se guarda.',
    'Cancelar intento', 'danger', 'Seguir intentando', 'primary');
  if (ok) cancelarIntento();
}

async function verRespuesta() {
  if (performance.now() < (V.bloqueoUI || 0)) return;
  if (!V.q) return;
  if (V.estado === 'corriendo') {
    if (!(await confirmarEnPausa(V, bucle, 'Ver respuesta', 'Si la mostrás, este intento se cancela sin guardarse.', 'Mostrar', 'primary', 'Seguir intentando'))) return;
  }
  detener();
  V.estado = 'viendo';
  V.k = 0;
  setReloj(0);
  $('#e-resultado').hidden = true;
  const box = $('#e-respuesta');
  box.textContent = V.q.respuesta;
  box.scrollTop = 0;
  progreso();
  botones();
}

function accionPrincipal() {
  switch (V.estado) {
    case 'sinPregunta':
      $('#e-preguntas').open = true;
      aviso('Elegí una pregunta de la lista.');
      break;
    case 'listo':
    case 'viendo':
      if (performance.now() < (V.bloqueoUI || 0)) return;
      empezar();
      break;
    case 'fin':
      if (performance.now() < V.bloqueo || (enRepaso(V) && !V.calificada)) return;
      empezar();
      break;
    case 'corriendo':
      revelar();
      break;
  }
}

function fechaHora(f) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(f || '');
  if (!m) return f || '';
  return `${m[3]}/${m[2]}/${m[1].slice(2)}` + (m[4] ? ` ${m[4]}:${m[5]}` : '');
}

/* Configuración de cada actividad: prefijo de los elementos, estado y dónde se guardan los tiempos. */
const CFG = {
  palabras: { p: 'e', S: () => V, tiempos: () => E.tiempos },
  tipeo:    { p: 't', S: () => T, tiempos: () => E.tiemposTipeo }
};

/** Récord de la pregunta elegida: siempre visible arriba, junto al reloj. */
function renderRecord(cfg, nuevo) {
  const S2 = cfg.S();
  const todos = S2.q ? (cfg.tiempos()[S2.q.id] || []) : [];
  const t = todos.filter(x => !x.h);   // con pistas no cuenta para el récord
  const caja = $('#' + cfg.p + '-rec');
  caja.className = 'rec';
  if (!t.length) {
    S2.rec = null;
    $('#' + cfg.p + '-rec-tiempo').textContent = '—';
    $('#' + cfg.p + '-rec-fecha').textContent = S2.q ? (todos.length ? 'Sin récord (solo con ayuda)' : 'Todavía sin récord') : '';
    return;
  }
  const mejor = t.reduce((m, x) => (x.ms < m.ms ? x : m), t[0]);
  S2.rec = mejor.ms;
  $('#' + cfg.p + '-rec-tiempo').textContent = formatoTiempo(mejor.ms);
  $('#' + cfg.p + '-rec-fecha').textContent = fechaHora(mejor.f);
  if (nuevo) { void caja.offsetWidth; caja.className = 'rec nuevo'; }
}

/** Tabla de historial (abajo): últimos intentos o los mejores. */
function renderHistorial(cfg) {
  const S2 = cfg.S();
  const cont = $('#' + cfg.p + '-hist');
  cont.innerHTML = '';
  $('#' + cfg.p + '-h-ultimos').className = S2.vistaHist === 'ultimos' ? 'activo' : '';
  $('#' + cfg.p + '-h-mejores').className = S2.vistaHist === 'mejores' ? 'activo' : '';
  const t = S2.q ? (cfg.tiempos()[S2.q.id] || []) : [];
  if (!t.length) {
    cont.append(el('p', 'muted centro', S2.q ? 'Todavía no hay tiempos para esta pregunta.' : '—'));
    return;
  }
  const validos = t.filter(x => !x.h);
  const rec = validos.length ? Math.min(...validos.map(x => x.ms)) : -1;
  const filas = S2.vistaHist === 'mejores'
    ? [...validos].sort((a, b) => a.ms - b.ms).slice(0, 10).map((x, i) => ({ x, n: i + 1 }))
    : t.map((x, i) => ({ x, n: i + 1 })).reverse().slice(0, 15);

  const tabla = el('table', 'tabla');
  const cab = el('tr');
  [[S2.vistaHist === 'mejores' ? 'Puesto' : 'N°', ''], ['Tiempo', ''], ['Fecha', ''], ['vs récord', 'd']]
    .forEach(([txt, cls]) => cab.append(el('th', cls, txt)));
  const thead = el('thead'); thead.append(cab); tabla.append(thead);

  const tbody = el('tbody');
  filas.forEach(({ x, n }) => {
    const esRec = !x.h && x.ms === rec;
    const tr = el('tr', (esRec ? 'es-rec ' : '') + (x === S2.ultimoReg ? 'nuevo' : ''));
    tr.append(
      el('td', '', String(n)),
      el('td', 't', formatoTiempo(x.ms)),
      el('td', 'f', fechaHora(x.f)),
      el('td', 'd', x.h ? `💡 ${x.h}` : esRec ? '★ récord' : '+' + ((x.ms - rec) / 1000).toFixed(2) + ' s')
    );
    tbody.append(tr);
  });
  tabla.append(tbody);
  cont.append(tabla);
}

function renderScores(cfg, nuevoRecord) {
  renderRecord(cfg, nuevoRecord);
  renderHistorial(cfg);
}

/* =====================================================================
   ACTIVIDAD 2: ESCRIBIR LETRA POR LETRA
   Letras y números hay que escribirlos; espacios y signos aparecen solos.
   Si la tecla es incorrecta suena un aviso y no se avanza hasta acertar.
   ===================================================================== */
const TECLAS_FILAS = ['1234567890', 'qwertyuiop', 'asdfghjklñ', 'zxcvbnm'];
const TECLAS_OK = TECLAS_FILAS.join('');

const T = {
  ruta: null, q: null, chars: [], pos: 0, total: 0, hechos: 0, errores: 0, pistas: 0, pistaPos: new Set(),
  estado: 'sinPregunta', // sinPregunta | listo | corriendo | fin | viendo
  t0: 0, raf: 0, bloqueo: 0, ultimoReg: null, wake: null,
  rec: null, pasado: false, vistaHist: 'ultimos', teclas: {}, tecladoListo: false
};

/** Letra "normalizada": sin mayúsculas ni tildes (la ñ se conserva como letra propia). */
function normTecla(c) {
  c = String(c).toLowerCase();
  if (c === 'ñ') return 'ñ';
  return c.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
/** ¿Hay que escribir este carácter? Letras y números sí; signos y espacios aparecen solos. */
function esTipeable(c) {
  const k = normTecla(c);
  return k.length === 1 && TECLAS_OK.includes(k);
}

/* ----- Sonido ----- */
let audioCtx = null;
function audio() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* nada */ }
  return audioCtx;
}
function sonidoError() {
  if (E.silencio) return;
  const ctx = audio();
  if (ctx) {
    try {
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(200, t);
      o.frequency.exponentialRampToValueAtTime(110, t + 0.18);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.22);
    } catch (e) { /* nada */ }
  }
  try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* nada */ }
}
function actualizarSonido() {
  const b = $('#t-sonido');
  b.textContent = E.silencio ? '🔇' : '🔊';
  b.title = E.silencio ? 'Activar sonido' : 'Silenciar';
  b.setAttribute('aria-label', b.title);
  b.setAttribute('aria-pressed', String(!!E.silencio));
}

/* ----- Teclado en pantalla ----- */
function construirTeclado() {
  if (T.tecladoListo) return;
  const cont = $('#t-teclado');
  cont.innerHTML = '';
  TECLAS_FILAS.forEach((fila, i) => {
    const f = el('div', 'tecla-fila' + (i === 0 ? ' nums' : ''));
    for (const ch of fila) {
      const b = el('button', 'tecla', ch.toUpperCase());
      b.type = 'button';
      b.addEventListener('pointerdown', e => { e.preventDefault(); tocarTecla(ch); });
      T.teclas[ch] = b;
      f.append(b);
    }
    cont.append(f);
  });
  T.tecladoListo = true;
}

/** Ubicación en la barra de arriba: en pantallas chicas solo se ve la última carpeta (la actividad). */
function pintarRuta(sel, ruta) {
  const c = $(sel);
  c.textContent = '';
  ruta.forEach((x, i) => {
    if (i) c.append(el('span', 'sep', ' › '));
    c.append(el('span', 'tr tr' + i, x));
  });
}

/* ----- Pantalla ----- */
function iniciarTipeo(ruta, alcance, vuelta) {
  T.ruta = ruta;
  T.ronda = nuevaRonda(alcance, vuelta);
  entrar('tipeo');
  pintarRutaRonda('#t-ruta', ruta, alcance);
  construirTeclado();
  actualizarSonido();
  detenerT();
  T.q = null;
  T.estado = 'sinPregunta';
  T.rec = null;
  renderListaTipeo();
  $('#t-pregunta').textContent = 'Elegí una pregunta de la lista';
  setRelojT(0);
  setBoxT('');
  $('#t-resultado').hidden = true;
  $('#t-preguntas').open = true;
  renderScores(CFG.tipeo);
  progresoT();
  botonesT();
  if (alcance) { const l = listaRonda(T); if (l.length) { cargarPreguntaTipeo(l[0]); $('#t-preguntas').open = false; } }
}

function renderListaTipeo() {
  const lista = listaRonda(T);
  $('#t-preguntas-titulo').textContent = `Preguntas (${lista.length}) — tocá una para elegirla` + textoRonda(T);
  const cont = $('#t-lista');
  cont.innerHTML = '';
  lista.forEach(q => {
    const b = el('button', 'item' + (T.q && T.q.id === q.id ? ' activo' : ''));
    b.type = 'button';
    b.append(el('span', 'num', pad(q.num, 3)), document.createTextNode(resumen(q)));
    b.onclick = async () => {
      if (T.estado === 'corriendo') {
        if (!(await confirmarEnPausa(T, bucleT, 'Intento en curso', 'Si cambiás de pregunta, este intento se cancela sin guardarse.', 'Cambiar', 'danger'))) return;
      }
      cargarPreguntaTipeo(q);
      $('#t-preguntas').open = false;
    };
    cont.appendChild(b);
  });
}

function cargarPreguntaTipeo(q) {
  detenerT();
  if (!T.ronda) T.ronda = nuevaRonda();
  T.q = q;
  T.chars = Array.from(q.respuesta.normalize('NFC'));
  T.total = T.chars.filter(esTipeable).length;
  T.pos = 0;
  T.hechos = 0;
  T.errores = 0;
  T.pistas = 0; T.pistaPos = new Set();
  T.estado = 'listo';
  // El toque que eligió «Continuar» no debe caer sobre «Pista» / «Ver respuesta», que aparecen en el mismo lugar
  T.bloqueoUI = performance.now() + 700;
  T.calificada = false;
  T.marcaDud = false;
  T.ultimoReg = null;
  T.pasado = false;
  $('#t-pregunta').textContent = q.pregunta;
  setRelojT(0);
  setBoxT(T.total
    ? 'Escribí la primera letra para empezar: el reloj arranca con tu primera tecla.'
    : 'Esta respuesta no tiene letras ni números para escribir. Probá con la otra actividad.');
  $('#t-resultado').hidden = true;
  renderListaTipeo();
  renderScores(CFG.tipeo);
  progresoT();
  botonesT();
}

function setRelojT(ms, clase) {
  const r = $('#t-reloj');
  r.textContent = formatoTiempo(ms);
  r.className = 'reloj' + (clase ? ' ' + clase : '');
}
function setBoxT(txt) {
  const b = $('#t-respuesta');
  b.textContent = '';
  if (txt) b.append(el('span', 'hint', txt));
  b.scrollTop = 0;
}
function progresoT() {
  $('#t-prog-txt').textContent = `Letra ${T.hechos} / ${T.total}`;
  $('#t-barra').style.width = (T.total ? (T.hechos / T.total) * 100 : 0) + '%';
}
function botonesT() {
  const fin = T.estado === 'fin';
  $('#t-teclado').hidden = fin;
  const repT = enRepaso(T);
  $('#t-main').hidden = !fin || (repT && !T.calificada);
  $('#t-main').className = 'btn block';
  $('#t-calif').hidden = !(fin && !T.calificada) || repT;
  $('#t-rep').hidden = !(fin && !T.calificada) || !repT;
  $('#t-r-apr').hidden = !!T.pistas;   // con pistas no se puede dar por aprendida
  actualizarDud('tipeo');
  $('#t-teclado').className = 'teclado' + (T.estado === 'sinPregunta' ? ' apagado' : '');
  $('#t-ver').disabled = T.estado === 'sinPregunta';
  $('#t-pista').disabled = T.estado === 'sinPregunta' || fin;
  $('#t-cancelar').disabled = T.estado !== 'corriendo';
  $('#t-cancelar').className = 'btn small' + (T.estado === 'corriendo' ? '' : ' oculto');
  // Mientras corre el reloj se esconde el historial; al terminar se esconden las ayudas y aparece "Siguiente"
  $('#s-tipeo').classList.toggle('en-curso', T.estado === 'corriendo');
  $('#s-tipeo').classList.toggle('terminado', fin);
  $('#t-row-ayuda').hidden = fin;
  $('#t-ayuda').textContent = fin
    ? (repT ? (T.pistas ? 'D = dudosa · R = repetir' : 'A = aprendida · D = dudosa · R = repetir')
            : 'C o → = continuar · R = reintentar · D = agregar a «Para repasar»')
    : 'Escribí con tu teclado · Enter = pista · Esc cancela el intento';
}

/** La pregunta que sigue en la misma actividad (si es la última, vuelve a la primera). */

/** Al terminar: lleva la vista al resultado (récord, bueno o malo), justo debajo del reloj. */
function verResultado(selResultado, selMarcador) {
  const r = $(selResultado), m = document.querySelector(selMarcador);
  if (!r.getBoundingClientRect) return;
  const y = r.getBoundingClientRect().top + window.scrollY - (m ? m.getBoundingClientRect().height : 0) - 10;
  window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}
const verResultadoT = () => verResultado('#t-resultado', '#s-tipeo .marcador');

function renderTipeo() {
  const box = $('#t-respuesta');
  box.textContent = '';
  let tramo = '', conPista = false;
  const volcar = () => {
    if (tramo) box.append(conPista ? el('span', 'pista', tramo) : document.createTextNode(tramo));
    tramo = '';
  };
  for (let i = 0; i < T.pos; i++) {
    const p = T.pistaPos.has(i);
    if (p !== conPista) { volcar(); conPista = p; }
    tramo += T.chars[i];
  }
  volcar();
  if (T.pos < T.chars.length) box.append(el('span', 'cursor'));
  ajustarScrollT();
  // Una vez que el navegador terminó de acomodar el nuevo tamaño, se vuelve a ajustar
  // (si no, la última línea puede quedar cortada a la mitad).
  requestAnimationFrame(() => { ajustarScrollT(); requestAnimationFrame(ajustarScrollT); });
}

/** Lleva el cuadro hasta la última línea y baja la página si el teclado fijo la tapa. */
function ajustarScrollT() {
  const box = $('#t-respuesta');
  if (!box || actual !== 'tipeo') return;
  box.scrollTop = box.scrollHeight;
  const barra = document.querySelector('#s-tipeo .acciones');
  if (!barra || !box.getBoundingClientRect) return;
  const hueco = box.getBoundingClientRect().bottom - barra.getBoundingClientRect().top + 12;
  if (hueco > 0) {
    window.scrollBy(0, hueco);
    box.scrollTop = box.scrollHeight;
  }
}

/** Muestra de una vez los signos y espacios que siguen (no hay que escribirlos). */
function avanzarAuto() {
  while (T.pos < T.chars.length && !esTipeable(T.chars[T.pos])) T.pos++;
}

function bucleT() {
  if (T.estado !== 'corriendo') return;
  const t = performance.now() - T.t0;
  const r = $('#t-reloj');
  r.textContent = formatoTiempo(t);
  const pas = T.rec !== null && t > T.rec;
  if (pas !== T.pasado) { T.pasado = pas; r.className = 'reloj' + (pas ? ' pasado' : ''); }
  T.raf = requestAnimationFrame(bucleT);
}
function detenerT() {
  cancelAnimationFrame(T.raf);
  if (T.wake) { try { T.wake.release(); } catch (e) { /* nada */ } T.wake = null; }
}

function empezarTipeo() {
  T.pos = 0;
  T.hechos = 0;
  T.errores = 0;
  T.pistas = 0; T.pistaPos = new Set();
  T.ultimoReg = null;
  T.pasado = false;
  avanzarAuto();
  renderTipeo();
  $('#t-resultado').hidden = true;
  T.estado = 'corriendo';
  T.t0 = performance.now();
  setRelojT(0);
  progresoT();
  botonesT();
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then(l => { T.wake = l; }).catch(() => {});
  }
  T.raf = requestAnimationFrame(bucleT);
}

function destelloError(k) {
  const box = $('#t-respuesta');
  box.classList.add('error');
  setTimeout(() => box.classList.remove('error'), 300);
  const b = T.teclas[k];
  if (b) {
    b.classList.add('mal');
    setTimeout(() => b.classList.remove('mal'), 260);
  }
}

function tocarTecla(raw) {
  if (T.estado === 'sinPregunta') { aviso('Elegí una pregunta de la lista.'); return; }
  if (T.estado === 'fin' || !T.total) return;
  const k = normTecla(raw);
  if (k.length !== 1 || !TECLAS_OK.includes(k)) return;
  audio(); // el navegador solo permite sonido después de un toque del usuario
  if (T.estado === 'listo' || T.estado === 'viendo') empezarTipeo();

  if (k === normTecla(T.chars[T.pos])) {
    T.pos++;
    T.hechos++;
    avanzarAuto();
    renderTipeo();
    progresoT();
    if (T.pos >= T.chars.length) terminarTipeo();
  } else {
    T.errores++;
    sonidoError();
    destelloError(k);
  }
}

/** Pista: escribe sola la próxima letra (queda marcada y se anota en el intento). */
function pistaT() {
  if (performance.now() < (T.bloqueoUI || 0)) return;
  if (T.estado === 'sinPregunta') { aviso('Elegí una pregunta de la lista.'); return; }
  if (T.estado === 'fin' || !T.total) return;
  audio();
  if (T.estado === 'listo' || T.estado === 'viendo') empezarTipeo();
  if (T.pos >= T.chars.length) return;
  T.pistas++;
  T.pistaPos.add(T.pos);
  T.pos++;
  T.hechos++;
  avanzarAuto();
  renderTipeo();
  progresoT();
  if (T.pos >= T.chars.length) terminarTipeo();
}

async function terminarTipeo() {
  const ms = Math.round(performance.now() - T.t0);
  detenerT();
  T.estado = 'fin';
  T.calificada = false;
  T.bloqueo = performance.now() + 900; // evita reiniciar por un toque de más
  const prev = (E.tiemposTipeo[T.q.id] || []).filter(x => !x.h);   // los intentos con ayuda no cuentan para comparar
  const res = T.pistas
    ? { clase: 'ayuda', titulo: 'CON AYUDA', detalle: `Usaste ${T.pistas} pista${T.pistas === 1 ? '' : 's'}. Queda en el historial, pero no cuenta para el récord ni para tu nivel habitual.` }
    : evaluar(prev, ms);
  const reg = { f: ahora(), ms, p: T.total, e: T.errores };
  if (T.pistas) reg.h = T.pistas;
  (E.tiemposTipeo[T.q.id] = E.tiemposTipeo[T.q.id] || []).push(reg);
  if (T.pistas) { marcarRepaso(T.q.id, 'tipeo', 'pistas'); T.ronda.dudosas.add(T.q.id); }
  T.ultimoReg = reg;
  setRelojT(ms, res.clase);
  const r = $('#t-resultado');
  r.className = 'resultado ' + res.clase;
  r.textContent = '';
  const err = T.errores ? ` Errores: ${T.errores}.` : ' ¡Sin errores!';
  r.append(el('b', '', res.titulo), document.createTextNode(res.detalle + err + (T.pistas ? ' Se agregó a «Para repasar».' : '')));
  r.hidden = false;
  renderScores(CFG.tipeo, res.clase === 'record');
  botonesT();
  verResultadoT();
  await guardarEstado();
}

async function pedirCancelarT() {
  if (T.estado !== 'corriendo') return;
  const ok = await confirmarEnPausa(T, bucleT, '¿Cancelar el intento?', 'Si cancelás, este intento no se guarda.',
    'Cancelar intento', 'danger', 'Seguir intentando', 'primary');
  if (ok) cancelarTipeo();
}

function reintentarT() {
  if (T.estado !== 'fin' || performance.now() < T.bloqueo || (enRepaso(T) && !T.calificada)) return;
  cargarPreguntaTipeo(T.q);
  window.scrollTo(0, 0);
}

function cancelarTipeo() {
  if (T.estado !== 'corriendo') return;
  cargarPreguntaTipeo(T.q);
  setBoxT('Intento cancelado. Escribí la primera letra para volver a empezar.');
}

async function verRespuestaT() {
  if (!T.q || performance.now() < (T.bloqueoUI || 0)) return;
  if (T.estado === 'corriendo') {
    if (!(await confirmarEnPausa(T, bucleT, 'Ver respuesta', 'Si la mostrás, este intento se cancela sin guardarse.', 'Mostrar', 'primary', 'Seguir intentando'))) return;
  }
  detenerT();
  T.estado = 'viendo';
  T.pos = 0;
  T.hechos = 0;
  setRelojT(0);
  $('#t-resultado').hidden = true;
  const box = $('#t-respuesta');
  box.textContent = T.q.respuesta;
  box.scrollTop = 0;
  progresoT();
  botonesT();
}

function enlazarTipeo() {
  $('#act-volver').onclick = volverMenu;
  $('#act-palabras').onclick = () => abrirSeleccion('palabras');
  $('#act-tipeo').onclick = () => abrirSeleccion('tipeo');
  $('#t-volver').onclick = volverMenu;
  $('#t-sonido').onclick = () => {
    E.silencio = !E.silencio;
    actualizarSonido();
    aviso(E.silencio ? 'Sonido silenciado' : 'Sonido activado');
    guardarEstado();
    if (!E.silencio) audio();
  };
  $('#t-ver').onclick = verRespuestaT;
  $('#t-pista').onclick = pistaT;
  $('#t-tec').onclick = () => {
    tecladoPantalla = !tecladoPantalla;
    try { localStorage.setItem('mp_teclado', tecladoPantalla ? '1' : '0'); } catch (e) { /* nada */ }
    aplicarModo();
    setTimeout(ajustarScrollT, 50);
  };
  $('#t-cancelar').onclick = pedirCancelarT;
  $('#t-main').onclick = reintentarT;
  $('#t-h-ultimos').onclick = () => { T.vistaHist = 'ultimos'; renderHistorial(CFG.tipeo); };
  $('#t-h-mejores').onclick = () => { T.vistaHist = 'mejores'; renderHistorial(CFG.tipeo); };
}

/* =====================================================================
   DATOS: copia de seguridad e importación
   ===================================================================== */
const D = { sel: null };

function abrirDatos() {
  if (!D.sel) D.sel = crearSelector($('#d-ubicacion'));
  D.sel.refrescar(E.ultima);
  $('#d-estado').textContent = '';
  $('#n-url').value = E.nube.url; $('#n-clave').value = E.nube.clave; $('#n-disp').value = E.nube.disp;
  $('#n-estado').textContent = E.nube.ultima ? 'Última sincronización: ' + E.nube.ultima : '';
  estadoPersistencia();
  entrar('datos');
}

async function estadoPersistencia() {
  const p = $('#d-persist');
  let txt = 'Los datos se guardan solo en este celular, dentro del navegador.';
  try {
    if (navigator.storage && navigator.storage.persisted) {
      let pers = await navigator.storage.persisted();
      if (!pers && navigator.storage.persist) pers = await navigator.storage.persist();
      txt += pers
        ? ' El almacenamiento está protegido contra borrado automático.'
        : ' El navegador podría borrarlos si se queda sin espacio: instalá la app en la pantalla de inicio y hacé copias de seguridad.';
    }
  } catch (e) { /* nada */ }
  if (!almacenamientoOk) txt += ' ATENCIÓN: hubo un error al guardar.';
  p.textContent = txt;
}

function descargar(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportarCopia() {
  const datos = { app: 'muestra-palabras', v: 1, exportado: ahora(), arbol: E.arbol, preguntas: E.preguntas, tiempos: E.tiempos, tiemposTipeo: E.tiemposTipeo, repaso: E.repaso };
  const d = new Date();
  const nombre = `MuestraPalabras-copia-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  descargar(new Blob([JSON.stringify(datos, null, 1)], { type: 'application/json' }), nombre);
  aviso('Copia exportada');
}

async function restaurarCopia(file) {
  const est = $('#d-estado');
  try {
    const datos = JSON.parse(await file.text());
    if (datos.app !== 'muestra-palabras' || !Array.isArray(datos.preguntas)) throw new Error('El archivo no es una copia de Muestra Palabras.');
    const ids = new Set(E.preguntas.map(q => q.id));
    const nuevas = datos.preguntas.filter(q => q && q.id && Array.isArray(q.ruta) && q.ruta.length === 4 && !ids.has(q.id));
    const ok = await confirmar('Restaurar copia', `Se agregarán ${nuevas.length} pregunta${nuevas.length === 1 ? '' : 's'} nueva${nuevas.length === 1 ? '' : 's'} (las que ya tenés no se tocan).`, 'Restaurar');
    if (!ok) return;
    mergeArbol(E.arbol, datos.arbol);
    nuevas.forEach(q => { agregarRuta(q.ruta); E.preguntas.push(q); });
    let tiemposAgregados = 0;
    const fusionar = (dst, src) => {
      Object.entries(src || {}).forEach(([id, lista]) => {
        if (!Array.isArray(lista)) return;
        const actuales = (dst[id] = dst[id] || []);
        const claves = new Set(actuales.map(x => x.f + '|' + x.ms));
        lista.forEach(x => {
          if (x && isFinite(x.ms) && !claves.has(x.f + '|' + x.ms)) { actuales.push(x); tiemposAgregados++; }
        });
      });
    };
    fusionar(E.tiempos, datos.tiempos);
    fusionar(E.tiemposTipeo, datos.tiemposTipeo);
    E.repaso = E.repaso || {};
    Object.entries(datos.repaso || {}).forEach(([id, r]) => { if (r && (!E.repaso[id] || (r.mod || 0) > (E.repaso[id].mod || 0))) E.repaso[id] = r; });
    await guardarEstado();
    D.sel.refrescar(E.ultima);
    est.textContent = `Restauradas ${nuevas.length} preguntas y ${tiemposAgregados} tiempos.`;
  } catch (err) {
    est.textContent = 'No se pudo restaurar: ' + err.message;
  }
}

/* ----- Importar .txt del programa de escritorio ----- */
function parseTxtPregunta(texto) {
  texto = texto.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = texto.match(/=== PREGUNTA ===\n([\s\S]*?)\n=== RESPUESTA ===\n?([\s\S]*)/);
  if (m) return { pregunta: m[1].trim(), respuesta: m[2].trim() };
  const lineas = texto.split('\n');
  const i = lineas.findIndex(l => l.trim());
  if (i < 0) return null;
  return { pregunta: lineas[i].trim(), respuesta: lineas.slice(i + 1).join('\n').trim() };
}

function parseTiempoStr(s) {
  const m = /^(\d+):(\d+)\.(\d+)$/.exec((s || '').trim());
  return m ? (+m[1] * 60 + +m[2]) * 1000 + +m[3] * 10 : NaN;
}

function parseTxtTiempos(texto) {
  const out = [];
  texto.replace(/^﻿/, '').split(/\r?\n/).forEach(l => {
    if (!l.trim() || l.trim().startsWith('#')) return;
    const p = l.split('|').map(s => s.trim());
    let ms = parseInt(p[2], 10);
    if (!isFinite(ms)) ms = parseTiempoStr(p[1]);
    if (!isFinite(ms)) return;
    out.push({ f: p[0] || '', ms, p: parseInt(p[3], 10) || 0 });
  });
  return out;
}

async function importarTxt(files) {
  const est = $('#d-estado');
  const ruta = D.sel.ruta();
  if (!ruta) { est.textContent = 'Primero elegí o creá (botón +) Área, Año, Materia y Actividad.'; return; }
  const qs = [], ts = {};
  for (const f of files) {
    const texto = await f.text();
    const nombre = f.name.replace(/\.txt$/i, '');
    if (/ - tiempos$/i.test(nombre)) ts[nombre.replace(/ - tiempos$/i, '').toLowerCase()] = parseTxtTiempos(texto);
    else qs.push({ nombre, texto });
  }
  qs.sort((a, b) => collator.compare(a.nombre, b.nombre));
  agregarRuta(ruta);
  let nuevas = 0, omitidas = 0, vacias = 0, tiempos = 0;
  for (const { nombre, texto } of qs) {
    const pr = parseTxtPregunta(texto);
    if (!pr || !pr.pregunta || !pr.respuesta) { vacias++; continue; }
    const existentes = pregs(ruta);
    if (existentes.some(q => q.pregunta === pr.pregunta)) { omitidas++; continue; }
    const usados = new Set(existentes.map(q => q.num));
    let num = parseInt((/Pregunta\s+(\d+)/i.exec(nombre) || [])[1], 10);
    if (!num || usados.has(num)) num = existentes.reduce((m, q) => Math.max(m, q.num), 0) + 1;
    const q = { id: uid(), ruta: [...ruta], num, pregunta: pr.pregunta, respuesta: pr.respuesta, archivo: nombre, mod: Date.now() };
    E.preguntas.push(q);
    nuevas++;
    const t = ts[nombre.toLowerCase()];
    if (t && t.length) { E.tiempos[q.id] = t; tiempos += t.length; }
  }
  await guardarEstado();
  D.sel.refrescar(ruta);
  const partes = [`Importadas ${nuevas} pregunta${nuevas === 1 ? '' : 's'}`, `${tiempos} tiempos`];
  if (omitidas) partes.push(`${omitidas} ya existían`);
  if (vacias) partes.push(`${vacias} sin contenido o ilegibles`);
  est.textContent = partes.join(' · ') + '.';
  const sinPareja = Object.keys(ts).filter(k => !qs.some(x => x.nombre.toLowerCase() === k));
  if (sinPareja.length) est.textContent += ` (${sinPareja.length} archivo${sinPareja.length === 1 ? '' : 's'} de tiempos sin su pregunta, no se importaron).`;
}


/* =====================================================================
   RONDAS Y "PARA REPASAR"
   - Al terminar cada pregunta se elige Aprendida o Dudosa y se pasa a la siguiente.
   - Las Dudosas (y las hechas con pistas) quedan en E.repaso y se repiten al final de la ronda.
   ===================================================================== */
/** vuelta = true: recorrido de estudio por «Mi progreso» (solo las pendientes de la vuelta); no es el modo repaso. */
const nuevaRonda = (alcance, vuelta) => ({ alcance: alcance || null, vuelta: !!vuelta, hechas: new Set(), dudosas: new Set() });
const CARGAR = { palabras: q => { cargarPreguntaEval(q); $('#e-preguntas').open = false; }, tipeo: q => { cargarPreguntaTipeo(q); $('#t-preguntas').open = false; } };

/** ¿Se está repasando (lista «Para repasar» o repitiendo dudosas)? */
function enRepaso(S2) { return !!(S2.ronda && S2.ronda.alcance && !S2.ronda.vuelta); }

function listaRonda(S2) {
  if (S2.ronda && S2.ronda.alcance) return S2.ronda.alcance.map(id => E.preguntas.find(q => q.id === id)).filter(Boolean);
  return S2.ruta ? pregs(S2.ruta) : [];
}
function textoRonda(S2) {
  const r = S2.ronda;
  if (!r || !r.hechas.size) return '';
  return ` · Ronda: ${r.hechas.size} hecha${r.hechas.size === 1 ? '' : 's'}` + (r.dudosas.size ? `, ${r.dudosas.size} dudosa${r.dudosas.size === 1 ? '' : 's'}` : '');
}
function pintarRutaRonda(sel, ruta, alcance) {
  if (!alcance || ruta) return pintarRuta(sel, ruta);
  const c = $(sel);
  c.textContent = '';
  c.append(el('span', 'tr tr3', 'Para repasar'));
}
function marcarRepaso(qid, tipo, motivo) {
  E.repaso = E.repaso || {};
  E.repaso[qid] = { tipo, motivo, f: ahora(), mod: Date.now() };
}
/** Quita de la lista dejando una marca (así la baja también llega a los otros dispositivos). */
function quitarRepaso(qid) {
  const r = (E.repaso || {})[qid];
  if (r) E.repaso[qid] = Object.assign({}, r, { q: true, mod: Date.now() });
}
function proximaRonda(S2) {
  const l = listaRonda(S2);
  const i = l.findIndex(q => q.id === S2.q.id);
  for (let k = 1; k <= l.length; k++) {
    const q = l[(i + k) % l.length];
    if (!S2.ronda.hechas.has(q.id)) return q;
  }
  return null;
}
async function finRonda(act) {
  const S2 = CFG[act].S();
  // Se repiten todas las de la ronda que siguen en «Para repasar» (dudosas o con pistas,
  // de esta ronda o de antes), no solo las marcadas como dudosas en esta ronda.
  const pend = new Set(itemsRepaso().map(x => x.q.id));
  const orden = listaRonda(S2).filter(q => pend.has(q.id) || S2.ronda.dudosas.has(q.id)).map(q => q.id);
  const alcanceActual = S2.ronda.alcance;
  if (S2.ronda.vuelta && !S2.ronda.dudosas.size) {
    // Terminó la vuelta de «Mi progreso»
    const n = progresoVuelta(S2.ruta, act).min;
    S2.ronda = nuevaRonda(null);
    await modal({
      titulo: `¡Vuelta ${n} completa! 🎉`, mensaje: 'Respondiste todas las preguntas de esta vuelta.',
      botones: [{ texto: 'Ver mi progreso', valor: true, clase: 'primary' }]
    });
    await volverMenu();
    abrirProgreso();
    return;
  }
  if (!orden.length && alcanceActual && !pend.size) {
    // Terminó el repaso: aviso y vuelta a la pantalla de inicio
    S2.ronda = nuevaRonda(alcanceActual);
    await modal({
      titulo: '¡Repaso completo! 🎉', mensaje: 'Ya no quedan preguntas para repasar.',
      botones: [{ texto: 'Ir al inicio', valor: true, clase: 'primary' }]
    });
    await volverMenu();
    return;
  }
  if (!orden.length) {
    S2.ronda = nuevaRonda(alcanceActual);
    aviso('¡Ronda completa! Todo aprendido 🎉');
    if (act === 'palabras') { renderListaEval(); botones(); } else { renderListaTipeo(); botonesT(); }
    return;
  }
  const n = orden.length;
  const uno = n === 1;
  const repetir = await confirmar('Ronda completa',
    `${uno ? 'Queda 1 pregunta' : `Quedan ${n} preguntas`} para repasar. ¿${uno ? 'La repetís' : 'Las repetís'} ahora?`,
    uno ? 'Repetirla' : `Repetir las ${n}`, 'primary', 'Terminar');
  if (repetir) {
    S2.ronda = nuevaRonda(orden);
    fondoRepaso();
    const q = listaRonda(S2)[0];
    CARGAR[act](q);
    window.scrollTo(0, 0);
  } else {
    S2.ronda = nuevaRonda(alcanceActual);
    aviso('Quedaron guardadas en «Para repasar».');
    if (act === 'palabras') { renderListaEval(); botones(); } else { renderListaTipeo(); botonesT(); }
  }
}
async function avanzarRonda(act) {
  const S2 = CFG[act].S();
  const nxt = proximaRonda(S2);
  if (nxt) { CARGAR[act](nxt); window.scrollTo(0, 0); }
  else await finRonda(act);
}
async function calificar(act, valor) {
  const S2 = CFG[act].S();
  if (S2.estado !== 'fin' || S2.calificada || !S2.q || performance.now() < S2.bloqueo) return;
  if (valor === 'apr' && (S2.marcaDud || (act === 'tipeo' && S2.pistas))) valor = 'dud';
  const id = S2.q.id;
  if (valor === 'rep') {
    // Repetir: queda en «Para repasar» y la misma pregunta arranca de nuevo enseguida
    const ya = E.repaso[id];
    if (!ya || ya.q) marcarRepaso(id, act, act === 'tipeo' && S2.pistas ? 'pistas' : 'repetir');
    await guardarEstado();
    if (act === 'palabras') empezar();
    else cargarPreguntaTipeo(S2.q);
    window.scrollTo(0, 0);
    return;
  }
  S2.calificada = true;
  S2.ronda.hechas.add(id);
  if (valor === 'apr') {
    // Solo se quita de «Para repasar» si se respondió desde el repaso; fuera de él, Continuar no la toca
    if (enRepaso(S2)) quitarRepaso(id);
    S2.ronda.dudosas.delete(id);
  } else {
    marcarRepaso(id, act, act === 'tipeo' && S2.pistas ? 'pistas' : 'dudosa');
    S2.ronda.dudosas.add(id);
  }
  await guardarEstado();
  await avanzarRonda(act);
}
/** Botoncito «Para repasar»: marca (o desmarca) la pregunta para que quede en la lista. */
function toggleDud(act) {
  const S2 = CFG[act].S();
  if (S2.estado !== 'fin' || S2.calificada || !S2.q) return;
  if (act === 'tipeo' && S2.pistas) return;   // con pistas va siempre a repaso
  S2.marcaDud = !S2.marcaDud;
  actualizarDud(act);
}
function actualizarDud(act) {
  const S2 = CFG[act].S();
  const b = $('#' + (act === 'tipeo' ? 't' : 'e') + '-dud');
  const on = !!S2.marcaDud || (act === 'tipeo' && !!S2.pistas);
  b.textContent = on ? '★ En repaso' : '☆ Para repasar';
  b.classList.toggle('on', on);
  b.disabled = act === 'tipeo' && !!S2.pistas;
}

/* ----- Pantalla "Para repasar" ----- */
function itemsRepaso() {
  return Object.entries(E.repaso || {})
    .map(([id, r]) => ({ q: E.preguntas.find(x => x.id === id), r }))
    .filter(x => x.q && !x.r.q)
    .sort((a, b) => (b.r.f || '').localeCompare(a.r.f || ''));
}
/* ----- Pantalla «Mi progreso» ----- */
/** Estudio por vueltas: una vuelta es un recorrido por todas las preguntas de la carpeta. Se calcula con los intentos
    ya guardados (los hechos con pistas no cuentan): vueltas completas = el mínimo de intentos entre las preguntas. */
function progresoVuelta(ruta, act) {
  const tiempos = (act === 'tipeo' ? E.tiemposTipeo : E.tiempos) || {};
  const lista = pregs(ruta);
  const n = lista.map(q => (tiempos[q.id] || []).filter(x => !(x.h > 0)).length);
  const min = n.length ? Math.min(...n) : 0;
  const pend = lista.filter((q, i) => n[i] === min);
  return { lista, min, pend, hechas: lista.length - pend.length };
}
function abrirProgreso() { entrar('progreso'); renderProgreso(); }
function renderProgreso() {
  const cont = $('#p-lista');
  cont.innerHTML = '';
  const grupos = new Map();
  E.preguntas.forEach(q => {
    const k = q.ruta.join('\u0001');
    if (!grupos.has(k)) grupos.set(k, q.ruta);
  });
  if (!grupos.size) { cont.append(el('p', 'muted centro', 'Todavía no hay preguntas.')); return; }
  [...grupos.values()].sort((a, b) => a.join('/').localeCompare(b.join('/'), 'es')).forEach(ruta => {
    const lista = pregs(ruta);
    const card = el('section', 'panel prog');
    card.append(el('h3', '', ruta.join(' › ')));
    [['palabras', '⏱️ Revelar palabras', iniciarEval, cargarPreguntaEval, '#e-preguntas'],
     ['tipeo', '⌨️ Escribir letra por letra', iniciarTipeo, cargarPreguntaTipeo, '#t-preguntas']].forEach(([act, nombre, iniciar, cargar, panel]) => {
      const p = progresoVuelta(ruta, act);
      const { hechas, pend, min } = p;
      const sig = pend[0];
      const fila = el('div', 'prog-fila');
      const cab = el('div', 'prog-cab');
      cab.append(el('span', '', nombre), el('span', 'prog-n', lista.length ? `Vuelta ${min + 1} · ${hechas} / ${lista.length}` : '—'));
      const barra = el('div', 'barra');
      const rell = el('div', 'prog-rell');
      rell.style.width = (lista.length ? Math.round(100 * hechas / lista.length) : 0) + '%';
      barra.append(rell);
      fila.append(cab, barra);
      if (sig) {
        if (!hechas && min) fila.append(el('p', 'muted prog-ok', `✓ Vuelta ${min} completa`));
        const txt = hechas ? `Retomar en la ${pad(sig.num, 3)} ›` : (min ? `Empezar la vuelta ${min + 1} ›` : `Empezar en la ${pad(sig.num, 3)} ›`);
        const b = el('button', 'btn small primary', txt);
        b.onclick = () => iniciar(ruta, pend.map(q => q.id), true);
        fila.append(b);
      }
      card.append(fila);
    });
    cont.append(card);
  });
}
function abrirRepaso() { entrar('repaso'); renderRepaso(); }
function renderRepaso() {
  const items = itemsRepaso();
  const hoy = ahora().slice(0, 10);
  $('#r-botones').hidden = !items.length;
  const cont = $('#r-lista');
  cont.innerHTML = '';
  items.forEach(({ q, r }) => {
    const b = el('button', 'item');
    b.type = 'button';
    const dia = (r.f || '').slice(0, 10);
    const cuando = dia === hoy ? 'Hoy' : fechaHora(r.f).slice(0, 8);
    b.append(
      el('span', 'tag', (r.motivo === 'pistas' ? '💡 Pistas' : r.motivo === 'repetir' ? '↻ Repetir' : '? Dudosa') + ' · ' + cuando),
      el('span', 'num', pad(q.num, 3)), document.createTextNode(resumen(q)),
      el('span', 'sub', q.ruta.slice(2).join(' › '))
    );
    b.onclick = async () => {
      const v = await modal({
        titulo: `Pregunta ${pad(q.num, 3)}`, mensaje: resumen(q),
        apilados: true,
        botones: [
          { texto: '⏱️ Practicar revelando', valor: 'palabras', clase: 'primary' },
          { texto: '⌨️ Practicar escribiendo', valor: 'tipeo', clase: 'primary' },
          { texto: 'Quitar de la lista', valor: 'quitar', clase: 'danger sep' },
          { texto: 'Cancelar', valor: null, cancel: true }
        ]
      });
      if (v === 'quitar') { quitarRepaso(q.id); await guardarEstado(); renderRepaso(); }
      else if (v) empezarRepaso(v, q.id);
    };
    cont.append(b);
  });
  $('#r-lista').hidden = false;
}
/** Arranca el repaso: si se elige una pregunta, empieza por ella y sigue con las demás de la lista. */
function empezarRepaso(act, primero) {
  let alc = itemsRepaso().map(x => x.q.id);
  const i = primero ? alc.indexOf(primero) : -1;
  if (i > 0) alc = alc.slice(i).concat(alc.slice(0, i));
  if (!alc.length) return;
  (act === 'tipeo' ? iniciarTipeo : iniciarEval)(null, alc);
}

/* =====================================================================
   Eventos
   ===================================================================== */
function enlazar() {
  // menú
  $('#m-crear').onclick = abrirCrear;
  $('#m-evaluar').onclick = abrirActividades;
  $('#m-datos').onclick = abrirDatos;
  $('#m-repaso').onclick = abrirRepaso;
  $('#m-progreso').onclick = abrirProgreso;
  $('#p-volver').onclick = volverMenu;
  $('#r-volver').onclick = volverMenu;
  $('#r-pal').onclick = () => empezarRepaso('palabras');
  $('#r-tip').onclick = () => empezarRepaso('tipeo');
  $('#e-apr').addEventListener('pointerdown', e => { e.preventDefault(); calificar('palabras', 'apr'); });
  $('#e-r-apr').addEventListener('pointerdown', e => { e.preventDefault(); calificar('palabras', 'apr'); });
  $('#e-r-dud').addEventListener('pointerdown', e => { e.preventDefault(); calificar('palabras', 'dud'); });
  $('#e-r-rep').addEventListener('pointerdown', e => { e.preventDefault(); calificar('palabras', 'rep'); });
  $('#t-r-apr').addEventListener('pointerdown', e => { e.preventDefault(); calificar('tipeo', 'apr'); });
  $('#t-r-dud').addEventListener('pointerdown', e => { e.preventDefault(); calificar('tipeo', 'dud'); });
  $('#t-r-rep').addEventListener('pointerdown', e => { e.preventDefault(); calificar('tipeo', 'rep'); });
  $('#e-dud').addEventListener('pointerdown', e => { e.preventDefault(); toggleDud('palabras'); });
  $('#t-apr').addEventListener('pointerdown', e => { e.preventDefault(); calificar('tipeo', 'apr'); });
  $('#t-dud').addEventListener('pointerdown', e => { e.preventDefault(); toggleDud('tipeo'); });

  // crear
  $('#c-volver').onclick = volverMenu;
  $('#c-nueva').onclick = async () => { if (await resolverCambios()) formNuevo(); };
  $('#c-guardar').onclick = guardarPregunta;
  $('#c-eliminar').onclick = eliminarPregunta;
  $('#c-respuesta').addEventListener('input', actualizarContador);

  // seleccionar
  $('#sel-volver').onclick = () => entrar('act');
  $('#sel-continuar').onclick = () => {
    const ruta = S.sel.ruta();
    if (ruta && pregs(ruta).length) (MODO === 'tipeo' ? iniciarTipeo : iniciarEval)(ruta);
  };

  // evaluación
  $('#e-volver').onclick = volverMenu;
  $('#e-ver').onclick = verRespuesta;
  $('#e-cancelar').onclick = pedirCancelar;
  $('#e-h-ultimos').onclick = () => { V.vistaHist = 'ultimos'; renderHistorial(CFG.palabras); };
  $('#e-h-mejores').onclick = () => { V.vistaHist = 'mejores'; renderHistorial(CFG.palabras); };
  const main = $('#e-main');
  main.addEventListener('pointerdown', e => { e.preventDefault(); accionPrincipal(); });
  $('#e-respuesta').addEventListener('click', () => { if (V.estado === 'corriendo') revelar(); });

  // datos
  $('#d-volver').onclick = volverMenu;
  $('#d-exportar').onclick = exportarCopia;
  $('#d-restaurar').onclick = () => $('#d-file-json').click();
  $('#d-file-json').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) restaurarCopia(f);
    e.target.value = '';
  });
  $('#d-importar').onclick = () => {
    if (!D.sel.ruta()) { $('#d-estado').textContent = 'Primero elegí o creá (botón +) Área, Año, Materia y Actividad.'; return; }
    $('#d-file-txt').click();
  };
  $('#d-file-txt').addEventListener('change', e => {
    if (e.target.files.length) importarTxt([...e.target.files]);
    e.target.value = '';
  });

  // teclado (útil si la abrís en una PC)
  document.addEventListener('keydown', e => {
    if (!$('#modal').hidden) return;
    if (actual === 'eval') {
      if (e.key === ' ' && !e.repeat) { e.preventDefault(); accionPrincipal(); }
      else if (V.estado === 'fin' && !V.calificada && enRepaso(V) && !e.repeat && !e.ctrlKey && !e.metaKey && 'adr'.includes(e.key.toLowerCase()) && e.key.length === 1) { e.preventDefault(); calificar('palabras', { a: 'apr', d: 'dud', r: 'rep' }[e.key.toLowerCase()]); }
      else if (V.estado === 'fin' && !V.calificada && !enRepaso(V) && !e.repeat && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c') { e.preventDefault(); calificar('palabras', 'apr'); }
      else if (V.estado === 'fin' && !V.calificada && !enRepaso(V) && !e.repeat && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleDud('palabras'); }
      else if (e.key === 'Enter' && !e.repeat && ['listo', 'viendo', 'fin'].includes(V.estado)) { e.preventDefault(); accionPrincipal(); }
      else if (e.key === 'Escape') pedirCancelar();
    } else if (actual === 'crear' && (e.ctrlKey || e.metaKey)) {
      if (e.key.toLowerCase() === 's') { e.preventDefault(); guardarPregunta(); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); $('#c-nueva').click(); }
    } else if (actual === 'tipeo') {
      if (e.key === 'Escape') pedirCancelarT();
      else if (T.estado === 'fin' && !T.calificada && enRepaso(T) && !e.repeat && !e.ctrlKey && !e.metaKey && e.key.length === 1 && 'adrADR'.includes(e.key)) { e.preventDefault(); calificar('tipeo', { a: 'apr', d: 'dud', r: 'rep' }[e.key.toLowerCase()]); }
      else if (T.estado === 'fin' && !enRepaso(T) && !e.repeat && !e.ctrlKey && !e.metaKey && e.key.length === 1 && 'cCdD'.includes(e.key)) { e.preventDefault(); if (e.key.toLowerCase() === 'c') calificar('tipeo', 'apr'); else toggleDud('tipeo'); }
      else if (T.estado === 'fin' && !e.repeat && !e.ctrlKey && !e.metaKey && (e.key === 'r' || e.key === 'R' || e.key === 'Enter')) { e.preventDefault(); reintentarT(); }
      else if (e.key === 'ArrowRight' && !e.repeat && T.estado === 'fin' && !enRepaso(T)) { e.preventDefault(); calificar('tipeo', 'apr'); }
      else if (e.key === 'Enter' && !e.repeat && ['listo', 'corriendo', 'viendo'].includes(T.estado)) { e.preventDefault(); pistaT(); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); tocarTecla(e.key); }
    }
  });
}


/* =====================================================================
   NUBE: Google Sheet (a través de un Google Apps Script)
   - Preguntas: la hoja manda; lo creado/editado acá se sube antes de bajar.
   - Tiempos: solo se agregan (nunca se pisan), así celular y notebook se complementan.
   ===================================================================== */
let nubeOcupada = false;
const nubeConectada = () => !!(E.nube && E.nube.url && E.nube.clave);

function refrescarNube() {
  const on = nubeConectada();
  $('#m-sync').hidden = !on;
  $('#m-sync-info').textContent = on
    ? (E.nube.ultima ? 'Última sincronización: ' + E.nube.ultima.slice(0, 16) : 'Todavía no sincronizaste.')
    : '';
}

function guardarConexion() {
  const url = $('#n-url').value.trim(), clave = $('#n-clave').value.trim(), disp = $('#n-disp').value.trim();
  if (url && !/^https:\/\/script\.google\.com\/.+\/exec\/?$/.test(url)) {
    $('#n-estado').textContent = 'La dirección debe empezar con https://script.google.com/ y terminar en /exec';
    return false;
  }
  if (url !== E.nube.url) Object.assign(E.nube, { vistos: [], borrados: [], enviados: {}, ultimaSync: 0, ultima: '' });
  Object.assign(E.nube, { url, clave, disp });
  guardarEstado();
  refrescarNube();
  $('#n-estado').textContent = url ? 'Conexión guardada.' : 'Conexión quitada.';
  return true;
}

const claveTiempo = (qid, tipo, x) => `${qid}|${tipo}|${x.f}|${x.ms}`;

async function sincronizar() {
  if (nubeOcupada) return;
  if (!nubeConectada()) { aviso('Primero cargá la dirección y la clave en "Copia de seguridad e importar".'); return; }
  nubeOcupada = true;
  const N = E.nube;
  const botones = document.querySelectorAll('#n-sync, #m-sync');
  botones.forEach(b => { b.disabled = true; });
  const est = $('#n-estado');
  est.textContent = 'Sincronizando…';
  aviso('Sincronizando…');
  try {
    const t0 = Date.now();
    const vistos = new Set(N.vistos);

    // 1) Qué hay que subir
    const subirP = E.preguntas
      .filter(q => !vistos.has(q.id) || (q.mod || 0) > (N.ultimaSync || 0))
      .map(q => ({ id: q.id, ruta: q.ruta, num: q.num, pregunta: q.pregunta, respuesta: q.respuesta, mod: q.mod || 0 }));
    const subirT = [];
    [['palabras', E.tiempos], ['tipeo', E.tiemposTipeo]].forEach(([tipo, mapa]) => {
      Object.entries(mapa || {}).forEach(([qid, lista]) => (lista || []).forEach(x => {
        const id = claveTiempo(qid, tipo, x);
        if (!N.enviados[id]) subirT.push({ id, f: x.f, tipo, qid, ms: x.ms, p: x.p, e: x.e, h: x.h });
      }));
    });

    const subirR = Object.entries(E.repaso || {}).map(([id, x]) => ({ id, tipo: x.tipo, motivo: x.motivo, f: x.f, mod: x.mod || 0, q: !!x.q }));

    // 2) Un solo viaje: sube lo nuevo y baja el estado completo de la hoja
    const ctl = new AbortController();
    const corte = setTimeout(() => ctl.abort(), 60000);
    let r;
    try {
      const resp = await fetch(N.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ clave: N.clave, disp: N.disp || 'sin nombre', preguntas: subirP, tiempos: subirT, borrar: N.borrados, repaso: subirR }),
        signal: ctl.signal
      });
      r = await resp.json();
    } finally { clearTimeout(corte); }
    if (!r || !r.ok) {
      const m = { clave: 'La clave no coincide con la del script.', configurar: 'Falta cambiar la clave dentro del script.' };
      throw new Error((r && (m[r.error] || r.error)) || 'Respuesta inesperada del script.');
    }

    // 3) Preguntas: la hoja manda
    const delaHoja = (r.preguntas || []).filter(q => q && q.id && Array.isArray(q.ruta) && q.ruta.length === 4 && q.pregunta && q.respuesta);
    const enHoja = new Set(delaHoja.map(q => q.id));
    const porBorrar = new Set(N.borrados);
    let nuevas = 0, actualizadas = 0;
    const rutasViejas = [];
    delaHoja.forEach(h => {
      if (porBorrar.has(h.id)) return;
      const l = E.preguntas.find(q => q.id === h.id);
      if (!l) {
        agregarRuta(h.ruta);
        E.preguntas.push({ id: h.id, ruta: h.ruta, num: h.num, pregunta: h.pregunta, respuesta: h.respuesta, mod: h.mod || 0 });
        nuevas++;
      } else {
        const cambia = l.pregunta !== h.pregunta || l.respuesta !== h.respuesta || l.num !== h.num || !mismaRuta(l.ruta, h.ruta);
        if (cambia) {
          rutasViejas.push(l.ruta);
          agregarRuta(h.ruta);
          Object.assign(l, { ruta: h.ruta, num: h.num, pregunta: h.pregunta, respuesta: h.respuesta });
          actualizadas++;
        }
        l.mod = h.mod || 0;
      }
    });
    // las que estaban en la hoja y ya no están: se borraron allá
    const faltan = E.preguntas.filter(q => vistos.has(q.id) && !enHoja.has(q.id));
    let quitadas = 0;
    if (faltan.length) {
      const ok = await confirmar('Preguntas quitadas en la hoja',
        `La hoja ya no tiene ${faltan.length} pregunta${faltan.length === 1 ? '' : 's'} que sí está${faltan.length === 1 ? '' : 'n'} en este dispositivo. ¿Quitar${faltan.length === 1 ? 'la' : 'las'} también de acá? (Los tiempos se conservan.) Si elegís conservarlas, se vuelven a subir a la hoja.`,
        'Quitar', 'danger', 'Conservar');
      if (ok) {
        const ids = new Set(faltan.map(q => q.id));
        faltan.forEach(q => rutasViejas.push(q.ruta));
        E.preguntas = E.preguntas.filter(q => !ids.has(q.id));
        quitadas = faltan.length;
      }
    }

    rutasViejas.forEach(podarVacias);   // carpetas que quedaron vacías por renombres o borrados

    // 4) Tiempos: se agregan los que faltan (solo de preguntas que existen acá)
    subirT.forEach(x => { N.enviados[x.id] = 1; });
    const hay = new Set(E.preguntas.map(q => q.id));
    let bajados = 0;
    (r.tiempos || []).forEach(t => {
      if (!t || !t.id || N.enviados[t.id] || !hay.has(t.qid)) return;
      N.enviados[t.id] = 1;
      const mapa = t.tipo === 'tipeo' ? E.tiemposTipeo : E.tiempos;
      const lista = (mapa[t.qid] = mapa[t.qid] || []);
      const ms = Number(t.ms);
      if (!isFinite(ms) || lista.some(x => x.f === t.f && x.ms === ms)) return;
      const reg = { f: t.f, ms };
      if (t.p !== '' && t.p != null) reg.p = Number(t.p);
      if (t.e !== '' && t.e != null) reg.e = Number(t.e);
      if (t.h !== '' && t.h != null && Number(t.h) > 0) reg.h = Number(t.h);
      lista.push(reg);
      bajados++;
    });

    // 5) Repaso: por pregunta gana el cambio más reciente
    let repBajados = 0;
    if (Array.isArray(r.repaso)) {
      E.repaso = E.repaso || {};
      r.repaso.forEach(x => {
        if (!x || !x.id || !hay.has(x.id)) return;
        const l = E.repaso[x.id];
        if (!l || (x.mod || 0) > (l.mod || 0)) {
          E.repaso[x.id] = { tipo: x.tipo, motivo: x.motivo, f: x.f, mod: x.mod || 0 };
          if (x.q) E.repaso[x.id].q = true;
          repBajados++;
        }
      });
    }

    N.vistos = [...enHoja].filter(id => E.preguntas.some(q => q.id === id));
    N.borrados = [];
    N.ultimaSync = t0;
    N.ultima = ahora();
    await guardarEstado();
    if (D.sel) D.sel.refrescar(E.ultima);
    refrescarMenu();

    const partes = [`Preguntas: ${nuevas} nuevas, ${actualizadas} actualizadas${quitadas ? ', ' + quitadas + ' quitadas' : ''}, ${subirP.length} subidas`,
      `Tiempos: ${bajados} bajados, ${subirT.length} subidos`];
    if (Array.isArray(r.repaso)) partes.push(`Repaso: ${repBajados} cambio${repBajados === 1 ? '' : 's'} bajado${repBajados === 1 ? '' : 's'}`);
    if (r.omitidas) partes.push(`${r.omitidas} fila${r.omitidas === 1 ? '' : 's'} de la hoja incompleta${r.omitidas === 1 ? '' : 's'} (revisá Área, Año, Materia, Actividad, Pregunta y Respuesta)`);
    est.textContent = partes.join(' · ');
    aviso('Sincronizado');
  } catch (err) {
    let m = err && err.message ? err.message : String(err);
    if (err && err.name === 'AbortError') m = 'Tardó demasiado. Probá de nuevo con mejor conexión.';
    else if (err instanceof TypeError) m = 'No se pudo conectar. Revisá tu conexión y que la dirección sea la de la implementación (termina en /exec).';
    else if (err instanceof SyntaxError) m = 'La respuesta no es la esperada. Revisá que el acceso de la implementación sea "Cualquier persona".';
    est.textContent = 'No se pudo sincronizar: ' + m;
    aviso('No se pudo sincronizar');
  } finally {
    nubeOcupada = false;
    botones.forEach(b => { b.disabled = false; });
  }
}

function enlazarNube() {
  $('#m-sync').onclick = sincronizar;
  $('#n-guardar').onclick = guardarConexion;
  $('#n-sync').onclick = async () => { if (guardarConexion()) await sincronizar(); };
}

/* ---- Computadora o celular: se detecta por mouse (puntero preciso con hover) ---- */
let tecladoPantalla = false;   // en PC el teclado en pantalla empieza oculto
try { tecladoPantalla = localStorage.getItem('mp_teclado') === '1'; } catch (e) { /* nada */ }
const mqPC = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : null;
function aplicarModo() {
  const pc = !!(mqPC && mqPC.matches);
  document.body.classList.toggle('pc', pc);
  const s = $('#s-tipeo');
  s.classList.toggle('sin-teclado', pc && !tecladoPantalla);
  const b = $('#t-tec');
  b.title = b.ariaLabel = tecladoPantalla ? 'Ocultar teclado en pantalla' : 'Mostrar teclado en pantalla';
  b.style.opacity = tecladoPantalla ? '1' : '.7';
}
if (mqPC && mqPC.addEventListener) mqPC.addEventListener('change', aplicarModo);

(async function init() {
  $('#m-version').textContent = `Versión ${VERSION.num} · ${VERSION.fecha}`;
  try {
    const guardado = await DB.leer();
    if (guardado) E = Object.assign(E, guardado);
    E.tiemposTipeo = E.tiemposTipeo || {};
    E.repaso = E.repaso || {};
  } catch (err) {
    almacenamientoOk = false;
    aviso('No se pudo abrir el almacenamiento del navegador.');
  }
  E.nube = Object.assign(NUBE_BASE(), E.nube || {});
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* nada */ }
  enlazar();
  enlazarTipeo();
  enlazarNube();
  aplicarModo();
  history.replaceState({ n: 'menu' }, '');
  mostrar('menu');
  refrescarMenu();
  if ('serviceWorker' in navigator) {
    // Cuando se instala una versión nueva, recargar una vez para mostrarla enseguida.
    const habia = !!navigator.serviceWorker.controller;
    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!habia || recargando) return;
      recargando = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => reg.update()).catch(() => {});
  }
})();
