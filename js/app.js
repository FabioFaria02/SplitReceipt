import { splitSummary, receiptBreakdown, memoryKey, normalizeReceipt, parseAmount, round2 } from "./calc.js";
import { callGemini, CATEGORIES } from "./ai.js";
import { fetchRate, CURRENCIES, currencySymbol } from "./rates.js";
import { KEYS, load, save, saveImages, getImages, deleteImages, pruneImages } from "./storage.js";
import { encodeShare, decodeShare, compactSplit } from "./share.js";

/* =========================================================
   Constantes
   ========================================================= */
const PALETTE = ["#5B7CFA", "#10B981", "#EC4899", "#8B5CF6", "#F59E0B", "#06B6D4", "#EF4444", "#84CC16", "#F97316", "#64748B"];
const DEFAULT_PEOPLE = [
  { id: "p_fabio", name: "Fábio", color: "#5B7CFA" },
  { id: "p_filipa", name: "Filipa", color: "#10B981" },
  { id: "p_ines", name: "Inês", color: "#EC4899" },
  { id: "p_laura", name: "Laura", color: "#8B5CF6" },
];
const CATEGORY = {
  fruta_legumes: ["Fruta e legumes", "🥦"], carne_peixe: ["Carne e peixe", "🥩"], laticinios_ovos: ["Laticínios e ovos", "🧀"],
  padaria: ["Padaria", "🥖"], mercearia: ["Mercearia", "🥫"], congelados: ["Congelados", "🧊"], bebidas: ["Bebidas", "🧃"],
  alcool: ["Álcool", "🍺"], doces_snacks: ["Doces e snacks", "🍫"], higiene: ["Higiene", "🧴"], casa_limpeza: ["Casa e limpeza", "🧽"],
  refeicao_pronta: ["Refeição pronta", "🥪"], restaurante: ["Restaurante", "🍽️"], taxas_sacos: ["Sacos e taxas", "🛍️"], outros: ["Outros", "🛒"],
};
const STORE_COLORS = {
  lidl: "#0050AA", billa: "#E2001A", tesco: "#00539F", albert: "#0096D6", penny: "#CD1719", kaufland: "#E10915",
  globus: "#E30613", rohlik: "#71B32D", biedronka: "#E2001A", zabka: "#00843D", spar: "#007F3D", aldi: "#00205B",
  continente: "#E30613", "pingo doce": "#6BA539", dm: "#002878", rossmann: "#C3002F", ikea: "#0058A3", auchan: "#E2001A", carrefour: "#004E9F",
};
const API_ENDPOINT = "/api/parse-receipt";
const MAX_PARALLEL = 2;

/* =========================================================
   Estado
   ========================================================= */
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

let people = load(KEYS.people, null) || DEFAULT_PEOPLE.map(p => ({ ...p }));
let settings = {
  theme: "auto", meId: "p_fabio", autoAssign: true, newItemsAll: false, revolutUser: "", geminiKey: "",
  ...load(KEYS.settings, {}),
};
let splits = load(KEYS.splits, []);
let memory = load(KEYS.memory, {});
let split = splits.find(s => s.id === load(KEYS.current, null)) || splits[0] || newSplit();

const ui = {
  brushOn: false,
  brush: [],
  jobs: [],
  openOwe: new Set(),
  readonly: false,
  backup: null, // estado guardado enquanto se vê um link partilhado
  sharedPayload: null,
};

function newSplit(name) {
  const d = new Date();
  return {
    id: uid(),
    name: name || `Compras ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
    createdAt: d.toISOString(),
    updatedAt: d.toISOString(),
    participants: people.map(p => p.id),
    receipts: [],
    settled: {},
  };
}

function persist() {
  if (ui.readonly) return;
  split.updatedAt = new Date().toISOString();
  const i = splits.findIndex(s => s.id === split.id);
  if (i >= 0) splits[i] = split; else splits.unshift(split);
  splits = splits.filter(s => s.receipts.length || s.id === split.id).slice(0, 80);
  if (!save(KEYS.splits, splits)) toast("O armazenamento local está cheio. Apaga divisões antigas no histórico.", "error");
  save(KEYS.current, split.id);
  save(KEYS.people, people);
  save(KEYS.settings, settings);
  save(KEYS.memory, memory);
}

/* =========================================================
   Utilitários
   ========================================================= */
const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtCache = new Map();
function fmtMoney(n, cur = "EUR") {
  if (!fmtCache.has(cur)) {
    try {
      fmtCache.set(cur, new Intl.NumberFormat("pt-PT", { style: "currency", currency: cur, currencyDisplay: "narrowSymbol" }));
    } catch {
      fmtCache.set(cur, { format: x => `${x.toFixed(2)} ${cur}` });
    }
  }
  const v = Math.abs(Number(n) || 0) < 0.005 ? 0 : Number(n) || 0;
  return fmtCache.get(cur).format(v);
}
const eur = n => fmtMoney(n, "EUR");
const fmtNum = (n, d = 2) => new Intl.NumberFormat("pt-PT", { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(n) || 0);
const plainAmount = n => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",");
function fmtDate(iso, opts = { weekday: "short", day: "numeric", month: "short" }) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("pt-PT", opts);
}
const shortDate = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");
const initials = name => String(name || "?").trim().split(/\s+/).slice(0, 2).map(x => x[0]).join("").toUpperCase() || "?";
const person = id => people.find(p => p.id === id) || { id, name: "?", color: "#888" };
const participants = () => split.participants.map(person).filter(p => p.name !== "?");
const avatar = (p, cls = "") => `<span class="av ${cls}" style="--c:${p.color}">${esc(initials(p.name))}</span>`;
const isMe = id => id === settings.meId;
const nameOf = id => person(id).name;

function storeColor(store) {
  const s = String(store || "").toLowerCase();
  for (const [k, c] of Object.entries(STORE_COLORS)) if (s.includes(k)) return c;
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 48%)`;
}
function itemEmoji(it) {
  return it.emoji || CATEGORY[it.category]?.[1] || "🛒";
}

async function copy(text, msg = "Copiado!") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(msg);
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* =========================================================
   Toasts, modais e "anular"
   ========================================================= */
function toast(message, type = "good", action = null) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icon = { good: "circle-check", warn: "triangle-exclamation", error: "circle-xmark" }[type] || "circle-info";
  el.innerHTML = `<i class="ti fa-solid fa-${icon}"></i><div class="tx">${esc(message)}</div>${action ? `<button class="btn sm">${esc(action.label)}</button>` : ""}`;
  if (action) el.querySelector("button").onclick = () => { action.run(); el.remove(); };
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s, transform .25s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 260);
  }, action ? 6000 : type === "error" ? 6000 : 2800);
}

function withUndo(message, fn) {
  const snapshot = JSON.stringify(split);
  fn();
  persist();
  render();
  toast(message, "good", {
    label: "Anular",
    run: () => {
      split = JSON.parse(snapshot);
      persist();
      render();
    },
  });
}

function openModal({ title, sub = "", body = "", foot = "", wide = false, onMount }) {
  closeModal();
  const wrap = document.createElement("div");
  wrap.className = "modal-wrap";
  wrap.innerHTML = `<div class="modal glass ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><div><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}</div>
    <button class="icon-btn sm" data-close aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}</div>`;
  wrap.addEventListener("click", e => {
    if (e.target === wrap || e.target.closest("[data-close]")) closeModal();
  });
  $("#modalRoot").appendChild(wrap);
  document.body.style.overflow = "hidden";
  onMount?.(wrap);
  const first = wrap.querySelector("input:not([type=checkbox]):not([type=hidden]), select, textarea");
  if (first && matchMedia("(pointer:fine)").matches) first.focus();
  return wrap;
}
function closeModal() {
  $("#modalRoot").innerHTML = "";
  document.body.style.overflow = "";
}
function confirmModal(title, text, okLabel = "Confirmar", danger = true) {
  return new Promise(resolve => {
    openModal({
      title, sub: text,
      foot: `<button class="btn ghost" data-close>Cancelar</button><button class="btn ${danger ? "danger" : "primary"}" id="okBtn">${esc(okLabel)}</button>`,
      onMount: m => {
        m.querySelector("#okBtn").onclick = () => { closeModal(); resolve(true); };
        m.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => resolve(false)));
      },
    });
  });
}

/* =========================================================
   Render
   ========================================================= */
let S = null; // resumo atual

function render() {
  S = splitSummary(split);
  document.body.classList.toggle("readonly", ui.readonly);
  document.body.classList.toggle("brushing", ui.brushOn);
  $("#splitName").textContent = split.name;
  $("#sharedBanner").classList.toggle("hidden", !ui.readonly);
  $("#themeBtn").innerHTML = `<i class="fa-solid fa-${document.documentElement.dataset.theme === "dark" ? "sun" : "moon"}"></i>`;
  renderHero();
  renderDropzone();
  renderBrushBar();
  renderReceipts();
  renderPeople();
  renderSummary();
  renderTransfers();
  renderShare();
  $("#bbBrush").classList.toggle("on", ui.brushOn);
}

function renderHero() {
  const hero = $("#hero");
  if (!split.receipts.length) { hero.classList.add("hidden"); return; }
  hero.classList.remove("hidden");
  const byCur = {};
  split.receipts.forEach(r => { byCur[r.currency] = (byCur[r.currency] || 0) + S.byReceipt[r.id].computedTotal; });
  const originals = Object.entries(byCur).filter(([c]) => c !== "EUR").map(([c, v]) => fmtMoney(v, c));
  const pct = S.total > 0 ? Math.round(((S.total - S.unassigned) / S.total) * 100) : 0;
  const dates = split.receipts.map(r => r.date).filter(Boolean).sort();
  const range = dates.length ? (dates[0] === dates.at(-1) ? fmtDate(dates[0]) : `${shortDate(dates[0])} – ${shortDate(dates.at(-1))}`) : "";
  hero.innerHTML = `
    <div class="hero-top">
      <div>
        <div class="eyebrow">Total da divisão</div>
        <div class="hero-amount num">${eur(S.total)}</div>
        <div class="hero-sub">${originals.length ? `<span>${originals.join(" + ")}</span>` : ""}${range ? `<span><i class="fa-regular fa-calendar"></i> ${esc(range)}</span>` : ""}</div>
      </div>
      <div class="hero-stats">
        <span class="chip"><i class="fa-solid fa-receipt"></i>${split.receipts.length} ${split.receipts.length === 1 ? "recibo" : "recibos"}</span>
        <span class="chip"><i class="fa-solid fa-basket-shopping"></i>${S.items} artigos</span>
        ${S.unassigned > 0.004 ? `<span class="chip warn"><i class="fa-solid fa-hourglass-half"></i>${eur(S.unassigned)} por atribuir</span>` : `<span class="chip good"><i class="fa-solid fa-check"></i>Tudo atribuído</span>`}
      </div>
    </div>
    <div class="progress">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-label"><span>${pct}% atribuído</span><span>${S.assignedItems}/${S.items} artigos</span></div>
    </div>
    <div class="hero-people">${participants().map(p => `<div class="hp">${avatar(p)}<span>${esc(p.name)}</span><strong>${eur(S.consumed[p.id] || 0)}</strong></div>`).join("")}</div>`;
}

