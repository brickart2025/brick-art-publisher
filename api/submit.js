// /api/submit.js — Brick Art Publisher (ROLLBACK / STABLE)
// Works with Shopify Admin REST 2024-07
// - Uploads PNGs via /files.json using JSON { file: { attachment, filename } }
// - Creates blog article with both images in body_html
// - Stores submitter email privately on the article as a metafield
// - CORS allowlist for storefront + localhost

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

  // ---------- 2) Env ----------
  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  const STORE = need("SHOPIFY_STORE_DOMAIN");         // e.g. ek4iwc-kq.myshopify.com
  const ADMIN = need("SHOPIFY_ADMIN_API_TOKEN");
  const BLOG_ID = need("BLOG_ID");                     // numeric blog id

  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  // ---------- 3) Shopify fetch helper ----------
  async function shopifyREST(path, init = {}) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": ADMIN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init.headers || {}),
    };
    return fetch(url, { ...init, headers });
  }

  // ---------- 4) Upload helper (JSON attachment + polling) ----------
  async function uploadToFiles(b64MaybePrefixed, filename) {
    if (!b64MaybePrefixed) return null;

    const base64 = String(b64MaybePrefixed)
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
      .replace(/\s+/g, "");

    if (base64.length < 100) {
      console.warn("[BrickArt] base64 too short:", filename, base64.length);
      return null;
    }

    const body = { file: { attachment: base64, filename } }; // ✅ the working recipe

    const r = await shopifyREST("/files.json", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const txt = await r.text();
    console.log("[BrickArt] /files.json →", r.status, (txt || "").slice(0, 160));

    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch {}

    // Some stores return the URL immediately, some are delayed
    let url =
      json?.file?.url ||
      (Array.isArray(json?.files) ? json.files[0]?.url : null) ||
      null;

    if (url) return url;

    if (r.status >= 400) {
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    // Poll by filename (Shopify sometimes needs a sec to process)
    const started = Date.now();
    const limitMs = 20_000;
    while (!url && Date.now() - started < limitMs) {
      await new Promise((s) => setTimeout(s, 1000));
      const pr = await shopifyREST(
        "/files.json?limit=25&fields=filename,url,created_at,updated_at",
        { method: "GET" }
      );
      const pt = await pr.text();
      let pj = null;
      try { pj = pt ? JSON.parse(pt) : null; } catch {}
      const match = (pj?.files || []).find(
        (f) => f?.filename === filename || f?.url?.includes(filename)
      );
      if (match?.url) {
        url = match.url;
        break;
      }
    }

    if (!url) throw new Error("File appeared to upload but no URL was returned");
    console.log("[BrickArt] File ready:", url);
    return url;
  }

  // ---------- 5) Safe HTML ----------
  const esc = (s = "") =>
    String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  try {
    // ---------- 6) Parse payload ----------
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
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
      submitterEmail,          // from frontend; saved privately
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    console.log("[BrickArt] Submission received:", {
      nickname, category, grid, baseplate, totalBricks,
      cleanLen: imageClean_b64?.length || 0,
      logoLen: imageLogo_b64?.length || 0,
      hasEmail: !!submitterEmail,
    });

    // ---------- 7) Filenames ----------
    const safe = `${String(timestamp).replace(/[^\dA-Za-z]/g, "")}-${String(nickname || "student")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`.slice(0, 120);

    // ---------- 8) Upload images (parallel) ----------
    const [cleanUrl, logoUrl] = await Promise.all([
      uploadToFiles(imageClean_b64, `${safe}-clean.png`),
      uploadToFiles(imageLogo_b64,  `${safe}-logo.png`),
    ]);

    // ---------- 9) Build article ----------
    const niceTime = new Date(timestamp).toLocaleString("en-US", {
      hour12: true, year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });

    const title = `Brick Art submission — ${nickname || "Student"} (${niceTime})`;
    const metaBits = [
      grid ? `Grid: ${grid}` : null,
      baseplate ? `Baseplate: ${baseplate}` : null,
      Number.isFinite(totalBricks) ? `Total Bricks: ${totalBricks}` : null,
    ].filter(Boolean).join(" · ");

    const body_html = [
      `<p><strong>Nickname:</strong> ${esc(nickname || "Student")}</p>`,
      metaBits ? `<p>${esc(metaBits)}</p>` : "",
      cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)"></p>` : "",
      logoUrl  ? `<p><img src="${logoUrl}"  alt="Design (logo)"></p>`  : "",
    ].join("\n");

    const articlePayload = {
      article: {
        title,
        body_html,
        tags: category ? String(category) : undefined,
      },
    };

    const ar = await shopifyREST(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(articlePayload),
    });
    const articleText = await ar.text();
    let aj = {};
    try { aj = articleText ? JSON.parse(articleText) : {}; } catch {}
    if (!ar.ok) {
      console.error("[BrickArt] Blog create FAILED", ar.status, ar.statusText, articleText?.slice(0, 300));
      return res.status(500).json({ ok: false, error: "Failed to create article" });
    }

    const articleId = aj?.article?.id;

    // ---------- 10) Save submitter email privately (metafield) ----------
    if (articleId && submitterEmail) {
      try {
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
        const mfRes = await shopifyREST("/metafields.json", {
          method: "POST",
          body: JSON.stringify(mfBody),
        });
        const mfTxt = await mfRes.text();
        console.log("[BrickArt] metafield save", mfRes.status, (mfTxt || "").slice(0, 140));
      } catch (mfe) {
        console.warn("[BrickArt] metafield save error:", mfe);
      }
    }

    // ---------- 11) Respond ----------
    const handle = aj?.article?.handle;
    const blogHandle = aj?.article?.blog?.handle;
    const storefrontUrl = handle && blogHandle
      ? `https://${STORE}/blogs/${blogHandle}/${handle}`
      : null;

    return res.status(200).json({
      ok: true,
      articleId,
      articleUrl: storefrontUrl,
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
