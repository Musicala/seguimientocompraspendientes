/********************************************************
 * Control de Compras Internas — app.js
 * Backend: Firebase (Auth Google + Firestore en tiempo real)
 * Datos aislados en: apps/compras-musicala/items
 ********************************************************/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* =========================
   CONFIG FIREBASE
========================= */
const firebaseConfig = {
  apiKey: "AIzaSyCsXw0N_GkdwYMkdfZ_H2XIBNeTpGFn_rg",
  authDomain: "musicala-admin-hub.firebaseapp.com",
  projectId: "musicala-admin-hub",
  storageBucket: "musicala-admin-hub.firebasestorage.app",
  messagingSenderId: "468927778540",
  appId: "1:468927778540:web:619daeb67ff0287d92dfc9",
};

// Equipo autorizado. Mantener sincronizado con las reglas de Firestore
// (bloque apps/compras-musicala -> comprasTeam()).
const ALLOWED_EMAILS = [
  "alekcaballeromusic@gmail.com",
  "catalina.medina.leal@gmail.com",
  "adminmusicala@gmail.com",
  "musicalaasesor@gmail.com",
];

// Ruta aislada: NO toca colecciones de otros aplicativos.
const ITEMS_PATH = ["apps", "compras-musicala", "items"];

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const itemsCol = collection(db, ...ITEMS_PATH);
const googleProvider = new GoogleAuthProvider();

/* =========================
   STATE
========================= */
const state = {
  items: [],
  cart: new Set(),
  cartQuantities: {},
  currentSearch: "",
  currentEstado: "",
  currentTipo: "",
  currentPrioridad: "",
  currentCategoria: "",
  currentSort: "updated_desc",
  loading: false,
  user: null,
  unsubscribe: null,
};

/* =========================
   HELPERS DOM
========================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* =========================
   HELPERS GENERALES
========================= */
function safeText(value, fallback = "—") {
  if (value === null || value === undefined || String(value).trim() === "") {
    return fallback;
  }
  return String(value).trim();
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value) {
  const num = Number(value || 0);
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(num || 0);
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeDateForInput(value) {
  if (!value) return "";
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}\s/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s.slice(0, 10);
}

function todayInputValue() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