function renderDropzone() {
  const empty = !split.receipts.length && !ui.jobs.length;
  const dz = $("#dropzone");
  dz.classList.toggle("big", empty);
  dz.querySelector(".dz-text").innerHTML = empty
    ? `<strong>Pronto para dividir?</strong><span>Fotografa ou carrega um ou vários recibos (imagem ou PDF). A IA lê cada artigo, traduz para português e converte para euros.</span>`
    : `<strong>Adicionar mais recibos</strong><span>Arrasta, cola (Ctrl+V) ou escolhe ficheiros · imagens ou PDF</span>`;
}

function renderBrushBar() {
  const bar = $("#brushBar");
  if (!ui.brushOn || !split.receipts.length) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const all = ui.brush.length === split.participants.length;
  bar.innerHTML = `
    <div class="label"><i class="fa-solid fa-paintbrush"></i>Pincel</div>
    <div class="pills">
      <button class="pill all ${all ? "on" : ""}" data-act="brush-all">Todos</button>
      ${participants().map(p => `<button class="pill ${ui.brush.includes(p.id) ? "on" : ""}" style="--c:${p.color}" data-act="brush-person" data-p="${p.id}">${avatar(p)}${esc(p.name)}</button>`).join("")}
    </div>
    <button class="btn sm ghost" data-act="brush-off"><i class="fa-solid fa-xmark"></i> Fechar</button>
    <div class="brush-hint">Escolhe as pessoas e toca nos artigos para lhes aplicar esta divisão${ui.brush.length ? "" : " (sem ninguém = limpar)"}.</div>`;
}

function renderReceipts() {
  const jobs = ui.jobs.map(j => `
    <div class="loading glass ${j.error ? "err" : ""}">
      <div class="spinner">${j.error ? `<i class="fa-solid fa-xmark" style="color:var(--bad)"></i>` : ""}</div>
      <div class="grow"><strong>${esc(j.label)}</strong><span>${esc(j.error || j.status)}</span>${j.error ? "" : `<div class="shimmer"></div>`}</div>
      ${j.error ? `<button class="btn sm" data-act="job-retry" data-j="${j.id}"><i class="fa-solid fa-rotate-right"></i> Tentar de novo</button><button class="icon-btn sm" data-act="job-remove" data-j="${j.id}" aria-label="Remover"><i class="fa-solid fa-xmark"></i></button>` : ""}
    </div>`).join("");
  $("#receipts").innerHTML = jobs + split.receipts.map(renderReceipt).join("");
}

