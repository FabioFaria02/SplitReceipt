import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  receiptBreakdown, splitSummary, settleDebts, allocateCents, normalizeReceipt,
  parseAmount, normalizeDate, memoryKey, repairRawReceipt, matchItemByName,
} from "../js/calc.js";

let n = 0;
const id = () => `id${++n}`;
const lidl = () => normalizeReceipt(JSON.parse(readFileSync(new URL("./fixtures/lidl-2026-10-10.json", import.meta.url))), id);
const A = "a", B = "b", C = "c", D = "d";

test("normaliza o recibo Lidl e a soma bate com o total", () => {
  const r = lidl();
  assert.equal(r.items.length, 8);
  assert.equal(r.currency, "CZK");
  assert.equal(r.items[0].discount, 50.94);
  r.rate = 1 / 24.3;
  const b = receiptBreakdown(r, [A, B]);
  assert.equal(Math.round(b.computedTotal * 100), 22896);
  assert.equal(b.mismatch, 0);
  assert.equal(b.eurTotal, Math.round((228.96 / 24.3) * 100) / 100);
});

test("divisão por pessoas soma exatamente o total em cêntimos", () => {
  const r = lidl();
  r.rate = 1 / 24.3;
  r.items.forEach((it, i) => { it.shares = i % 2 ? { [A]: 1, [B]: 1, [C]: 1 } : { [A]: 1, [D]: 2 }; });
  const b = receiptBreakdown(r, [A, B, C, D]);
  const sum = Object.values(b.perPerson).reduce((s, v) => s + Math.round(v * 100), 0);
  assert.equal(sum, Math.round(b.eurTotal * 100));
  assert.equal(b.unassignedEur, 0);
});

test("valor debitado em euros sobrepõe a taxa", () => {
  const r = lidl();
  r.rate = 1 / 24.3;
  r.eurCharged = 9.5;
  r.items.forEach(it => { it.shares = { [A]: 1, [B]: 1 }; });
  const b = receiptBreakdown(r, [A, B]);
  assert.equal(b.eurTotal, 9.5);
  assert.equal(b.perPerson[A] + b.perPerson[B], 9.5);
});

test("cupão geral distribui-se proporcionalmente só pelos artigos escolhidos", () => {
  const r = normalizeReceipt({ currency: "EUR", items: [{ original: "x", price: 10 }, { original: "y", price: 30 }, { original: "z", price: 60 }] }, id);
  r.discounts.push({ id: "d1", label: "Cupão", amount: 8, target: "items", itemIds: [r.items[0].id, r.items[1].id] });
  r.items[0].shares = { [A]: 1 };
  r.items[1].shares = { [B]: 1 };
  r.items[2].shares = { [C]: 1 };
  const b = receiptBreakdown(r, [A, B, C]);
  assert.equal(b.perPerson[A], 8);
  assert.equal(b.perPerson[B], 24);
  assert.equal(b.perPerson[C], 60);
  assert.equal(b.eurTotal, 92);
});

test("modo 'spread' espalha descontos de linha por todos", () => {
  const r = normalizeReceipt({ currency: "EUR", items: [{ original: "x", basePrice: 10, discount: 5, price: 5 }, { original: "y", price: 10 }] }, id);
  r.items[0].shares = { [A]: 1 };
  r.items[1].shares = { [B]: 1 };
  let b = receiptBreakdown(r, [A, B]);
  assert.deepEqual([b.perPerson[A], b.perPerson[B]], [5, 10]);
  r.lineDiscountMode = "spread";
  b = receiptBreakdown(r, [A, B]);
  assert.deepEqual([b.perPerson[A], b.perPerson[B]], [7.5, 7.5]);
});

test("pagadores diferentes geram acertos compensados", () => {
  const r1 = normalizeReceipt({ currency: "EUR", items: [{ original: "x", price: 30 }] }, id);
  r1.items[0].shares = { [A]: 1, [B]: 1, [C]: 1 };
  r1.payerId = A;
  const r2 = normalizeReceipt({ currency: "EUR", items: [{ original: "y", price: 12 }] }, id);
  r2.items[0].shares = { [A]: 1, [B]: 1, [C]: 1 };
  r2.payerId = B;
  const s = splitSummary({ participants: [A, B, C], receipts: [r1, r2] });
  assert.equal(s.total, 42);
  assert.deepEqual(s.net, { [A]: 16, [B]: -2, [C]: -14 });
  assert.deepEqual(s.transfers, [{ from: C, to: A, amount: 14 }, { from: B, to: A, amount: 2 }]);
});

test("artigos por atribuir ficam com quem pagou", () => {
  const r = normalizeReceipt({ currency: "EUR", items: [{ original: "x", price: 10 }, { original: "y", price: 5 }] }, id);
  r.items[0].shares = { [A]: 1, [B]: 1 };
  r.payerId = A;
  const s = splitSummary({ participants: [A, B], receipts: [r] });
  assert.equal(s.unassigned, 5);
  assert.deepEqual(s.transfers, [{ from: B, to: A, amount: 5 }]);
});