function formatDateDisplay(value, fallback = "—") {
  if (!value) return fallback;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-");
    return `${d}/${m}/${y}`;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("es-CO", {
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(parsed);
  }
  return fallback;
}

function formatDateTimeDisplay(value, fallback = "—") {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("es-CO", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(parsed);
  }
  return formatDateDisplay(value, fallback);
}

function tsToIso(value) {
  if (!value) return "";
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  return String(value);
}

function debounce(fn, delay = 300) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

const isPending = (i) => String(i?.estado || "").toLowerCase() === "pendiente";
const isBought = (i) => String(i?.estado || "").toLowerCase() === "comprado";
const isDiscarded = (i) => String(i?.estado || "").toLowerCase() === "descartado";
const isHighPriority = (i) => String(i?.prioridad || "").toLowerCase() === "alta";
const isIdea = (i) => String(i?.tipo || "").toLowerCase() === "idea";

/* =========================
   TOAST / UI STATE
========================= */
function showToast(message, isError = false) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.style.background = isError ? "#c43f44" : "#16203a";
  el.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function setLoading(isLoading) {
  state.loading = !!isLoading;
  document.body.style.cursor = isLoading ? "progress" : "";
  $$("button").forEach((btn) => {
    if (!btn.dataset.keepEnabled) btn.disabled = !!isLoading;
  });
}

/* =========================
   LABELS
========================= */
function estadoLabel(estado) {
  const e = String(estado || "").toLowerCase();
  if (e === "pendiente") return "Pendiente";
  if (e === "comprado") return "Comprado";
  if (e === "descartado") return "Descartado";
  return safeText(estado);
}

function prioridadLabel(prioridad) {
  const p = String(prioridad || "").toLowerCase();
  if (p === "alta") return "Alta";
  if (p === "media") return "Media";
  if (p === "baja") return "Baja";
  return safeText(prioridad);
}

/* =========================
   NORMALIZE ITEMS
========================= */
function normalizeItem(item = {}) {
  const createdAt = tsToIso(item.createdAt) || tsToIso(item.fechaRegistro) || "";
  const updatedAt = tsToIso(item.updatedAt) || createdAt;
  return {
    id: safeText(item.id, ""),
    tipo: safeText(item.tipo, "necesidad").toLowerCase(),
    item: safeText(item.item, ""),
    categoria: safeText(item.categoria, ""),
    prioridad: safeText(item.prioridad, "media").toLowerCase(),
    estado: safeText(item.estado, "pendiente").toLowerCase(),
    precioEstimado: item.precioEstimado ?? "",
    precioReal: item.precioReal ?? "",
    lugarSugerido: safeText(item.lugarSugerido, ""),
    lugarCompra: safeText(item.lugarCompra, ""),
    anotadoPor: safeText(item.anotadoPor, ""),
    anotadoPorEmail: safeText(item.anotadoPorEmail, ""),
    compradoPor: safeText(item.compradoPor, ""),
    compradoPorEmail: safeText(item.compradoPorEmail, ""),
    fechaRegistro: createdAt,
    fechaCompra: item.fechaCompra || "",
    tags: safeText(item.tags, ""),
    notas: safeText(item.notas, ""),
    createdAt,
    updatedAt,
  };
}

/* =========================
   RENDER STATS
========================= */
function renderStats(stats = {}) {
  $("#statPendientes").textContent = safeText(stats.pendientes ?? 0, "0");
  $("#statComprados").textContent = safeText(stats.comprados ?? 0, "0");
  $("#statEstimado").textContent = money(stats.estimadoPendiente || 0);
  $("#statGastado").textContent = money(stats.gastadoComprado || 0);
}

/* =========================
   ITEM HELPERS
========================= */
function renderMoneyOrDash(value) {
  if (value === "" || value === null || value === undefined) return "—";
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return "—";
  return money(num);
}

function renderNotesBlock(item) {
  if (!item.notas || item.notas === "—") return "";
  return `<div class="item-notes">${escapeHtml(item.notas)}</div>`;
}

function kvRow(k, v) {
  return `<article class="kv"><span class="k">${k}</span><div class="v">${v}</div></article>`;
}

function renderPurchaseMeta(item) {
  return [
    kvRow("Lugar sugerido", escapeHtml(safeText(item.lugarSugerido))),
    kvRow("Lugar compra", escapeHtml(safeText(item.lugarCompra))),
    kvRow("Fecha registro", escapeHtml(formatDateTimeDisplay(item.fechaRegistro))),
    kvRow("Fecha compra", escapeHtml(formatDateDisplay(item.fechaCompra))),
  ].join("");
}

function renderNeedBy(item) {
  if (isIdea(item)) return "Idea para considerar";
  const notes = normalizeText(item.notas);
  const tags = normalizeText(item.tags);
  if (notes.includes("urgente") || tags.includes("urgente")) return "Conviene resolverlo pronto";
  if (isHighPriority(item)) return "Marcado con prioridad alta";
  if (item.lugarSugerido && item.lugarSugerido !== "—") return `Sugerido en ${escapeHtml(item.lugarSugerido)}`;
  return "Pendiente de definir en esta vuelta de compra";
}

function extractQuantityLabel(item) {
  const candidates = [item.item, item.notas];
  const patterns = [
    /\b(\d+)\s*(?:und|unds|unidad|unidades|u)\b/i,
    /\b(\d+)\s*(?:caja|cajas|paquete|paquetes|resma|resmas|rollo|rollos)\b/i,
    /\bcantidad\s*[:=-]?\s*(\d+)\b/i,
    /\bcant\s*[:=-]?\s*(\d+)\b/i,
    /\bx\s*(\d+)\b/i,
  ];
  for (const raw of candidates) {
    const text = String(raw || "").trim();
    if (!text) continue;
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return `x${match[1]}`;
    }
  }
  return "";
}

function normalizeQuantityValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const num = Number(raw.replace(",", "."));
  if (!Number.isFinite(num) || num <= 0) return "";
  return Number.isInteger(num) ? String(num) : String(num).replace(/\.0+$/, "");
}

function cartQuantityLabel(item) {
  const manual = normalizeQuantityValue(state.cartQuantities[String(item.id)] || "");
  if (manual) return `x${manual}`;
  return extractQuantityLabel(item);
}

function buildCartQuoteRows() {
  return cartItems().map((item) => ({ quantity: cartQuantityLabel(item), name: item.item }));
}

function buildCartQuoteText() {
  return buildCartQuoteRows()
    .map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name))
    .join("\n")
    .trim();
}

