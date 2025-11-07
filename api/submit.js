// /api/submit.js
// Brick Art Publisher — receives designer submissions and publishes to Shopify

export default async function handler(req, res) {
  // --- 1) CORS (allow from your storefront) ---
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

  // --- 2) Required env ---
  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing environment variable: ${k}`);
    return v;
  };
  const STORE = need("SHOPIFY_STORE_DOMAIN");         // e.g. ek4iwc-kq.myshopify.com
  const ADMIN = need("SHOPIFY_ADMIN_API_TOKEN");
  const BLOG_ID = need("BLOG_ID");                     // numeric blog id (not handle)
  const API_VERSION = "2024-07";

  // --- 3) Small helpers ---
  const esc = (s = "") => String(s).replace(/[&<>"]/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;"
  }[m]));

  async function shopifyREST(path, init = {}) {
    const url = `https://${STORE}/admin/api/${API_VERSION}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": ADMIN,
      Accept: "application/json",
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    };
    console.log("[BrickArt] ->", url);
    const r = await fetch(url, { ...init, headers });
    return r;
  }

  // Upload base64 to Shopify Files using JSON (file.attachment)
async function uploadToFiles(b64MaybePrefixed, filename) {
  if (!b64MaybePrefixed) return null;

  // strip any data URL prefix and whitespace
  const base64 = String(b64MaybePrefixed)
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
    .replace(/\s+/g, "");

  if (base64.length < 80) {
    console.warn("[BrickArt] base64 too short:", filename, base64.length);
    return null;
  }

  // JSON body with file.attachment + filename
  const body = {
    file: {
      attachment: base64,      // ✅ NOT "content"
      filename,                // ✅ keep this
      // DO NOT send file_type or mime_type — they cause 406 on some stores
    },
  };

  const r = await shopifyREST("/files.json", {
    method: "POST",
    body: JSON.stringify(body),       // headers (Accept + Content-Type) are set in shopifyREST
  });

  const txt = await r.text();
  console.log("[BrickArt] /files.json (JSON) ->", { status: r.status, ok: r.ok, preview: (txt || "").slice(0, 140) });

  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch {}

  // Try to read the URL directly
  let url = json?.file?.url || (Array.isArray(json?.files) ? json.files[0]?.url : null) || null;
  if (url) return url;

  if (!r.ok) {
    throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
  }

  // Fallback: poll by filename for up to ~15s
  const started = Date.now();
  const timeoutMs = 15000;
  while (!url && Date.now() - started < timeoutMs) {
    await new Promise((s) => setTimeout(s, 1000));
    const pr = await shopifyREST("/files.json?limit=25&fields=filename,url,created_at,updated_at", { method: "GET" });
    const pt = await pr.text();
    let pj = null;
    try { pj = pt ? JSON.parse(pt) : null; } catch {}
    const hit = (pj?.files || []).find(f => f?.filename === filename || f?.url?.includes(filename));
    if (hit?.url) { url = hit.url; break; }
  }

  if (!url) throw new Error("File appeared to upload but no URL was returned.");
  console.log("[BrickArt] File ready:", url);
  return url;
}

  try {
    // --- 4) Parse body safely ---
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
      submitterEmail,         // from frontend (not public), optional
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing required fields (timestamp + at least one image)" });
    }

    console.log("[BrickArt] Submission received:", {
      nickname, category, grid, baseplate, totalBricks, timestamp,
      cleanLen: imageClean_b64 ? imageClean_b64.length : 0,
      logoLen: imageLogo_b64 ? imageLogo_b64.length : 0,
      hasEmail: !!submitterEmail,
    });

    const safe = `${String(timestamp).replace(/[^\dTZ:-]/g, "")}-${String(nickname || "student").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 80);

    // --- 5) Upload images (parallel) ---
    const [cleanUrl, logoUrl] = await Promise.all([
      uploadToFiles(imageClean_b64, `${safe}-clean.png`),
      uploadToFiles(imageLogo_b64,  `${safe}-logo.png`),
    ]);

    // --- 6) Create blog article ---
    const when = new Date(timestamp);
    const niceTime = when.toLocaleString("en-US", {
      hour12: true, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });

    const metaBits = [
      grid ? `Grid: ${grid}` : null,
      baseplate ? `Baseplate: ${baseplate}` : null,
      Number.isFinite(totalBricks) ? `Total Bricks: ${totalBricks}` : null,
    ].filter(Boolean).join(" · ");

    const body_html =
      `<p><strong>Nickname:</strong> ${esc(nickname || "Student")}</p>` +
      (metaBits ? `<p>${esc(metaBits)}</p>` : "") +
      (cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)"></p>` : "") +
      (logoUrl  ? `<p><img src="${logoUrl}" alt="Design (logo)"></p>` : "");

    const articlePayload = {
      article: {
        title: `Brick Art submission — ${nickname || "Student"} (${niceTime})`,
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
    try { aj = articleText ? JSON.parse(articleText) : {}; } catch (e) {}
    if (!ar.ok) {
      console.error("[BrickArt] Blog create FAILED", ar.status, ar.statusText, (articleText || "").slice(0, 200));
      return res.status(500).json({ ok: false, error: "Failed to create article" });
    }

    const articleId = aj?.article?.id;
    const handle = aj?.article?.handle;
    const blogHandle = aj?.article?.blog?.handle;
    const storefrontUrl = (handle && blogHandle) ? `https://${STORE}/blogs/${blogHandle}/${handle}` : null;

    // --- 7) Save submitter email privately on the article (metafield) ---
    try {
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
        const mfRes = await shopifyREST("/metafields.json", {
          method: "POST",
          body: JSON.stringify(mfBody),
        });
        const mfTxt = await mfRes.text();
        console.log("[BrickArt] metafield result ->", { status: mfRes.status, ok: mfRes.ok, preview: (mfTxt || "").slice(0, 120) });
      }
    } catch (mfe) {
      console.error("[BrickArt] metafield creation error", mfe);
      // do not fail the whole request on metafield issues
    }

    // --- 8) Done ---
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
