// /api/submit.js — Brick Art Publisher (Vercel Node serverless)
// Requires env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, BLOG_ID

export default async function handler(req, res) {
  // ---------- 1) CORS ----------
  const ALLOW = new Set([
    "https://www.brick-art.com",
    "https://brick-art.com",
    "http://localhost:3000",
  ]);
  const origin = req.headers.origin;
  if (origin && ALLOW.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // ---------- 2) Env + Shopify helper ----------
  const requireEnv = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing environment variable: ${k}`);
    return v;
  };
  const STORE = requireEnv("SHOPIFY_STORE_DOMAIN"); // e.g. ek4iwc-kq.myshopify.com
  const ADMIN = requireEnv("SHOPIFY_ADMIN_API_TOKEN");
  const BLOG_ID = requireEnv("BLOG_ID"); // numeric id or handle; we use id for REST
  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  async function shopify(path, init = {}) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": ADMIN,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    };
    console.log("[BrickArt] →", url);
    return fetch(url, { ...init, headers });
  }

  // ---------- 3) Utilities ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s = "") =>
    String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  // Upload base64 PNG to Shopify Files, return CDN URL
  async function uploadToFiles(b64MaybePrefixed, filename) {
    if (!b64MaybePrefixed) return null;

    // Clean: strip data URL prefix + whitespace/newlines
    const raw = String(b64MaybePrefixed)
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
      .replace(/\s+/g, "");

    if (!raw || raw.length < 50) {
      console.warn("[BrickArt] base64 too short for", filename, raw.length);
      return null;
    }

    // REST /files.json expects: { file: { attachment, filename } }
    const resp = await shopify("/files.json", {
      method: "POST",
      body: JSON.stringify({ file: { attachment: raw, filename } }),
    });

    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    console.log("[BrickArt] /files.json ->", { status: resp.status, ok: resp.ok, preview: (text || "").slice(0, 140) });

    let url = json?.file?.url || (Array.isArray(json?.files) ? json.files[0]?.url : null) || null;

    // Poll a bit if URL not yet ready (Shopify processes files async)
    if (!url) {
      console.warn("[BrickArt] fileCreate returned no URL; polling by filename…", filename);
      for (let i = 0; i < 24 && !url; i++) {
        await sleep(700);
        const r2 = await shopify("/files.json?limit=25&fields=filename,url,created_at,updated_at");
        const t2 = await r2.text();
        let j2 = null;
        try { j2 = t2 ? JSON.parse(t2) : null; } catch {}
        const list = Array.isArray(j2?.files) ? j2.files : [];
        const hit = list.find((f) => (f.filename || "").includes(filename));
        if (hit?.url) url = hit.url;
      }
    }

    if (!resp.ok && !url) {
      throw new Error(`File upload failed: ${resp.status} ${resp.statusText}`);
    }
    if (!url) throw new Error("Upload finished without a CDN URL.");

    console.log("[BrickArt] File ready:", url);
    return url;
  }

  // ---------- 4) Handle request ----------
  try {
    // Body might be string (from fetch) or object
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts,
      timestamp,
      imageClean_b64,
      imageLogo_b64,
      submitterEmail, // from frontend, stored privately
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing required fields (timestamp, at least one image)" });
    }

    console.log("[BrickArt] Submission received:", {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      timestamp,
      cleanLen: imageClean_b64?.length || 0,
      logoLen: imageLogo_b64?.length || 0,
      hasEmail: !!submitterEmail,
    });

    // ---------- 5) Upload images (parallel) ----------
    const baseName =
      `${String(timestamp).replace(/[:.Z-]/g, "")}-${String(nickname || "student").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const [cleanUrl, logoUrl] = await Promise.all([
      uploadToFiles(imageClean_b64, `${baseName}-clean.png`),
      uploadToFiles(imageLogo_b64, `${baseName}-logo.png`),
    ]);

    // ---------- 6) Create the blog article ----------
    const niceTime = new Date(timestamp).toLocaleString("en-US", {
      hour12: true,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const metaLine = [
      grid ? `Grid: ${grid}` : null,
      baseplate ? `Baseplate: ${baseplate}` : null,
      Number.isFinite?.(totalBricks) ? `Total Bricks: ${totalBricks}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Brick artist")}</p>
      ${metaLine ? `<p>${esc(metaLine)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)" /></p>` : ""}
      ${logoUrl ? `<p><img src="${logoUrl}" alt="Design (logo)" /></p>` : ""}
    `;

    const articlePayload = {
      article: {
        title: `Brick Art submission — ${nickname || "Brick artist"} (${niceTime})`,
        body_html,
        tags: category ? String(category) : undefined,
      },
    };

    const ar = await shopify(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(articlePayload),
    });

    const articleText = await ar.text();
    let aj = {};
    try { aj = articleText ? JSON.parse(articleText) : {}; } catch {}
    if (!ar.ok) {
      console.error("[BrickArt] Blog create FAILED", ar.status, articleText?.slice?.(0, 300));
      return res.status(500).json({ ok: false, error: "Failed to create article" });
    }

    const articleId = aj?.article?.id;

    // ---------- 7) Save private submitter email metafield ----------
    try {
      if (articleId && submitterEmail) {
        const mfBody = {
          metafield: {
            namespace: "brickart",
            key: "submitter_email",
            type: "single_line_text_field",
            value: String(submitterEmail),
          },
        };
        const mfRes = await shopify(`/articles/${articleId}/metafields.json`, {
          method: "POST",
          body: JSON.stringify(mfBody),
        });
        const mfText = await mfRes.text();
        console.log("[BrickArt] metafield save ->", { status: mfRes.status, ok: mfRes.ok, preview: (mfText || "").slice(0, 140) });
      }
    } catch (mfe) {
      console.error("[BrickArt] metafield creation error:", mfe);
    }

    // ---------- 8) Respond ----------
    const handle = aj?.article?.handle;
    const blogHandle = aj?.article?.blog?.handle;
    const storefrontUrl =
      handle && blogHandle ? `https://${STORE.replace(".myshopify.com", "")}.myshopify.com/blogs/${blogHandle}/${handle}` : null;

    return res.status(200).json({
      ok: true,
      articleId,
      articleUrl: storefrontUrl,
      files: { cleanUrl, logoUrl },
    });
  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    return res.status(500).json({ ok: false, error: "Server error", detail: String(err?.message || err) });
  }
}
