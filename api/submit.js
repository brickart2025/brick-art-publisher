// /api/submit.js — Brick Art Publisher (Vercel serverless)
// Creates Shopify Files from base64, then a blog article, then saves submitter email privately.

export default async function handler(req, res) {
  // --- 1) CORS ---
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

  // --- 2) Method guard ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- 3) Env ---
  const STORE = process.env.SHOPIFY_STORE_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const BLOG_ID = process.env.BLOG_ID;
  if (!STORE || !TOKEN || !BLOG_ID) {
    console.error("[BrickArt] Missing env", { STORE: !!STORE, TOKEN: !!TOKEN, BLOG_ID: !!BLOG_ID });
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }
  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  // --- 4) Helpers ---
  const toRawB64 = (s = "") => String(s).replace(/^data:image\/\w+;base64,/, "").trim();
  const esc = (s = "") => String(s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

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

  async function uploadFile(rawOrDataUrl, filename) {
    const raw = toRawB64(rawOrDataUrl);
    if (!raw) return null;

    const body = {
      file: {
        attachment: raw,          // ✅ correct field for REST /files.json
        filename,
        mime_type: "image/png",
        alt: "Brick Art submission",
      },
    };

    const r = await shopifyFetch("/files.json", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const text = await r.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {}
    if (!r.ok) {
      console.error("[BrickArt] File upload failed", r.status, r.statusText, text?.slice(0, 300));
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    const url = json?.file?.url || json?.files?.[0]?.url || null;
    console.log("[BrickArt] File stored:", url);
    return url;
  }

  // --- 5) Main flow ---
  try {
    // Parse body
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
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
      submitterEmail, // ✅ from frontend; stored privately as metafield
    } = body;

    if (!timestamp) {
      return res.status(400).json({ ok: false, error: "Missing timestamp" });
    }

    console.log("[BrickArt] Submission received:", {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      cleanLen: imageClean_b64?.length || 0,
      logoLen: imageLogo_b64?.length || 0,
      hasEmail: !!submitterEmail,
    });

    // Upload images
    const safe = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const base = `${safe(timestamp)}-${safe(nickname || "student")}`;
    const cleanUrl = imageClean_b64 ? await uploadFile(imageClean_b64, `${base}-clean.png`) : null;
    const logoUrl  = imageLogo_b64 ? await uploadFile(imageLogo_b64,  `${base}-logo.png`)  : null;

    // Build article
    const title = `Brick Art — ${nickname || "Student"} (${new Date(timestamp).toLocaleString("en-US")})`;
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

    // Create article
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
      return res.status(500).json({ ok: false, error: "Failed to create article" });
    }

    const articleId = articleJson?.article?.id;
    console.log("[BrickArt] Blog article created:", articleId);

    // Save submitter email as private metafield on the article (admin-only)
    if (articleId && submitterEmail) {
      const mfBody = {
        metafield: {
          namespace: "brickart",
          key: "submitter_email",
          type: "single_line_text_field",
          value: String(submitterEmail),
          owner_resource: "article",
          owner_id: articleId,
        },
      };

      try {
        const mfRes = await shopifyFetch("/metafields.json", {
          method: "POST",
          body: JSON.stringify(mfBody),
        });
        if (mfRes.ok) {
          console.log("[BrickArt] Metafield saved for email:", submitterEmail);
        } else {
          const mfText = await mfRes.text();
          console.warn("[BrickArt] Metafield save failed", mfRes.status, mfText?.slice(0, 200));
        }
      } catch (mErr) {
        console.error("[BrickArt] Metafield creation error", mErr);
      }
    }

    // Success response
    const handle = articleJson?.article?.handle;
    const blogHandle = articleJson?.article?.blog?.handle;
    const articleUrl = handle && blogHandle
      ? `https://${STORE}/blogs/${blogHandle}/${handle}`
      : null;

    return res.status(200).json({
      ok: true,
      articleId,
      articleUrl,
      files: { cleanUrl, logoUrl },
    });
  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    return res.status(500).json({ ok: false, error: "Server error", detail: String(err?.message || err) });
  }
}
