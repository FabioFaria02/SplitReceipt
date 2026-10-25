// Gera js/config.js durante o deploy no GitHub Actions a partir dos Secrets/Variables.
import { writeFileSync } from "node:fs";

const config = {
  geminiKey: (process.env.GEMINI_API_KEY || "").trim(),
  geminiModel: (process.env.GEMINI_MODEL || "").trim(),
};
if (!config.geminiKey) {
  console.warn("::warning::GEMINI_API_KEY não está definido nos Secrets — a app vai pedir a chave a cada utilizador.");
}
writeFileSync(
  new URL("../js/config.js", import.meta.url),
  `// Gerado automaticamente no deploy.\nexport const CONFIG = ${JSON.stringify(config)};\n`
);
console.log(`config.js gerado (chave: ${config.geminiKey ? "sim" : "não"}, modelo: ${config.geminiModel || "predefinido"})`);