function downloadCartQuotePdf() {
  const rows = buildCartQuoteRows();
  if (!rows.length) { showToast("El carrito está vacío", true); return; }

  const jsPdf = window.jspdf?.jsPDF;
  if (!jsPdf) { showToast("No se pudo cargar el generador de PDF", true); return; }

  const doc = new jsPdf({ unit: "mm", format: "letter" });
  const date = todayInputValue();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 18;
  let y = 22;

  doc.setFillColor(22, 32, 58);
  doc.rect(0, 0, pageWidth, 36, "F");
  doc.setFillColor(49, 86, 211);
  doc.rect(0, 36, pageWidth, 3, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text("Musicala", margin, y);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text("Lista para cotizacion", margin, y + 8);
  doc.text(`Fecha: ${formatDateDisplay(date)}`, pageWidth - margin, y + 8, { align: "right" });

  y = 52;
  doc.setTextColor(22, 32, 58);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text("Items seleccionados para cotizar", margin, y);

  y += 8;
  doc.setTextColor(107, 118, 140);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Documento generado desde el carrito de compras internas. No incluye precios estimados.", margin, y);

  y += 12;
  doc.setFillColor(245, 247, 251);
  doc.setDrawColor(217, 226, 240);
  doc.roundedRect(margin, y - 7, pageWidth - margin * 2, 10, 2, 2, "FD");
  doc.setTextColor(107, 118, 140);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("CANT.", margin + 4, y);
  doc.text("ITEM", margin + 30, y);

  y += 8;
  rows.forEach((row, index) => {
    const quantity = row.quantity || "-";
    const name = row.name || "Sin nombre";
    const nameLines = doc.splitTextToSize(name, pageWidth - margin * 2 - 38);
    const rowHeight = Math.max(11, nameLines.length * 5 + 6);
    if (y + rowHeight > pageHeight - 18) { doc.addPage(); y = 22; }
    if (index % 2 === 0) {
      doc.setFillColor(251, 252, 255);
      doc.roundedRect(margin, y - 5, pageWidth - margin * 2, rowHeight, 2, 2, "F");
    }
    doc.setDrawColor(232, 238, 248);
    doc.line(margin, y + rowHeight - 5, pageWidth - margin, y + rowHeight - 5);
    doc.setTextColor(22, 32, 58);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(quantity, margin + 4, y + 2);
    doc.setFont("helvetica", "normal");
    doc.text(nameLines, margin + 30, y + 2);
    y += rowHeight;
  });

  const totalPages = doc.internal.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(141, 150, 170);
    doc.text(`Pagina ${page} de ${totalPages}`, pageWidth - margin, pageHeight - 10, { align: "right" });
  }

  doc.save(`cotizacion-musicala-${date}.pdf`);
  showToast("PDF descargado");
}

/* =========================
   RENDER LIST
========================= */
function itemCard(rawItem) {
  const item = normalizeItem(rawItem);
  const estado = item.estado;
  const prioridad = item.prioridad;
  const inCart = state.cart.has(String(item.id));
  const idea = isIdea(item);

  const quick = [];
  if (item.categoria && item.categoria !== "—") quick.push(`<span class="item-tag">${escapeHtml(item.categoria)}</span>`);
  const est = renderMoneyOrDash(item.precioEstimado);
  if (est !== "—") quick.push(`<span class="item-tag">≈ ${escapeHtml(est)}</span>`);
  const real = renderMoneyOrDash(item.precioReal);
  if (real !== "—") quick.push(`<span class="item-tag tag-real">${escapeHtml(real)}</span>`);
  if (item.anotadoPor && item.anotadoPor !== "—") quick.push(`<span class="item-tag tag-muted">✎ ${escapeHtml(item.anotadoPor)}</span>`);
  const quickHtml = quick.length ? `<div class="item-quick">${quick.join("")}</div>` : "";

  return `
    <article class="item ${inCart ? "in-cart" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="item-top">
        <div class="item-head">
          <h3 class="item-title">${escapeHtml(safeText(item.item, "Sin nombre"))}</h3>
          <div class="item-subtitle">${renderNeedBy(item)}</div>
        </div>
        <div class="item-meta">
          ${inCart ? '<span class="pill cart">En carrito</span>' : ""}
          ${idea ? '<span class="pill tipo-idea-badge">💡 Idea</span>' : ""}
          <span class="pill estado-${escapeHtml(estado)}">${escapeHtml(estadoLabel(estado))}</span>
          ${idea ? "" : `<span class="pill prio-${escapeHtml(prioridad)}">${escapeHtml(prioridadLabel(prioridad))}</span>`}
        </div>
      </div>

      ${quickHtml}

      <div class="item-actions">
        ${isPending(item) ? `<button class="mini-btn ${inCart ? "cart-remove" : "cart-add"}" type="button" data-action="${inCart ? "remove-cart" : "add-cart"}" data-id="${escapeHtml(item.id)}">${inCart ? "Quitar" : "Al carrito"}</button>` : ""}
        ${isPending(item) ? `<button class="mini-btn buy" type="button" data-action="buy" data-id="${escapeHtml(item.id)}">Comprado</button>` : ""}
        <button class="mini-btn" type="button" data-action="edit" data-id="${escapeHtml(item.id)}">Editar</button>
        ${!isDiscarded(item)
          ? `<button class="mini-btn danger" type="button" data-action="discard" data-id="${escapeHtml(item.id)}">Descartar</button>`
          : `<button class="mini-btn warn" type="button" data-action="restore" data-id="${escapeHtml(item.id)}">Restaurar</button>`}
      </div>

      <details class="item-more">
        <summary>Ver detalle</summary>
        <div class="item-details">
          ${kvRow("Categoría", escapeHtml(safeText(item.categoria)))}
          ${kvRow("Estimado", escapeHtml(renderMoneyOrDash(item.precioEstimado)))}
          ${kvRow("Real", escapeHtml(renderMoneyOrDash(item.precioReal)))}
          ${kvRow("Anotado por", escapeHtml(safeText(item.anotadoPor)))}
          ${renderPurchaseMeta(item)}
        </div>
        ${renderNotesBlock(item)}
      </details>
    </article>
  `;
}

