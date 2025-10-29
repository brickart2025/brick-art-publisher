// api/submit.js  — Brick Art Publisher (images + post)
// Handles POSTs from the mosaic tool and creates a draft article in Shopify.
// Also uploads the student's images (clean + branded) to Shopify Files.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // 1. Grab the incoming submission body
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts, // { colorName: count, ... }
      imageClean_b64, // base64 *without* the "data:image/png;base64," prefix
      imageLogo_b64,  // base64 *without* the prefix
      timestamp,
    } = req.body;

    // 2. Basic validation
    if (!nickname || !timestamp) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (nickname, timestamp)",
      });
    }

    // 3. Helper: load required env vars
    const requireEnv = (key) => {
      if (process.env[key]) return process.env[key];
      throw new Error(`Missing environment variable: ${key}`);
    };

    const SHOPIFY_DOMAIN = requireEnv("SHOPIFY_STORE_DOMAIN"); // e.g. "ek4iwc-kq.myshopify.com"
    const ADMIN_TOKEN   = requireEnv("SHOPIFY_ADMIN_API_TOKEN");
    const BLOG_ID       = requireEnv("BLOG_ID"); // numeric blog id as a string

    // Tiny helper for authorized fetch calls to Shopify Admin REST or GraphQL
    async function shopifyFetch(path, { method = "GET", jsonBody, isGraphQL = false } = {}) {
      const url = isGraphQL
        ? `https://${SHOPIFY_DOMAIN}/admin/api/2024-07/graphql.json`
        : `https://${SHOPIFY_DOMAIN}${path}`;

      const headers = {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
      };

      if (isGraphQL) {
        headers["Content-Type"] = "application/json";
      } else if (jsonBody) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        method,
        headers,
        body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      if (!response.ok) {
        console.error("shopifyFetch error:", response.status, response.statusText, data);
        throw new Error(`Shopify API error ${response.status} ${response.statusText}`);
      }

      return data;
    }

    // 4. Upload images to Shopify Files (GraphQL fileCreate)

    // Build the input array for fileCreate
    // Only include an entry if that base64 string is actually present
    const fileInputs = [];

    if (imageClean_b64 && imageClean_b64.trim() !== "") {
      fileInputs.push({
        alt: `Brick Art clean mosaic`,
        contentType: "IMAGE",
        originalSource: `data:image/png;base64,${imageClean_b64}`,
      });
    }

    if (imageLogo_b64 && imageLogo_b64.trim() !== "") {
      fileInputs.push({
        alt: `Brick Art branded mosaic`,
        contentType: "IMAGE",
        originalSource: `data:image/png;base64,${imageLogo_b64}`,
      });
    }

    let cleanUrl = "";
    let logoUrl = "";

    if (fileInputs.length > 0) {
      // Build GraphQL mutation
      const gqlMutation = `
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              ... on MediaImage {
                alt
                image {
                  url
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const gqlVariables = { files: fileInputs };

      const gqlResult = await shopifyFetch("/admin/api/2024-07/graphql.json", {
        method: "POST",
        isGraphQL: true,
        jsonBody: {
          query: gqlMutation,
          variables: gqlVariables,
        },
      });

      // gqlResult.fileCreate.files is an array of uploaded images
      const uploaded = gqlResult?.data?.fileCreate;
      if (!uploaded) {
        console.error("fileCreate unexpected response:", gqlResult);
        throw new Error("fileCreate mutation returned no data");
      }

      const userErrors = uploaded.userErrors || [];
      if (userErrors.length > 0) {
        console.error("fileCreate userErrors:", userErrors);
        // NOTE: we won't hard-fail if only one of them failed – we'll just continue.
      }

      // Map them back to cleanUrl / logoUrl by index, in the order we pushed
      // If you ever reorder fileInputs, keep this mapping consistent.
      let idx = 0;
      if (imageClean_b64 && imageClean_b64.trim() !== "") {
        const media = uploaded.files?.[idx];
        const url = media?.image?.url;
        if (url) cleanUrl = url;
        idx += 1;
      }

      if (imageLogo_b64 && imageLogo_b64.trim() !== "") {
        const media = uploaded.files?.[idx];
        const url = media?.image?.url;
        if (url) logoUrl = url;
        idx += 1;
      }
    }

    // 5. Build HTML for the blog post body
    // Brick breakdown list
    function buildBrickList(breakdown = {}) {
      const entries = Object.entries(breakdown);
      if (!entries.length) return "";
      // Make an <li> list of "Color – Count"
      const items = entries
        .map(([color, count]) => {
          const label = color.charAt(0).toUpperCase() + color.slice(1);
          return `<li>${label}: ${count}</li>`;
        })
        .join("");

      return `
        <p><strong>Brick Breakdown:</strong></p>
        <ul>${items}</ul>
      `;
    }

    const brickListHTML = buildBrickList(brickCounts);

    // Clean / original image block
    const cleanBlock = cleanUrl
      ? `
        <p><strong>Original Mosaic:</strong></p>
        <p><img src="${cleanUrl}" alt="Original mosaic by ${nickname || "artist"}"
          style="max-width:100%; height:auto;" /></p>
      `
      : "";

    // Branded / watermarked image block
    const logoBlock = logoUrl
      ? `
        <p><strong>Branded Mosaic:</strong></p>
        <p><img src="${logoUrl}" alt="Branded mosaic by ${nickname || "artist"}"
          style="max-width:100%; height:auto;" /></p>
      `
      : "";

    // Final article HTML
    const articleHTML = `
      <p><strong>Artist:</strong> ${nickname || "Unknown Artist"}</p>
      <p><strong>Category:</strong> ${category || "Uncategorized"}</p>
      <p><strong>Grid Size:</strong> ${grid || "Unknown"}</p>
      <p><strong>Baseplate:</strong> ${baseplate || "Unknown"}</p>
      <p><strong>Total Bricks:</strong> ${totalBricks || "Unknown"}</p>

      ${brickListHTML}

      ${cleanBlock}
      ${logoBlock}
    `;

    // 6. Create blog article via REST Admin API
    // We'll create as a hidden draft (published: false)
    // We’ll put grid and baseplate in tags so you can filter later.
    // We'll also include category in tags.
    const tagsArr = [];
    if (grid) tagsArr.push(grid);
    if (baseplate) tagsArr.push(baseplate);
    if (category) tagsArr.push(category);

    // Fallback for title: "nickname – timestamp"
    const niceTitle = `${nickname || "Artist"} – ${timestamp}`;

    const createArticlePayload = {
      article: {
        title: niceTitle,
        author: "Shopify API",
        tags: tagsArr.join(", "),
        body_html: articleHTML,
        published: false,
      },
    };

    const articleResp = await shopifyFetch(
      `/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`,
      {
        method: "POST",
        jsonBody: createArticlePayload,
      }
    );

    const article = articleResp?.article;
    if (!article) {
      console.error("No article data in response:", articleResp);
      throw new Error("Shopify did not return article data");
    }

    // 7. Respond back to caller with success info
    return res.status(200).json({
      ok: true,
      blog_id: BLOG_ID,
      article_id: article.id,
      article_handle: article.handle,
      article_admin_url: `https://${SHOPIFY_DOMAIN}/admin/blogs/${BLOG_ID}/articles/${article.id}`,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
}
