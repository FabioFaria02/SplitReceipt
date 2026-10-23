// Lógica pura de cálculo (sem DOM) — testável com `node --test`.

export const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Pesos válidos de um artigo: { personId: peso>0 }. */
export function itemWeights(item, participants) {
  const out = {};
  const allowed = participants ? new Set(participants) : null;
  for (const [pid, w] of Object.entries(item.shares || {})) {
    const weight = num(w);
    if (weight > 0 && (!allowed || allowed.has(pid))) out[pid] = weight;
  }
  return out;
}

/** Valor da linha usado como base para dividir (antes de descontos gerais). */
export function itemBaseValue(item, receipt) {
  const price = num(item.price);
  if (receipt.lineDiscountMode === "spread") {
    const discount = num(item.discount);
    return discount > 0 ? price + discount : price;
  }
  return price;
}

/**
 * Distribui um valor por "baldes" em cêntimos, garantindo que a soma bate certo
 * (método do maior resto).
 */
export function allocateCents(rawByKey, totalCents) {
  const keys = Object.keys(rawByKey);
  const out = {};
  if (!keys.length) return out;
  let used = 0;
  const rema = [];
  for (const k of keys) {
    const cents = rawByKey[k] * 100;
    const floor = Math.floor(cents + 1e-9);
    out[k] = floor;
    used += floor;
    rema.push([k, cents - floor]);
  }
  let diff = totalCents - used;
  rema.sort((a, b) => b[1] - a[1]);
  let i = 0;
  while (diff > 0 && rema.length) { out[rema[i % rema.length][0]] += 1; diff--; i++; }
  i = rema.length - 1;
  while (diff < 0 && rema.length) { out[rema[(i + rema.length) % rema.length][0]] -= 1; diff++; i--; }
  return out;
}

/**
 * Calcula tudo sobre um recibo: valor efetivo de cada artigo (após descontos
 * gerais distribuídos), conversão para euros e parte de cada pessoa.
 */
export function receiptBreakdown(receipt, participants = null) {
  const items = receipt.items || [];
  const values = new Map(items.map(it => [it.id, itemBaseValue(it, receipt)]));
  const effective = new Map(values);
  const discountShare = new Map(items.map(it => [it.id, 0]));
  const discountTotals = {};

  const discounts = (receipt.discounts || [])
    .map(d => ({ ...d, amount: num(d.amount), percent: Math.max(0, num(d.percent)) }))
    .filter(d => d.amount !== 0 || d.percent > 0);
  if (receipt.lineDiscountMode === "spread") {
    const lineTotal = items.reduce((s, it) => s + Math.max(0, num(it.discount)), 0);
    if (lineTotal > 0) discounts.push({ id: "__line", amount: lineTotal, target: "all" });
  }

  for (const d of discounts) {
    let targets = items;
    if (d.target === "items" && Array.isArray(d.itemIds) && d.itemIds.length) {
      const set = new Set(d.itemIds);
      targets = items.filter(it => set.has(it.id));
    }
    // Só artigos com valor positivo absorvem descontos.
    targets = targets.filter(it => values.get(it.id) > 0);
    const base = targets.reduce((s, it) => s + values.get(it.id), 0);
    if (base <= 0) continue;
    // Desconto em percentagem: a mesma % em cada artigo; valor fixo: proporcional ao preço.
    const amount = d.percent > 0 ? base * d.percent / 100 : d.amount;
    discountTotals[d.id] = amount;
    for (const it of targets) {
      const part = amount * values.get(it.id) / base;
      effective.set(it.id, effective.get(it.id) - part);
      discountShare.set(it.id, discountShare.get(it.id) + part);
    }
  }

  const computedTotal = items.reduce((s, it) => s + effective.get(it.id), 0);
  const rate = num(receipt.rate, 0) > 0 ? num(receipt.rate) : 1; // EUR por unidade
  const charged = num(receipt.eurCharged, 0);
  const eurTotal = round2(charged > 0 ? charged : computedTotal * rate);
  const factor = Math.abs(computedTotal) > 1e-9 ? eurTotal / computedTotal : rate;

  const rawEur = {};
  const original = {};
  const perItem = {};
  let unassignedRaw = 0;
  let unassignedOriginal = 0;
  let assignedCount = 0;

  for (const it of items) {
    const eff = effective.get(it.id);
    const eur = eff * factor;
    const weights = itemWeights(it, participants);
    const sumW = Object.values(weights).reduce((a, b) => a + b, 0);
    perItem[it.id] = { base: values.get(it.id), effective: eff, eur, discountShare: discountShare.get(it.id), weights, sumW, people: {} };
    if (sumW <= 0) {
      unassignedRaw += eur;
      unassignedOriginal += eff;
      continue;
    }
    assignedCount++;
    for (const [pid, w] of Object.entries(weights)) {
      rawEur[pid] = (rawEur[pid] || 0) + eur * w / sumW;
      original[pid] = (original[pid] || 0) + eff * w / sumW;
      perItem[it.id].people[pid] = eur * w / sumW;
    }
  }

  const cents = allocateCents({ ...rawEur, __unassigned: unassignedRaw }, Math.round(eurTotal * 100));
  const perPerson = {};
  for (const pid of Object.keys(rawEur)) perPerson[pid] = cents[pid] / 100;
  const unassignedEur = (cents.__unassigned || 0) / 100;

  const printed = receipt.printedTotal == null || receipt.printedTotal === "" ? null : num(receipt.printedTotal, null);
  const mismatch = printed == null ? 0 : round2(printed - computedTotal);

  return {
    computedTotal,
    eurTotal,
    factor,
    perItem,
    perPerson,
    perPersonOriginal: original,
    unassignedEur,
    unassignedOriginal,
    assignedCount,
    itemCount: items.length,
    mismatch,
    printedTotal: printed,
    discountTotals,
  };
}

