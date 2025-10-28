export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const submission = req.body;

    const {
      nickname = "Unknown Artist",
      category = "Uncategorized",
      grid = "Unknown",
      baseplate = "Unknown",
      totalBricks = "Unknown",
      brickCounts = {},
      imageClean_b64,
      imageLogo_b64,
      timestamp = "",
    } = submission;

    const brickListHtml = Object.entries(brickCounts)
      .map(([color, count]) => `<li>${color} – ${count}</li>`)
      .join("");

    const cleanImgTag = imageClean_b64
      ? `<img style="max-width:100%;height:auto;" alt="Clean version of ${nickname}'s mosaic" src="data:image/png;base64,${imageClean_b64}" />`
      : "";

    const logoImgTag = imageLogo_b64
      ? `<img style="max-width:100%;height:auto;" alt="Brick Art Gallery version of ${nickname}'s mosaic" src="data:image/png;base64,${imageLogo_b64}" />`
      : "";

    const articleHtml = `
      <p><strong>Artist:</strong> ${nickname}</p>
      <p><strong>Category:</strong> ${category}</p>
      <p><strong>Grid Size:</strong> ${grid} x ${grid}</p>
      <p><strong>Baseplate:</strong> ${baseplate}</p>
      <p><strong>Total Bricks:</strong> ${totalBricks}</p>
      ${
        brickListHtml
          ? `<p><strong>Brick Breakdown:</strong></p><ul>${brickListHtml}</ul>`
          : ""
      }
      ${cleanImgTag ? `<p><strong>Original Mosaic:</strong></p>${cleanImgTag}` : ""}
      ${logoImgTag ? `<p><strong>Brick Art Gallery Mosaic:</strong></p>${logoImgTag}` : ""}
      <p><em>Submitted on ${timestamp}</em></p>
    `;

    const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
    const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
    const BLOG_ID = process.env.BLOG_ID;

    if (!SHOPIFY_DOMAIN || !ADMIN_TOKEN || !BLOG_ID) {
      return res.status(500).json({
        ok: false,
        error: "Missing SHOPIFY_DOMAIN / SHOPIFY_ADMIN_API_TOKEN / BLOG_ID",
      });
    }

    const apiPath = `https://${SHOPIFY_DOMAIN}/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`;

    const payload = {
      article: {
        title: `Clean mosaic by ${nickname}`,
        body_html: articleHtml,
        tags: [category, `${grid}x${grid}`, baseplate].join(", "),
        published_at: null,
      },
    };

    const shopifyResp = await fetch(apiPath, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const shopifyJson = await shopifyResp.json();

    if (!shopifyResp.ok) {
      return res.status(502).json({ ok: false, error: "Shopify error", shopifyJson });
    }

    return res.status(200).json({ ok: true, created: shopifyJson });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || err });
  }
}