function renderEmpty(message = "No hay registros.") {
  const container = $("#listContainer");
  if (container) container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function renderList(items = []) {
  const container = $("#listContainer");
  if (!container) return;
  const count = $("#resultCount");
  if (count) count.textContent = items.length ? `${items.length} ${items.length === 1 ? "registro" : "registros"}` : "";
  if (!items.length) {
    renderEmpty("No hay registros con esos filtros. O están muy organizados o todavía no han registrado nada.");
    return;
  }
  container.innerHTML = items.map(itemCard).join("");
}

function cartItems() {
  return state.items.filter((item) => state.cart.has(String(item.id)) && isPending(item));
}

function renderCart() {
  const items = sortItems(cartItems());
  const container = $("#cartContainer");
  if (!container) return;

  const estimated = items.reduce((sum, item) => sum + toNumber(item.precioEstimado), 0);
  const urgentCount = items.filter(isHighPriority).length;

  $("#cartCount").textContent = `${items.length} ${items.length === 1 ? "pendiente" : "pendientes"}`;
  $("#cartEstimated").textContent = money(estimated);
  $("#cartUrgent").textContent = `${urgentCount} ${urgentCount === 1 ? "alta" : "altas"}`;

  if (!items.length) {
    container.innerHTML = `<div class="empty compact-empty">Aún no han seleccionado compras para esta vuelta.</div>`;
    return;
  }

  container.innerHTML = items.map((item) => {
    const quantity = cartQuantityLabel(item);
    const manualQuantity = normalizeQuantityValue(state.cartQuantities[String(item.id)] || "");
    return `
      <article class="cart-item" data-id="${escapeHtml(item.id)}">
        <div class="cart-item-top">
          <div>
            <h4 class="cart-item-title">${escapeHtml(item.item)}</h4>
            <div class="cart-item-meta">${escapeHtml(quantity || safeText(item.categoria))} · ${escapeHtml(prioridadLabel(item.prioridad))}</div>
          </div>
          <span class="pill prio-${escapeHtml(item.prioridad)}">${escapeHtml(quantity || "Pendiente")}</span>
        </div>
        <label class="cart-quantity">
          <span>Cantidad</span>
          <input type="number" min="1" step="1" inputmode="numeric"
            placeholder="${escapeHtml(quantity ? quantity.replace(/^x/, "") : "1")}"
            value="${escapeHtml(manualQuantity)}"
            data-action="cart-quantity" data-id="${escapeHtml(item.id)}" />
        </label>
        <div class="cart-item-actions">
          <button class="mini-btn buy" type="button" data-action="buy" data-id="${escapeHtml(item.id)}">Marcar comprado</button>
          <button class="mini-btn cart-remove" type="button" data-action="remove-cart" data-id="${escapeHtml(item.id)}">Quitar</button>
        </div>
      </article>
    `;
  }).join("");
}

/* =========================
   SORT / FILTER / STATS
========================= */
function priorityRank(p) {
  if (p === "alta") return 0;
  if (p === "media") return 1;
  if (p === "baja") return 2;
  return 3;
}

function compareDates(a, b) {
  const first = new Date(a || 0).getTime();
  const second = new Date(b || 0).getTime();
  return (Number.isFinite(first) ? first : 0) - (Number.isFinite(second) ? second : 0);
}

function matchesFilters(item) {
  const estadoOk = !state.currentEstado || item.estado === state.currentEstado;
  const tipoOk = !state.currentTipo || item.tipo === state.currentTipo;
  const prioridadOk = !state.currentPrioridad || item.prioridad === state.currentPrioridad;

  const categoriaNeedle = normalizeText(state.currentCategoria);
  const categoriaOk = !categoriaNeedle || normalizeText(item.categoria).includes(categoriaNeedle);

  const searchNeedle = normalizeText(state.currentSearch);
  const searchHaystack = normalizeText([
    item.item, item.categoria, item.tags, item.notas,
    item.lugarSugerido, item.lugarCompra, item.anotadoPor, item.compradoPor,
  ].join(" "));
  const searchOk = !searchNeedle || searchHaystack.includes(searchNeedle);

  return estadoOk && tipoOk && prioridadOk && categoriaOk && searchOk;
}

function sortItems(items = []) {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (state.currentSort === "cart_priority") {
      const cartDiff = Number(state.cart.has(String(b.id))) - Number(state.cart.has(String(a.id)));
      if (cartDiff !== 0) return cartDiff;
      const priorityDiff = priorityRank(a.prioridad) - priorityRank(b.prioridad);
      if (priorityDiff !== 0) return priorityDiff;
      return compareDates(b.updatedAt, a.updatedAt);
    }
    if (state.currentSort === "created_desc") return compareDates(b.createdAt, a.createdAt);
    if (state.currentSort === "created_asc") return compareDates(a.createdAt, b.createdAt);
    if (state.currentSort === "updated_asc") return compareDates(a.updatedAt, b.updatedAt);
    if (state.currentSort === "priority") {
      const byPriority = priorityRank(a.prioridad) - priorityRank(b.prioridad);
      if (byPriority !== 0) return byPriority;
      return compareDates(b.updatedAt, a.updatedAt);
    }
    return compareDates(b.updatedAt, a.updatedAt);
  });
  return sorted;
}