function renderReceipt(r) {
  const b = S.byReceipt[r.id];
  const cur = r.currency;
  const parts = participants();
  const unassigned = r.items.filter(it => !Object.keys(b.perItem[it.id].weights).length).length;
  const suggested = r.items.filter(it => it.suggested).length;
  const rateLabel = cur === "EUR" ? "" : r.eurCharged > 0
    ? `Taxa real · 1 € = ${fmtNum(1 / b.factor, 2)} ${currencySymbol(cur)}`
    : r.rate ? `1 € = ${fmtNum(1 / r.rate, cur === "HUF" ? 1 : 3)} ${currencySymbol(cur)}${r.rateSource === "bce" ? " · BCE" : r.rateSource === "manual" ? " · manual" : r.rateSource === "aproximada" ? " · aprox." : ""}${r.rateDate ? ` ${shortDate(r.rateDate)}` : ""}`
      : "Sem taxa de câmbio";
  const mismatch = b.printedTotal != null && Math.abs(b.mismatch) >= 0.01;
  const warnings = [...(r.warnings || [])];
  const meta = [r.date ? fmtDate(r.date) : "", r.time, r.location].filter(Boolean).map(esc).join(" · ");

  return `<article class="receipt glass ${r.collapsed ? "collapsed" : ""}" data-r="${r.id}">
    <div class="r-head">
      <div class="r-logo" style="background:${storeColor(r.store)}">${esc(initials(r.store).slice(0, 2))}</div>
      <div class="r-title"><h3>${esc(r.store)}</h3><div class="meta">${meta || "Sem data"}</div></div>
      <div class="r-total"><strong>${eur(b.eurTotal)}</strong>${cur !== "EUR" ? `<span>${fmtMoney(b.computedTotal, cur)}</span>` : ""}</div>
    </div>
    <div class="r-bar">
      <label class="payer"><i class="fa-solid fa-credit-card"></i> Pagou
        <select data-payer="${r.id}" aria-label="Quem pagou">${parts.map(p => `<option value="${p.id}" ${p.id === r.payerId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      </label>
      ${cur !== "EUR" ? `<button class="chip ${r.rate || r.eurCharged ? "" : "bad"}" data-act="r-edit" data-r="${r.id}" title="Alterar taxa de câmbio"><i class="fa-solid fa-arrow-right-arrow-left"></i>${esc(rateLabel)}</button>` : ""}
      ${b.printedTotal != null ? (mismatch ? `<span class="chip warn" title="A soma dos artigos não bate com o total impresso"><i class="fa-solid fa-triangle-exclamation"></i>Diferença ${fmtMoney(b.mismatch, cur)}</span>` : `<span class="chip good" title="A soma dos artigos bate com o total do recibo"><i class="fa-solid fa-check-double"></i>Total confere</span>`) : ""}
      ${unassigned ? `<span class="chip warn"><i class="fa-solid fa-user-clock"></i>${unassigned} por atribuir</span>` : ""}
      <span class="spacer"></span>
      ${r.hasImage ? `<button class="icon-btn sm" data-act="r-image" data-r="${r.id}" title="Ver recibo original" aria-label="Ver recibo original"><i class="fa-regular fa-image"></i></button>` : ""}
      <button class="icon-btn sm edit-only" data-act="r-discounts" data-r="${r.id}" title="Descontos e cupões" aria-label="Descontos"><i class="fa-solid fa-tags"></i></button>
      <button class="icon-btn sm edit-only" data-act="r-edit" data-r="${r.id}" title="Editar recibo" aria-label="Editar recibo"><i class="fa-solid fa-pen"></i></button>
      <button class="icon-btn sm edit-only" data-act="r-delete" data-r="${r.id}" title="Apagar recibo" aria-label="Apagar recibo"><i class="fa-regular fa-trash-can"></i></button>
      <button class="icon-btn sm collapse-btn" data-act="r-collapse" data-r="${r.id}" title="Encolher" aria-label="Encolher"><i class="fa-solid fa-chevron-down"></i></button>
    </div>
    ${mismatch ? `<div class="r-warn"><i class="fa-solid fa-circle-exclamation"></i><div>A soma dos artigos (${fmtMoney(b.computedTotal, cur)}) difere do total impresso (${fmtMoney(b.printedTotal, cur)}). Confirma os preços com a imagem do recibo${b.mismatch < 0 ? " ou adiciona a diferença como desconto" : " ou adiciona um acerto"}.</div><button class="btn sm edit-only" data-act="r-fix" data-r="${r.id}">${b.mismatch < 0 ? "Adicionar desconto" : "Adicionar acerto"}</button></div>` : ""}
    ${warnings.length ? `<div class="r-warn"><i class="fa-solid fa-robot"></i><div>${warnings.map(esc).join("<br>")}</div><button class="btn sm ghost" data-act="r-dismiss" data-r="${r.id}" aria-label="Dispensar"><i class="fa-solid fa-xmark"></i></button></div>` : ""}
    ${r.discounts.length || (r.lineDiscountMode === "spread" && r.items.some(i => i.discount > 0)) ? `<div class="r-discounts">
      ${r.discounts.map(d => `<button class="chip accent" data-act="r-discounts" data-r="${r.id}"><i class="fa-solid fa-ticket"></i>${esc(d.translated || d.label)} −${fmtMoney(d.amount, cur)} · ${d.target === "items" && d.itemIds?.length ? `${d.itemIds.length} artigos` : "proporcional"}</button>`).join("")}
      ${r.lineDiscountMode === "spread" ? `<button class="chip accent" data-act="r-discounts" data-r="${r.id}"><i class="fa-solid fa-percent"></i>Descontos dos artigos espalhados por todos</button>` : ""}
    </div>` : ""}
    <div class="r-items">${r.items.map(it => renderItem(r, it, b.perItem[it.id], parts)).join("") || `<div class="empty-mini">Sem artigos. Adiciona manualmente.</div>`}</div>
    <div class="r-foot edit-only">
      <button class="btn sm" data-act="r-all" data-r="${r.id}"><i class="fa-solid fa-users"></i> Tudo para todos</button>
      ${unassigned ? `<button class="btn sm" data-act="r-rest" data-r="${r.id}"><i class="fa-solid fa-user-plus"></i> Restantes para todos</button>` : ""}
      ${suggested ? `<button class="btn sm" data-act="r-accept" data-r="${r.id}"><i class="fa-solid fa-wand-magic-sparkles"></i> Confirmar ${suggested} sugestões</button>` : ""}
      <button class="btn sm" data-act="r-clear" data-r="${r.id}"><i class="fa-solid fa-eraser"></i> Limpar</button>
      <button class="btn sm ghost" data-act="item-add" data-r="${r.id}"><i class="fa-solid fa-plus"></i> Artigo</button>
    </div>
  </article>`;
}

function renderItem(r, it, info, parts) {
  const cur = r.currency;
  const assigned = Object.keys(info.weights);
  const allOn = parts.length > 0 && parts.every(p => info.weights[p.id] > 0);
  const tags = [];
  if (it.quantity && it.quantity !== 1) {
    const q = it.unit === "kg" || it.unit === "l" ? `${fmtNum(it.quantity, 3)} ${it.unit}` : `${fmtNum(it.quantity, 0)} un`;
    tags.push(`<span class="tag">${q}${it.unitPrice ? ` × ${fmtMoney(it.unitPrice, cur)}` : ""}</span>`);
  }
  if (it.discount > 0) tags.push(`<span class="tag disc"><i class="fa-solid fa-tag"></i>−${fmtMoney(it.discount, cur)}${it.discountLabel ? ` · ${esc(it.discountLabel)}` : ""}${r.lineDiscountMode === "spread" ? " (espalhado)" : ""}</span>`);
  if (info.discountShare > 0.004 && r.discounts.length) tags.push(`<span class="tag disc"><i class="fa-solid fa-ticket"></i>cupão −${fmtMoney(info.discountShare, cur)}</span>`);
  if (it.suggested) tags.push(`<span class="tag ai"><i class="fa-solid fa-wand-magic-sparkles"></i>sugestão da memória</span>`);
  const sameName = memoryKey(it.original) === memoryKey(it.translated);
  const weightsEqual = new Set(Object.values(info.weights)).size <= 1;
  const each = assigned.length > 1 && weightsEqual ? `<span class="tiny muted num each">${eur(info.eur / assigned.length)} cada</span>` : "";

  return `<div class="item ${assigned.length ? "" : "unassigned"} ${it.suggested ? "suggested" : ""}" data-r="${r.id}" data-i="${it.id}">
    <div class="item-main">
      <div class="emoji">${esc(itemEmoji(it))}</div>
      <div class="item-open" data-act="item-edit" title="Editar artigo">
        <div class="item-name">${esc(it.translated || it.original || "Artigo")}</div>
        ${it.original && !sameName ? `<div class="item-orig">${esc(it.original)}</div>` : ""}
        ${tags.length ? `<div class="item-tags">${tags.join("")}</div>` : ""}
      </div>
      <div class="item-price">
        <strong>${eur(info.eur)}</strong>
        ${cur !== "EUR" ? `<span>${it.discount > 0 && r.lineDiscountMode !== "spread" ? `<s>${fmtMoney(it.basePrice, cur)}</s> ` : ""}${fmtMoney(info.effective, cur)}</span>` : it.discount > 0 && r.lineDiscountMode !== "spread" ? `<span><s>${eur(it.basePrice)}</s></span>` : ""}
      </div>
    </div>
    <div class="item-people">
      <button class="pill all mini ${allOn ? "on" : ""}" data-act="item-all">Todos</button>
      ${parts.map(p => {
        const w = info.weights[p.id];
        return `<button class="pill mini ${w ? "on" : ""}" style="--c:${p.color}" data-act="item-person" data-p="${p.id}" aria-pressed="${!!w}">${avatar(p)}${esc(p.name)}${w && w !== 1 ? `<span class="w">×${fmtNum(w, w % 1 ? 1 : 0)}</span>` : ""}</button>`;
      }).join("")}
      <button class="icon-btn sm edit-only" data-act="item-edit" title="Editar artigo / partes diferentes" aria-label="Editar artigo"><i class="fa-solid fa-sliders"></i></button>
      ${each}
    </div>
  </div>`;
}

function renderPeople() {
  const set = new Set(split.participants);
  $("#peoplePanel").innerHTML = `
    <div class="panel-head"><h3><i class="fa-solid fa-user-group"></i>Pessoas</h3><span class="sub">${set.size} nesta divisão</span></div>
    ${people.map(p => `<div class="person-row ${set.has(p.id) ? "" : "off"}">
      ${avatar(p)}
      <div class="name">${esc(p.name)}${isMe(p.id) ? "<small>(eu)</small>" : ""}</div>
      <button class="icon-btn sm edit-only" data-act="person-edit" data-p="${p.id}" aria-label="Editar ${esc(p.name)}"><i class="fa-solid fa-pen"></i></button>
      <button class="toggle ${set.has(p.id) ? "on" : ""} edit-only" data-act="person-toggle" data-p="${p.id}" aria-label="Participa nesta divisão" aria-pressed="${set.has(p.id)}"></button>
    </div>`).join("")}
    <form class="add-row edit-only" id="addPersonForm">
      <input class="input" id="newPerson" placeholder="Adicionar pessoa…" maxlength="24" autocomplete="off">
      <button class="icon-btn" type="submit" aria-label="Adicionar"><i class="fa-solid fa-plus"></i></button>
    </form>`;
}

function renderSummary() {
  const parts = participants();
  const panel = $("#summaryPanel");
  if (!split.receipts.length) {
    panel.innerHTML = `<div class="panel-head"><h3><i class="fa-solid fa-scale-balanced"></i>Parte de cada um</h3></div><div class="empty-mini">Adiciona um recibo para veres quanto gastou cada pessoa.</div>`;
    return;
  }
  panel.innerHTML = `<div class="panel-head"><h3><i class="fa-solid fa-scale-balanced"></i>Parte de cada um</h3><span class="sub">para a despesa no Revolut</span></div>
    ${parts.map(p => {
      const consumed = S.consumed[p.id] || 0;
      const net = S.net[p.id] || 0;
      const paid = S.paid[p.id] || 0;
      const open = ui.openOwe.has(p.id);
      const status = Math.abs(net) < 0.005 ? `<span class="muted">quites</span>` : net > 0 ? `<span class="pos">recebe ${eur(net)}</span>` : `<span class="neg">deve ${eur(-net)}</span>`;
      return `<div class="owe ${open ? "open" : ""}">
        <button class="owe-head" data-act="owe-toggle" data-p="${p.id}">
          ${avatar(p, "lg")}
          <div class="who"><strong>${esc(p.name)}</strong><span>${paid > 0.004 ? `pagou ${eur(paid)} · ` : ""}${status}</span></div>
          <div class="amt"><strong>${eur(consumed)}</strong></div>
          <i class="fa-solid fa-chevron-down chev"></i>
        </button>
        <div class="owe-body">${personBreakdownHtml(p.id)}
          <div style="display:flex;gap:6px;margin-top:10px">
            <button class="btn sm" data-act="copy-amount" data-v="${consumed}"><i class="fa-regular fa-copy"></i> ${plainAmount(consumed)}</button>
            <button class="btn sm" data-act="person-message" data-p="${p.id}"><i class="fa-regular fa-message"></i> Mensagem</button>
          </div>
        </div>
      </div>`;
    }).join("")}
    ${S.unassigned > 0.004 ? `<div class="note"><i class="fa-solid fa-circle-info"></i> Ainda há ${eur(S.unassigned)} por atribuir — por agora contam como de quem pagou.</div>` : ""}`;
}

function personBreakdownHtml(pid) {
  let html = "";
  for (const r of split.receipts) {
    const b = S.byReceipt[r.id];
    const lines = r.items.filter(it => b.perItem[it.id].people[pid] != null);
    if (!lines.length) continue;
    html += `<div class="owe-store">${esc(r.store)} ${r.date ? `· ${shortDate(r.date)}` : ""} <span class="muted">${eur(b.perPerson[pid] || 0)}</span></div>`;
    html += lines.map(it => {
      const info = b.perItem[it.id];
      const frac = info.weights[pid] / info.sumW;
      const label = frac >= 0.999 ? "" : ` <span class="muted">(${fractionLabel(info.weights[pid], info.sumW)})</span>`;
      return `<div class="owe-line"><span>${esc(itemEmoji(it))} ${esc(it.translated || it.original)}${label}</span><b>${eur(info.people[pid])}</b></div>`;
    }).join("");
  }
  return html || `<div class="empty-mini">Nada atribuído ainda.</div>`;
}

function fractionLabel(w, total) {
  if (Number.isInteger(w) && Number.isInteger(total)) return w === 1 ? `1/${total}` : `${w}/${total}`;
  return `${Math.round((w / total) * 100)}%`;
}

function transferKey(t) { return `${t.from}>${t.to}>${Math.round(t.amount * 100)}`; }

function renderTransfers() {
  const panel = $("#transfersPanel");
  if (!split.receipts.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  const t = S.transfers;
  panel.innerHTML = `<div class="panel-head"><h3><i class="fa-solid fa-right-left"></i>Acertos</h3><span class="sub">${t.length ? `${t.length} ${t.length === 1 ? "transferência" : "transferências"}` : ""}</span></div>
    ${t.length ? t.map(x => {
      const from = person(x.from), to = person(x.to);
      const done = !!split.settled?.[transferKey(x)];
      return `<div class="transfer ${done ? "done" : ""}">
        <button class="check ${done ? "on" : ""} edit-only" data-act="transfer-done" data-k="${esc(transferKey(x))}" aria-label="Marcar como pago"><i class="fa-solid fa-check"></i></button>
        ${avatar(from)}<i class="fa-solid fa-arrow-right arrow"></i>${avatar(to)}
        <div class="t-names"><strong>${esc(from.name)}</strong> paga a <strong>${esc(to.name)}</strong></div>
        <button class="t-amt" data-act="copy-amount" data-v="${x.amount}" title="Copiar valor">${eur(x.amount)}</button>
      </div>`;
    }).join("") : `<div class="empty-mini"><i class="fa-solid fa-champagne-glasses"></i> Ninguém deve nada a ninguém.</div>`}
    <div class="note">Escolhe quem pagou cada recibo; os acertos já compensam recibos pagos por pessoas diferentes.</div>`;
}

function renderShare() {
  const panel = $("#sharePanel");
  if (!split.receipts.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="panel-head"><h3><i class="fa-solid fa-share-nodes"></i>Partilhar</h3></div>
    <div class="share-grid">
      <button class="btn" data-act="share-text"><i class="fa-regular fa-copy"></i>Copiar resumo</button>
      <button class="btn" data-act="share-native"><i class="fa-brands fa-whatsapp"></i>Enviar</button>
      <button class="btn" data-act="share-link"><i class="fa-solid fa-link"></i>Link</button>
      <button class="btn" data-act="share-people"><i class="fa-regular fa-message"></i>Por pessoa</button>
      <button class="btn ghost" data-act="export-csv"><i class="fa-solid fa-file-csv"></i>CSV</button>
      <button class="btn ghost" data-act="export-json"><i class="fa-solid fa-file-export"></i>Backup</button>
    </div>`;
}

/* =========================================================
   Textos de partilha
   ========================================================= */
function summaryText() {
  const lines = [`🧾 ${split.name}`];
  for (const r of split.receipts) {
    const b = S.byReceipt[r.id];
    lines.push(`• ${r.store}${r.date ? ` ${shortDate(r.date)}` : ""}: ${r.currency !== "EUR" ? `${fmtMoney(b.computedTotal, r.currency)} = ` : ""}${eur(b.eurTotal)} (pagou ${nameOf(r.payerId)})`);
  }
  lines.push("", `💶 Total: ${eur(S.total)}`);
  for (const p of participants()) lines.push(`${p.name}: ${eur(S.consumed[p.id] || 0)}`);
  if (S.transfers.length) {
    lines.push("", "↪️ Acertos:");
    for (const t of S.transfers) lines.push(`${nameOf(t.from)} → ${nameOf(t.to)}: ${eur(t.amount)}${split.settled?.[transferKey(t)] ? " ✅" : ""}`);
  }
  if (S.unassigned > 0.004) lines.push("", `⚠️ ${eur(S.unassigned)} ainda por atribuir`);
  return lines.join("\n");
}

function personText(pid) {
  const p = person(pid);
  const lines = [`Olá ${p.name}! 🧾 ${split.name}`];
  for (const r of split.receipts) {
    const b = S.byReceipt[r.id];
    const its = r.items.filter(it => b.perItem[it.id].people[pid] != null);
    if (!its.length) continue;
    lines.push("", `${r.store}${r.date ? ` (${shortDate(r.date)})` : ""}:`);
    for (const it of its) {
      const info = b.perItem[it.id];
      const frac = info.weights[pid] / info.sumW;
      lines.push(`• ${it.translated || it.original}${frac < 0.999 ? ` (${fractionLabel(info.weights[pid], info.sumW)})` : ""} — ${eur(info.people[pid])}`);
    }
  }
  lines.push("", `A tua parte: ${eur(S.consumed[pid] || 0)}`);
  const owes = S.transfers.filter(t => t.from === pid);
  for (const t of owes) lines.push(`👉 Pagas ${eur(t.amount)} a ${nameOf(t.to)}`);
  const gets = S.transfers.filter(t => t.to === pid);
  for (const t of gets) lines.push(`👈 Recebes ${eur(t.amount)} de ${nameOf(t.from)}`);
  if (owes.length && settings.revolutUser && owes.some(t => isMe(t.to))) lines.push(`Revolut: https://revolut.me/${settings.revolutUser.replace(/^@/, "")}`);
  return lines.join("\n");
}

function csvExport() {
  const parts = participants();
  const rows = [["Recibo", "Data", "Pagou", "Artigo (original)", "Artigo (PT)", "Moeda", "Preço original", "Valor efetivo", "Valor EUR", ...parts.map(p => p.name)]];
  for (const r of split.receipts) {
    const b = S.byReceipt[r.id];
    for (const it of r.items) {
      const info = b.perItem[it.id];
      rows.push([r.store, r.date, nameOf(r.payerId), it.original, it.translated, r.currency, it.price, round2(info.effective), round2(info.eur), ...parts.map(p => round2(info.people[p.id] || 0))]);
    }
  }
  rows.push([]);
  rows.push(["TOTAL", "", "", "", "", "", "", "", S.total, ...parts.map(p => S.consumed[p.id] || 0)]);
  return rows.map(r => r.map(v => {
    const s = typeof v === "number" ? String(v).replace(".", ",") : String(v ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(";")).join("\n");
}

/* =========================================================
   Importação de recibos
   ========================================================= */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Não foi possível ler o ficheiro."));
    fr.readAsDataURL(file);
  });
}

async function prepareFile(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    if (file.size > 4.2 * 1024 * 1024) throw new Error("PDF demasiado grande (máx. ~4 MB).");
    const url = await readAsDataURL(file);
    return { mimeType: "application/pdf", data: url.split(",")[1] };
  }
  const url = await readAsDataURL(file);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Formato de imagem não suportado (experimenta JPG/PNG)."));
    i.src = url;
  });
  // Recibos são longos: limita o lado maior mantendo o texto legível.
  const maxSide = 2400, maxWidth = 1500;
  let scale = Math.min(1, maxSide / Math.max(img.width, img.height), maxWidth / img.width);
  if (img.height / img.width > 3.5) scale = Math.min(1, 3600 / img.height, 1100 / img.width);
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { mimeType: "image/jpeg", data: c.toDataURL("image/jpeg", 0.86).split(",")[1] };
}

