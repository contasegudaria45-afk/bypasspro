// ============================================================
//  BypassPro — Motor de bypass serverless (Vercel/Node)
//  Made in Wesley ⚡
//
//  Estratégia: NÃO reimplementamos o bypass de cada plataforma
//  (isso quebra toda semana). Em vez disso, encaminhamos para
//  os motores de bypass que já fazem esse trabalho pesado e
//  são mantidos diariamente, com FALLBACK automático em cascata.
//
//  Ordem de tentativa:
//    1) bypass.vip  (API documentada, cobre Linkvertise/Workink/Lootlabs/AdMaven/etc)
//    2) izen.lol    (motor Zen — Platoboost/Codex/Hydrogen/key systems)
//    3) Resolução de redirect HTTP nativa (encurtadores simples: bit.ly, tinyurl...)
// ============================================================

// fetch com timeout
async function fetchT(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// ---- Provedor 1: bypass.vip ----
async function viaBypassVip(url) {
  const r = await fetchT("https://api.bypass.vip/bypass", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!r.ok) throw new Error("bypass.vip HTTP " + r.status);
  const j = await r.json();
  const result = j.result || j.destination || j.url;
  if (j.status === "success" && result) {
    return { finalUrl: result, provider: "bypass.vip" };
  }
  throw new Error("bypass.vip: " + (j.message || "sem resultado"));
}

// ---- Provedor 2: izen.lol (Zen) ----
async function viaIzen(url) {
  const r = await fetchT("https://api.izen.lol/bypass?url=" + encodeURIComponent(url), {
    headers: { "Accept": "application/json" },
  });
  if (!r.ok) throw new Error("izen HTTP " + r.status);
  const j = await r.json();
  const result = j.result || j.destination || j.bypassed || j.url;
  if (result) return { finalUrl: result, provider: "izen.lol" };
  throw new Error("izen: sem resultado");
}

// ---- Provedor 3: resolução nativa de redirects (encurtadores simples) ----
async function viaRedirect(url) {
  // Node 18+ segue redirects e expõe a URL final em res.url
  const r = await fetchT(url, { method: "GET", redirect: "follow" }, 10000);
  if (r.url && r.url.replace(/\/+$/, "") !== url.replace(/\/+$/, "")) {
    return { finalUrl: r.url, provider: "redirect-follow" };
  }
  // tenta capturar meta-refresh / location no corpo
  const txt = await r.text().catch(() => "");
  const meta = txt.match(/http-equiv=["']?refresh["']?[^>]*url=([^"'>\s]+)/i);
  if (meta && meta[1]) return { finalUrl: meta[1], provider: "meta-refresh" };
  if (r.url) return { finalUrl: r.url, provider: "redirect-follow" };
  throw new Error("redirect: sem destino");
}

const PROVIDERS = [viaBypassVip, viaIzen, viaRedirect];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  let url = "";
  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      url = (body.url || "").trim();
    } catch { url = ""; }
  } else {
    url = ((req.query && req.query.url) || "").trim();
  }

  if (!url) return res.status(400).json({ status: "error", message: "Parâmetro 'url' ausente." });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { new URL(url); } catch { return res.status(400).json({ status: "error", message: "URL inválida." }); }

  const t0 = Date.now();
  const attempts = [];

  for (const provider of PROVIDERS) {
    try {
      const out = await provider(url);
      if (out && out.finalUrl) {
        attempts.push({ provider: provider.name, ok: true });
        return res.status(200).json({
          status: "success",
          original: url,
          result: out.finalUrl,
          provider: out.provider,
          elapsed: ((Date.now() - t0) / 1000).toFixed(2),
          attempts,
        });
      }
    } catch (e) {
      attempts.push({ provider: provider.name, ok: false, error: String(e.message || e) });
    }
  }

  return res.status(502).json({
    status: "error",
    original: url,
    message: "Nenhum motor conseguiu desencurtar este link. Pode estar expirado, exigir captcha, ou os provedores estarem fora do ar. Tente novamente.",
    elapsed: ((Date.now() - t0) / 1000).toFixed(2),
    attempts,
  });
}