function computeStats(items = []) {
  return items.reduce((acc, item) => {
    if (isPending(item)) {
      acc.pendientes += 1;
      acc.estimadoPendiente += toNumber(item.precioEstimado);
    }
    if (isBought(item)) {
      acc.comprados += 1;
      acc.gastadoComprado += toNumber(item.precioReal);
    }
    return acc;
  }, { pendientes: 0, comprados: 0, estimadoPendiente: 0, gastadoComprado: 0 });
}

function renderApp() {
  renderStats(computeStats(state.items));
  renderList(sortItems(state.items.filter(matchesFilters)));
  renderCart();
  updateDuplicateHint();
}

/* =========================
   CART STATE
========================= */
function removeFromCart(id) {
  const key = String(id);
  state.cart.delete(key);
  delete state.cartQuantities[key];
}

function toggleCart(id, forceInCart) {
  const key = String(id);
  const item = findItemById(key);
  if (!item || !isPending(item)) { removeFromCart(key); return; }
  if (forceInCart === true) state.cart.add(key);
  else if (forceInCart === false) removeFromCart(key);
  else if (state.cart.has(key)) removeFromCart(key);
  else state.cart.add(key);
}

function findPotentialDuplicates(text) {
  const needle = normalizeText(text);
  if (!needle || needle.length < 3) return [];
  return state.items
    .filter((item) => {
      const name = normalizeText(item.item);
      return name && (name.includes(needle) || needle.includes(name));
    })
    .slice(0, 3);
}

function updateDuplicateHint() {
  const hint = $("#duplicateHint");
  const input = $("#item");
  if (!hint || !input) return;
  const duplicates = findPotentialDuplicates(input.value);
  if (!duplicates.length) {
    hint.textContent = "";
    hint.classList.add("hidden");
    return;
  }
  hint.textContent = `Ojo: ya existen registros parecidos como ${duplicates.map((i) => `"${i.item}"`).join(", ")}.`;
  hint.classList.remove("hidden");
}

/* =========================
   FIRESTORE — TIEMPO REAL
========================= */
function subscribeItems() {
  if (state.unsubscribe) state.unsubscribe();
  renderEmpty("Cargando registros...");
  state.unsubscribe = onSnapshot(
    itemsCol,
    (snapshot) => {
      state.items = snapshot.docs.map((d) => normalizeItem({ id: d.id, ...d.data() }));
      renderApp();
    },
    (err) => {
      console.error(err);
      showToast("No se pudieron cargar los datos", true);
      renderEmpty("No se pudieron cargar los datos. Revisa permisos o conexión.");
    }
  );
}

/* =========================
   ACTIONS FIRESTORE
========================= */
function authorFields() {
  const u = state.user || {};
  return {
    name: u.displayName || (u.email ? u.email.split("@")[0] : ""),
    email: (u.email || "").toLowerCase(),
  };
}