async function parseWithAI(files) {
  let backendError = "";
  try {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json().catch(() => null) : null;
    if (res.ok && data?.receipt) return data.receipt;
    backendError = data?.error || (res.status === 404 ? "O servidor de IA não está disponível neste endereço." : `Servidor respondeu HTTP ${res.status}.`);
    if (res.status === 413) backendError = "Ficheiro demasiado grande para o servidor.";
  } catch (err) {
    backendError = "Sem ligação ao servidor de IA.";
  }
  if (settings.geminiKey) {
    const { receipt } = await callGemini({ apiKey: settings.geminiKey, files });
    return receipt;
  }
  throw new Error(`${backendError} Configura GEMINI_API_KEY no Netlify ou uma chave pessoal nas Definições.`);
}

function enqueue(files, { sameReceipt = false } = {}) {
  if (ui.readonly) return;
  const list = [...files].filter(f => /^image\//.test(f.type) || f.type === "application/pdf" || /\.(pdf|heic|jpe?g|png|webp)$/i.test(f.name));
  if (!list.length) { toast("Escolhe imagens ou PDFs.", "warn"); return; }
  const groups = sameReceipt ? [list] : list.map(f => [f]);
  for (const g of groups) {
    ui.jobs.push({ id: uid(), files: g, label: g.length > 1 ? `${g.length} fotos do mesmo recibo` : g[0].name || "Recibo", status: "Na fila…", error: null, running: false });
  }
  render();
  pumpJobs();
}

function pumpJobs() {
  const running = ui.jobs.filter(j => j.running).length;
  const next = ui.jobs.filter(j => !j.running && !j.error).slice(0, Math.max(0, MAX_PARALLEL - running));
  next.forEach(runJob);
}

function setJob(job, patch) {
  Object.assign(job, patch);
  renderReceipts();
}

async function runJob(job) {
  job.running = true;
  try {
    setJob(job, { status: "A preparar imagem…" });
    const prepared = [];
    for (const f of job.files) prepared.push(await prepareFile(f));
    setJob(job, { status: "A IA está a ler os artigos, descontos e total…" });
    const raw = await parseWithAI(prepared);
    setJob(job, { status: "A converter para euros…" });
    const receipt = normalizeReceipt(raw, uid);
    await addReceipt(receipt, prepared);
    ui.jobs = ui.jobs.filter(j => j !== job);
  } catch (err) {
    console.error(err);
    job.running = false;
    setJob(job, { error: err?.message || "Não foi possível ler o recibo." });
  }
  render();
  pumpJobs();
}

async function addReceipt(r, images) {
  if (!r.items.length) throw new Error("A IA não encontrou artigos neste ficheiro. É um recibo?");
  const dup = split.receipts.find(x => x.store === r.store && x.date === r.date && x.printedTotal != null && x.printedTotal === r.printedTotal);
  r.payerId = split.participants.includes(settings.meId) ? settings.meId : split.participants[0] || null;
  await applyRate(r);
  applyMemory(r);
  if (images?.length) {
    await saveImages(r.id, images);
    r.hasImage = true;
  }
  split.receipts.push(r);
  split.receipts.sort((a, b) => `${a.date || "9"}${a.time || ""}`.localeCompare(`${b.date || "9"}${b.time || ""}`));
  persist();
  const b = receiptBreakdown(r, split.participants);
  toast(`${r.store}: ${r.items.length} artigos · ${eur(b.eurTotal)}`);
  if (dup) toast(`Atenção: parece que este recibo do ${r.store} já tinha sido adicionado.`, "warn");
}

async function applyRate(r) {
  if (r.currency === "EUR") { Object.assign(r, { rate: 1, rateSource: "eur", rateDate: null }); return; }
  const res = await fetchRate(r.currency, r.date);
  r.rate = res.rate;
  r.rateSource = res.source;
  r.rateDate = res.date;
  if (!res.rate) r.warnings.push(`Não encontrei taxa de câmbio para ${r.currency}. Define-a manualmente em Editar.`);
  else if (res.source === "aproximada") r.warnings.push("Sem internet para a taxa de câmbio: usei um valor aproximado. Confirma em Editar.");
}

function applyMemory(r) {
  for (const it of r.items) {
    const m = settings.autoAssign ? memory[memoryKey(it.original)] : null;
    const shares = {};
    if (m) for (const [pid, w] of Object.entries(m.shares)) if (split.participants.includes(pid)) shares[pid] = w;
    if (Object.keys(shares).length) {
      it.shares = shares;
      it.suggested = true;
    } else if (settings.newItemsAll) {
      it.shares = Object.fromEntries(split.participants.map(p => [p, 1]));
    }
  }
}

function remember(it) {
  const key = memoryKey(it.original);
  if (!key) return;
  const shares = it.shares || {};
  if (!Object.keys(shares).length) { delete memory[key]; return; }
  memory[key] = { shares: { ...shares }, n: (memory[key]?.n || 0) + 1, t: Date.now(), name: it.translated };
  const keys = Object.keys(memory);
  if (keys.length > 1500) {
    keys.sort((a, b) => memory[a].t - memory[b].t).slice(0, keys.length - 1500).forEach(k => delete memory[k]);
  }
}

/* =========================================================
   Ações
   ========================================================= */
const findR = id => split.receipts.find(r => r.id === id);
const findItem = (rid, iid) => findR(rid)?.items.find(i => i.id === iid);

function setShares(it, shares) {
  it.shares = shares;
  it.suggested = false;
  remember(it);
}

const actions = {
  "item-person"(el) {
    const { r, i } = el.closest(".item").dataset;
    const it = findItem(r, i);
    const shares = { ...it.shares };
    if (shares[el.dataset.p] > 0) delete shares[el.dataset.p]; else shares[el.dataset.p] = 1;
    setShares(it, shares);
    commit();
  },
  "item-all"(el) {
    const { r, i } = el.closest(".item").dataset;
    const it = findItem(r, i);
    const allOn = split.participants.every(p => it.shares?.[p] > 0);
    setShares(it, allOn ? {} : Object.fromEntries(split.participants.map(p => [p, 1])));
    commit();
  },
  "item-edit"(el) {
    const { r, i } = el.closest(".item").dataset;
    itemModal(r, i);
  },
  "item-add"(el) { itemModal(el.dataset.r, null); },
  "r-collapse"(el) { const r = findR(el.dataset.r); r.collapsed = !r.collapsed; commit(); },
  "r-edit"(el) { receiptModal(el.dataset.r); },
  "r-discounts"(el) { discountsModal(el.dataset.r); },
  "r-image"(el) { imageModal(el.dataset.r); },
  async "r-delete"(el) {
    const r = findR(el.dataset.r);
    withUndo(`Recibo ${r.store} apagado.`, () => { split.receipts = split.receipts.filter(x => x !== r); });
  },
  "r-all"(el) {
    const r = findR(el.dataset.r);
    withUndo("Todos os artigos divididos por todos.", () => r.items.forEach(it => setShares(it, Object.fromEntries(split.participants.map(p => [p, 1])))));
  },
  "r-rest"(el) {
    const r = findR(el.dataset.r);
    r.items.filter(it => !Object.keys(it.shares || {}).some(p => split.participants.includes(p))).forEach(it => setShares(it, Object.fromEntries(split.participants.map(p => [p, 1]))));
    commit();
  },
  "r-accept"(el) {
    findR(el.dataset.r).items.forEach(it => { if (it.suggested) { it.suggested = false; remember(it); } });
    commit();
  },
  "r-clear"(el) {
    const r = findR(el.dataset.r);
    withUndo("Atribuições limpas.", () => r.items.forEach(it => { it.shares = {}; it.suggested = false; }));
  },
  "r-dismiss"(el) { findR(el.dataset.r).warnings = []; commit(); },
  "r-fix"(el) {
    const r = findR(el.dataset.r);
    const b = receiptBreakdown(r, split.participants);
    if (b.mismatch < 0) {
      r.discounts.push({ id: uid(), label: "Diferença para o total", translated: "Diferença para o total", amount: round2(-b.mismatch), target: "all", itemIds: [] });
    } else {
      r.items.push({ id: uid(), original: "Acerto", translated: "Acerto para o total", category: "outros", emoji: "➕", quantity: 1, unit: "un", unitPrice: null, basePrice: b.mismatch, discount: 0, discountLabel: "", price: b.mismatch, shares: Object.fromEntries(split.participants.map(p => [p, 1])) });
    }
    commit();
    toast("Diferença corrigida — agora bate certo com o total.");
  },
  "job-retry"(el) {
    const j = ui.jobs.find(x => x.id === el.dataset.j);
    if (j) { j.error = null; j.status = "Na fila…"; render(); pumpJobs(); }
  },
  "job-remove"(el) { ui.jobs = ui.jobs.filter(x => x.id !== el.dataset.j); render(); },
  "person-toggle"(el) {
    const pid = el.dataset.p;
    if (split.participants.includes(pid)) {
      if (split.participants.length <= 1) return toast("É preciso pelo menos uma pessoa.", "warn");
      split.participants = split.participants.filter(x => x !== pid);
      split.receipts.forEach(r => { if (r.payerId === pid) r.payerId = split.participants[0]; });
    } else {
      split.participants = people.map(p => p.id).filter(id => id === pid || split.participants.includes(id));
    }
    ui.brush = ui.brush.filter(x => split.participants.includes(x));
    commit();
  },
  "person-edit"(el) { personModal(el.dataset.p); },
  "owe-toggle"(el) {
    const p = el.dataset.p;
    ui.openOwe.has(p) ? ui.openOwe.delete(p) : ui.openOwe.add(p);
    renderSummary();
  },
  "copy-amount"(el) { copy(plainAmount(Number(el.dataset.v)), `${plainAmount(Number(el.dataset.v))} € copiado`); },
  "person-message"(el) { personMessageModal(el.dataset.p); },
  "transfer-done"(el) {
    split.settled ||= {};
    const k = el.dataset.k;
    if (split.settled[k]) delete split.settled[k]; else split.settled[k] = true;
    commit();
  },
  "share-text"() { copy(summaryText(), "Resumo copiado"); },
  async "share-native"() {
    const text = summaryText();
    if (navigator.share) {
      try { await navigator.share({ title: split.name, text }); } catch { /* cancelado */ }
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    }
  },
  async "share-link"() { shareLinkModal(); },
  "share-people"() { personMessageModal(split.participants[0]); },
  "export-csv"() { download(`${slug(split.name)}.csv`, "﻿" + csvExport(), "text/csv;charset=utf-8"); },
  "export-json"() { download(`${slug(split.name)}.json`, JSON.stringify({ app: "splitreceipt", v: 1, split, people }, null, 2), "application/json"); },
  "brush-person"(el) {
    const p = el.dataset.p;
    ui.brush = ui.brush.includes(p) ? ui.brush.filter(x => x !== p) : [...ui.brush, p];
    renderBrushBar();
  },
  "brush-all"() {
    ui.brush = ui.brush.length === split.participants.length ? [] : [...split.participants];
    renderBrushBar();
  },
  "brush-off"() { toggleBrush(false); },
};

const slug = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "divisao";

function commit() { persist(); render(); }

function toggleBrush(on = !ui.brushOn) {
  if (on && !split.receipts.length) return toast("Adiciona primeiro um recibo.", "warn");
  ui.brushOn = on;
  if (on && !ui.brush.length) ui.brush = [...split.participants];
  render();
  if (on) toast("Pincel ativo: escolhe pessoas e toca nos artigos.");
}

document.addEventListener("click", e => {
  let el = e.target.closest("[data-act]");
  if (el?.classList.contains("item-open") && ui.brushOn) el = null; // no pincel, tocar no nome pinta
  if (el && !el.closest(".modal-wrap")) {
    if (ui.readonly && !["owe-toggle", "copy-amount", "share-text", "share-native", "export-csv", "person-message", "r-image", "r-collapse", "share-people"].includes(el.dataset.act)) return;
    e.preventDefault();
    actions[el.dataset.act]?.(el, e);
    return;
  }
  // Modo pincel: tocar num artigo aplica a seleção.
  if (ui.brushOn && !ui.readonly) {
    const item = e.target.closest(".item");
    if (item && !e.target.closest("button, select, input")) {
      const it = findItem(item.dataset.r, item.dataset.i);
      setShares(it, Object.fromEntries(ui.brush.map(p => [p, 1])));
      commit();
    }
  }
});

document.addEventListener("change", e => {
  const sel = e.target.closest("[data-payer]");
  if (sel && !ui.readonly) {
    findR(sel.dataset.payer).payerId = sel.value;
    commit();
  }
});

document.addEventListener("submit", e => {
  if (e.target.id === "addPersonForm") {
    e.preventDefault();
    const name = $("#newPerson").value.trim();
    if (!name) return;
    const used = new Set(people.map(p => p.color));
    const p = { id: "p_" + uid(), name, color: PALETTE.find(c => !used.has(c)) || PALETTE[people.length % PALETTE.length] };
    people.push(p);
    split.participants.push(p.id);
    commit();
    toast(`${name} adicionad${/a$/i.test(name) ? "a" : "o"}.`);
  }
});

/* =========================================================
   Modais
   ========================================================= */
function importOptionsModal() {
  openModal({
    title: "Adicionar recibos",
    sub: "Fotos, PDFs, vários de uma vez — ou um recibo longo em várias fotos.",
    body: `<div class="option-grid">
      <label class="option" for="cameraInput"><i class="fa-solid fa-camera"></i><strong>Fotografar</strong><span>Abre a câmara do telemóvel.</span></label>
      <label class="option" for="fileInput"><i class="fa-solid fa-images"></i><strong>Fotos ou PDFs</strong><span>Escolhe vários: cada ficheiro é um recibo diferente.</span></label>
      <label class="option" for="multiPartInput"><i class="fa-solid fa-scroll"></i><strong>Recibo longo</strong><span>Várias fotos que são partes do <b>mesmo</b> recibo (ex.: Tesco comprido).</span></label>
      <button class="option" id="manualOpt"><i class="fa-solid fa-keyboard"></i><strong>Introduzir à mão</strong><span>Cria um recibo vazio e adiciona artigos.</span></button>
      <button class="option" id="jsonOpt"><i class="fa-solid fa-code"></i><strong>Importar JSON / backup</strong><span>Recupera uma divisão exportada ou cola dados.</span></button>
    </div>
    <input type="file" id="multiPartInput" accept="image/*" multiple class="hidden">`,
    onMount: m => {
      m.querySelector("#multiPartInput").onchange = e => { closeModal(); enqueue(e.target.files, { sameReceipt: true }); };
      m.querySelector("label[for=cameraInput]").addEventListener("click", () => setTimeout(closeModal, 300));
      m.querySelector("label[for=fileInput]").addEventListener("click", () => setTimeout(closeModal, 300));
      m.querySelector("#manualOpt").onclick = () => manualReceiptModal();
      m.querySelector("#jsonOpt").onclick = () => jsonImportModal();
    },
  });
}

function currencyOptions(selected) {
  return CURRENCIES.map(([c, n]) => `<option value="${c}" ${c === selected ? "selected" : ""}>${c} — ${n}</option>`).join("");
}

function manualReceiptModal() {
  openModal({
    title: "Novo recibo manual",
    body: `<div class="field"><label>Loja</label><input class="input" id="mStore" placeholder="Ex.: Tesco"></div>
      <div class="grid2"><div class="field"><label>Data</label><input class="input" type="date" id="mDate" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>Moeda</label><select class="select input" id="mCur">${currencyOptions("CZK")}</select></div></div>`,
    foot: `<button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="mOk">Criar</button>`,
    onMount: m => {
      m.querySelector("#mOk").onclick = async () => {
        const r = normalizeReceipt({ store: m.querySelector("#mStore").value || "Recibo", date: m.querySelector("#mDate").value, currency: m.querySelector("#mCur").value, items: [] }, uid);
        r.payerId = split.participants.includes(settings.meId) ? settings.meId : split.participants[0];
        closeModal();
        await applyRate(r);
        split.receipts.push(r);
        commit();
        itemModal(r.id, null);
      };
    },
  });
}

function jsonImportModal() {
  openModal({
    title: "Importar JSON",
    sub: "Aceita um backup do SplitReceipt ou um recibo no formato da IA.",
    body: `<textarea class="input" id="jsonArea" placeholder='{"store":"Lidl","currency":"CZK","date":"2026-10-10","items":[{"original":"Rohlík","translated":"Pão","price":3.9}]}'></textarea>
      <div class="note">Ou escolhe um ficheiro: <input type="file" id="jsonFile" accept="application/json,.json"></div>`,
    foot: `<button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="jsonOk"><i class="fa-solid fa-file-import"></i> Importar</button>`,
    onMount: m => {
      m.querySelector("#jsonFile").onchange = async e => { m.querySelector("#jsonArea").value = await e.target.files[0].text(); };
      m.querySelector("#jsonOk").onclick = async () => {
        try {
          const data = JSON.parse(m.querySelector("#jsonArea").value);
          if (data?.app === "splitreceipt" && data.split) {
            importSplit(data.split, data.people || []);
          } else {
            closeModal();
            await addReceipt(normalizeReceipt(data, uid), null);
            render();
            return;
          }
          closeModal();
        } catch (err) {
          toast(err.message?.startsWith("A IA") ? err.message : "JSON inválido.", "error");
        }
      };
    },
  });
}

function importSplit(s, ppl) {
  for (const p of ppl) if (!people.some(x => x.id === p.id)) people.push(p);
  const copyS = JSON.parse(JSON.stringify(s));
  if (splits.some(x => x.id === copyS.id)) copyS.id = uid();
  copyS.receipts.forEach(r => { r.hasImage = false; });
  split = copyS;
  persist();
  render();
  toast(`Divisão "${split.name}" importada.`);
}

function itemModal(rid, iid) {
  const r = findR(rid);
  const isNew = !iid;
  const it = isNew
    ? { id: uid(), original: "", translated: "", category: "outros", emoji: "", quantity: 1, unit: "un", unitPrice: null, basePrice: 0, discount: 0, discountLabel: "", price: 0, shares: settings.newItemsAll ? Object.fromEntries(split.participants.map(p => [p, 1])) : {} }
    : JSON.parse(JSON.stringify(findItem(rid, iid)));
  const cur = r.currency;
  const sym = currencySymbol(cur);
  const weights = { ...it.shares };
  const canSplitUnits = !isNew && it.unit === "un" && Number.isInteger(it.quantity) && it.quantity >= 2 && it.quantity <= 30;

  openModal({
    title: isNew ? "Adicionar artigo" : "Editar artigo",
    sub: isNew ? `Recibo ${esc(r.store)}` : esc(it.original),
    body: `
      <div class="grid2">
        <div class="field"><label>Nome em português</label><input class="input" id="fTr" value="${esc(it.translated)}" placeholder="Ex.: Manteiga"></div>
        <div class="field"><label>Nome original</label><input class="input" id="fOr" value="${esc(it.original)}" placeholder="Ex.: Máslo"></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Preço (${sym})</label><input class="input num" id="fBase" inputmode="decimal" value="${it.basePrice ? fmtNum(it.basePrice) : ""}" placeholder="0,00"></div>
        <div class="field"><label>Desconto (${sym})</label><input class="input num" id="fDisc" inputmode="decimal" value="${it.discount ? fmtNum(it.discount) : ""}" placeholder="0,00"></div>
        <div class="field"><label>Quantidade</label><input class="input num" id="fQty" inputmode="decimal" value="${fmtNum(it.quantity, it.quantity % 1 ? 3 : 0)}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Categoria</label><select class="select input" id="fCat">${CATEGORIES.map(c => `<option value="${c}" ${c === it.category ? "selected" : ""}>${CATEGORY[c][1]} ${CATEGORY[c][0]}</option>`).join("")}</select></div>
        <div class="field"><label>Emoji</label><input class="input" id="fEmoji" value="${esc(it.emoji)}" maxlength="4" placeholder="${CATEGORY[it.category]?.[1] || "🛒"}"></div>
      </div>
      <div class="rate-box" id="fFinal"></div>
      <div class="field"><span class="lbl">Partes de cada pessoa <span class="hint">— ex.: 2 para quem comeu o dobro, 0 para quem não entra</span></span>
        <div id="fWeights"></div>
      </div>`,
    foot: `${!isNew ? `<button class="btn danger left" id="fDel"><i class="fa-regular fa-trash-can"></i></button>` : ""}
      ${canSplitUnits ? `<button class="btn" id="fUnits" title="Cria uma linha por unidade"><i class="fa-solid fa-divide"></i> Separar ${it.quantity} unidades</button>` : ""}
      <button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="fSave">Guardar</button>`,
    onMount: m => {
      const q = s => m.querySelector(s);
      const final = () => round2((parseAmount(q("#fBase").value) || 0) - Math.abs(parseAmount(q("#fDisc").value) || 0));
      const drawFinal = () => {
        const f = final();
        const rate = r.eurCharged > 0 ? receiptBreakdown(r, split.participants).factor : r.rate || 1;
        q("#fFinal").innerHTML = `Valor final: <strong>${fmtMoney(f, cur)}</strong>${cur !== "EUR" ? ` ≈ <strong>${eur(f * rate)}</strong>` : ""} <span class="muted">(antes de cupões gerais)</span>`;
        drawWeights();
      };
      const drawWeights = () => {
        const f = final();
        const rate = r.eurCharged > 0 ? receiptBreakdown(r, split.participants).factor : r.rate || 1;
        const sumW = participants().reduce((s, p) => s + (weights[p.id] || 0), 0);
        q("#fWeights").innerHTML = participants().map(p => `<div class="weight-row">${avatar(p)}<span class="name">${esc(p.name)}</span>
          <span class="val">${weights[p.id] && sumW ? eur((f * rate * weights[p.id]) / sumW) : "—"}</span>
          <div class="stepper"><button type="button" data-w="-1" data-p="${p.id}">−</button><input data-wi="${p.id}" inputmode="decimal" value="${weights[p.id] ? fmtNum(weights[p.id], weights[p.id] % 1 ? 1 : 0) : 0}"><button type="button" data-w="1" data-p="${p.id}">+</button></div></div>`).join("");
      };
      q("#fWeights").addEventListener("click", e => {
        const b = e.target.closest("[data-w]");
        if (!b) return;
        const v = Math.max(0, (weights[b.dataset.p] || 0) + Number(b.dataset.w));
        if (v) weights[b.dataset.p] = v; else delete weights[b.dataset.p];
        drawWeights();
      });
      q("#fWeights").addEventListener("change", e => {
        const i = e.target.closest("[data-wi]");
        if (!i) return;
        const v = Math.max(0, parseAmount(i.value) || 0);
        if (v) weights[i.dataset.wi] = v; else delete weights[i.dataset.wi];
        drawWeights();
      });
      ["#fBase", "#fDisc"].forEach(s => q(s).addEventListener("input", drawFinal));
      drawFinal();

      const collect = () => {
        const base = parseAmount(q("#fBase").value) || 0;
        const disc = Math.abs(parseAmount(q("#fDisc").value) || 0);
        Object.assign(it, {
          translated: q("#fTr").value.trim() || q("#fOr").value.trim() || "Artigo",
          original: q("#fOr").value.trim() || q("#fTr").value.trim(),
          basePrice: round2(base), discount: round2(disc), price: round2(base - disc),
          quantity: parseAmount(q("#fQty").value) || 1,
          category: q("#fCat").value, emoji: q("#fEmoji").value.trim(),
        });
      };
      q("#fSave").onclick = () => {
        collect();
        if (!it.price && !it.basePrice) return toast("Indica o preço.", "warn");
        setShares(it, { ...weights });
        if (isNew) r.items.push(it);
        else r.items[r.items.findIndex(x => x.id === it.id)] = it;
        closeModal();
        commit();
      };
      q("#fDel") && (q("#fDel").onclick = () => {
        closeModal();
        withUndo("Artigo apagado.", () => { r.items = r.items.filter(x => x.id !== it.id); });
      });
      q("#fUnits") && (q("#fUnits").onclick = () => {
        collect();
        const n = it.quantity;
        const idx = r.items.findIndex(x => x.id === it.id);
        const per = round2(it.price / n), perBase = round2(it.basePrice / n), perDisc = round2(it.discount / n);
        const units = Array.from({ length: n }, (_, k) => ({
          ...it, id: uid(), quantity: 1, unitPrice: null, translated: `${it.translated} (${k + 1}/${n})`,
          price: k === n - 1 ? round2(it.price - per * (n - 1)) : per,
          basePrice: k === n - 1 ? round2(it.basePrice - perBase * (n - 1)) : perBase,
          discount: k === n - 1 ? round2(it.discount - perDisc * (n - 1)) : perDisc,
          shares: { ...weights }, suggested: false,
        }));
        closeModal();
        withUndo(`Separado em ${n} unidades.`, () => { r.items.splice(idx, 1, ...units); });
      });
    },
  });
}

function receiptModal(rid) {
  const r = findR(rid);
  openModal({
    title: "Editar recibo",
    sub: `${r.items.length} artigos`,
    body: `
      <div class="grid2">
        <div class="field"><label>Loja</label><input class="input" id="eStore" value="${esc(r.store)}"></div>
        <div class="field"><label>Local</label><input class="input" id="eLoc" value="${esc(r.location)}"></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Data</label><input class="input" type="date" id="eDate" value="${esc(r.date)}"></div>
        <div class="field"><label>Hora</label><input class="input" type="time" id="eTime" value="${esc(r.time)}"></div>
        <div class="field"><label>Moeda</label><select class="select input" id="eCur">${currencyOptions(r.currency)}${CURRENCIES.some(c => c[0] === r.currency) ? "" : `<option selected>${esc(r.currency)}</option>`}</select></div>
      </div>
      <div class="field"><label>Total impresso no recibo (${currencySymbol(r.currency)})</label><input class="input num" id="eTotal" inputmode="decimal" value="${r.printedTotal != null ? fmtNum(r.printedTotal) : ""}"><span class="hint">Serve para confirmar se a IA leu tudo bem.</span></div>
      <div id="rateSection"></div>
      <div class="field"><span class="lbl">Descontos dos artigos (ex.: "SLEVA 60%")</span>
        <div class="seg" id="eMode"><button type="button" data-v="item" class="${r.lineDiscountMode !== "spread" ? "on" : ""}">Ficam no artigo</button><button type="button" data-v="spread" class="${r.lineDiscountMode === "spread" ? "on" : ""}">Espalhar por todos</button></div>
        <span class="hint">"Ficam no artigo": quem leva o artigo beneficia do desconto. "Espalhar": todos os artigos ficam mais baratos na proporção do seu preço.</span>
      </div>`,
    foot: `<button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="eSave">Guardar</button>`,
    onMount: m => {
      const q = s => m.querySelector(s);
      let mode = r.lineDiscountMode || "item";
      let rate = r.rate;
      let rateSource = r.rateSource;
      let rateDate = r.rateDate;
      const drawRate = () => {
        const cur = q("#eCur").value;
        if (cur === "EUR") { q("#rateSection").innerHTML = ""; return; }
        const sym = currencySymbol(cur);
        q("#rateSection").innerHTML = `
          <div class="grid2">
            <div class="field"><label>Taxa: 1 € = ? ${sym}</label><input class="input num" id="eRate" inputmode="decimal" value="${rate ? fmtNum(1 / rate, 4) : ""}"><span class="hint">${rateSource === "bce" ? `Banco Central Europeu${rateDate ? ` de ${fmtDate(rateDate, { day: "numeric", month: "short", year: "numeric" })}` : ""}` : rateSource === "manual" ? "Definida por ti" : rateSource ? `Fonte: ${rateSource}` : ""}</span></div>
            <div class="field"><label>Ou: valor debitado em €</label><input class="input num" id="eCharged" inputmode="decimal" value="${r.eurCharged ? fmtNum(r.eurCharged) : ""}" placeholder="ex.: o que o Revolut cobrou"><span class="hint">Se preencheres, a divisão usa exatamente este valor.</span></div>
          </div>
          <button type="button" class="btn sm" id="eFetch" style="margin:-4px 0 12px"><i class="fa-solid fa-rotate"></i> Usar taxa oficial do dia do recibo</button>`;
        q("#eRate").addEventListener("input", () => { rateSource = "manual"; });
        q("#eFetch").onclick = async () => {
          q("#eFetch").disabled = true;
          const res = await fetchRate(cur, q("#eDate").value);
          rate = res.rate; rateSource = res.source; rateDate = res.date;
          const keepCharged = q("#eCharged").value;
          drawRate();
          q("#eCharged").value = keepCharged;
          toast(res.rate ? `1 € = ${fmtNum(1 / res.rate, 4)} ${sym}` : "Não consegui obter a taxa.", res.rate ? "good" : "error");
        };
      };
      q("#eCur").addEventListener("change", async () => {
        rate = null; rateSource = null; rateDate = null;
        drawRate();
        q("#eFetch")?.click();
      });
      q("#eMode").addEventListener("click", e => {
        const btn = e.target.closest("button");
        if (!btn) return;
        mode = btn.dataset.v;
        q("#eMode").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === btn));
      });
      drawRate();
      q("#eSave").onclick = async () => {
        const cur = q("#eCur").value;
        const dateChanged = q("#eDate").value !== r.date;
        Object.assign(r, {
          store: q("#eStore").value.trim() || "Recibo",
          location: q("#eLoc").value.trim(),
          date: q("#eDate").value,
          time: q("#eTime").value,
          printedTotal: parseAmount(q("#eTotal").value),
          lineDiscountMode: mode,
        });
        if (cur === "EUR") {
          Object.assign(r, { currency: cur, rate: 1, rateSource: "eur", rateDate: null, eurCharged: null });
        } else {
          const typed = parseAmount(q("#eRate")?.value);
          if (rateSource === "manual" && typed > 0) rate = 1 / typed;
          Object.assign(r, { currency: cur, rate, rateSource, rateDate, eurCharged: parseAmount(q("#eCharged")?.value) || null });
          if (dateChanged && rateSource === "bce") await applyRate(r);
          if (!r.rate && !r.eurCharged) await applyRate(r);
        }
        closeModal();
        commit();
      };
    },
  });
}

