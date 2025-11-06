// /api/submit.js — Brick Art Publisher (Vercel serverless)
// Upload to Shopify Files, then create a Blog Article (Admin REST 2024-07)

export default async function handler(req, res) {
  // --- 1) CORS (preflight + simple) ---
  const ORIGINS = [
    "https://www.brick-art.com",
    "https://brick-art.myshopify.com", // optional: theme preview
  ];
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();

  // --- 2) Method guard ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- 3) Env vars ---
  const STORE   = process.env.SHOPIFY_STORE_DOMAIN;     // e.g. brick-art.myshopify.com
  const TOKEN   = process.env.SHOPIFY_ADMIN_API_TOKEN;  // needs write_files, write_content
  const BLOG_ID = process.env.BLOG_ID;                  // numeric id
  if (!STORE || !TOKEN || !BLOG_ID) {
    console.error("[BrickArt] Missing envs", { STORE: !!STORE, TOKEN: !!TOKEN, BLOG_ID: !!BLOG_ID });
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const API_BASE = `https://${STORE}/admin/api/2024-07`;

  // --- 4) Helpers ---
  const esc = (s = "") =>
    String(s).replace(/[&<>"]/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));

  const toRawBase64 = (src = "") =>
    src.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();

  async function shopifyFetch(path, init = {}) {
    const url = `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    };
    console.log("[BrickArt] Shopify →", url);
    return fetch(url, { ...init, headers });
  }

  // --- 5) Upload file (REST 'attachment' payload) ---
  async function uploadFile(base64, filename) {
    if (!base64) return null;
    const raw = toRawBase64(base64);
    if (!raw) return null;

    const body = {
      file: {
        attachment: raw,          // ✅ this variant matches your store
        filename,
        mime_type: "image/png",   // harmless; remove if Shopify ever complains
        alt: "Brick Art submission"
      }
    };

    const r = await shopifyFetch("/files.json", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const text = await r.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {}

    if (!r.ok) {
      console.error("[BrickArt] File upload FAILED", r.status, json?.errors || text?.slice(0,300));
      throw new Error(JSON.stringify({ step: "files.create", status: r.status, errors: json?.errors || text }));
    }

    const url = json?.file?.url || json?.files?.[0]?.url || null;
    console.log("[BrickArt] File stored:", url);
    return url;
  }

  try {
    // --- 6) Parse body (also handle string bodies) ---
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      timestamp,
      imageClean_b64,
      imageLogo_b64,
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing required fields (timestamp and image)" });
    }

    console.log("[BrickArt] Submission received:", { nickname, category, grid, baseplate, totalBricks, timestamp });

    // --- 7) Upload images (prefer both if provided) ---
    const safeNameBase =
      `${String(timestamp).replace(/[:.Z\-]/g,"")}-${String(nickname||"anon").toLowerCase().replace(/[^a-z0-9]+/g,"-")}`.replace(/-+/g,"-");

    const cleanUrl = await uploadFile(imageClean_b64, `${safeNameBase}-clean.png`);
    const logoUrl  = await uploadFile(imageLogo_b64,  `${safeNameBase}-logo.png`);

    // --- 8) Build article HTML ---
    const meta = [
      grid ? `Grid: ${grid}` : "",
      baseplate ? `Baseplate: ${baseplate}` : "",
      (typeof totalBricks === "number" ? `Total Bricks: ${totalBricks}` : ""),
    ].filter(Boolean).join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Anonymous")}</p>
      ${meta ? `<p>${esc(meta)}</p>` : ""}
      ${category ? `<p><em>Category:</em> ${esc(category)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Brick Art design (clean)"/></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}" alt="Brick Art design (watermarked)"/></p>` : ""}
    `.trim();

    // --- 9) Create blog article ---
    const articlePayload = {
      article: {
        title: `Brick Art submission — ${nickname || "Anonymous"} (${new Date(timestamp).toLocaleString()})`,
        body_html,
        tags: category || undefined,
      },
    };

    const r = await shopifyFetch(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(articlePayload),
    });

    const t = await r.text();
    let articleJson = {};
    try { articleJson = t ? JSON.parse(t) : {}; } catch {}

    if (!r.ok) {
      console.error("[BrickArt] Blog create FAILED", r.status, articleJson?.errors || t?.slice(0,300));
      return res.status(500).json({
        ok: false,
        error: "Failed to create blog post",
        detail: articleJson?.errors || t,
        cleanUrl,
        logoUrl,
      });
    }

    const articleId = articleJson?.article?.id;
    const handle = articleJson?.article?.handle;
    const blogHandle = articleJson?.article?.blog?.handle;
    const storefrontUrl = (handle && blogHandle)
      ? `https://${STORE}/blogs/${blogHandle}/${handle}`
      : null;

    return res.status(200).json({
      ok: true,
      articleId,
      cleanUrl,
      logoUrl,
      storefrontUrl,
    });

  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      detail: err?.message || String(err),
    });
  }
}
