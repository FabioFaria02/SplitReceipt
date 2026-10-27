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

STEP 1 — TRANSCRIBE ("lines")
- Before building items, copy EVERY line of the receipt body into "lines", in order, from the first product down to the final total: product lines, quantity/weight lines, discount lines, subtotal and total. Do not skip any line, even short or strange names (e.g. "CLEVER", "BURTY").
- For each line: "text" = the text as printed (without the VAT letter), "amount" = the number printed in the right-hand price column on THAT SAME line, or null if that line has no price in the right column.
- Read each amount straight across from its own line. Never move a price up or down to a neighbouring line.

STEP 2 — ITEMS (one entry per purchased product)
- A product = its name line + (optionally) ONE quantity/weight detail line, e.g. "3 ks x 9,90 Kč/ks", "4 * 37,90 Kč", "2 x 3,90", "N 0,130 kg (V) x 149,00 Kč/kg", "0,395 kg * 244,90 Kč/kg". Tare lines like "0,002 kg (PT)" / "PT: 0,002 kg" are ignored.
- The item's price is the LINE TOTAL = the single right-column amount that belongs to that product. Depending on the store it is printed:
    • on the name line, with the detail line AFTER it (Lidl, Kaufland),
    • on the name line, with the detail line BEFORE it (Billa, Albert, Penny),
    • on the detail line under the name, while the name line has no amount (Tesco, Globus).
  ALWAYS decide by arithmetic: price = quantity × unitPrice (±0,01). When quantity > 1 the price is NEVER the unit price.
- Every product becomes exactly one item: never merge two products, never skip one, never split one product into its units.
- Tesco example (total on the detail line):
    TS TESTO PIZZA 400g                      → name line, no amount
    4 * 37,90 Kč                     151,60  → item price 151,60, quantity 4, unitPrice 37,90
    JC MASLO 250 g / 2 * 54,90 Kč    109,80  → item price 109,80, quantity 2, unitPrice 54,90
    TS KURECI FILETKY OA / 0,395 kg * 244,90 Kč/kg  96,74 → price 96,74, quantity 0,395 kg
    BROSKVE PULENE 210g              56,90   → price 56,90, quantity 1
- Billa example (detail lines come BEFORE their product):
    CV KUCHYŇSKÉ ROLE            C   22,90   → item price 22,90 (quantity 1)
    2,000 ks x 11,90 Kč/ks                   → 2 × 11,90 = 23,80 → belongs to the NEXT line
    CV OVES. VLOČKY JEM          B   23,80   → item price 23,80, quantity 2, unitPrice 11,90
    N 0,970 kg (V) x 22,90 Kč/kg             → 0,970 × 22,90 = 22,21 → NEXT line
    0,002 kg (PT)                            → tare, ignore
    BANÁNY                       B   22,21   → item price 22,21, quantity 0,970 kg
    CLEVER                       B  139,90   → its own item, price 139,90
    2,000 ks x 0,00 Kč/ks / KUPON NAROZENINY 0,00 → ignore (zero value)
    Mezisoučet 726,29 = sum of all item prices; BILLA KLUB NAROZENINY 10 % -72,63 → general discount; Celkem 653,66 = total.
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

DISCOUNTS PRINTED AFTER THE PRODUCTS ("discounts")
- Discount lines printed after the products / after the subtotal go in "discounts" (amount positive, as printed). Each one has "appliesTo":
    • if the discount line names a product, appliesTo = the "original" text of THAT item, copied exactly from your items. Tesco Clubcard "CC <product>" lines always name a product: "CC GER SMETANO.SYR 1 -15,00" → appliesTo "GER SMETANO.SYR 180g"; "CC NES CREMA ROZ.K.2 -85,00" → appliesTo "NES CREMA ROZ.K.275g"; "CC TS KURECI FILETKY -25,68" → appliesTo "TS KURECI FILETKY OA". The names are truncated: match by the first words.
    • if it applies to the whole purchase or you cannot tell which product (e.g. "KUPON ISIC 10% SLEVA", "KUPON N2104 NEALKO", "Billa Klub 10 %", staff discount), appliesTo = null.
- percent = the percentage only when the line prints one (e.g. "10 %"), else null.
- Summary lines such as Lidl "Celková sleva", Tesco "celková úspora" / "S CLUBCARD jste dnes ušetřili" only REPEAT other discounts: do NOT add them.
- Never count the same discount twice, and never also put these after-subtotal discounts inside items.

