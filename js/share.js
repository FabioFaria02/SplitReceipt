// Links de partilha (só de leitura) — a divisão vai comprimida no próprio URL.

const b64url = bytes => {
  let s = "";
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = str => {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeShare(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if ("CompressionStream" in window) {
    return "z" + b64url(await pipe(json, new CompressionStream("deflate-raw")));
  }
  return "j" + b64url(json);
}

export async function decodeShare(token) {
  const kind = token[0];
  const bytes = fromB64url(token.slice(1));
  const raw = kind === "z" ? await pipe(bytes, new DecompressionStream("deflate-raw")) : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}

/** Versão compacta da divisão para caber num link. */
export function compactSplit(split, people) {
  const used = new Set(split.participants);
  return {
    v: 1,
    split: {
      ...split,
      settled: split.settled || {},
      receipts: split.receipts.map(r => ({
        ...r,
        warnings: undefined,
        items: r.items.map(({ suggested, ...it }) => it),
      })),
    },
    people: people.filter(p => used.has(p.id)),
  };
}
