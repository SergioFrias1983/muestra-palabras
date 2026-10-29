'use strict';

/* =====================================================================
   Muestra Palabras (versión celular / PWA)
   Datos guardados en IndexedDB del navegador. Sin servidor.
   ===================================================================== */

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
let E = { v: 1, arbol: {}, preguntas: [], tiempos: {}, ultima: [] };
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
function modal({ titulo = '', mensaje = '', input = null, botones }) {
  return new Promise(resolve => {
    const m = $('#modal'), inp = $('#modal-input'), bs = $('#modal-botones');
    $('#modal-titulo').textContent = titulo;
    $('#modal-msg').textContent = mensaje;
    $('#modal-msg').hidden = !mensaje;
    inp.hidden = input === null;
    inp.value = input || '';
    bs.innerHTML = '';

    const cerrar = v => {
      m.hidden = true;
      document.removeEventListener('keydown', tecla, true);
      resolve(v);
    };
    const tecla = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const c = botones.find(b => b.cancel);
        cerrar(c ? c.valor : null);
      } else if (e.key === 'Enter' && input !== null) {
        e.preventDefault();
        cerrar({ ok: true, texto: inp.value });
      }
    };
    botones.forEach(b => {
      const btn = el('button', 'btn ' + (b.clase || ''), b.texto);
      btn.type = 'button';
      btn.onclick = () => cerrar(input !== null && b.valor === 'ok' ? { ok: true, texto: inp.value } : b.valor);
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
const confirmar = (titulo, mensaje, si = 'Aceptar', clase = 'primary') =>
  modal({
    titulo, mensaje,
    botones: [{ texto: 'Cancelar', valor: false, cancel: true }, { texto: si, valor: true, clase }]
  });

/* ---------------- Selector de 4 listas encadenadas ---------------- */
function crearSelector(cont, alCambiar) {
  cont.innerHTML = '';
  const selects = [], btns = [];

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
const PANTALLAS = ['menu', 'crear', 'sel', 'eval', 'datos'];
let actual = 'menu';

function mostrar(n) {
  PANTALLAS.forEach(p => ($('#s-' + p).hidden = p !== n));
  actual = n;
  window.scrollTo(0, 0);
}
function entrar(n) {
  mostrar(n);
  history.pushState({ n }, '');
}
async function puedeSalir() {
  if (actual === 'crear') return resolverCambios();
  if (actual === 'eval' && V.estado === 'corriendo') {
    const ok = await confirmar('Intento en curso', '¿Salir sin guardar este intento?', 'Salir', 'danger');
    if (!ok) return false;
    cancelarIntento();
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
  if (!C.sel) C.sel = crearSelector($('#c-ubicacion'), onUbicacionCrear);
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
    await guardarEstado();
    aviso('Cambios guardados');
    cargarEnForm(q);
  } else {
    const num = pregs(C.ruta).reduce((m, q) => Math.max(m, q.num), 0) + 1;
    E.preguntas.push({ id: uid(), ruta: [...C.ruta], num, pregunta: p, respuesta: r });
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
  const t = E.tiempos[q.id] || [];
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
  if (borrarHist) delete E.tiempos[q.id];
  await guardarEstado();
  aviso('Pregunta eliminada');
  formNuevo();
}

/* =====================================================================
   ELEGIR QUÉ EVALUAR
   ===================================================================== */
const S = { sel: null };

function abrirSeleccion() {
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
  t0: 0, raf: 0, bloqueo: 0, ultimoReg: null, wake: null
};

function iniciarEval(ruta) {
  V.ruta = ruta;
  mostrar('eval');
  history.replaceState({ n: 'eval' }, '');
  $('#e-ruta').textContent = ruta.join(' › ');
  V.q = null;
  V.estado = 'sinPregunta';
  renderListaEval();
  $('#e-pregunta').textContent = 'Elegí una pregunta de la lista';
  setReloj(0);
  setBox('');
  $('#e-resultado').hidden = true;
  $('#e-preguntas').open = true;
  renderScores();
  progreso();
  botones();
}

function renderListaEval() {
  const lista = pregs(V.ruta);
  $('#e-preguntas-titulo').textContent = `Preguntas (${lista.length}) — tocá una para elegirla`;
  const cont = $('#e-lista');
  cont.innerHTML = '';
  lista.forEach(q => {
    const b = el('button', 'item' + (V.q && V.q.id === q.id ? ' activo' : ''));
    b.type = 'button';
    b.append(el('span', 'num', pad(q.num, 3)), document.createTextNode(resumen(q)));
    b.onclick = async () => {
      if (V.estado === 'corriendo') {
        if (!(await confirmar('Intento en curso', 'Si cambiás de pregunta, este intento se cancela sin guardarse.', 'Cambiar', 'danger'))) return;
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
  V.q = q;
  V.tokens = tokenizar(q.respuesta);
  V.idxPal = [];
  V.tokens.forEach((t, i) => { if (!t.esp) V.idxPal.push(i); });
  V.n = V.idxPal.length;
  V.k = 0;
  V.estado = 'listo';
  V.ultimoReg = null;
  $('#e-pregunta').textContent = q.pregunta;
  setReloj(0);
  setBox('Tocá EMPEZAR. Con el reloj corriendo, cada toque revela una palabra.');
  $('#e-resultado').hidden = true;
  renderListaEval();
  renderScores();
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
  $('#e-ver').disabled = V.estado === 'sinPregunta';
  $('#e-cancelar').disabled = V.estado !== 'corriendo';
}

function bucle() {
  if (V.estado !== 'corriendo') return;
  setReloj(performance.now() - V.t0);
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
      detalle: `Mejor que tu promedio. Quedaste a ${segs(ms - mejor)} del récord. Puesto ${puesto} de ${todos.length}.` };
  }
  return { clase: 'malo', titulo: 'TIEMPO MALO',
    detalle: `Peor que tu promedio por ${segs(ms - prom)}. Puesto ${puesto} de ${todos.length}.` };
}

async function terminar() {
  const ms = Math.round(performance.now() - V.t0);
  detener();
  V.estado = 'fin';
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
  renderScores();
  botones();
  r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

async function verRespuesta() {
  if (!V.q) return;
  if (V.estado === 'corriendo') {
    if (!(await confirmar('Ver respuesta', 'Si la mostrás, este intento se cancela sin guardarse.', 'Mostrar', 'primary'))) return;
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
      empezar();
      break;
    case 'fin':
      if (performance.now() < V.bloqueo) return;
      empezar();
      break;
    case 'corriendo':
      revelar();
      break;
  }
}

function renderScores() {
  const cont = $('#e-score');
  cont.innerHTML = '';
  const t = V.q ? (E.tiempos[V.q.id] || []) : [];
  if (!t.length) {
    cont.append(el('p', 'muted centro', V.q ? 'Todavía no hay tiempos para esta pregunta.' : '—'));
    return;
  }
  const orden = [...t].sort((a, b) => a.ms - b.ms);
  const mejor = orden[0];
  const prom = t.reduce((s, x) => s + x.ms, 0) / t.length;
  const kv = (k, v) => { const d = el('div', 'kv'); d.append(el('span', '', k), el('span', '', v)); return d; };
  cont.append(
    kv('Mejor tiempo', `${formatoTiempo(mejor.ms)} (${fechaCorta(mejor.f)})`),
    kv('Promedio', formatoTiempo(prom)),
    kv('Intentos', String(t.length))
  );
  cont.append(el('h4', '', 'Los 10 mejores'));
  const ol = el('ol');
  orden.slice(0, 10).forEach(x => {
    ol.append(el('li', x === V.ultimoReg ? 'nuevo' : '', `${formatoTiempo(x.ms)}  ·  ${fechaCorta(x.f)}`));
  });
  cont.append(ol);
}

/* =====================================================================
   DATOS: copia de seguridad e importación
   ===================================================================== */
const D = { sel: null };

function abrirDatos() {
  if (!D.sel) D.sel = crearSelector($('#d-ubicacion'));
  D.sel.refrescar(E.ultima);
  $('#d-estado').textContent = '';
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
  const datos = { app: 'muestra-palabras', v: 1, exportado: ahora(), arbol: E.arbol, preguntas: E.preguntas, tiempos: E.tiempos };
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
    Object.entries(datos.tiempos || {}).forEach(([id, lista]) => {
      if (!Array.isArray(lista)) return;
      const actuales = (E.tiempos[id] = E.tiempos[id] || []);
      const claves = new Set(actuales.map(x => x.f + '|' + x.ms));
      lista.forEach(x => {
        if (x && isFinite(x.ms) && !claves.has(x.f + '|' + x.ms)) { actuales.push(x); tiemposAgregados++; }
      });
    });
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
    const q = { id: uid(), ruta: [...ruta], num, pregunta: pr.pregunta, respuesta: pr.respuesta, archivo: nombre };
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
   Eventos
   ===================================================================== */
function enlazar() {
  // menú
  $('#m-crear').onclick = abrirCrear;
  $('#m-evaluar').onclick = abrirSeleccion;
  $('#m-datos').onclick = abrirDatos;

  // crear
  $('#c-volver').onclick = volverMenu;
  $('#c-nueva').onclick = async () => { if (await resolverCambios()) formNuevo(); };
  $('#c-guardar').onclick = guardarPregunta;
  $('#c-eliminar').onclick = eliminarPregunta;
  $('#c-respuesta').addEventListener('input', actualizarContador);

  // seleccionar
  $('#sel-volver').onclick = volverMenu;
  $('#sel-continuar').onclick = () => {
    const ruta = S.sel.ruta();
    if (ruta && pregs(ruta).length) iniciarEval(ruta);
  };

  // evaluación
  $('#e-volver').onclick = volverMenu;
  $('#e-ver').onclick = verRespuesta;
  $('#e-cancelar').onclick = cancelarIntento;
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
      else if (e.key === 'Enter' && !e.repeat && ['listo', 'viendo', 'fin'].includes(V.estado)) { e.preventDefault(); accionPrincipal(); }
      else if (e.key === 'Escape') cancelarIntento();
    } else if (actual === 'crear' && (e.ctrlKey || e.metaKey)) {
      if (e.key.toLowerCase() === 's') { e.preventDefault(); guardarPregunta(); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); $('#c-nueva').click(); }
    }
  });
}

(async function init() {
  try {
    const guardado = await DB.leer();
    if (guardado) E = Object.assign(E, guardado);
  } catch (err) {
    almacenamientoOk = false;
    aviso('No se pudo abrir el almacenamiento del navegador.');
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* nada */ }
  enlazar();
  history.replaceState({ n: 'menu' }, '');
  mostrar('menu');
  refrescarMenu();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
