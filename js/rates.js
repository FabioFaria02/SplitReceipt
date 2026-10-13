// Taxas de câmbio para EUR, à data do recibo (BCE via Frankfurter, com alternativas).

const CACHE_KEY = "sr.rates.v1";

// Valores aproximados (EUR por unidade) — só usados se não houver internet.
const FALLBACK = {
  CZK: 1 / 24.3, PLN: 1 / 4.26, HUF: 1 / 395, RON: 1 / 5.05, BGN: 1 / 1.9558, GBP: 1 / 0.85,
  CHF: 1 / 0.94, DKK: 1 / 7.46, SEK: 1 / 11.1, NOK: 1 / 11.7, USD: 1 / 1.1, TRY: 1 / 40,
  RSD: 1 / 117, BAM: 1 / 1.9558, ISK: 1 / 145, MKD: 1 / 61.5, ALL: 1 / 98, UAH: 1 / 45,
};

export const CURRENCIES = [
  ["EUR", "Euro", "€"], ["CZK", "Coroa checa", "Kč"], ["PLN", "Zlóti polaco", "zł"],
  ["HUF", "Forint húngaro", "Ft"], ["RON", "Leu romeno", "lei"], ["BGN", "Lev búlgaro", "лв"],
  ["GBP", "Libra", "£"], ["CHF", "Franco suíço", "CHF"], ["DKK", "Coroa dinamarquesa", "kr"],
  ["SEK", "Coroa sueca", "kr"], ["NOK", "Coroa norueguesa", "kr"], ["ISK", "Coroa islandesa", "kr"],
  ["USD", "Dólar", "$"], ["TRY", "Lira turca", "₺"], ["RSD", "Dinar sérvio", "дин"],
  ["BAM", "Marco bósnio", "KM"], ["MKD", "Dinar macedónio", "ден"], ["ALL", "Lek albanês", "L"],
  ["UAH", "Hryvnia", "₴"],
];

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
}
function writeCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* cheio */ }
}

async function getJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Devolve { rate (EUR por 1 unidade), date, source }.
 * source: "eur" | "bce" | "mercado" | "aproximada"
 */
export async function fetchRate(currency, date) {
  const cur = String(currency || "EUR").toUpperCase();
  if (cur === "EUR") return { rate: 1, date: date || null, source: "eur" };

  const today = new Date().toISOString().slice(0, 10);
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today ? date : null;
  const key = `${cur}_${day || "latest_" + today}`;
  const cache = readCache();
  if (cache[key]) return cache[key];

  const attempts = [
    async () => {
      const d = await getJson(`https://api.frankfurter.dev/v1/${day || "latest"}?base=${cur}&symbols=EUR`);
      return d?.rates?.EUR ? { rate: d.rates.EUR, date: d.date, source: "bce" } : null;
    },
    async () => {
      const d = await getJson(`https://api.frankfurter.app/${day || "latest"}?from=${cur}&to=EUR`);
      return d?.rates?.EUR ? { rate: d.rates.EUR, date: d.date, source: "bce" } : null;
    },
    async () => {
      const c = cur.toLowerCase();
      const d = await getJson(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day || "latest"}/v1/currencies/${c}.json`);
      return d?.[c]?.eur ? { rate: d[c].eur, date: d.date, source: "mercado" } : null;
    },
    async () => {
      const d = await getJson(`https://open.er-api.com/v6/latest/${cur}`);
      return d?.rates?.EUR ? { rate: d.rates.EUR, date: today, source: "mercado" } : null;
    },
  ];

  for (const attempt of attempts) {
    try {
      const res = await attempt();
      if (res && res.rate > 0) {
        cache[key] = res;
        writeCache(cache);
        return res;
      }
    } catch { /* tenta a próxima fonte */ }
  }
  // Última taxa conhecida desta moeda, senão valor aproximado.
  const known = Object.entries(cache).filter(([k]) => k.startsWith(cur + "_")).map(([, v]) => v).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  if (known) return { ...known, source: "cache" };
  if (FALLBACK[cur]) return { rate: FALLBACK[cur], date: null, source: "aproximada" };
  return { rate: null, date: null, source: "desconhecida" };
}

export function currencySymbol(code) {
  return CURRENCIES.find(c => c[0] === code)?.[2] || code;
}