async function createItem(payload) {
  const author = authorFields();
  const ref = await addDoc(itemsCol, {
    tipo: payload.tipo || "necesidad",
    item: payload.item,
    categoria: payload.categoria || "",
    prioridad: payload.prioridad || "media",
    estado: "pendiente",
    precioEstimado: payload.precioEstimado || "",
    precioReal: "",
    lugarSugerido: payload.lugarSugerido || "",
    lugarCompra: "",
    anotadoPor: payload.anotadoPor || author.name,
    anotadoPorEmail: author.email,
    compradoPor: "",
    compradoPorEmail: "",
    fechaCompra: "",
    tags: payload.tags || "",
    notas: payload.notas || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

async function updateItemDoc(id, fields) {
  await updateDoc(doc(db, ...ITEMS_PATH, id), { ...fields, updatedAt: serverTimestamp() });
}

async function updateItem(payload) {
  const { id, ...fields } = payload;
  await updateItemDoc(id, fields);
}

async function markPurchased(payload) {
  const author = authorFields();
  const { id, ...fields } = payload;
  await updateItemDoc(id, {
    ...fields,
    estado: "comprado",
    compradoPor: fields.compradoPor || author.name,
    compradoPorEmail: author.email,
  });
}

async function discardItem(id) {
  await updateItemDoc(id, { estado: "descartado" });
}

async function restoreItem(id) {
  await updateItemDoc(id, { estado: "pendiente" });
}

/* =========================
   MODALS
========================= */
function openDialog(id) { document.getElementById(id)?.showModal?.(); }
function closeDialog(id) { const d = document.getElementById(id); if (d?.open) d.close(); }
function findItemById(id) { return state.items.find((x) => String(x.id) === String(id)) || null; }

function fillPurchaseDialog(item) {
  $("#purchaseId").value = item.id || "";
  $("#purchaseDialogItemName").textContent = item.item || "—";
  $("#purchasePrecioReal").value = item.precioReal || "";
  $("#purchaseLugarCompra").value = item.lugarCompra === "—" ? "" : item.lugarCompra || "";
  $("#purchaseCompradoPor").value = item.compradoPor === "—" ? "" : (item.compradoPor || authorFields().name);
  $("#purchaseFechaCompra").value = normalizeDateForInput(item.fechaCompra) || todayInputValue();
  $("#purchaseNotas").value = item.notas === "—" ? "" : item.notas || "";
}

function fillEditDialog(item) {
  $("#editId").value = item.id || "";
  $("#editDialogItemName").textContent = item.item || "—";
  $("#editItem").value = item.item || "";
  $("#editCategoria").value = item.categoria === "—" ? "" : item.categoria || "";
  $("#editTipo").value = item.tipo || "necesidad";
  $("#editPrioridad").value = item.prioridad || "media";
  $("#editEstado").value = item.estado || "pendiente";
  $("#editPrecioEstimado").value = item.precioEstimado || "";
  $("#editPrecioReal").value = item.precioReal || "";
  $("#editLugarSugerido").value = item.lugarSugerido === "—" ? "" : item.lugarSugerido || "";
  $("#editLugarCompra").value = item.lugarCompra === "—" ? "" : item.lugarCompra || "";
  $("#editAnotadoPor").value = item.anotadoPor === "—" ? "" : item.anotadoPor || "";
  $("#editCompradoPor").value = item.compradoPor === "—" ? "" : item.compradoPor || "";
  $("#editFechaCompra").value = normalizeDateForInput(item.fechaCompra);
  $("#editTags").value = item.tags === "—" ? "" : item.tags || "";
  $("#editNotas").value = item.notas === "—" ? "" : item.notas || "";
}

/* =========================
   FORM PAYLOADS
========================= */
function getCreatePayload() {
  return {
    tipo: $("#tipo").value || "necesidad",
    item: $("#item").value.trim(),
    categoria: $("#categoria").value.trim(),
    prioridad: $("#prioridad").value,
    precioEstimado: $("#precioEstimado").value.trim(),
    lugarSugerido: $("#lugarSugerido").value.trim(),
    anotadoPor: $("#anotadoPor")?.value.trim() || "",
    notas: $("#notas").value.trim(),
    tags: $("#tags").value.trim(),
  };
}

function getPurchasePayload() {
  return {
    id: $("#purchaseId").value,
    precioReal: $("#purchasePrecioReal").value.trim(),
    lugarCompra: $("#purchaseLugarCompra").value.trim(),
    compradoPor: $("#purchaseCompradoPor").value.trim(),
    fechaCompra: $("#purchaseFechaCompra").value,
    notas: $("#purchaseNotas").value.trim(),
  };
}

function getEditPayload() {
  return {
    id: $("#editId").value,
    tipo: $("#editTipo").value,
    item: $("#editItem").value.trim(),
    categoria: $("#editCategoria").value.trim(),
    prioridad: $("#editPrioridad").value,
    estado: $("#editEstado").value,
    precioEstimado: $("#editPrecioEstimado").value.trim(),
    precioReal: $("#editPrecioReal").value.trim(),
    lugarSugerido: $("#editLugarSugerido").value.trim(),
    lugarCompra: $("#editLugarCompra").value.trim(),
    anotadoPor: $("#editAnotadoPor").value.trim(),
    compradoPor: $("#editCompradoPor").value.trim(),
    fechaCompra: $("#editFechaCompra").value,
    tags: $("#editTags").value.trim(),
    notas: $("#editNotas").value.trim(),
  };
}

/* =========================
   EVENTS
========================= */
function bindTipoSegment() {
  $("#tipoSeg")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    $$(".seg-btn", $("#tipoSeg")).forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    const tipo = btn.dataset.tipo || "necesidad";
    $("#tipo").value = tipo;
    $("#formCreate").dataset.tipoIdea = tipo === "idea" ? "1" : "";
  });
}

function bindPriorityChips() {
  $("#prioridadChips")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".prio-chip");
    if (!btn) return;
    $$(".prio-chip", $("#prioridadChips")).forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    $("#prioridad").value = btn.dataset.prioridad || "media";
  });
}

function resetCreateForm() {
  $("#tipo").value = "necesidad";
  $("#formCreate").dataset.tipoIdea = "";
  $$(".seg-btn", $("#tipoSeg")).forEach((x, i) => x.classList.toggle("active", i === 0));
  $("#prioridad").value = "media";
  $$(".prio-chip", $("#prioridadChips")).forEach((x) =>
    x.classList.toggle("active", x.dataset.prioridad === "media")
  );
  const more = $("#moreDetails");
  if (more) more.open = false;
}

