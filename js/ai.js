// Prompt, schema e chamada à API Gemini — partilhado entre o browser
// (chave pessoal opcional) e a função Netlify (chave no servidor).

export const DEFAULT_MODELS = ["gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash"];

export const CATEGORIES = [
  "fruta_legumes", "carne_peixe", "laticinios_ovos", "padaria", "mercearia", "congelados",
  "bebidas", "alcool", "doces_snacks", "higiene", "casa_limpeza", "refeicao_pronta",
  "restaurante", "taxas_sacos", "outros",
];

export const PROMPT = `You are an expert at reading shop, supermarket and restaurant receipts from any European country (Czechia, Slovakia, Poland, Hungary, Portugal, Spain, Germany, Austria, Croatia, Romania, UK, etc.) and in any currency.
Read the receipt (images or PDF) and return ONLY JSON that follows the response schema.
If several images are given, they are consecutive parts of ONE single long receipt, possibly overlapping: merge them and never duplicate the overlapping lines.

CURRENCY
- "currency" is the ISO 4217 code of the amounts: Kč→CZK, zł/PLN→PLN, Ft/HUF→HUF, €→EUR, lei/RON→RON, лв→BGN, £→GBP, Fr./CHF→CHF, kr→DKK/SEK/NOK (decide by country/language), $→USD. Use the shop's country and language when the symbol is missing.

ITEMS (one entry per purchased product)
- Quantity / weight detail lines are NOT items. Merge them into the product they belong to, e.g. "3 ks x 9,90 Kč/ks", "2 x 3,90", "N 0,130 kg (V) x 149,00 Kč/kg", tare lines like "0,002 kg (PT)" or "PT: 0,002 kg".
  These detail lines can be printed AFTER the product (Lidl) or BEFORE the product (Billa). Decide by arithmetic: quantity × unitPrice must equal that product's line price.
- Ignore lines whose amount is 0 (e.g. "BK KUPON KC 0,00", "UVÍTACÍ KUPÓN 0,00"), VAT tables (DPH, VAT, ÁFA, PTU, IVA), payment/card lines, loyalty points, change, subtotal and total lines.
- price = final amount charged for that line AFTER any discount that belongs to that specific line.
- basePrice = amount of that line before its own discount (equal to price when there is no line discount).
- discount = positive amount of that line's own discount (0 if none). discountLabel = the discount text as printed (e.g. "SLEVA 60%").
- Line discounts are discount lines printed right next to a product: Lidl "SLEVA 60% -50,94" followed by "Cena po slevě 33,96", Tesco "Clubcard cena/price", Kaufland/Albert "Sleva", Biedronka/Lidl PL "Rabat", Spar "Akció", Portuguese "Desconto imediato"/"Poupança". They belong to that product, never to the whole receipt.
- Deposits (záloha, kaucja, betétdíj, Pfand), bags (taška, torba, saco) and service fees are items too.
- quantity: number of units, or kg/l for weighed products (number, dot decimal). unit: "un", "kg" or "l". unitPrice: price per unit/kg if printed, else null.
- original: the product name exactly as printed.
- translated: a short, natural European Portuguese (pt-PT) name. Expand abbreviations, keep brand names. Examples: "Jemný kečup" → "Ketchup suave", "Hamburger. housky" → "Pães de hambúrguer", "Olomoucké tvarůžky" → "Queijo de Olomouc (tvarůžky)", "ČESNEK VOLNÝ" → "Alho avulso", "Mleté maso mix" → "Carne picada mista", "Bochník šum. 500g" → "Pão de forma Šumava 500 g".
- category: one of ${CATEGORIES.join(", ")}. emoji: one fitting emoji.

GENERAL DISCOUNTS ("discounts")
- ONLY coupons/discounts that apply to the whole purchase or cannot be safely tied to one product (e.g. Tesco Clubcard vouchers, "Kupón -10 %" at the end, staff discount). amount is positive.
- If a coupon clearly names a single product, put it as that product's line discount instead.
- Summary lines such as Lidl "Celková sleva" or Tesco "Clubcard savings" only REPEAT line discounts already listed: do NOT add them again.
- Never count the same discount twice.

TOTALS AND METADATA
- total = final amount paid as printed (K PLATBĚ, Celkem, Celková zaplacená částka, Razem/SUMA PLN, Összesen, Total, TOTAL A PAGAR…).
- Self-check: sum(items.price) − sum(discounts.amount) must equal total. If it does not, re-read the receipt carefully. If it still differs, describe the problem in "warnings" (pt-PT).
- store: the brand (Lidl, Billa, Tesco, Albert, Penny, Kaufland, Biedronka, Żabka, Spar, Continente, Pingo Doce, restaurant name…). location: short city/address.
- date: YYYY-MM-DD (receipts print DD.MM.YY, DD/MM/YY or DD.MM.YYYY; two-digit years are 20YY). time: HH:MM.
- paymentMethod: e.g. "Cartão", "Dinheiro", "Lidl Pay".
- JSON numbers use a dot as decimal separator (receipts use commas).
- Never invent products or amounts. If something is unreadable, use null and add a warning in pt-PT.`;