function discountsModal(rid) {
  const r = findR(rid);
  const cur = r.currency;
  const draft = JSON.parse(JSON.stringify(r.discounts));
  const lineTotal = r.items.reduce((s, it) => s + (it.discount || 0), 0);
  let mode = r.lineDiscountMode || "item";

  openModal({
    title: "Descontos e cupões",
    sub: `${esc(r.store)} · como repartir as poupanças`,
    wide: true,
    body: `
      ${lineTotal > 0 ? `<div class="field"><span class="lbl">Descontos já ligados a artigos (${fmtMoney(lineTotal, cur)})</span>
        <div class="seg" id="dMode"><button type="button" data-v="item" class="${mode !== "spread" ? "on" : ""}">Ficam no artigo</button><button type="button" data-v="spread" class="${mode === "spread" ? "on" : ""}">Espalhar por todos os artigos</button></div></div>` : ""}
      <div class="field"><span class="lbl">Descontos gerais / cupões (não ligados a um artigo)</span><div id="dList"></div>
        <button type="button" class="btn sm" id="dAdd" style="align-self:flex-start"><i class="fa-solid fa-plus"></i> Adicionar desconto</button>
        <span class="hint">Cada cupão é repartido proporcionalmente ao preço dos artigos escolhidos (todos, por defeito). Ex.: cupão Tesco de −50 Kč só nos artigos da Clubcard.</span>
      </div>`,
    foot: `<button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="dSave">Guardar</button>`,
    onMount: m => {
      const q = s => m.querySelector(s);
      const draw = () => {
        q("#dList").innerHTML = draft.map((d, idx) => `
          <div class="rate-box" data-d="${idx}">
            <div class="grid3" style="grid-template-columns:2fr 1fr auto;align-items:end">
              <div class="field" style="margin:0"><label>Descrição</label><input class="input" data-f="translated" value="${esc(d.translated || d.label)}"></div>
              <div class="field" style="margin:0"><label>Valor (${currencySymbol(cur)})</label><input class="input num" data-f="amount" inputmode="decimal" value="${fmtNum(d.amount)}"></div>
              <button type="button" class="icon-btn" data-del="${idx}" aria-label="Remover"><i class="fa-regular fa-trash-can"></i></button>
            </div>
            <div class="seg" style="margin-top:10px"><button type="button" data-t="all" class="${d.target !== "items" ? "on" : ""}">Todos os artigos</button><button type="button" data-t="items" class="${d.target === "items" ? "on" : ""}">Só alguns artigos</button></div>
            ${d.target === "items" ? `<div style="margin-top:8px;max-height:260px;overflow:auto">${r.items.map(it => `<label class="check-row"><input type="checkbox" data-item="${it.id}" ${d.itemIds?.includes(it.id) ? "checked" : ""}><span class="grow">${esc(itemEmoji(it))} ${esc(it.translated)}</span><span class="muted num">${fmtMoney(it.price, cur)}</span></label>`).join("")}</div>` : ""}
          </div>`).join("") || `<div class="empty-mini">Sem descontos gerais.</div>`;
      };
      q("#dList").addEventListener("input", e => {
        const box = e.target.closest("[data-d]");
        if (!box || !e.target.dataset.f) return;
        const d = draft[box.dataset.d];
        if (e.target.dataset.f === "amount") d.amount = Math.abs(parseAmount(e.target.value) || 0);
        else d.translated = d.label = e.target.value;
      });
      q("#dList").addEventListener("change", e => {
        const box = e.target.closest("[data-d]");
        if (!box || !e.target.dataset.item) return;
        const d = draft[box.dataset.d];
        const set = new Set(d.itemIds || []);
        e.target.checked ? set.add(e.target.dataset.item) : set.delete(e.target.dataset.item);
        d.itemIds = [...set];
      });
      q("#dList").addEventListener("click", e => {
        const box = e.target.closest("[data-d]");
        const del = e.target.closest("[data-del]");
        const t = e.target.closest("[data-t]");
        if (del) { draft.splice(Number(del.dataset.del), 1); draw(); }
        else if (t && box) { draft[box.dataset.d].target = t.dataset.t; draw(); }
      });
      q("#dAdd").onclick = () => { draft.push({ id: uid(), label: "Cupão", translated: "Cupão", amount: 0, target: "all", itemIds: [] }); draw(); };
      q("#dMode")?.addEventListener("click", e => {
        const btn = e.target.closest("button");
        if (!btn) return;
        mode = btn.dataset.v;
        q("#dMode").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === btn));
      });
      draw();
      q("#dSave").onclick = () => {
        r.discounts = draft.filter(d => d.amount > 0);
        r.lineDiscountMode = mode;
        closeModal();
        commit();
      };
    },
  });
}

