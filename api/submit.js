//
// /api/submit.js  — Brick Art Publisher endpoint (Vercel serverless)
// SAME FORMAT AS PREVIOUS WORKING VERSION — NO NEW IMPORTS, NO SYNTAX CHANGES
//

export default async function handler(req, res) {
  // --- 1) CORS ---
  res.setHeader("Access-Control-Allow-Origin", "https://www.brick-art.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();

  // --- 2) Only POST allowed ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- 3) Env vars (SAME AS EARLIER CHAT) ---
  const STORE = process.env.SHOPIFY_STORE_DOMAIN;           
  const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;        
  const BLOG_ID = process.env.BLOG_ID;
  if (!STORE || !TOKEN || !BLOG_ID) {
    console.error("[BrickArt] Missing environment config", { STORE, TOKEN: !!TOKEN, BLOG_ID });
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const API_BASE = `https://${STORE}/admin/api/2024-07`;

  // --- 4) Helpers (unchanged logic) ---
  const esc = (s = "") => String(s).replace(/[&<>"]/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));
  const toRawBase64 = (src = "") => src.replace(/^data:image\/\w+;base64,/, "").trim();

  async function shopifyFetch(path, init = {}) {
    const url = `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init.headers || {})
    };
    console.log("[BrickArt] Shopify →", url);
    return fetch(url, { ...init, headers });
  }

  async function uploadFile(base64, filename) {
    if (!base64) return null;
    const raw = toRawBase64(base64);
    if (!raw) return null;

    const body = {
      file: {
        attachment: raw,
        filename,
        mime_type: "image/png",
        alt: "Brick Art submission"
      }
    };

    const r = await shopifyFetch("/files.json", {
      method: "POST",
      body: JSON.stringify(body)
    });

    const text = await r.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {}

    if (!r.ok) {
      console.error("[BrickArt] File upload error", r.status, r.statusText, text?.slice(0,200));
      throw new Error("File upload failed");
    }

    const url = json?.file?.url || json?.files?.[0]?.url || null;
    console.log("[BrickArt] File stored:", url);
    return url;
  }

  try {
    // --- 5) Parse Form Submission ---
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      timestamp,
      imageClean_b64,
      imageLogo_b64
    } = req.body || {};

    if (!nickname || !timestamp) {
      return res.status(400).json({ ok: false, error: "Missing nickname or timestamp" });
    }

    console.log("[BrickArt] Submission received:", nickname, timestamp);

    // --- 6) Upload images ---
    const safeName = `${String(timestamp).replace(/[:.Z\-]/g,"")}-${nickname.toLowerCase().replace(/[^a-z0-9]+/g,"-")}`;
    const cleanUrl = await uploadFile(imageClean_b64, `${safeName}-clean.png`);
    const logoUrl  = await uploadFile(imageLogo_b64,  `${safeName}-logo.png`);

    // --- 7) Build Post HTML ---
    const meta = [
      grid ? `Grid: ${grid}` : "",
      baseplate ? `Baseplate: ${baseplate}` : "",
      totalBricks ? `Total Bricks: ${totalBricks}` : ""
    ].filter(Boolean).join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname)}</p>
      ${meta ? `<p>${esc(meta)}</p>` : ""}
      ${category ? `<p><em>Category:</em> ${esc(category)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" /></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}" /></p>` : ""}
    `.trim();

    // --- 8) Create Shopify Blog Post ---
    const post = {
      article: {
        title: `Brick Art — ${nickname}`,
        body_html,
        tags: category || undefined
      }
    };

    const r = await shopifyFetch(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(post)
    });

    const t = await r.text();
    let json = {};
    try { json = t ? JSON.parse(t) : {}; } catch {}

    if (!r.ok) {
      console.error("[BrickArt] Blog create failed:", t?.slice(0,300));
      return res.status(500).json({ ok: false, error: "Failed to create blog post" });
    }

    return res.status(200).json({
      ok: true,
      articleId: json?.article?.id,
      cleanUrl,
      logoUrl
    });

  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    return res.status(500).json({ ok: false, error: "Server error", detail: err?.message });
  }
}
