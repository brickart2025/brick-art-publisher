// submit.js — Brick Art Publisher
// Handles POSTs from the mosaic tool and creates Shopify blog posts.

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
      imageClean_b64,
      imageLogo_b64,
      timestamp,
    } = req.body;

    // Basic validation
    if (!nickname || !timestamp) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (nickname, timestamp)",
      });
    }

    // --- Helper to load required env vars ---
    const requireEnv = (key, fallback) => {
      if (process.env[key]) return process.env[key];
      if (fallback) return fallback;
      throw new Error(`Missing environment variable: ${key}`);
    };

    const SHOPIFY_DOMAIN = requireEnv("SHOPIFY_STORE_DOMAIN");
    const ADMIN_TOKEN = requireEnv("SHOPIFY_ADMIN_API_TOKEN");
    const BLOG_ID = requireEnv("BLOG_ID");

    // --- Upload image to Shopify via GraphQL ---
    async function uploadSingleImageToShopify({ b64, altText, filename }) {
      if (!b64 || !b64.trim()) return "";

      const graphqlEndpoint = `https://${SHOPIFY_DOMAIN}/admin/api/2024-07/graphql.json`;

      const mutation = `
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              ... on MediaImage {
                id
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

      const variables = {
        files: [
          {
            alt: altText || "Brick Art mosaic",
            contentType: "IMAGE",
            originalSource: `data:image/png;base64,${b64}`,
            filename: filename || "brick-art.png",
          },
        ],
      };

      const resp = await fetch(graphqlEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
        body: JSON.stringify({ query: mutation, variables }),
      });

      const data = await resp.json();

      if (data.errors) {
        console.error("GraphQL upload errors:", data.errors);
        return "";
      }

      const fileNode = data?.data?.fileCreate?.files?.[0];
      return fileNode?.image?.url || "";
    }

    // --- Upload images ---
    const cleanUrl = await uploadSingleImageToShopify({
      b64: imageClean_b64,
      altText: `${nickname} mosaic`,
      filename: `${nickname}-clean.png`,
    });

    const logoUrl = await uploadSingleImageToShopify({
      b64: imageLogo_b64,
      altText: `${nickname} branded mosaic`,
      filename: `${nickname}-branded.png`,
    });

    // --- Build blog HTML ---
    const brickList =
      brickCounts &&
      Object.entries(brickCounts)
        .map(([color, count]) => `<li>${color}: ${count}</li>`)
        .join("");

    const html = `
      <p><strong>Artist:</strong> ${nickname}</p>
      <p><strong>Category:</strong> ${category || "Uncategorized"}</p>
      <p><strong>Grid Size:</strong> ${grid}</p>
      <p><strong>Baseplate:</strong> ${baseplate}</p>
      <p><strong>Total Bricks:</strong> ${totalBricks}</p>
      <p><strong>Brick Breakdown:</strong></p>
      <ul>${brickList}</ul>
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Original mosaic" /></p>` : ""}
      ${logoUrl ? `<p><img src="${logoUrl}" alt="Branded mosaic" /></p>` : ""}
    `;

    // --- Create Shopify blog post ---
    const blogEndpoint = `https://${SHOPIFY_DOMAIN}/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`;

    const postBody = {
      article: {
        title: `${nickname} – ${timestamp}`,
        author: "Shopify API",
        tags: [category, grid, baseplate].filter(Boolean).join(", "),
        body_html: html,
        published: false, // keep unpublished for review
      },
    };

    const postResp = await fetch(blogEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN,
      },
      body: JSON.stringify(postBody),
    });

    const postData = await postResp.json();

    if (!postResp.ok) {
      console.error("Shopify post creation failed:", postData);
      return res.status(500).json({ ok: false, error: "Failed to post to Shopify" });
    }

    return res.status(200).json({
      ok: true,
      blog_id: BLOG_ID,
      article_id: postData.article?.id,
      article_admin_url: `https://${SHOPIFY_DOMAIN}/admin/blogs/${BLOG_ID}/articles/${postData.article?.id}`,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
