// api/submit.js
//
// Brick Art Publisher endpoint
// Receives mosaic submission JSON, uploads images to Shopify Files, then
// creates a blog post in the Brick Art Gallery blog.
//
// Environment variables required (in Vercel / .env):
//   SHOPIFY_STORE_DOMAIN       e.g. "ek4iwc-kq.myshopify.com"
//   SHOPIFY_ADMIN_API_TOKEN    Admin API access token (private)
//   BLOG_ID                    numeric blog id for "Brick Art Gallery"

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

// simple required-env guard
function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// helper: upload ONE base64 image to Shopify Files and return its CDN URL
async function uploadSingleImageToShopify({ b64, altText, filename }) {
  if (!b64 || !b64.trim()) {
    return "";
  }

  const graphqlEndpoint = `https://${requireEnv(
    "SHOPIFY_STORE_DOMAIN",
    SHOPIFY_STORE_DOMAIN
  )}/admin/api/2024-07/graphql.json`;

  // GraphQL mutation for fileCreate
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
            preview {
              image {
                url
              }
            }
            previewImage {
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

  // variables payload to send
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

  // Call Shopify GraphQL Admin API
  const resp = await fetch(graphqlEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": requireEnv(
        "SHOPIFY_ADMIN_API_TOKEN",
        SHOPIFY_ADMIN_API_TOKEN
      ),
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const data = await resp.json();

  // basic error logging for debugging
  if (!resp.ok) {
    console.error("fileCreate HTTP error:", resp.status, resp.statusText, data);
    return "";
  }
  if (data.errors) {
    console.error("fileCreate GraphQL errors:", data.errors);
  }

  const userErrors = data?.data?.fileCreate?.userErrors || [];
  if (userErrors.length > 0) {
    console.error("fileCreate userErrors:", userErrors);
  }

  // try a few possible locations Shopify might put the URL
  const fileNode = data?.data?.fileCreate?.files?.[0];
  const cdnUrl =
    fileNode?.image?.url ||
    fileNode?.previewImage?.url ||
    fileNode?.preview?.image?.url ||
    "";

  return cdnUrl;
}

// helper: build the HTML body for the blog post
function buildArticleHTML({
  nickname,
  category,
  grid,
  baseplate,
  totalBricks,
  brickCounts,
  cleanUrl,
  logoUrl,
}) {
  // brick breakdown as <ul>
  const brickList = brickCounts
    ? `<p><strong>Brick Breakdown:</strong></p>
       <ul>
         ${Object.entries(brickCounts)
           .map(([color, count]) => {
             const nice =
               color.charAt(0).toUpperCase() + color.slice(1).toLowerCase();
             return `<li>${nice}: ${count}</li>`;
           })
           .join("")}
       </ul>`
    : "";

  // block for original mosaic image
  const cleanBlock = cleanUrl
    ? `
      <p><strong>Original Mosaic:</strong></p>
      <p><img src="${cleanUrl}"
              alt="Original mosaic by ${nickname || "artist"}"
              style="max-width:100%; height:auto;" /></p>
    `
    : "";

  // block for branded / logo mosaic image
  const logoBlock = logoUrl
    ? `
      <p><strong>Branded Mosaic:</strong></p>
      <p><img src="${logoUrl}"
              alt="Branded mosaic by ${nickname || "artist"}"
              style="max-width:100%; height:auto;" /></p>
    `
    : "";

  // final HTML
  return `
    <p><strong>Artist:</strong> ${nickname || "Unknown Artist"}</p>
    <p><strong>Category:</strong> ${category || "Uncategorized"}</p>
    <p><strong>Grid Size:</strong> ${grid || "Unknown"}</p>
    <p><strong>Baseplate:</strong> ${baseplate || "Unknown"}</p>
    <p><strong>Total Bricks:</strong> ${totalBricks || "Unknown"}</p>

    ${brickList}
    ${cleanBlock}
    ${logoBlock}
  `;
}

// helper: create Shopify blog article via REST Admin API
async function createShopifyArticle({ title, html, tags }) {
  const adminEndpoint = `https://${requireEnv(
    "SHOPIFY_STORE_DOMAIN",
    SHOPIFY_STORE_DOMAIN
  )}/admin/api/2024-07/blogs/${requireEnv("BLOG_ID", BLOG_ID)}/articles.json`;

  const bodyPayload = {
    article: {
      title,
      author: "Shopify API",
      tags: tags || [],
      body_html: html,
      published: false, // keep it hidden for manual approval
    },
  };

  const resp = await fetch(adminEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": requireEnv(
        "SHOPIFY_ADMIN_API_TOKEN",
        SHOPIFY_ADMIN_API_TOKEN
      ),
    },
    body: JSON.stringify(bodyPayload),
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error("Article create HTTP error:", resp.status, resp.statusText, data);
    throw new Error(
      `Failed to create article: ${resp.status} ${resp.statusText}`
    );
  }

  return data?.article;
}

// the actual route handler Vercel will call
export default async function handler(req, res) {
  try {
    // Only POST is allowed
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use POST.",
      });
    }

    // Parse JSON body. On Vercel Node runtime, req.body may already be parsed,
    // but we'll handle both cases safely.
    const payload =
      typeof req.body === "object" && req.body !== null
        ? req.body
        : JSON.parse(req.body || "{}");

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
    } = payload;

    // basic validation: we at least want a nickname and timestamp
    if (!nickname || !timestamp) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing required fields (nickname/timestamp)" });
    }

    // 1. Upload both images (if present) to Shopify Files.
    const cleanUrl = await uploadSingleImageToShopify({
      b64: imageClean_b64,
      altText: `Original mosaic by ${nickname}`,
      filename: `${nickname || "mosaic"}-clean.png`,
    });

    const logoUrl = await uploadSingleImageToShopify({
      b64: imageLogo_b64,
      altText: `Branded mosaic by ${nickname}`,
      filename: `${nickname || "mosaic"}-logo.png`,
    });

    // 2. Build the blog article HTML with text + images
    const html = buildArticleHTML({
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts,
      cleanUrl,
      logoUrl,
    });

    // 3. Create the Shopify article (hidden / unpublished)
    const title = `${nickname} – ${timestamp}`;
    // tags: category, grid, baseplate for filtering in gallery later
    const tags = [
      category || "Uncategorized",
      grid || "",
      baseplate || "",
    ].filter(Boolean);

    const article = await createShopifyArticle({
      title,
      html,
      tags,
    });

    // success response
    return res.status(200).json({
      ok: true,
      blog_id: article?.blog_id,
      article_id: article?.id,
      article_handle: article?.handle,
      article_admin_url: `https://${SHOPIFY_STORE_DOMAIN}/admin/blogs/${article?.blog_id}/articles/${article?.id}`,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Internal server error",
    });
  }
}
