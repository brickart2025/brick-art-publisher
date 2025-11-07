// /api/submit.js — Brick Art Publisher (Vercel serverless)
// Uses Shopify Admin REST 2024-07
// - Upload images to Files via file.content (base64)
// - Create blog article with the uploaded image URLs
// - Save submitter email privately as an article metafield

export default async function handler(req, res) {
  // ----- 1) CORS (allow your storefront + localhost) -----
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
  if (req.method === "OPTIONS") return res.status(200).end();

  // ----- 2) POST only -----
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // ----- 3) Env -----
  const required = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing environment variable: ${k}`);
    return v;
  };
  const STORE = required("SHOPIFY_STORE_DOMAIN");        // e.g. ek4iwc-kq.myshopify.com
  const TOKEN = required("SHOPIFY_ADMIN_API_TOKEN");     // Admin API access token
  const BLOG_ID = required("BLOG_ID");                   // numeric blog id

  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  // ----- 4) Helpers -----
  function esc(s = "") {
    return String(s).replace(/[&<>"]/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));
  }
  const toRawBase64 = (src = "") => src.replace(/^data:image\/\w+;base64,/, "").trim();

  async function shopifyFetch(path, init = {}) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init.headers || {}),
    };
    console.log("[BrickArt] →", url);
    return fetch(url, { ...init, headers });
  }

  // ✅ Correct upload for REST /files.json (prevents 406)
  async function uploadFile(b64, filename) {
    if (!b64) return null;
    const raw = toRawBase64(b64);
    if (!raw) return null;

    const body = {
      file: {
        content: raw,        // IMPORTANT: use 'content' (not 'attachment')
        filename: filename
        // keep minimal: extra fields like file_type can cause 406
      }
    };

    const r = await shopifyFetch("/files.json", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error("[BrickArt] File upload failed", r.status, r.statusText, text?.slice(0, 300));
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {}
    const url = json?.file?.url || json?.files?.[0]?.url || null;
    console.log("[BrickArt] File stored:", url);
    return url;
  }

  try {
    // ----- 5) Parse body -----
    // Body may arrive as string if a proxy rewrites it; normalize to object.
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
      // frontend sends this as 'submitterEmail'
      submitterEmail,
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (timestamp and at least one image)",
      });
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

    // ----- 6) Upload images -----
    const safeBase = `${String(timestamp).replace(/[:.Z\-]/g, "")}-${String(nickname || "student")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`;

    const [cleanUrl, logoUrl] = await Promise.all([
      uploadFile(imageClean_b64, `${safeBase}-clean.png`),
      uploadFile(imageLogo_b64,  `${safeBase}-logo.png`),
    ]);

    // ----- 7) Create article -----
    const niceTime = new Date(timestamp).toLocaleString("en-US", {
      hour12: true, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });

    const title = `Brick Art submission — ${nickname || "Student"} (${niceTime})`;
    const metaBits = [
      grid ? `Grid: ${grid}` : null,
      baseplate ? `Baseplate: ${baseplate}` : null,
      Number.isFinite(totalBricks) ? `Total Bricks: ${totalBricks}` : null,
    ].filter(Boolean).join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Student")}</p>
      ${metaBits ? `<p>${esc(metaBits)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)" /></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}"  alt="Design (logo)"  /></p>` : ""}
    `.trim();

    const articlePayload = {
      article: {
        title,
        body_html,
        tags: category ? String(category) : undefined,
      },
    };

    const ar = await shopifyFetch(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(articlePayload),
    });

    const articleText = await ar.text();
    let articleJson = {};
    try { articleJson = articleText ? JSON.parse(articleText) : {}; } catch {}
    if (!ar.ok) {
      console.error("[BrickArt] Blog create FAILED", ar.status, ar.statusText, articleText?.slice(0, 300));
      return res.status(500).json({ ok: false, error: "Failed to create blog post" });
    }

    const articleId = articleJson?.article?.id;

    // ----- 8) Save submitter email privately as a metafield on the article -----
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
        const mfRes = await shopifyFetch(`/articles/${articleId}/metafields.json`, {
          method: "POST",
          body: JSON.stringify(mfBody),
        });
        if (!mfRes.ok) {
          const mfTxt = await mfRes.text();
          console.error("[BrickArt] metafield create error", mfRes.status, mfRes.statusText, mfTxt?.slice(0, 300));
        } else {
          console.log("[BrickArt] metafield saved for article", articleId);
        }
      }
    } catch (mfe) {
      console.error("[BrickArt] metafield creation error", mfe);
    }

    // ----- 9) Done -----
    return res.status(200).json({
      ok: true,
      articleId,
      files: { cleanUrl, logoUrl },
    });
  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      detail: String(err?.message || err),
    });
  }
}