test("allocateCents e settleDebts", () => {
  const c = allocateCents({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }, 100);
  assert.equal(c.a + c.b + c.c, 100);
  assert.deepEqual(settleDebts({ a: 0, b: 0 }), []);
});

test("parseAmount, normalizeDate, memoryKey", () => {
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("84,90 Kč"), 84.9);
  assert.equal(parseAmount("-50,94"), -50.94);
  assert.equal(normalizeDate("10.10.26"), "2026-10-10");
  assert.equal(normalizeDate("06/10/2026"), "2026-10-06");
  assert.equal(normalizeDate("2026-10-08"), "2026-10-08");
  assert.equal(memoryKey("Bochník šum. 500g"), memoryKey("BOCHNÍK ŠUM. 500 g"));
});

test("linhas de valor zero (cupões a 0,00) são ignoradas", () => {
  const r = normalizeReceipt({ currency: "CZK", items: [{ original: "BK KUPON KC", price: 0 }, { original: "HOUSKA", price: 6.24 }] }, id);
  assert.equal(r.items.length, 1);
});

test("Billa Klub 10 %: deteta a percentagem e desconta 10 % de cada artigo", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/billa-2026-10-23.json", import.meta.url)));
  delete raw.discounts[0].percent; // mesmo sem a IA indicar, o "10 %" do nome chega
  const r = normalizeReceipt(raw, id);
  assert.equal(r.discounts[0].percent, 10);
  r.rate = 1;
  const b = receiptBreakdown(r, [A]);
  assert.equal(Math.round(b.computedTotal * 100), 65366);
  for (const it of r.items) {
    assert.ok(Math.abs(b.perItem[it.id].effective - it.price * 0.9) < 1e-9, it.original);
  }
});

test("percentagem só em alguns artigos mantém 10 % nesses artigos", () => {
  const r = normalizeReceipt({ currency: "EUR", items: [{ original: "x", price: 10 }, { original: "y", price: 30 }] }, id);
  r.discounts.push({ id: "p", label: "Sleva", amount: 4, percent: 10, target: "items", itemIds: [r.items[1].id] });
  const b = receiptBreakdown(r, [A]);
  assert.equal(b.perItem[r.items[0].id].effective, 10);
  assert.equal(b.perItem[r.items[1].id].effective, 27);
  assert.equal(b.discountTotals.p, 3);
});

test("cupão de valor fixo continua proporcional", () => {
  const r = normalizeReceipt({ currency: "EUR", items: [{ original: "x", price: 10 }, { original: "y", price: 30 }], discounts: [{ label: "Kupón", amount: 4 }] }, id);
  assert.equal(r.discounts[0].percent, null);
  const b = receiptBreakdown(r, [A]);
  assert.equal(b.perItem[r.items[0].id].effective, 9);
  assert.equal(b.perItem[r.items[1].id].effective, 27);
});

test("Tesco: preço unitário lido como total é corrigido (4 × 37,90 = 151,60)", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/tesco-2026-10-27-misread.json", import.meta.url)));
  const fixed = repairRawReceipt(raw);
  const pizza = fixed.items.find(i => i.original.includes("PIZZA"));
  assert.equal(pizza.price, 151.6);
  assert.equal(Math.round(fixed.items.reduce((s, i) => s + i.price, 0) * 100), 180486);
});

test("Tesco: cupões CC ficam no artigo certo, os gerais repartidos, total confere", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/tesco-2026-10-27-misread.json", import.meta.url)));
  const r = normalizeReceipt(raw, id);
  const byName = n => r.items.find(i => i.original.startsWith(n));
  assert.equal(byName("GER SMETANO").discount, 15);
  assert.equal(byName("NES CREMA").discount, 85);
  assert.equal(byName("DR.O BOU").discount, 10);
  assert.equal(byName("FJK RAJ").discount, 23);
  assert.equal(byName("PEJ BA").discount, 10);
  assert.equal(byName("TS KURECI").discount, 25.68);
  assert.equal(byName("TS KRUTI").discount, 15.01);
  assert.equal(byName("TS MLEKO").discount, 0);
  // ISIC "10 %" não bate com 10 % da soma → fica valor fixo repartido por todos
  assert.deepEqual(r.discounts.map(d => [d.label, d.amount, d.percent]), [
    ["KUPON ISIC 10% SLEVA", 153.62, null], ["KUPON N2202 SLEVA", 100, null],
    ["KUPON N2106 LAHUDKY", 10, null], ["KUPON N2104 NEALKO", 10, null],
  ]);
  r.rate = 1;
  const b = receiptBreakdown(r, [A]);
  assert.equal(Math.round(b.computedTotal * 100), 134755);
  assert.equal(b.mismatch, 0);
});

test("matchItemByName não associa cupões genéricos", () => {
  const items = [{ original: "BILLA GRANA PADANO" }, { original: "TS MLEKO BZL 1 L" }];
  assert.equal(matchItemByName("BILLA KLUB NAROZENINY 10 %", items), null);
  assert.equal(matchItemByName("KUPON N2104 NEALKO", items), null);
  assert.equal(matchItemByName("CC TS MLEKO BZL", items), items[1]);
});
