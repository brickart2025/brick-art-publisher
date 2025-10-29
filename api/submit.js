export const config = {
  runtime: "nodejs"
};

import axios from "axios";

export default async function handler(req, res) {
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
      imageClean,
      imageLogo,
      timestamp,
    } = req.body || {};

    const articleHtml = `
      <p><strong>Artist:</strong> ${nickname || "Unknown Artist"}</p>
      <p><strong>Category:</strong> ${category || "Uncategorized"}</p>
      <p><strong>Grid Size:</strong> ${grid || "?"} x ${grid || "?"}</p>
      <p><strong>Baseplate:</strong> ${baseplate || "?"}</p>
      <p><strong>Total Bricks:</strong> ${totalBricks || "0"}</p>
      ${brickCounts ? `<ul>${Object.entries(brickCounts)
        .map(([color, count]) => `<li>${color}: ${count}</li>`)
        .join("")}</ul>` : ""}
      ${imageClean ? `<p><img src="${imageClean}" style="max-width:100%"/></p>` : ""}
      ${imageLogo ? `<p><img src="${imageLogo}" style="max-width:100%"/></p>` : ""}
    `;

    const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
    const BLOG_ID = process.env.SHOPIFY_BLOG_ID;
    const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    const url = `https://${SHOP_DOMAIN}/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`;
    const payload = {
      article: {
        title: nickname || "New Brick Art Submission",
        body_html: articleHtml,
        tags: [category, `${grid}x${grid}`, baseplate].join(", "),
        published_at: null,
      },
    };

    const shopifyResp = await axios.post(url, payload, {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    });

    return res.status(200).json({
      ok: true,
      articleId: shopifyResp.data.article?.id || null,
    });
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
}
