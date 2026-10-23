import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkReceipt, correctionMessage, buildGeminiBody } from "../js/ai.js";

const fx = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

test("leitura correta do Billa bate com subtotal e total", () => {
  const c = checkReceipt(fx("billa-2026-10-23"));
  assert.equal(c.ok, true);
  assert.equal(c.itemsSum, 726.29);
});

test("leitura errada do Billa (preços deslizados, artigos em falta) é detetada", () => {
  const c = checkReceipt(fx("billa-2026-10-23-misread"));
  assert.equal(c.ok, false);
  assert.equal(c.diff, 162.8);
  const msg = correctionMessage(c);
  assert.match(msg, /162\.80/);
  assert.match(msg, /MISSING/);
});

test("Lidl continua a bater certo", () => {
  assert.equal(checkReceipt(fx("lidl-2026-10-10")).ok, true);
});

test("pedido de releitura inclui a resposta anterior e a correção", () => {
  const body = buildGeminiBody([{ mimeType: "image/jpeg", data: "AA" }], { feedback: { previous: "{}", message: "corrige" } });
  assert.deepEqual(body.contents.map(c => c.role), ["user", "model", "user"]);
  assert.ok(body.generationConfig.responseSchema.properties.lines);
});
