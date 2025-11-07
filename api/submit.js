// /api/submit.js — Brick Art Publisher (stable + brick counts table)
// Keeps your working Files upload; only adds a table of brickCounts to body_html.

export default async function handler(req, res) {
  // --- CORS (same simple allow list you used before) ---
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

  // --- Env ---
  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing environment variable: ${k}`);
    return v;
  };
  const STORE = need("SHOPIFY_STORE_DOMAIN");        // e.g. yourstore.myshopify.com
  const TOKEN = need("SHOPIFY_ADMIN_API_TOKEN");
  const BLOG_ID = need("BLOG_ID");
  const API_VERSION = "2024-07";
  const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

  // --- Helpers ---
  const esc = (s = "") => String(s).replace(/[&<>"]/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  }[m]));

  // Render Brick Counts table for article body (NEW)
  function countsTableHtml(brickCounts) {
    if (!brickCounts || typeof brickCounts !== "object") return "";
    const rows = Object.entries(brickCounts)
      .filter(([_, qty]) => Number(qty) > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([color, qty]) => (
        `<tr>
           <td style="padding:4px 8px;border:1px solid #e5e7eb;">${String(color)}</td>
           <td style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right;">${qty}</td>
         </tr>`
      ))
      .join("");
    if (!rows) return "";
    return `
      <div style="margin-top:10px;">
        <div style="font-weight:700;margin:6px 0;">Brick Colors &amp; Quantities</div>
        <table style="border-collapse:collapse;font-size:14px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:4px 8px;border:1px solid #e5e7eb;">Color</th>
              <th style="text-align:right;padding:4px 8px;border:1px solid #e5e7eb;">Qty</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function toRawBase64(dataUrl = "") {
    return String(dataUrl).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
  }

  async function shopifyFetch(path, init = {}) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    };
    console.log("[BrickArt] →", url);
    const r = await fetch(url, { ...init, headers });
    return r;
  }

  // Upload via Files API using JSON 'attachment' (your working approach)
  async function uploadFile(b64, filename) {
    if (!b64) return null;
    const attachment = toRawBase64(b64);
    if (!attachment) return null;

    const r = await shopifyFetch("/files.json", {
      method: "POST",
      body: JSON.stringify({ file: { attachment, filename } }),
    });

    const txt = await r.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch {}

    if (!r.ok) {
      console.error("[BrickArt] File upload failed:", r.status, r.statusText, (txt || "").slice(0, 300));
      throw new Error(`File upload failed: ${r.status} ${r.statusText}`);
    }

    const url = json?.file?.url || (Array.isArray(json?.files) ? json.files[0]?.url : null) || null;
    console.log("[BrickArt] File stored:", url);
    return url;
  }

  try {
    // --- Parse payload ---
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts,        // <-- we'll render this
      timestamp,
      imageClean_b64,
      imageLogo_b64,
    } = body;

    if (!timestamp) {
      return res.status(400).json({ ok: false, error: "Missing timestamp" });
    }

    console.log("[BrickArt] Submission received:", {
      nickname, category, grid, baseplate, totalBricks,
      cleanLen: imageClean_b64?.length || 0,
      logoLen: imageLogo_b64?.length || 0,
    });

    // --- Filenames ---
    const safeBase =
      `${String(timestamp).replace(/[^\dA-Za-z]/g, "")}-${String(nickname || "student").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      .slice(0, 120);
    const cleanName = `${safeBase}-clean.png`;
    const logoName  = `${safeBase}-logo.png`;

    // --- Upload images (unchanged behavior) ---
    const cleanUrl = await uploadFile(imageClean_b64, cleanName);
    const logoUrl  = await uploadFile(imageLogo_b64,  logoName);

    // --- Build article body (only addition is the table) ---
    const niceTime = new Date(timestamp).toLocaleString("en-US", {
      hour12: true, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });

    const metaLine = [
      grid ? `Grid: ${grid}` : null,
      baseplate ? `Baseplate: ${baseplate}` : null,
      Number.isFinite(totalBricks) ? `Total Bricks: ${totalBricks}` : null,
    ].filter(Boolean).join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Student")}</p>
      ${metaLine ? `<p>${esc(metaLine)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)" /></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}"  alt="Design (logo)"  /></p>`  : ""}
      ${countsTableHtml(brickCounts)}
    `.trim();

    // --- Create article (keeps your original style: category as tag) ---
    const articlePayload = {
      article: {
        title: `Brick Art submission — ${nickname || "Student"} (${niceTime})`,
        body_html,
        tags: category || undefined,
      },
    };

    const ar = await shopifyFetch(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(articlePayload),
    });

    const atxt = await ar.text();
    let aj = {};
    try { aj = atxt ? JSON.parse(atxt) : {}; } catch {}
    if (!ar.ok) {
      console.error("[BrickArt] Blog create failed:", ar.status, ar.statusText, (atxt || "").slice(0, 300));
      return res.status(500).json({ ok: false, error: "Failed to create blog post" });
    }

    return res.status(200).json({
      ok: true,
      articleId: aj?.article?.id,
      cleanUrl,
      logoUrl,
    });
  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    return res.status(500).json({ ok: false, error: "Server error", detail: String(err?.message || err) });
  }
}
