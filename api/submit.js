// api/submit.js
// Serverless function for Vercel
// Receives mosaic submission JSON and turns it into a Shopify blog post.

import { axiosPost } from "./axios-lite.js";

// --- env helpers -------------------------------------------------
function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

const SHOPIFY_STORE_DOMAIN = requireEnv("SHOPIFY_STORE_DOMAIN"); // e.g. ek4iwc-kq.myshopify.com
const SHOPIFY_ADMIN_API_TOKEN = requireEnv("SHOPIFY_ADMIN_API_TOKEN"); // Admin API token
const BLOG_ID = requireEnv("BLOG_ID"); // numeric blog id as a string, e.g. "91651211375"

// --- utility: build the blog post HTML ---------------------------
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
  // Make a <li> list if we have brickCounts
  let brickList = "";
  if (brickCounts && typeof brickCounts === "object") {
    const entries = Object.entries(brickCounts); // [["black",300], ...]
    if (entries.length > 0) {
      brickList =
        "<p><strong>Brick Breakdown:</strong></p><ul>" +
        entries
          .map(
            ([color, count]) =>
              `<li>${color.charAt(0).toUpperCase() + color.slice(1)} – ${count}</li>`
          )
          .join("") +
        "</ul>";
    }
  }

  // Clean/original mosaic image block
  const cleanBlock = cleanUrl
    ? `
      <p><strong>Original Mosaic:</strong></p>
      <p><img src="${cleanUrl}" alt="Original mosaic by ${nickname || "artist"}"
      style="max-width:100%; height:auto;" /></p>
    `
    : "";

  // Branded / logo mosaic block
  const logoBlock = logoUrl
    ? `
      <p><strong>Branded Mosaic:</strong></p>
      <p><img src="${logoUrl}" alt="Branded mosaic by ${nickname || "artist"}"
      style="max-width:100%; height:auto;" /></p>
    `
    : "";

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

// --- handler (Vercel style) --------------------------------------
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // pull fields from request body
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
    } = req.body || {};

    // sanity check: we at least need nickname, etc.
    if (!nickname || !timestamp) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing required fields (nickname/timestamp)" });
    }

    // 1. Upload images to Shopify Files via GraphQL --------------------------------
    // Build Shopify GraphQL mutation payload.
    // We only include each file block if we actually got base64 data.
    const filesInput = [];

    if (imageClean_b64 && imageClean_b64.trim() !== "") {
      filesInput.push({
        alt: `Brick Art clean mosaic`,
        contentType: "IMAGE",
        originalSource: `data:image/png;base64,${imageClean_b64}`,
      });
    }

    if (imageLogo_b64 && imageLogo_b64.trim() !== "") {
      filesInput.push({
        alt: `Brick Art branded mosaic`,
        contentType: "IMAGE",
        originalSource: `data:image/png;base64,${imageLogo_b64}`,
      });
    }

    let cleanUrl = "";
    let logoUrl = "";

    if (filesInput.length > 0) {
      // GraphQL mutation string
      const gqlMutation = `
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              preview {
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

      // Build request body for Shopify GraphQL Admin API
      const gqlBody = {
        query: gqlMutation,
        variables: {
          files: filesInput,
        },
      };

      // Send to Shopify GraphQL
      const uploadResp = await axiosPost(
        `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`,
        gqlBody,
        {
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
        }
      );

      if (!uploadResp.ok) {
        return res.status(500).json({
          ok: false,
          step: "fileCreate",
          status: uploadResp.status,
          error: uploadResp.data,
        });
      }

      // unpack URLs
      // structure: data.fileCreate.files[x].preview.image.url
      try {
        const createdFiles = uploadResp.data.data.fileCreate.files || [];
        if (createdFiles[0]) {
          cleanUrl =
            createdFiles[0].preview?.image?.url ||
            createdFiles[0].image?.url ||
            "";
        }
        if (createdFiles[1]) {
          logoUrl =
            createdFiles[1].preview?.image?.url ||
            createdFiles[1].image?.url ||
            "";
        }
      } catch (e) {
        // swallow parse errors, keep URLs blank if we can't parse
      }
    }

    // 2. Build HTML body for the blog post -----------------------------------------
    const article_html = buildArticleHTML({
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts,
      cleanUrl,
      logoUrl,
    });

    // Title for blog post
    // Example: "Test Artist – 2025-10-28 15:00"
    const article_title = `${nickname} – ${timestamp}`;

    // Tags (comma-separated or array)
    // We’ll generate some simple tags
    const tagsArr = [
      category || "Uncategorized",
      `${grid}x${grid}`,
      baseplate || "Unknown Baseplate",
    ];
    const tagsStr = tagsArr.join(", ");

    // 3. Create Shopify Blog Article via REST Admin API ----------------------------
    const articlePayload = {
      article: {
        title: article_title,
        body_html: article_html,
        tags: tagsStr,
        published_at: null, // draft/unpublished
      },
    };

    const articleResp = await axiosPost(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`,
      articlePayload,
      {
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
      }
    );

    if (!articleResp.ok) {
      return res.status(500).json({
        ok: false,
        step: "createArticle",
        status: articleResp.status,
        error: articleResp.data,
      });
    }

    // Shopify REST returns { article: {...} }
    const createdArticle = articleResp.data.article || {};

    // 4. Respond success -----------------------------------------------------------
    return res.status(200).json({
      ok: true,
      blog_id: BLOG_ID,
      article_id: createdArticle.id,
      article_handle: createdArticle.handle,
      article_admin_url: `https://${SHOPIFY_STORE_DOMAIN}/admin/blogs/${BLOG_ID}/articles/${createdArticle.id}`,
      preview_image_clean: cleanUrl,
      preview_image_logo: logoUrl,
    });
  } catch (err) {
    // Catch truly unexpected errors (missing env, etc.)
    console.error("submit.js fatal error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || err.toString(),
      stack: err.stack || null,
    });
  }
}