function bindCreateForm() {
  const form = $("#formCreate");
  if (!form) return;
  form.addEventListener("reset", () => {
    setTimeout(resetCreateForm, 0);
    updateDuplicateHint();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = getCreatePayload();
    if (!payload.item) {
      showToast("Escriban qué se necesita", true);
      $("#item")?.focus();
      return;
    }
    try {
      setLoading(true);
      await createItem(payload);
      form.reset();
      resetCreateForm();
      showToast("Registro guardado");
      $("#item")?.focus();
    } catch (err) {
      console.error(err);
      showToast(err.message || "No se pudo guardar", true);
    } finally {
      setLoading(false);
    }
  });
}

function bindPurchaseForm() {
  $("#formPurchase")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = getPurchasePayload();
    try {
      setLoading(true);
      await markPurchased(payload);
      removeFromCart(payload.id);
      closeDialog("purchaseDialog");
      showToast("Compra registrada correctamente");
    } catch (err) {
      console.error(err);
      showToast(err.message || "No se pudo marcar como comprado", true);
    } finally {
      setLoading(false);
    }
  });
}

function bindEditForm() {
  $("#formEdit")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = getEditPayload();
    if (!payload.item) {
      showToast("El nombre del requerimiento no puede quedar vacío", true);
      $("#editItem")?.focus();
      return;
    }
    try {
      setLoading(true);
      await updateItem(payload);
      if (payload.estado !== "pendiente") removeFromCart(payload.id);
      closeDialog("editDialog");
      showToast("Registro actualizado");
    } catch (err) {
      console.error(err);
      showToast(err.message || "No se pudo actualizar", true);
    } finally {
      setLoading(false);
    }
  });
}

function bindHelpButton() {
  $("#btnHelpGuide")?.addEventListener("click", () => openDialog("helpDialog"));
}

function applyPrioritySelectClass(select) {
  if (!select) return;
  select.classList.remove("priority-alta", "priority-media", "priority-baja");
  const value = String(select.value || "").toLowerCase();
  if (["alta", "media", "baja"].includes(value)) select.classList.add(`priority-${value}`);
}

function bindPrioritySelects() {
  ["#editPrioridad", "#filterPrioridad"].forEach((selector) => {
    const select = $(selector);
    if (!select) return;
    applyPrioritySelectClass(select);
    select.addEventListener("change", () => applyPrioritySelectClass(select));
  });
}

function bindFilters() {
  const debouncedSearch = debounce(() => {
    state.currentSearch = $("#searchInput")?.value.trim() || "";
    renderApp();
  }, 250);
  const debouncedCategory = debounce(() => {
    state.currentCategoria = $("#filterCategoria")?.value.trim() || "";
    renderApp();
  }, 250);

  $("#searchInput")?.addEventListener("input", debouncedSearch);
  $("#filterCategoria")?.addEventListener("input", debouncedCategory);
  $("#filterPrioridad")?.addEventListener("change", () => {
    state.currentPrioridad = $("#filterPrioridad").value;
    renderApp();
  });
  $("#sortBy")?.addEventListener("change", () => {
    state.currentSort = $("#sortBy").value;
    renderApp();
  });

  $("#estadoChips")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    $$(".chip", $("#estadoChips")).forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    state.currentEstado = btn.dataset.estado || "";
    renderApp();
  });

  $("#tipoChips")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    $$(".chip", $("#tipoChips")).forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    state.currentTipo = btn.dataset.tipo || "";
    renderApp();
  });
}

function bindCreateAssistants() {
  $("#item")?.addEventListener("input", () => updateDuplicateHint());
  $("#quickCategoryChips")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-category]");
    if (!btn) return;
    $("#categoria").value = btn.dataset.category || "";
    $("#categoria")?.focus();
  });
}

function bindCartActions() {
  $("#btnClearCart")?.addEventListener("click", () => {
    state.cart.clear();
    state.cartQuantities = {};
    renderApp();
    showToast("Carrito limpiado");
  });

  $("#btnCopyCart")?.addEventListener("click", async () => {
    const text = buildCartQuoteText();
    if (!text) { showToast("El carrito está vacío", true); return; }
    try {
      await navigator.clipboard.writeText(text);
      showToast("Lista copiada para cotizar");
    } catch (err) {
      console.error(err);
      showToast("No se pudo copiar la lista", true);
    }
  });

  $("#btnDownloadCart")?.addEventListener("click", () => downloadCartQuotePdf());

  $("#cartContainer")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const item = findItemById(id);
    if (!item) return;
    if (action === "buy") { fillPurchaseDialog(item); openDialog("purchaseDialog"); return; }
    if (action === "remove-cart") { removeFromCart(id); renderApp(); }
  });

  $("#cartContainer")?.addEventListener("input", (e) => {
    const input = e.target.closest('input[data-action="cart-quantity"]');
    if (!input) return;
    const id = String(input.dataset.id || "");
    const quantity = normalizeQuantityValue(input.value);
    if (quantity) state.cartQuantities[id] = quantity;
    else delete state.cartQuantities[id];
  });
}