TOTALS AND METADATA
- total = final amount paid as printed (K PLATBĚ, Celkem, Celková zaplacená částka, Razem/SUMA PLN, Összesen, Total, TOTAL A PAGAR…).
- subtotal = the printed subtotal before general discounts (Mezisoučet, Suma, Subtotal) or null if not printed.
- Self-check BEFORE answering: sum(items.price) must equal subtotal (when printed), and sum(items.price) − sum(discounts.amount) must equal total. If not, compare items against "lines" again: look for a skipped product or a price shifted to the wrong product. Only if it still differs, describe the problem in "warnings" (pt-PT).
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
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { text: { type: "STRING" }, amount: nullableNumber },
        required: ["text"],
      },
    },
    subtotal: nullableNumber,
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
          percent: nullableNumber,
          appliesTo: { type: "STRING", nullable: true },
        },
        required: ["label", "amount"],
      },
    },
    warnings: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["store", "currency", "items"],
  propertyOrdering: ["store", "location", "date", "time", "currency", "lines", "items", "discounts", "subtotal", "total", "paymentMethod", "warnings"],
};

/**
 * feedback (opcional): { previous: resposta anterior (texto JSON), message: correção }
 * → conversa de 3 turnos para a IA reler o recibo.
 */
export function buildGeminiBody(files, { schema = true, feedback = null } = {}) {
  const parts = [{ text: PROMPT }];
  for (const f of files) parts.push({ inline_data: { mime_type: f.mimeType, data: f.data } });
  const generationConfig = { responseMimeType: "application/json", temperature: feedback ? 0.2 : 0.1 };
  if (schema) generationConfig.responseSchema = SCHEMA;
  const contents = [{ role: "user", parts }];
  if (feedback?.previous && feedback?.message) {
    contents.push({ role: "model", parts: [{ text: String(feedback.previous).slice(0, 60000) }] });
    contents.push({ role: "user", parts: [{ text: String(feedback.message).slice(0, 4000) }] });
  }
  return { contents, generationConfig };
}

/** Confere a resposta da IA: soma dos artigos vs subtotal/total impressos. */
export function checkReceipt(raw) {
  const n = v => (typeof v === "number" && Number.isFinite(v) ? v : Number(String(v ?? "").replace(",", ".")) || 0);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const itemsSum = items.reduce((a, it) => a + n(it.price), 0);
  const disc = (Array.isArray(raw?.discounts) ? raw.discounts : []).reduce((a, d) => a + Math.abs(n(d.amount)), 0);
  const total = raw?.total == null ? null : n(raw.total);
  const subtotal = raw?.subtotal == null ? null : n(raw.subtotal);
  const r2 = x => Math.round(x * 100) / 100;
  const totalDiff = total == null ? 0 : r2(total - (itemsSum - disc));
  const subtotalDiff = subtotal == null || !subtotal ? 0 : r2(subtotal - itemsSum);
  const diff = Math.abs(totalDiff) >= 0.02 ? totalDiff : subtotalDiff;
  return { ok: Math.abs(diff) < 0.02, diff, itemsSum: r2(itemsSum), discounts: r2(disc), total, subtotal, count: items.length };
}

/** Mensagem para a IA corrigir a leitura quando a soma não bate. */
export function correctionMessage(check) {
  const ref = check.subtotal ? `the printed subtotal is ${check.subtotal}` : `the printed total is ${check.total}`;
  return `Your answer is wrong: the ${check.count} item prices add up to ${check.itemsSum} (minus ${check.discounts} of general discounts), but ${ref}. The difference is ${Math.abs(check.diff).toFixed(2)} (${check.diff > 0 ? "items are MISSING or too cheap" : "items are duplicated or too expensive"}).
Re-read the receipt image line by line from the top:
1. Rewrite "lines" completely, one entry per printed line, with the amount from the right-hand column of that same line.
2. Make sure every priced product line is an item (look for skipped short names), and that no price was shifted to the line above or below.
3. Each item price is the LINE TOTAL (quantity × unit price), never the unit price: Tesco "TS TESTO PIZZA 400g / 4 * 37,90 Kč 151,60" → price 151,60. Quantity/weight lines (e.g. "2,000 ks x 11,90", "N 0,970 kg x 22,90") belong to the product whose price equals quantity × unit price — in Billa/Albert/Penny that is the product BELOW them, in Tesco the total is printed on the quantity line itself.
4. Discounts printed after the subtotal that name a product (Tesco "CC ...") need "appliesTo" with that item's original name.
Return the complete corrected JSON.`;
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
export async function callGemini({ apiKey, files, models = DEFAULT_MODELS, fetchImpl = fetch, feedback = null }) {
  let lastError = null;
  for (const model of models.filter(Boolean)) {
    for (const schema of [true, false]) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      let response, data;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(buildGeminiBody(files, { schema, feedback })),
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
