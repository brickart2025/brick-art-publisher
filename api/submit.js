// /api/submit.js — Brick Art Publisher (Shopify Files upload)
// Requires env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, BLOG_ID

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "https://www.brick-art.com");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "https://www.brick-art.com");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
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
      submitterEmail
    } = req.body;

    const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
    const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
    const BLOG_ID = process.env.BLOG_ID;

    // ---- Helper: upload base64 image to Shopify Files API ----
    async function uploadImage(b64, filename) {
      if (!b64) return null;

      // Strip prefix if present
      const cleanB64 = b64.replace(/^data:image\/png;base64,/, "");
      const buf = Buffer.from(cleanB64, "base64");
      const encoded = buf.toString("base64");

      const uploadRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/2024-07/files.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_TOKEN,
          },
          body: JSON.stringify({
            file: {
              attachment: encoded,
              filename: filename,
              content_type: "image/png"
            },
          }),
        }
      );

      const uploadData = await uploadRes.json();
      console.log("[BrickArt] → /files.json", uploadData);

      if (!uploadRes.ok || !uploadData.file?.url) {
        throw new Error(`File upload failed: ${uploadRes.status} ${uploadData?.errors || ''}`);
      }
      return uploadData.file.url;
    }

    console.log("[BrickArt] Submission received", { nickname, baseplate, totalBricks });

    const cleanUrl = await uploadImage(imageClean_b64, `${nickname}-${Date.now()}-clean.png`);
    const logoUrl = await uploadImage(imageLogo_b64, `${nickname}-${Date.now()}-logo.png`);

    // ---- Create blog article ----
    const articleBody = `
      <p><strong>Nickname:</strong> ${nickname}</p>
      <p>Grid: ${grid} · Baseplate: ${baseplate} · Total Bricks: ${totalBricks}</p>
      ${logoUrl ? `<img src="${logoUrl}" alt="${nickname}" />` : ""}
    `;

    const articleRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
        body: JSON.stringify({
          article: {
            title: `Brick Art submission — ${nickname} (${timestamp})`,
            author: "Shopify API",
            tags: [category, grid === "16" ? "16x16" : "32x32", baseplate],
            body_html: articleBody,
            image: cleanUrl ? { src: cleanUrl } : undefined,
          },
        }),
      }
    );

    const articleData = await articleRes.json();

    if (!articleRes.ok) {
      console.error("[BrickArt] Article creation failed:", articleData);
      throw new Error("Article creation failed");
    }

    console.log("[BrickArt] Submission success", articleData.article?.id);
    res.status(200).json({ ok: true, articleId: articleData.article?.id });
  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    res.status(500).json({ ok: false, error: "Server error", detail: err.message });
  }
}
