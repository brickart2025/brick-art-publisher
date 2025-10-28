// publish.js
//
// What this server does:
// 1. Receives POSTs from Mechanic (JSON payload from your webhook task).
// 2. Uploads the clean + logo images to Shopify Files via Admin GraphQL.
// 3. Builds HTML for the gallery post.
// 4. Creates a blog article in your Brick Art Gallery blog.
//
// HOW TO RUN (local test):
//   npm init -y
//   npm install express node-fetch
//   node publish.js
//
// HOW TO DEPLOY:
//   - You can deploy this to a tiny Node host (Render, Railway, Fly.io, etc.).
//   - Or wrap this handler as a Vercel serverless function.
//
// IMPORTANT: Fill in BLOG_ID and SHOPIFY_ADMIN_TOKEN before deploying.

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" })); // because we send base64 images

// >>>> FILL THESE IN <<<<
const SHOP_DOMAIN = "ek4iwc-kq.myshopify.com";
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const BLOG_ID = "91651211375"; // numeric string, like "91651211375"

// Helper: upload one base64 PNG to Shopify Files via Admin GraphQL
async function uploadImageToFiles({ base64Data, altText }) {
  if (!base64Data || base64Data.trim() === "") {
    return ""; // if missing, just skip gracefully
  }

  // base64Data from Mechanic starts with "data:image/png;base64,AAAA..."
  // Shopify expects just the raw base64, no prefix.
  const stripped = base64Data.replace(/^data:image\/\w+;base64,/, "");

  const mutation = `
    mutation fileCreate(
      $fileBytes: Base64!,
      $alt: String!
    ) {
      fileCreate(
        files: [
          {
            alt: $alt,
            contentType: IMAGE,
            originalSource: $fileBytes
          }
        ]
      ) {
        files {
          url
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    fileBytes: stripped,
    alt: altText || "Brick Art Mosaic",
  };

  const resp = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/2024-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({
        query: mutation,
        variables,
      }),
    }
  );

  const data = await resp.json();

  // If Shopify returns an error, log it so we can debug later
  if (
    !data ||
    !data.data ||
    !data.data.fileCreate ||
    data.data.fileCreate.userErrors?.length
  ) {
    console.error("fileCreate userErrors:", data);
    return "";
  }

  const url = data.data.fileCreate.files?.[0]?.url || "";
  return url;
}

// Helper: build article HTML body
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
  // Brick breakdown as <li> list
  let brickListHtml = "";
  if (brickCounts && typeof brickCounts === "object") {
    brickListHtml += "<ul>";
    for (const color in brickCounts) {
      const count = brickCounts[color];
      brickListHtml += `<li><strong>${color}</strong>: ${count}</li>`;
    }
    brickListHtml += "</ul>";
  }

  // Images (conditionally include if upload worked)
  const cleanImgHtml = cleanUrl
    ? `<p><strong>Original Mosaic:</strong><br/><img src="${cleanUrl}" alt="Original ${nickname}" style="max-width:100%; height:auto;"/></p>`
    : "";

  const logoImgHtml = logoUrl
    ? `<p><strong>Brick Art Version:</strong><br/><img src="${logoUrl}" alt="Brick Art version of ${nickname}" style="max-width:100%; height:auto;"/></p>`
    : "";

  return `
    <p><strong>Artist:</strong> ${nickname}</p>
    <p><strong>Category:</strong> ${category}</p>
    <p><strong>Grid Size:</strong> ${grid}×${grid}</p>
    <p><strong>Baseplate:</strong> ${baseplate}</p>
    <p><strong>Total Bricks:</strong> ${totalBricks}</p>

    <p><strong>Brick Breakdown:</strong></p>
    ${brickListHtml}

    ${cleanImgHtml}
    ${logoImgHtml}
  `;
}

// POST endpoint that Mechanic will call
app.post("/publish", async (req, res) => {
  try {
    // 1. Extract payload from Mechanic
    const {
      nickname = "Unknown Artist",
      category = "Uncategorized",
      grid = "Unknown",
      baseplate = "Unknown",
      totalBricks = 0,
      brickCounts = {},
      imageClean_b64 = "",
      imageLogo_b64 = "",
      timestamp = "",
    } = req.body || {};

    console.log("[Incoming submission]", {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      timestamp,
    });

    // 2. Upload both images to Shopify Files
    const cleanUrl = await uploadImageToFiles({
      base64Data: imageClean_b64,
      altText: `Clean mosaic by ${nickname}`,
    });

    const logoUrl = await uploadImageToFiles({
      base64Data: imageLogo_b64,
      altText: `Brick Art mosaic by ${nickname}`,
    });

    console.log("[Uploaded image URLs]", { cleanUrl, logoUrl });

    // 3. Build article title + HTML
    const article_title = `${nickname} – ${category} (${grid}x${grid})`;
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

    // 4. Create article in the Brick Art Gallery blog
    const postResp = await fetch(
      `https://${SHOP_DOMAIN}/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        },
        body: JSON.stringify({
          article: {
            title: article_title,
            body_html: article_html,
            tags: [
              category,
              `${grid}x${grid}`,
              baseplate,
              "Brick Art Gallery",
            ].join(", "),
            published_at: null, // keep as draft for review. Set to new Date().toISOString() to auto-publish
          },
        }),
      }
    );

    const postData = await postResp.json();
    console.log("[Article create response]", postData);

    // return success info to caller
    res.status(200).json({
      ok: true,
      message: "Received and attempted publish",
      cleanUrl,
      logoUrl,
      articleResponse: postData,
    });
  } catch (err) {
    console.error("Publish error", err);
    res.status(500).json({ ok: false, error: err.message || err.toString() });
  }
});

// Basic GET for sanity check
app.get("/", (req, res) => {
  res.send("Brick Art Publisher is alive ✅");
});

// Start server locally on port 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Brick Art Publisher listening on ${PORT}`);
});
