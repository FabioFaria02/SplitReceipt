import { callGemini, DEFAULT_MODELS } from "../../js/ai.js";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });

const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const MAX_FILES = 6;

export default async (req) => {
  if (req.method !== "POST") return reply(405, { error: "Método não permitido." });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return reply(500, { error: "A variável GEMINI_API_KEY não está configurada no Netlify.", code: "NO_KEY" });

  let body;
  try { body = await req.json(); } catch { return reply(400, { error: "Pedido inválido (JSON)." }); }

  const files = Array.isArray(body?.files) ? body.files : [];
  if (!files.length) return reply(400, { error: "Nenhum ficheiro recebido." });
  if (files.length > MAX_FILES) return reply(400, { error: `Máximo de ${MAX_FILES} imagens por recibo.` });
  for (const f of files) {
    if (typeof f?.data !== "string" || !f.data || !ALLOWED.test(f?.mimeType || "")) {
      return reply(400, { error: "Ficheiro inválido: só imagens ou PDF." });
    }
  }

  const models = [process.env.GEMINI_MODEL, ...DEFAULT_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  try {
    const fb = body?.feedback;
    const feedback = fb && typeof fb.previous === "string" && typeof fb.message === "string" ? { previous: fb.previous, message: fb.message } : null;
    const { receipt, model } = await callGemini({ apiKey, files, models, feedback });
    return reply(200, { receipt, model });
  } catch (err) {
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return reply(status, { error: err?.message || "Erro interno ao processar o recibo." });
  }
};

export const config = { path: "/api/parse-receipt" };