function bindListActions() {
  $("#listContainer")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const item = findItemById(id);
    if (!id || !item) { showToast("No se encontró el registro seleccionado", true); return; }

    if (action === "buy") { fillPurchaseDialog(item); openDialog("purchaseDialog"); return; }
    if (action === "add-cart") { toggleCart(id, true); renderApp(); showToast("Agregado al carrito"); return; }
    if (action === "remove-cart") { toggleCart(id, false); renderApp(); showToast("Quitado del carrito"); return; }
    if (action === "edit") { fillEditDialog(item); openDialog("editDialog"); return; }

    if (action === "discard") {
      const ok = window.confirm(`¿Descartar el registro "${item.item}"?\n\nEsto no lo elimina, solo lo mueve a descartados.`);
      if (!ok) return;
      try {
        setLoading(true);
        await discardItem(id);
        removeFromCart(id);
        showToast("Registro descartado");
      } catch (err) {
        console.error(err);
        showToast(err.message || "No se pudo descartar", true);
      } finally { setLoading(false); }
      return;
    }

    if (action === "restore") {
      try {
        setLoading(true);
        await restoreItem(id);
        showToast("Registro restaurado");
      } catch (err) {
        console.error(err);
        showToast(err.message || "No se pudo restaurar", true);
      } finally { setLoading(false); }
    }
  });
}

function bindDialogCloseButtons() {
  $$("[data-close-dialog]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(btn.dataset.closeDialog));
  });
  $$("dialog").forEach((dlg) => {
    dlg.addEventListener("click", (e) => {
      const rect = dlg.getBoundingClientRect();
      const inDialog =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!inDialog && e.target === dlg) dlg.close();
    });
  });
}

/* =========================
   TEMA CLARO / OSCURO
========================= */
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  try { localStorage.setItem("compras-theme", theme); } catch (_) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0e1426" : "#3156d3");
}

function bindTheme() {
  let stored = "light";
  try { stored = localStorage.getItem("compras-theme") || "light"; } catch (_) {}
  applyTheme(stored);
  $("#btnTheme")?.addEventListener("click", () => {
    applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
  });
}

/* =========================
   AUTENTICACIÓN
========================= */
function renderUserChip(user) {
  const name = user.displayName || (user.email ? user.email.split("@")[0] : "Usuario");
  $("#userName").textContent = name;
  $("#userMail").textContent = user.email || "";
  const avatar = $("#userAvatar");
  if (user.photoURL) {
    avatar.innerHTML = `<img src="${escapeHtml(user.photoURL)}" alt="${escapeHtml(name)}" referrerpolicy="no-referrer" />`;
  } else {
    avatar.textContent = (name[0] || "·").toUpperCase();
  }
}

function showAuthError(message) {
  const el = $("#authError");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function bindAuth() {
  $("#btnGoogleLogin")?.addEventListener("click", async () => {
    $("#authError").hidden = true;
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error(err);
      if (err?.code !== "auth/popup-closed-by-user" && err?.code !== "auth/cancelled-popup-request") {
        showAuthError("No se pudo iniciar sesión. Intenta de nuevo.");
      }
    }
  });

  $("#btnLogout")?.addEventListener("click", async () => {
    try { await signOut(auth); } catch (err) { console.error(err); }
  });

  onAuthStateChanged(auth, (user) => {
    const email = (user?.email || "").toLowerCase();
    if (user && ALLOWED_EMAILS.includes(email)) {
      state.user = user;
      renderUserChip(user);
      $("#authGate").hidden = true;
      $("#app").hidden = false;
      subscribeItems();
    } else {
      state.user = null;
      if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
      state.items = [];
      $("#app").hidden = true;
      $("#authGate").hidden = false;
      if (user) {
        // Autenticado pero sin permiso: cerrar sesión y avisar.
        showAuthError("Este correo no tiene acceso. Usa una cuenta autorizada de Musicala.");
        signOut(auth).catch(() => {});
      }
    }
  });
}

/* =========================
   INIT
========================= */
function init() {
  if ($("#purchaseFechaCompra")) $("#purchaseFechaCompra").value = todayInputValue();

  bindTheme();
  bindAuth();
  bindTipoSegment();
  bindPriorityChips();
  bindCreateForm();
  bindPurchaseForm();
  bindEditForm();
  bindHelpButton();
  bindPrioritySelects();
  bindFilters();
  bindCreateAssistants();
  bindCartActions();
  bindListActions();
  bindDialogCloseButtons();
}

document.addEventListener("DOMContentLoaded", init);