async function imageModal(rid) {
  const r = findR(rid);
  const imgs = await getImages(rid);
  if (!imgs?.length) return toast("A imagem deste recibo não está guardada neste dispositivo.", "warn");
  const urls = [];
  const body = imgs.map(img => {
    if (img.mimeType === "application/pdf") {
      const bytes = Uint8Array.from(atob(img.data), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      urls.push(url);
      return `<iframe class="receipt-pdf" src="${url}" title="PDF do recibo"></iframe>`;
    }
    return `<img class="receipt-img" src="data:${img.mimeType};base64,${img.data}" alt="Recibo ${esc(r.store)}">`;
  }).join("");
  openModal({ title: esc(r.store), sub: "Recibo original — compara com os artigos lidos", body, wide: true });
  setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 120000);
}

function personModal(pid) {
  const p = person(pid);
  let color = p.color;
  const usedElsewhere = splits.some(s => s.id !== split.id && s.participants.includes(pid));
  openModal({
    title: "Editar pessoa",
    body: `<div class="field"><label>Nome</label><input class="input" id="pName" value="${esc(p.name)}" maxlength="24"></div>
      <div class="field"><span class="lbl">Cor</span><div class="pills" id="pColors">${PALETTE.map(c => `<button type="button" class="av ${c === color ? "lg" : ""}" style="--c:${c};outline:${c === color ? "2px solid var(--text)" : "none"}" data-c="${c}" aria-label="Cor ${c}"></button>`).join("")}</div></div>
      <label class="setting"><div><strong>Sou eu</strong><span>Usado como quem paga por defeito e nas mensagens.</span></div><input type="checkbox" id="pMe" ${isMe(pid) ? "checked" : ""}></label>`,
    foot: `<button class="btn danger left" id="pDel"><i class="fa-regular fa-trash-can"></i> Remover</button><button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="pSave">Guardar</button>`,
    onMount: m => {
      const q = s => m.querySelector(s);
      q("#pColors").onclick = e => {
        const b = e.target.closest("[data-c]");
        if (!b) return;
        color = b.dataset.c;
        q("#pColors").querySelectorAll("[data-c]").forEach(x => { x.style.outline = x === b ? "2px solid var(--text)" : "none"; });
      };
      q("#pSave").onclick = () => {
        p.name = q("#pName").value.trim() || p.name;
        p.color = color;
        if (q("#pMe").checked) settings.meId = pid;
        else if (isMe(pid)) settings.meId = null;
        closeModal();
        commit();
      };
      q("#pDel").onclick = async () => {
        const ok = await confirmModal(`Remover ${esc(p.name)}?`, usedElsewhere ? "Esta pessoa aparece noutras divisões do histórico; lá continuará visível como “?”." : "Deixa de aparecer na lista de pessoas.", "Remover");
        if (!ok) return;
        people = people.filter(x => x.id !== pid);
        split.participants = split.participants.filter(x => x !== pid);
        split.receipts.forEach(r => { if (r.payerId === pid) r.payerId = split.participants[0]; });
        if (!split.participants.length && people.length) split.participants = [people[0].id];
        commit();
      };
    },
  });
}

