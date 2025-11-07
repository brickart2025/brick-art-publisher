// /api/submit.js — Brick Art Publisher (stable, with baseplate tags + email metafield)
// Works with Shopify Admin REST 2024-07

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
  const STORE = need("SHOPIFY_STORE_DOMAIN");         // e.g. yourstore.myshopify.com
  const ADMIN = need("SHOPIFY_ADMIN_API_TOKEN");
  const BLOG_ID = need("BLOG_ID");                     // numeric blog id
  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  // ---------- 3) Helpers ----------
  async function shopifyREST(path, init = {}) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": ADMIN,
      "Accept": "application/json",
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    };
    console.log("[BrickArt] ->", url);
    return fetch(url, { ...init, headers });
  }

  const esc = (s = "") =>
    String(s).replace(/[&<>"]/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));

  // Upload via JSON body: { file: { attachment, filename } }
  async function uploadToFiles(b64MaybePrefixed, filename) {
    if (!b64MaybePrefixed) return null;

    const base64 = String(b64MaybePrefixed)
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
      .replace(/\s+/g, "");

    if (base64.length < 100) {
      console.warn("[BrickArt] base64 too short:", filename, base64.length);
      return null;
    }

    const body = { file: { attachment: base64, filename } };

    const r = await shopifyREST("/files.json", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const txt = await r.text();
    console.log("[BrickArt] /files.json →", r.status, (txt || "").slice(0, 160));

    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch {}

    let url = json?.file?.url || (Array.isArray(json?.files) ? json.files[0]?.url : null) || null;
    if (url) return url;

    if (r.status >= 400) {
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    // Poll for URL if not returned immediately
    const started = Date.now();
    const limitMs = 20_000;
    while (!url && Date.now() - started < limitMs) {
      await new Promise((s) => setTimeout(s, 1000));
      const pr = await shopifyREST("/files.json?limit=25&fields=filename,url,created_at,updated_at", { method: "GET" });
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

  try {
    // ---------- 4) Parse payload ----------
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      nickname,
      category,           // human category (will be passed as tag too)
      grid,               // "16" or "32" etc. (optional)
      baseplate,          // e.g., "Blue 16x16", "White 32x32", "No plate 16x16"
      totalBricks,
      brickCounts,
      timestamp,
      imageClean_b64,     // keep as-is (PNG from frontend)
      imageLogo_b64,      // may be JPEG after your shrink; fine either way
      submitterEmail,     // private (metafield)
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing required fields (timestamp + at least one image)" });
    }

    console.log("[BrickArt] Submission received:", {
      nickname, category, grid, baseplate, totalBricks, timestamp,
      cleanLen: imageClean_b64?.length || 0,
      logoLen: imageLogo_b64?.length || 0,
      hasEmail: !!submitterEmail,
    });

    // ---------- 5) Build filenames ----------
    const safe =
      `${String(timestamp).replace(/[^\dA-Za-z]/g, "")}-${String(nickname || "student").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 120);

    const cleanName = `${safe}-clean.png`; // keep clean PNG
    // If your frontend converted the logo to JPEG, extension here doesn’t matter to Shopify; it's fine.
    const logoName  = `${safe}-logo.jpg`;

    // ---------- 6) Upload images ----------
    const [cleanUrl, logoUrl] = await Promise.all([
      uploadToFiles(imageClean_b64, cleanName),
      uploadToFiles(imageLogo_b64,  logoName),
    ]);

    // ---------- 7) Build article body ----------
    const niceTime = new Date(timestamp).toLocaleString("en-US", {
      hour12: true, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });

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

    // ---------- 8) Tags: category + plate-<color> ----------
    const plateSlug = baseplate
      ? `plate-${String(baseplate).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-(16x16|32x32|33x23)$/,'')}` // drop size suffix in tag
      : null;

    // Category may be a single string; use as-is. If you ever send multiple, join them.
    const tagList = [category, plateSlug].filter(Boolean).join(", ");

    // ---------- 9) Create the blog article ----------
    const articlePayload = {
      article: {
        title: `Brick Art submission — ${nickname || "Student"} (${niceTime})`,
        body_html,
        tags: tagList,
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

    // ---------- 10) Save submitter email (private metafield) ----------
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
      tagsApplied: tagList,
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