/** Resumo da divisão completa (vários recibos, vários pagadores). */
export function splitSummary(split) {
  const participants = split.participants || [];
  const consumed = {};
  const paid = {};
  const byReceipt = {};
  let total = 0;
  let unassigned = 0;
  let items = 0;
  let assignedItems = 0;
  participants.forEach(pid => { consumed[pid] = 0; paid[pid] = 0; });

  for (const r of split.receipts || []) {
    const b = receiptBreakdown(r, participants);
    byReceipt[r.id] = b;
    total += b.eurTotal;
    unassigned += b.unassignedEur;
    items += b.itemCount;
    assignedItems += b.assignedCount;
    for (const [pid, v] of Object.entries(b.perPerson)) consumed[pid] = (consumed[pid] || 0) + v;
    if (r.payerId) {
      // Artigos por atribuir ficam, por agora, por conta de quem pagou.
      paid[r.payerId] = (paid[r.payerId] || 0) + b.eurTotal - b.unassignedEur;
    }
  }

  const net = {};
  const keys = new Set([...Object.keys(consumed), ...Object.keys(paid)]);
  for (const pid of keys) net[pid] = round2((paid[pid] || 0) - (consumed[pid] || 0));
  for (const pid of keys) consumed[pid] = round2(consumed[pid] || 0);

  return {
    byReceipt,
    consumed,
    paid,
    net,
    total: round2(total),
    unassigned: round2(unassigned),
    items,
    assignedItems,
    transfers: settleDebts(net),
  };
}

/** Minimiza o número de transferências (ganancioso, em cêntimos). */
export function settleDebts(net) {
  const debtors = [];
  const creditors = [];
  for (const [pid, v] of Object.entries(net)) {
    const c = Math.round(v * 100);
    if (c < 0) debtors.push([pid, -c]);
    else if (c > 0) creditors.push([pid, c]);
  }
  debtors.sort((a, b) => b[1] - a[1]);
  creditors.sort((a, b) => b[1] - a[1]);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i][1], creditors[j][1]);
    if (amount > 0) transfers.push({ from: debtors[i][0], to: creditors[j][0], amount: amount / 100 });
    debtors[i][1] -= amount;
    creditors[j][1] -= amount;
    if (debtors[i][1] === 0) i++;
    if (creditors[j][1] === 0) j++;
  }
  return transfers;
}