function personMessageModal(pid) {
  const parts = participants();
  let current = pid;
  openModal({
    title: "Mensagem por pessoa",
    sub: "Lista do que cada um levou e quanto deve.",
    body: `<div class="pills" id="mmPeople" style="margin-bottom:12px">${parts.map(p => `<button class="pill ${p.id === current ? "on" : ""}" style="--c:${p.color}" data-p="${p.id}">${avatar(p)}${esc(p.name)}</button>`).join("")}</div><div class="share-text" id="mmText"></div>`,
    foot: `<button class="btn" id="mmCopy"><i class="fa-regular fa-copy"></i> Copiar</button><button class="btn primary" id="mmSend"><i class="fa-brands fa-whatsapp"></i> Enviar</button>`,
    onMount: m => {
      const q = s => m.querySelector(s);
      const draw = () => {
        q("#mmText").textContent = personText(current);
        q("#mmPeople").querySelectorAll("[data-p]").forEach(b => b.classList.toggle("on", b.dataset.p === current));
      };
      q("#mmPeople").onclick = e => { const b = e.target.closest("[data-p]"); if (b) { current = b.dataset.p; draw(); } };
      q("#mmCopy").onclick = () => copy(personText(current), "Mensagem copiada");
      q("#mmSend").onclick = async () => {
        const text = personText(current);
        if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelado */ } }
        else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
      };
      draw();
    },
  });
}

async function shareLinkModal() {
  let url;
  try {
    const token = await encodeShare(compactSplit(split, people));
    url = `${location.origin}${location.pathname}#s=${token}`;
  } catch {
    return toast("Não foi possível criar o link.", "error");
  }
  openModal({
    title: "Link só de leitura",
    sub: "Quem abrir vê os artigos, quem deve o quê e pode guardar uma cópia. Os dados vão dentro do link — nada fica num servidor.",
    body: `<input class="input" readonly value="${esc(url)}" id="slUrl"><div class="note">${url.length.toLocaleString("pt-PT")} caracteres · as imagens dos recibos não são incluídas.</div>`,
    foot: `<button class="btn" id="slCopy"><i class="fa-regular fa-copy"></i> Copiar link</button><button class="btn primary" id="slSend"><i class="fa-solid fa-share"></i> Partilhar</button>`,
    onMount: m => {
      m.querySelector("#slCopy").onclick = () => copy(url, "Link copiado");
      m.querySelector("#slSend").onclick = async () => {
        if (navigator.share) { try { await navigator.share({ title: split.name, url }); } catch { /* cancelado */ } }
        else window.open(`https://wa.me/?text=${encodeURIComponent(`${split.name}: ${url}`)}`, "_blank", "noopener");
      };
      m.querySelector("#slUrl").onclick = e => e.target.select();
    },
  });
}

function historyModal() {
  const list = [...splits].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  openModal({
    title: "Divisões",
    sub: "Cada divisão junta um ou mais recibos.",
    body: `<button class="btn primary block" id="hNew" style="margin-bottom:12px"><i class="fa-solid fa-plus"></i> Nova divisão</button>
      ${list.map(s => {
        const sum = splitSummary(s);
        const stores = [...new Set(s.receipts.map(r => r.store))].join(", ");
        const allSettled = sum.transfers.length > 0 && sum.transfers.every(t => s.settled?.[transferKey(t)]);
        return `<div class="hist-row ${s.id === split.id ? "current" : ""}" data-open="${s.id}">
          <div class="r-logo" style="width:40px;height:40px;background:${storeColor(s.receipts[0]?.store)}">${esc(initials(s.receipts[0]?.store || s.name).slice(0, 2))}</div>
          <div class="grow"><strong>${esc(s.name)}</strong><span>${s.receipts.length} recibos${stores ? ` · ${esc(stores)}` : ""}</span></div>
          ${allSettled ? `<span class="chip good"><i class="fa-solid fa-check"></i>pago</span>` : ""}
          <strong class="num">${eur(sum.total)}</strong>
          <button class="icon-btn sm" data-del="${s.id}" aria-label="Apagar"><i class="fa-regular fa-trash-can"></i></button>
        </div>`;
      }).join("") || `<div class="empty-mini">Ainda não há divisões guardadas.</div>`}`,
    onMount: m => {
      m.querySelector("#hNew").onclick = () => {
        persist();
        split = newSplit();
        ui.brushOn = false;
        closeModal();
        commit();
      };
      m.querySelector(".modal-body").addEventListener("click", async e => {
        const del = e.target.closest("[data-del]");
        if (del) {
          e.stopPropagation();
          const s = splits.find(x => x.id === del.dataset.del);
          const ok = await confirmModal(`Apagar "${esc(s.name)}"?`, "Isto não pode ser anulado.", "Apagar");
          if (!ok) return historyModal();
          s.receipts.forEach(r => deleteImages(r.id));
          splits = splits.filter(x => x !== s);
          if (s.id === split.id) split = splits[0] || newSplit();
          commit();
          historyModal();
          return;
        }
        const row = e.target.closest("[data-open]");
        if (row) {
          split = splits.find(x => x.id === row.dataset.open);
          ui.brushOn = false;
          closeModal();
          commit();
        }
      });
    },
  });
}

