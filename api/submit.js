// api/submit.js — Brick Art Publisher (Node runtime)

// If you’re using Next.js/Vercel default Node runtime, this export is fine:
export default async function handler(req, res) {
  // --- 1) CORS ---
  res.setHeader("Access-Control-Allow-Origin", "https://www.brick-art.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // --- 2) Allow only POST ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    // --- 3) Parse request body ---
    const {
      nickname,
      timestamp,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts,
      imageClean_b64,
      imageLogo_b64,
    } = req.body || {};

    // --- 4) Basic validation ---
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
      logoLength:  imageLogo_b64?.length  || 0,
    });

    // --- 5) Env vars ---
    const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;      // e.g. brick-art.myshopify.com
    const ADMIN_TOKEN    = process.env.SHOPIFY_ADMIN_API_TOKEN;   // Admin API access token
    const BLOG_ID        = process.env.BLOG_ID;                    // Target blog id (number)
    const API_VERSION    = "2024-10";

    if (!SHOPIFY_DOMAIN || !ADMIN_TOKEN || !BLOG_ID) {
      throw new Error("Missing env: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, or BLOG_ID");
    }

    // --- 6) Simple Shopify client ---
    const shopifyFetch = (path, init = {}) => {
      const url = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}${path}`;
      const headers = {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      };
      return fetch(url, { ...init, headers });
    };

  // --- 7) Upload a base64 PNG to Shopify Files ---
const uploadFile = async (b64, filename) => {
  if (!b64) return null;
  const body = { file: { attachment: b64, filename, mime_type: "image/png" } };

  const r = await shopifyFetch(`/files.json`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  let j = null;
  try {
    j = await r.json(); // try parsing JSON if body exists
  } catch (e) {
    console.error("[BrickArt] Shopify upload: response not JSON", e);
  }

  if (!r.ok) {
    console.error("[BrickArt] File upload failed:", r.status, j || await r.text());
    throw new Error(`File upload failed: ${r.status}`);
  }

  console.log("[BrickArt] File upload success", j);
  return j?.file?.url || j?.files?.[0]?.url || null;
};

    // --- 8) Helpers for article content ---
    const esc = (s = "") =>
      String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
    const niceTime = new Date(timestamp).toLocaleString("en-US", { hour12: true });

    const baseName =
      `${timestamp.replace(/[:.Z-]/g, "")}-${(nickname || "student")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`;

    // --- 9) Upload images ---
    const cleanUrl = await uploadFile(imageClean_b64, `${baseName}-clean.png`);
    const logoUrl  = await uploadFile(imageLogo_b64,  `${baseName}-logo.png`);

    // --- 10) Build article body ---
    const title = `Brick Art submission — ${nickname || "Student"} (${niceTime})`;
    const meta  = [
      grid ? `Grid: ${grid}` : null,
      baseplate ? `Baseplate: ${baseplate}` : null,
      Number.isFinite(totalBricks) ? `Total Bricks: ${totalBricks}` : null,
    ].filter(Boolean).join(" • ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Student")}</p>
      ${meta ? `<p>${esc(meta)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Design (clean)" /></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}"  alt="Design (with logo)" /></p>` : ""}
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
    const aj = await ar.json();

    if (!ar.ok) {
      console.error("Create article failed", ar.status, aj);
      throw new Error(`Create article failed: ${ar.status}`);
    }

    const articleUrl = aj.article?.handle
      ? `https://${SHOPIFY_DOMAIN}/blogs/${aj.article.blog_id}/${aj.article.handle}`
      : undefined;

    // --- 12) Done ---
    return res.status(200).json({
      ok: true,
      articleId: aj.article?.id,
      articleUrl,
      files: { cleanUrl, logoUrl },
    });

  } catch (err) {
    console.error("[BrickArt] Server error:", err);
    return res.status(500).json({ ok: false, error: "Server error", details: err.message });
  }
}
