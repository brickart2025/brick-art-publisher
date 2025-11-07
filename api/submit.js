// api/submit.js
// Brick Art Publisher — image-in-article version (matches your 3:15pm success)
// ENV: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, BLOG_ID

export default async function handler(req, res) {
  // ----- CORS -----
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

  // ----- Env + helpers -----
  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env: ${k}`);
    return v;
  };
  const STORE = need("SHOPIFY_STORE_DOMAIN");
  const TOKEN = need("SHOPIFY_ADMIN_API_TOKEN");
  const BLOG_ID = need("BLOG_ID");
  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  const shopify = (path, init = {}) => {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init.headers || {}),
    };
    return fetch(url, { ...init, headers });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function uploadToFiles(b64MaybePrefixed, filename) {
    if (!b64MaybePrefixed) return null;
    const raw = String(b64MaybePrefixed).replace(/^data:image\/\w+;base64,/, "");

    // Minimal, accepted payload
    const r = await shopify("/files.json", {
      method: "POST",
      body: JSON.stringify({ file: { attachment: raw, filename } }),
    });

    const txt = await r.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch {}
    console.log("[BrickArt] /files.json POST", { status: r.status, ok: r.ok, preview: (txt || "").slice(0, 160) });

    // Try immediate URL
    let url =
      json?.file?.url ||
      (Array.isArray(json?.files) ? json.files[0]?.url : null) ||
      null;

    // If no URL, poll for it by filename (Shopify can be async here)
    if (!url) {
      const maxTries = 20; // ~14s
      for (let i = 0; i < maxTries && !url; i++) {
        await sleep(700);
        const gr = await shopify("/files.json?limit=25&fields=filename,url,created_at,updated_at");
        const gt = await gr.text();
        let gj = null;
        try { gj = gt ? JSON.parse(gt) : null; } catch {}
        const list = Array.isArray(gj?.files) ? gj.files : [];
        const hit = list.find((f) => (f.filename || "").includes(filename));
        if (hit?.url) url = hit.url;
        if (!url) console.log("[BrickArt] poll files… try", i + 1);
      }
    }

    if (!r.ok && !url) {
      throw new Error(`File upload failed: ${r.status} ${r.statusText} :: ${txt || "<empty>"}`);
    }
    if (!url) throw new Error("Upload finished but no CDN URL was found.");
    console.log("[BrickArt] file ready:", url);
    return url;
  }

  try {
    // ----- Parse body -----
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
      submitterEmail,     // preferred
      userEmail,          // legacy key (frontend might send this)
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing timestamp or images" });
    }

    const privateEmail = submitterEmail || userEmail || null;

    console.log("[BrickArt] Submission", {
      nickname, category, grid, baseplate, totalBricks, timestamp,
      cleanLen: imageClean_b64 ? imageClean_b64.length : 0,
      logoLen: imageLogo_b64 ? imageLogo_b64.length : 0,
      hasEmail: !!privateEmail,
    });

    // ----- Upload images (parallel) -----
    const safeBase = `${String(timestamp).replace(/[^\dA-Za-z]/g, "")}-${String(nickname || "artist").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const [cleanUrl, logoUrl] = await Promise.all([
      uploadToFiles(imageClean_b64, `${safeBase}-clean.png`).catch((e) => { console.error("clean upload err", e); return null; }),
      uploadToFiles(imageLogo_b64,  `${safeBase}-logo.png`).catch((e)  => { console.error("logo upload err",  e); return null; }),
    ]);

    // ----- Create article with images in body_html -----
    const esc = (s = "") => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
    const niceTime = new Date(timestamp).toLocaleString("en-US", {
      hour12: true, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit",
    });
    const title = `Brick Art submission — ${nickname || "Brick artist"} (${niceTime})`;
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
      body: JSON.stringify({ article: { title, body_html, tags: category ? String(category) : undefined } }),
    });

    const articleText = await ar.text();
    let aj = null;
    try { aj = articleText ? JSON.parse(articleText) : null; } catch {}
    if (!ar.ok) {
      console.error("[BrickArt] article create failed", ar.status, ar.statusText, (articleText || "").slice(0, 160));
      return res.status(500).json({ ok: false, error: "Create article failed" });
    }

    const articleId = aj?.article?.id;

    // ----- Save email privately (non-blocking) -----
    if (articleId && privateEmail) {
      try {
        const mf = await shopify(`/articles/${articleId}/metafields.json`, {
          method: "POST",
          body: JSON.stringify({
            metafield: {
              namespace: "brickart",
              key: "submitter_email",
              type: "single_line_text_field",
              value: String(privateEmail),
            },
          }),
        });
        const mfTxt = await mf.text();
        console.log("[BrickArt] metafield result", { status: mf.status, ok: mf.ok, preview: (mfTxt || "").slice(0, 160) });
      } catch (mfe) {
        console.warn("[BrickArt] metafield save skipped/failed", mfe);
      }
    }

    const handle = aj?.article?.handle;
    const blogHandle = aj?.article?.blog?.handle;
    const articleUrl = (handle && blogHandle) ? `https://${STORE}/blogs/${blogHandle}/${handle}` : null;

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
