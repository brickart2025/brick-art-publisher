// api/submit.js
// Brick Art Publisher — receives designer submissions and publishes to Shopify

export default async function handler(req, res) {
  // --- 1) CORS (preflight + allow browser POST from your site) ---
  const ALLOW_ORIGINS = new Set([
    "https://www.brick-art.com",
    "https://brick-art.com",
    "http://localhost:3000",
  ]);
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // --- 2) POST only ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- 3) Load required env vars ---
  const requireEnv = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing environment variable: ${k}`);
    return v;
  };
  const STORE = requireEnv("SHOPIFY_STORE_DOMAIN");
  const ADMIN_TOKEN = requireEnv("SHOPIFY_ADMIN_API_TOKEN");
  const BLOG_ID = requireEnv("BLOG_ID");

  // --- 4) Shopify REST base ---
  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  // --- 5) Helper: call Shopify Admin with proper headers ---
  async function shopifyFetch(path, init = {}) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    };
    console.log("[BrickArt] Shopify request:", url);
    return fetch(url, { ...init, headers });
  }

  // --- 6) Helper: upload a base64 PNG to Shopify Files, return hosted URL ---
  async function uploadFile(b64, filename) {
    if (!b64) return null; // nothing to upload

    const body = {
      file: {
        content: b64,          // RAW base64 (no "data:image/png;base64," prefix)
        filename,
        file_type: "IMAGE",
        mime_type: "image/png",
        alt: "Brick Art upload",
      },
    };

    const r = await shopifyFetch("/files.json", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const text = await r.text();
    if (!text?.trim()) {
      console.warn("[BrickArt] Shopify upload: empty response body");
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error("[BrickArt] Shopify upload: response not JSON", e);
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    if (!r.ok) {
      console.error("[BrickArt] File upload failed", {
        status: r.status,
        statusText: r.statusText,
        bodyPreview: text.slice(0, 300),
      });
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    const url = json?.file?.url || json?.files?.[0]?.url || null;
    return url;
  }

  try {
    // --- 7) Parse incoming body ---
    const {
      nickname,
      category,           // optional tag/category
      grid,               // optional (e.g., which grid)
      baseplate,          // optional (string label)
      totalBricks,        // optional (number)
      brickCounts,        // optional (object)
      timestamp,          // ISO string
      imageClean_b64,     // RAW base64 (no prefix)
      imageLogo_b64,      // RAW base64 (no prefix)
    } = req.body || {};

    if (!nickname || !timestamp) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (nickname, timestamp)",
      });
    }

    console.log("[BrickArt] Received payload:", {
      nickname,
      timestamp,
      cleanLength: imageClean_b64?.length || 0,
      logoLength: imageLogo_b64?.length || 0,
    });

    // --- 8) Helpers for article content/filenames ---
    const esc = (s = "") =>
      String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

    const niceTime = new Date(timestamp).toLocaleString("en-US", {
      hour12: true,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const baseName = `${timestamp.replace(/[:.Z-]/g, "")}-${(nickname || "student")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`;

    // --- 9) Upload images to Shopify Files ---
    const cleanUrl = await uploadFile(imageClean_b64, `${baseName}-clean.png`);
    const logoUrl  = await uploadFile(imageLogo_b64,  `${baseName}-logo.png`);

    // --- 10) Build article body ---
    const title = `Brick Art submission — ${nickname || "Student"} (${niceTime})`;
    const meta = [
      grid ? `Grid: ${grid}` : null,
      baseplate ? `Baseplate: ${baseplate}` : null,
      Number.isFinite(totalBricks) ? `Total Bricks: ${totalBricks}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Student")}</p>
      ${meta ? `<p>${esc(meta)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)" /></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}"  alt="Design (logo)"  /></p>` : ""}
    `;

    // --- 11) Create the blog article ---
    const articleBody = {
      article: {
        title,
        body_html,
        tags: category ? String(category) : undefined,
      },
    };

    const ar = await shopifyFetch(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(articleBody),
    });

    const articleText = await ar.text();
    if (!articleText?.trim()) {
      throw new Error(`Create article failed: empty response (${ar.status} ${ar.statusText})`);
    }

    let aj;
    try {
      aj = JSON.parse(articleText);
    } catch (e) {
      console.error("[BrickArt] Create article: response not JSON", e, articleText.slice(0, 300));
      throw new Error(`Create article failed: ${ar.status} ${ar.statusText}`);
    }

    if (!ar.ok) {
      console.error("[BrickArt] Create article error", ar.status, ar.statusText, articleText.slice(0, 300));
      throw new Error(`Create article failed: ${ar.status} ${ar.statusText}`);
    }

    // --- 12) Done ---
    return res.status(200).json({
      ok: true,
      articleId: aj?.article?.id,
      articleUrl: aj?.article?.handle
        ? `https://${STORE}/blogs/${BLOG_ID}/${aj.article.handle}`
        : null,
      files: { cleanUrl, logoUrl },
    });
  } catch (err) {
    console.error("[BrickArt] Server error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: String(err.message || err),
    });
  }
}