function settingsModal() {
  const memCount = Object.keys(memory).length;
  openModal({
    title: "Definições",
    body: `
      <div class="setting"><div><strong>Tema</strong><span>Vidro claro ou escuro.</span></div>
        <div class="seg" id="sTheme" style="width:220px">${[["auto", "Auto"], ["light", "Claro"], ["dark", "Escuro"]].map(([v, l]) => `<button type="button" data-v="${v}" class="${settings.theme === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="setting"><div><strong>Eu sou</strong><span>Quem paga por defeito.</span></div>
        <select class="select input" id="sMe" style="width:160px"><option value="">—</option>${people.map(p => `<option value="${p.id}" ${isMe(p.id) ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
      <div class="setting"><div><strong>Memória de atribuições</strong><span>Sugere automaticamente quem leva cada artigo com base nas divisões anteriores (${memCount} artigos memorizados).</span></div>
        <button class="toggle ${settings.autoAssign ? "on" : ""}" id="sAuto" aria-label="Memória"></button></div>
      <div class="setting"><div><strong>Artigos novos para todos</strong><span>Sem sugestão da memória, divide por todos em vez de ficar por atribuir.</span></div>
        <button class="toggle ${settings.newItemsAll ? "on" : ""}" id="sAll" aria-label="Novos para todos"></button></div>
      <div class="setting"><div><strong>Utilizador Revolut</strong><span>Adiciona o teu link revolut.me nas mensagens de cobrança.</span></div>
        <input class="input" id="sRev" style="width:160px" placeholder="@utilizador" value="${esc(settings.revolutUser)}"></div>
      <div class="setting"><div><strong>Chave Gemini pessoal</strong><span>Opcional. Só é usada se o servidor (Netlify) não tiver GEMINI_API_KEY. Fica guardada apenas neste dispositivo.</span></div>
        <input class="input" id="sKey" type="password" style="width:160px" placeholder="AIza…" value="${esc(settings.geminiKey)}" autocomplete="off"></div>
      <div class="setting"><div><strong>Dados</strong><span>Backup de tudo (pessoas, divisões e memória).</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button class="btn sm" id="sExport">Exportar</button><label class="btn sm" for="sImport">Importar</label><input type="file" id="sImport" accept=".json" class="hidden"></div></div>
      <div class="setting"><div><strong>Esquecer memória</strong><span>Apaga as sugestões aprendidas.</span></div><button class="btn sm danger" id="sForget">Esquecer</button></div>`,
    foot: `<button class="btn primary" id="sDone">Feito</button>`,
    onMount: m => {
      const q = s => m.querySelector(s);
      q("#sTheme").onclick = e => {
        const b = e.target.closest("button");
        if (!b) return;
        settings.theme = b.dataset.v;
        applyTheme();
        q("#sTheme").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
      };
      q("#sAuto").onclick = e => { settings.autoAssign = !settings.autoAssign; e.currentTarget.classList.toggle("on", settings.autoAssign); };
      q("#sAll").onclick = e => { settings.newItemsAll = !settings.newItemsAll; e.currentTarget.classList.toggle("on", settings.newItemsAll); };
      q("#sForget").onclick = () => { memory = {}; persist(); toast("Memória apagada."); };
      q("#sExport").onclick = () => download(`splitreceipt-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: "splitreceipt-backup", v: 1, people, splits, memory, settings: { ...settings, geminiKey: "" } }, null, 2), "application/json");
      q("#sImport").onchange = async e => {
        try {
          const data = JSON.parse(await e.target.files[0].text());
          if (data.app === "splitreceipt" && data.split) { closeModal(); importSplit(data.split, data.people || []); return; }
          if (data.app !== "splitreceipt-backup") throw new Error();
          for (const p of data.people || []) if (!people.some(x => x.id === p.id)) people.push(p);
          for (const s of data.splits || []) if (!splits.some(x => x.id === s.id)) splits.push(s);
          memory = { ...data.memory, ...memory };
          persist();
          closeModal();
          render();
          toast("Backup importado.");
        } catch { toast("Ficheiro de backup inválido.", "error"); }
      };
      q("#sDone").onclick = () => {
        settings.meId = q("#sMe").value || null;
        settings.revolutUser = q("#sRev").value.trim();
        settings.geminiKey = q("#sKey").value.trim();
        closeModal();
        commit();
      };
    },
  });
}

function renameModal() {
  openModal({
    title: "Nome da divisão",
    body: `<input class="input" id="rnName" value="${esc(split.name)}" maxlength="60">`,
    foot: `<button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="rnOk">Guardar</button>`,
    onMount: m => {
      const ok = () => { split.name = m.querySelector("#rnName").value.trim() || split.name; closeModal(); commit(); };
      m.querySelector("#rnOk").onclick = ok;
      m.querySelector("#rnName").onkeydown = e => { if (e.key === "Enter") ok(); };
    },
  });
}

function aboutModal() {
  openModal({
    title: "Como funciona",
    body: `<ol class="how">
      <li><b>Adiciona recibos</b> — foto, PDF ou vários de uma vez. Um recibo comprido pode ir em várias fotos ("Recibo longo").</li>
      <li><b>A IA lê tudo</b>: artigos, quantidades, descontos de cada artigo (ex.: "SLEVA 60%"), cupões gerais, total e moeda. Traduz para português.</li>
      <li><b>Conversão para euros</b> com a taxa do Banco Central Europeu do dia do recibo. Se souberes o valor exato que o banco cobrou, coloca-o em Editar → "valor debitado em €".</li>
      <li><b>Atribui os artigos</b>: toca nas pessoas de cada artigo, usa "Todos", o <b>pincel</b> para atribuir muitos de seguida, ou ⚙️ para partes diferentes (ex.: 2 croissants para um, 1 para outro).</li>
      <li><b>Descontos</b>: os de artigo ficam no artigo (ou espalham-se por todos, se preferires). Cupões gerais são repartidos proporcionalmente, por todos ou só por alguns artigos.</li>
      <li><b>Memória</b>: da próxima vez que comprares o mesmo artigo, a app sugere as mesmas pessoas.</li>
      <li><b>No fim</b>: vês a parte de cada um (para a despesa no Revolut), os acertos entre pessoas, e podes partilhar por mensagem ou por link.</li>
    </ol>
    <div class="note">Os dados ficam só neste dispositivo (localStorage). As imagens são enviadas apenas para a IA para leitura.</div>`,
  });
}

/* =========================================================
   Tema, links partilhados, arranque
   ========================================================= */
function applyTheme() {
  const t = settings.theme === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === "dark" ? "#0c0f1d" : "#eef1f8";
  $("#themeBtn").innerHTML = `<i class="fa-solid fa-${t === "dark" ? "sun" : "moon"}"></i>`;
}

async function openSharedFromHash() {
  const m = location.hash.match(/^#s=(.+)$/);
  if (!m) return false;
  try {
    const payload = await decodeShare(m[1]);
    ui.sharedPayload = payload;
    ui.backup = { split, people };
    ui.readonly = true;
    ui.brushOn = false;
    const merged = [...people];
    for (const p of payload.people) {
      const i = merged.findIndex(x => x.id === p.id);
      if (i >= 0) merged[i] = p; else merged.push(p);
    }
    people = merged;
    split = payload.split;
    return true;
  } catch {
    toast("Link de partilha inválido ou incompleto.", "error");
    history.replaceState(null, "", location.pathname);
    return false;
  }
}

function leaveShared(keep) {
  const payload = ui.sharedPayload;
  people = ui.backup.people;
  split = ui.backup.split;
  ui.readonly = false;
  ui.backup = null;
  ui.sharedPayload = null;
  history.replaceState(null, "", location.pathname);
  if (keep) importSplit(payload.split, payload.people);
  else render();
}

function bindGlobal() {
  $("#addBtn").onclick = importOptionsModal;
  $("#bbAdd").onclick = importOptionsModal;
  $("#moreImportBtn").onclick = importOptionsModal;
  $("#bbBrush").onclick = () => toggleBrush();
  $("#bbSummary").onclick = () => $("#summaryPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#historyBtn").onclick = historyModal;
  $("#settingsBtn").onclick = settingsModal;
  $("#splitNameBtn").onclick = () => !ui.readonly && renameModal();
  $("#aboutBtn").onclick = aboutModal;
  $("#themeBtn").onclick = () => {
    settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme();
    persist();
  };
  $("#importSharedBtn").onclick = () => leaveShared(true);
  $("#closeSharedBtn").onclick = () => leaveShared(false);
  $("#fileInput").onchange = e => { enqueue(e.target.files); e.target.value = ""; };
  $("#cameraInput").onchange = e => { enqueue(e.target.files); e.target.value = ""; };

  // Arrastar e largar / colar
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { if (e.dataTransfer?.types?.includes("Files") && !ui.readonly) { dragDepth++; $("#dragOverlay").classList.remove("hidden"); } });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#dragOverlay").classList.add("hidden"); });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault();
    dragDepth = 0;
    $("#dragOverlay").classList.add("hidden");
    if (e.dataTransfer?.files?.length) enqueue(e.dataTransfer.files);
  });
  window.addEventListener("paste", e => {
    if (e.target.closest?.("input, textarea")) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) enqueue(files);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if ($("#modalRoot").children.length) closeModal();
      else if (ui.brushOn) toggleBrush(false);
    }
  });
  window.addEventListener("hashchange", async () => { if (await openSharedFromHash()) render(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => settings.theme === "auto" && applyTheme());
}

async function init() {
  // Garante que os participantes existem (pessoas podem ter sido removidas).
  split.participants = split.participants.filter(id => people.some(p => p.id === id));
  if (!split.participants.length) split.participants = people.map(p => p.id);
  applyTheme();
  bindGlobal();
  await openSharedFromHash();
  render();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // Limpa imagens órfãs (recibos apagados) algum tempo depois, para permitir "Anular".
  setTimeout(() => { if (!ui.readonly) pruneImages(splits.flatMap(s => s.receipts.map(r => r.id))); }, 15000);
}

init();