/** Chave normalizada de um artigo para memória de atribuições. */
export function memoryKey(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\d+([.,]\d+)?\s*(g|kg|ml|l|ks|x|%)\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Converte números com vírgula/ponto vindos da IA ou do utilizador. */
export function parseAmount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).trim().replace(/[^\d,.\-]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Normaliza a resposta da IA (ou JSON importado) para o modelo interno. */
export function normalizeReceipt(raw, makeId) {
  const id = makeId || (() => Math.random().toString(36).slice(2, 10));
  const items = (Array.isArray(raw?.items) ? raw.items : [])
    .map(it => {
      const price = parseAmount(it.price ?? it.czk ?? it.total ?? it.amount);
      let discount = Math.abs(parseAmount(it.discount ?? it.discountCzk) || 0);
      let basePrice = parseAmount(it.basePrice ?? it.baseCzk);
      if (price == null) return null;
      if (basePrice == null || basePrice < price) basePrice = discount > 0 ? price + discount : price;
      if (!discount && basePrice > price) discount = round2(basePrice - price);
      const quantity = parseAmount(it.quantity) || 1;
      return {
        id: id(),
        original: String(it.original || it.name || "").trim(),
        translated: String(it.translated || it.original || it.name || "").trim(),
        category: it.category || "outros",
        emoji: it.emoji || "",
        quantity,
        unit: it.unit || (quantity % 1 ? "kg" : "un"),
        unitPrice: parseAmount(it.unitPrice ?? it.unitPriceCzk),
        basePrice: round2(basePrice),
        discount: round2(discount),
        discountLabel: it.discountLabel || "",
        price: round2(price),
        shares: it.shares && typeof it.shares === "object" ? { ...it.shares } : {},
      };
    })
    .filter(it => it && !(it.price === 0 && it.discount === 0));

  const discounts = (Array.isArray(raw?.discounts) ? raw.discounts : [])
    .map(d => ({
      id: id(),
      label: String(d.label || d.original || "Desconto").trim(),
      translated: String(d.translated || d.labelTranslated || d.label || "Desconto").trim(),
      amount: Math.abs(parseAmount(d.amount) || 0),
      percent: Math.abs(parseAmount(d.percent) || 0) || null,
      target: d.target === "items" ? "items" : "all",
      itemIds: Array.isArray(d.itemIds) ? d.itemIds : [],
    }))
    .filter(d => d.amount > 0 || d.percent > 0);
  const legacyGeneral = Math.abs(parseAmount(raw?.generalDiscountCzk) || 0);
  if (legacyGeneral > 0 && !discounts.length) {
    discounts.push({ id: id(), label: "Desconto geral", translated: "Desconto geral", amount: legacyGeneral, target: "all", itemIds: [] });
  }

  // "10 %" no nome do desconto: guarda como percentagem se bater com a soma dos artigos.
  const itemsSum = items.reduce((s, it) => s + it.price, 0);
  for (const d of discounts) {
    if (d.percent > 0 && d.percent <= 100) continue;
    d.percent = null;
    const m = `${d.label} ${d.translated}`.match(/(\d{1,2}(?:[.,]\d+)?)\s*%/);
    const pct = m ? parseAmount(m[1]) : null;
    if (pct > 0 && itemsSum > 0 && Math.abs(itemsSum * pct / 100 - d.amount) <= Math.max(0.05, d.amount * 0.01)) d.percent = pct;
  }

  const currency = String(raw?.currency || "").toUpperCase().trim() || (raw?.totalCzk != null ? "CZK" : "EUR");
  return {
    id: id(),
    store: String(raw?.store || "").trim() || "Recibo",
    location: String(raw?.location || "").trim(),
    date: normalizeDate(raw?.date),
    time: String(raw?.time || "").trim().slice(0, 5),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "EUR",
    printedTotal: parseAmount(raw?.total ?? raw?.totalCzk),
    items,
    discounts,
    lineDiscountMode: "item",
    rate: currency === "EUR" ? 1 : null,
    rateSource: currency === "EUR" ? "eur" : null,
    rateDate: null,
    eurCharged: null,
    payerId: null,
    warnings: (Array.isArray(raw?.warnings) ? raw.warnings : []).map(String).filter(Boolean),
    paymentMethod: String(raw?.paymentMethod || "").trim(),
  };
}

/** Aceita YYYY-MM-DD, DD.MM.YY, DD/MM/YYYY… devolve YYYY-MM-DD ou "". */
export function normalizeDate(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return "";
}
