// api/submit.js
// Brick Art Publisher — rollback version that reliably uploads images to Shopify
// ENV required: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, BLOG_ID

export default async function handler(req, res) {
  // --- CORS (allow from your storefront + preflight) ---
  const ALLOW = new Set([
    "https://www.brick-art.com",
    "https://brick-art.com",
    "http://localhost:3000",
  ]);
  const origin = req.headers.origin || "";
  if (ALLOW.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- Env & base ---
  const requireEnv = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env: ${k}`);
    return v;
  };
  const STORE = requireEnv("SHOPIFY_STORE_DOMAIN");
  const TOKEN = requireEnv("SHOPIFY_ADMIN_API_TOKEN");
  const BLOG_ID = requireEnv("BLOG_ID");
  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  // --- Shopify fetch helper ---
  async function shopify(path, init = {}) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init.headers || {}),
    };
    return fetch(url, { ...init, headers });
  }

  // --- Sleep helper for polling ---
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- Upload base64 -> Shopify Files (REST /files.json with attachment) ---
  async function uploadFile(b64MaybeWithPrefix, filename) {
    if (!b64MaybeWithPrefix) return null;

    const raw = String(b64MaybeWithPrefix).replace(/^data:image\/\w+;base64,/, "");

    // Minimal, known-good payload: only attachment + filename
    const r = await shopify("/files.json", {
      method: "POST",
      body: JSON.stringify({
        file: {
          attachment: raw,
          filename,
        },
      }),
    });

    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}

    console.log("[BrickArt] POST /files.json", { status: r.status, ok: r.ok, bodyPreview: (text || "").slice(0, 160) });

    // If the API already returns a URL, use it immediately.
    let url =
      (json && json.file && json.file.url) ||
      (json && Array.isArray(json.files) && json.files[0] && json.files[0].url) ||
      null;

    // If no URL yet, poll the recent files list a few times and match by filename.
    if (!url) {
      for (let i = 0; i < 10 && !url; i++) {
        await sleep(700);
        const gr = await shopify("/files.json?limit=25&fields=id,created_at,updated_at,filename,url");
        const gt = await gr.text();
        let gj = null;
        try { gj = gt ? JSON.parse(gt) : null; } catch (_) {}

        const list = (gj && (gj.files || gj.file || [])) || [];
        const match = list.find((f) => {
          const fName = f.filename || f.file_name || "";
          const fUrl  = f.url || "";
          return (fName && fName.includes(filename)) || (fUrl && fUrl.includes(filename));
        });
        if (match && match.url) url = match.url;

        if (!url) console.log("[BrickArt] poll files (try", i + 1, ") — no url yet");
      }
    }

    if (!r.ok && !url) {
      throw new Error(`File upload failed: ${r.status} ${r.statusText} :: ${text || "<empty>"}`);
    }
    if (!url) throw new Error("File upload succeeded but no URL was found after polling.");

    return url;
  }

  try {
    // --- Parse body (stringified or object) ---
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
      submitterEmail, // optional, stored privately; never shown publicly
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing required fields (timestamp and at least one image)" });
    }

    console.log("[BrickArt] Submission received:", {
      nickname, category, grid, baseplate, totalBricks, timestamp,
      cleanLen: imageClean_b64 ? imageClean_b64.length : 0,
      logoLen:  imageLogo_b64  ? imageLogo_b64.length  : 0,
      hasEmail: !!submitterEmail,
    });

    // --- Upload images (in parallel) ---
    const safe = `${String(timestamp).replace(/[^\dA-Za-z]/g, "")}-${String(nickname || "student").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const [cleanUrl, logoUrl] = await Promise.all([
      uploadFile(imageClean_b64, `${safe}-clean.png`).catch((e) => { console.error("clean upload err", e); return null; }),
      uploadFile(imageLogo_b64,  `${safe}-logo.png`).catch((e)  => { console.error("logo upload err",  e); return null; }),
    ]);

    // --- Build article ---
    const niceTime = new Date(timestamp).toLocaleString("en-US", {
      hour12: true, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
    });
    const title = `Brick Art submission — ${nickname || "Brick artist"} (${niceTime})`;

    const esc = (s = "") => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
    const meta = [
      grid ? `Grid: ${grid}` : null,
      baseplate ? `Baseplate: ${baseplate}` : null,
      Number.isFinite(totalBricks) ? `Total Bricks: ${totalBricks}` : null,
    ].filter(Boolean).join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Brick artist")}</p>
      ${meta ? `<p>${esc(meta)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)" /></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}"  alt="Design (logo)"  /></p>` : ""}
    `;

    const ar = await shopify(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify({
        article: {
          title,
          body_html,
          tags: category ? String(category) : undefined,
        },
      }),
    });

    const articleText = await ar.text();
    let aj = null;
    try { aj = articleText ? JSON.parse(articleText) : null; } catch (_) {}
    if (!ar.ok) {
      console.error("[BrickArt] blog create failed", ar.status, ar.statusText, (articleText || "").slice(0, 160));
      return res.status(500).json({ ok: false, error: "Create article failed" });
    }

    const articleId = aj?.article?.id;

    // --- Store submitter email privately (non-blocking) ---
    if (articleId && submitterEmail) {
      try {
        const mfRes = await shopify(`/articles/${articleId}/metafields.json`, {
          method: "POST",
          body: JSON.stringify({
            metafield: {
              namespace: "brickart",
              key: "submitter_email",
              type: "single_line_text_field",
              value: String(submitterEmail),
            },
          }),
        });
        const mfTxt = await mfRes.text();
        console.log("[BrickArt] metafield result", { status: mfRes.status, ok: mfRes.ok, bodyPreview: (mfTxt || "").slice(0, 160) });
      } catch (mfe) {
        console.warn("[BrickArt] metafield save skipped/failed", mfe);
      }
    }

    // --- Success ---
    const handle = aj?.article?.handle;
    const blogHandle = aj?.article?.blog?.handle;
    const storefrontUrl = (handle && blogHandle) ? `https://${STORE}/blogs/${blogHandle}/${handle}` : null;

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
      detail: String(err && err.message ? err.message : err),
    });
  }
}
