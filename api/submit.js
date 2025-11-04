// api/submit.js
//
// Brick Art Publisher (Vercel, Node runtime)
// - Accepts POSTed JSON from the designer
// - Uploads images to Shopify Files
// - Creates a Shopify Blog Article that references the uploaded images
//
// Required Vercel env vars (Settings → Environment Variables):
//   SHOPIFY_STORE_DOMAIN      e.g. brick-art.myshopify.com  (admin domain, not storefront)
//   SHOPIFY_ADMIN_API_TOKEN   Admin API access token (write_files, write_content)
//   BLOG_ID                   Numeric id of target Blog
//
// Client is expected to send (JSON):
//   nickname, category?, grid?, baseplate?, totalBricks?, brickCounts?, timestamp,
//   imageClean_b64, imageLogo_b64  (RAW base64, NO "data:image/png;base64," prefix)
//
// NOTE: If you still have the prefix client-side, strip it before sending:
//   dataUrl.replace(/^data:image\/\w+;base64,/, "")

export default async function handler(req, res) {
  // --- 1) CORS (allow Shopify theme origin) ---
  res.setHeader("Access-Control-Allow-Origin", "https://www.brick-art.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // --- 2) Only POST allowed ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- 3) Config / Env ---
  const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;       // brick-art.myshopify.com
  const ADMIN_TOKEN    = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const BLOG_ID        = process.env.BLOG_ID;                     // numeric id
  const API_VERSION    = "2024-07";                               // or "2024-10"
  const BASE           = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}`;

  const requireEnv = (k) => {
    if (!process.env[k]) throw new Error(`Missing env: ${k}`);
    return process.env[k];
  };
  try {
    requireEnv("SHOPIFY_STORE_DOMAIN");
    requireEnv("SHOPIFY_ADMIN_API_TOKEN");
    requireEnv("BLOG_ID");
  } catch (e) {
    console.error("[BrickArt] Env error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }

  // Helper: call Shopify Admin REST with proper headers + versioned base URL
  async function shopifyFetch(path, init = {}) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init.headers || {}),
    };
    console.log("[BrickArt] Shopify request:", url);
    return fetch(url, { ...init, headers });
  }

  // Helper: upload base64 PNG to Files API, return hosted URL
  const uploadFile = async (b64, filename) => {
    if (!b64) return null; // safe no-op when an image wasn't provided

    // Shopify expects: { file: { attachment: <base64>, filename, mime_type } }
    const body = {
      file: {
        attachment: b64,            // RAW base64 (no data: prefix)
        filename,
        mime_type: "image/png",
      },
    };

    const r = await shopifyFetch("/files.json", {
      method: "POST",
      body: JSON.stringify(body),
    });

    // Read body ONCE then parse
    const text = await r.text();
    if (!text?.trim()) {
      console.warn("[BrickArt] Shopify upload: empty response body");
    }

    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      console.error("[BrickArt] Shopify upload: response not JSON", e);
      throw new Error(`Upload response not JSON (status ${r.status})`);
    }

    if (!r.ok) {
      console.error("[BrickArt] File upload failed", {
        status: r.status,
        statusText: r.statusText,
        bodyPreview: text.slice(0, 500),
      });
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    const url = json?.file?.url || null;
    console.log("[BrickArt] File upload success", { url });
    return url;
  };

  // Small helpers
  const okStr = (v) => v && typeof v === "string" && v.trim().length > 0;
  const esc = (s = "") =>
    String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  try {
    // --- 4) Parse body sent by the designer ---
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
    } = req.body || {};

    if (!okStr(nickname) || !okStr(timestamp)) {
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

    // --- 5) Upload images to Shopify Files ---
    const baseName =
      `${String(timestamp).replace(/[:.Z\-]/g, "")}-${(nickname || "student")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`;

    const cleanUrl = await uploadFile(imageClean_b64, `${baseName}-clean.png`);
    const logoUrl  = await uploadFile(imageLogo_b64,  `${baseName}-logo.png`);

    // --- 6) Build the article content ---
    const niceTime = new Date(timestamp).toLocaleString("en-US", { hour12: true });
    const title = `Brick Art submission — ${nickname}`;
    const meta = [
      grid ? `Grid: ${grid}` : "",
      baseplate ? `Baseplate: ${baseplate}` : "",
      Number.isFinite(totalBricks) ? `Total Bricks: ${totalBricks}` : "",
    ].filter(Boolean).join(" • ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname)}</p>
      <p><strong>Submitted:</strong> ${esc(niceTime)}</p>
      ${meta ? `<p>${esc(meta)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)" /></p>` : ""}
      ${logoUrl ? `<p><img src="${logoUrl}" alt="Design (logo)" /></p>` : ""}
    `;

    // --- 7) Create the blog article ---
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

    const arText = await ar.text();
    let articleJson = {};
    try { articleJson = arText ? JSON.parse(arText) : {}; } catch {}

    if (!ar.ok) {
      console.error("[BrickArt] Create article failed", {
        status: ar.status,
        statusText: ar.statusText,
        bodyPreview: arText?.slice(0, 500),
      });
      return res.status(502).json({
        ok: false,
        error: `Create article failed: ${ar.status} ${ar.statusText}`,
        details: arText?.slice(0, 500) || "",
      });
    }

    // Respond with IDs/URLs so the client can confirm
    return res.status(200).json({
      ok: true,
      articleId: articleJson?.article?.id ?? null,
      articleHandle: articleJson?.article?.handle ?? null,
      files: { cleanUrl, logoUrl },
    });
  } catch (err) {
    console.error("[BrickArt] Server error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: String(err?.message || err),
    });
  }
}