const nullableNumber = { type: "NUMBER", nullable: true };

export const SCHEMA = {
  type: "OBJECT",
  properties: {
    store: { type: "STRING" },
    location: { type: "STRING", nullable: true },
    date: { type: "STRING", nullable: true },
    time: { type: "STRING", nullable: true },
    currency: { type: "STRING" },
    total: nullableNumber,
    paymentMethod: { type: "STRING", nullable: true },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          original: { type: "STRING" },
          translated: { type: "STRING" },
          category: { type: "STRING", enum: CATEGORIES },
          emoji: { type: "STRING" },
          quantity: nullableNumber,
          unit: { type: "STRING", enum: ["un", "kg", "l"] },
          unitPrice: nullableNumber,
          basePrice: nullableNumber,
          discount: nullableNumber,
          discountLabel: { type: "STRING", nullable: true },
          price: { type: "NUMBER" },
        },
        required: ["original", "translated", "price"],
        propertyOrdering: ["original", "translated", "category", "emoji", "quantity", "unit", "unitPrice", "basePrice", "discount", "discountLabel", "price"],
      },
    },
    discounts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING" },
          translated: { type: "STRING" },
          amount: { type: "NUMBER" },
        },
        required: ["label", "amount"],
      },
    },
    warnings: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["store", "currency", "items"],
  propertyOrdering: ["store", "location", "date", "time", "currency", "items", "discounts", "total", "paymentMethod", "warnings"],
};

export function buildGeminiBody(files, { schema = true } = {}) {
  const parts = [{ text: PROMPT }];
  for (const f of files) parts.push({ inline_data: { mime_type: f.mimeType, data: f.data } });
  const generationConfig = { responseMimeType: "application/json", temperature: 0.1 };
  if (schema) generationConfig.responseSchema = SCHEMA;
  return { contents: [{ role: "user", parts }], generationConfig };
}

export function extractReceiptJson(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("").trim();
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(reason ? `A IA não devolveu dados (${reason}).` : "A IA não devolveu dados do recibo.");
  }
  const clean = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("A IA devolveu conteúdo que não é JSON válido.");
  }
}

/**
 * Chama a Gemini tentando vários modelos (caso algum não exista na conta)
 * e, se o schema for rejeitado, repete sem schema.
 */
export async function callGemini({ apiKey, files, models = DEFAULT_MODELS, fetchImpl = fetch }) {
  let lastError = null;
  for (const model of models.filter(Boolean)) {
    for (const schema of [true, false]) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      let response, data;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(buildGeminiBody(files, { schema })),
        });
        const raw = await response.text();
        try { data = JSON.parse(raw); } catch { data = null; }
      } catch (err) {
        lastError = new Error(`Falha de rede ao contactar a Gemini: ${err.message}`);
        break;
      }
      if (response.ok) return { receipt: extractReceiptJson(data), model };
      const msg = data?.error?.message || `Erro Gemini HTTP ${response.status}.`;
      lastError = Object.assign(new Error(msg), { status: response.status });
      if (response.status === 400 && schema && /schema|field|property/i.test(msg)) continue; // tenta sem schema
      if (response.status === 404 || /not found|not supported/i.test(msg)) break; // próximo modelo
      if (response.status === 429 || response.status >= 500) break;
      throw lastError; // 400/401/403: não adianta insistir
    }
  }
  throw lastError || new Error("Não foi possível ler o recibo.");
}
