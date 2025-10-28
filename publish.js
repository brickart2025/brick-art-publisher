// publish.js
// Brick Art Publisher API
//
// This is the Express server that Vercel (or localhost) will run.
// It receives form submissions from your Mosaic app / Mechanic,
// uploads the two images to Shopify as Files (via GraphQL),
// then creates a blog post via Shopify REST Admin API.
//
// IMPORTANT:
// - No secrets are hardcoded. All secrets are read from process.env.
// - You must define these in .env (locally) or in Vercel dashboard:
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_API_TOKEN
//   BLOG_ID
//
// Example .env values (do NOT commit .env):
//   SHOPIFY_STORE_DOMAIN=ek4iwc-kq.myshopify.com
//   SHOPIFY_ADMIN_API_TOKEN=shpat_************************
//   BLOG_ID=123456789012
//
// -------------------------------------------------------

import express from "express";

const app = express();

// we expect JSON from Mechanic / from the frontend submitter
app.use(express.json({ limit: "10mb" })); // large b64 images allowed

// pull env secrets
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

// quick helper to bail loudly if env is missing
function requireEnv(name, value) {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}
requireEnv("SHOPIFY_STORE_DOMAIN", SHOPIFY_STORE_DOMAIN);
requireEnv("SHOPIFY_ADMIN_API_TOKEN", SHOPIFY_ADMIN_API_TOKEN);
requireEnv("BLOG_ID", BLOG_ID);

// -------------------------------------------------------
// helper: upload the two images to Shopify Files via GraphQL
// returns { cleanUrl, logoUrl }
async function uploadImagesToShopify({ imageClean_b64, imageLogo_b64, nickname }) {
  // Shopify GraphQL Admin endpoint
  const graphqlEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`;

  // strip "data:image/png;base64," etc if present
  function stripPrefix(b64) {
    if (!b64) return "";
    const commaIndex = b64.indexOf(",");
    return commaIndex !== -1 ? b64.slice(commaIndex + 1) : b64;
  }

  const cleanBytes = stripPrefix(imageClean_b64);
  const logoBytes = stripPrefix(imageLogo_b64);

  // filenames to show in Files
  const timestamp = Date.now();
  const safeNick = nickname ? nickname.replace(/[^a-z0-9_-]/gi, "_") : "mosaic";
  const fnameClean = `${safeNick}_${timestamp}_clean.png`;
  const fnameLogo = `${safeNick}_${timestamp}_logo.png`;

  // GraphQL mutation body
  const gqlBody = {
    query: `
      mutation fileCreate(
        $cleanBytes: Base64!,
        $logoBytes: Base64!,
        $fnameClean: String!,
        $fnameLogo: String!
      ) {
        clean: fileCreate(
          files: [
            {
              alt: "Brick Art clean mosaic",
              contentType: IMAGE,
              filename: $fnameClean,
              originalSource: $cleanBytes
            }
          ]
        ) {
          files { url }
          userErrors { field message }
        }

        logo: fileCreate(
          files: [
            {
              alt: "Brick Art logo mosaic",
              contentType: IMAGE,
              filename: $fnameLogo,
              originalSource: $logoBytes
            }
          ]
        ) {
          files { url }
          userErrors { field message }
        }
      }
    `,
    variables: {
      cleanBytes,
      logoBytes,
      fnameClean,
      fnameLogo,
    },
  };

  const gqlResp = await fetch(graphqlEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify(gqlBody),
  });

  if (!gqlResp.ok) {
    const text = await gqlResp.text();
    throw new Error(`Shopify GraphQL upload failed (${gqlResp.status}): ${text}`);
  }

  const gqlJson = await gqlResp.json();

  // pull URLs if available
  const cleanUrl =
    gqlJson?.data?.clean?.files?.[0]?.url || "";
  const logoUrl =
    gqlJson?.data?.logo?.files?.[0]?.url || "";

  return { cleanUrl, logoUrl };
}

// -------------------------------------------------------
// helper: build HTML for the blog post
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
  // brickCounts is an object like { red: 12, blue: 4, ... }

  const brickList = brickCounts
    ? Object.entries(brickCounts)
        .map(
          ([color, count]) =>
            `<li>${color.replace(/(^|\s)\S/g, s => s.toUpperCase())} – ${count}</li>`
        )
        .join("")
    : "";

  return `
    <p><strong>Artist:</strong> ${nickname || "Unknown Artist"}</p>
    <p><strong>Category:</strong> ${category || "Uncategorized"}</p>
    <p><strong>Grid Size:</strong> ${grid || "Unknown"}</p>
    <p><strong>Baseplate:</strong> ${baseplate || "Unknown"}</p>
    <p><strong>Total Bricks:</strong> ${totalBricks || "Unknown"}</p>

    ${
      brickList
        ? `<p><strong>Brick Breakdown:</strong></p><ul>${brickList}</ul>`
        : ""
    }

    ${
      cleanUrl
        ? `<p><strong>Original Mosaic:</strong></p>
           <p><img src="${cleanUrl}" alt="Original mosaic by ${nickname ||
            "artist"}" style="max-width:100%; height:auto;" /></p>`
        : ""
    }

    ${
      logoUrl
        ? `<p><strong>Branded Mosaic:</strong></p>
           <p><img src="${logoUrl}" alt="Branded mosaic by ${nickname ||
            "artist"}" style="max-width:100%; height:auto;" /></p>`
        : ""
    }
  `;
}

// -------------------------------------------------------
// helper: create the Shopify blog article (REST Admin API)
async function createShopifyArticle({ title, html, tags }) {
  const restEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`;

  const body = {
    article: {
      title,
      body_html: html,
      tags,
      published: true,
    },
  };

  const resp = await fetch(restEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Create article failed (${resp.status}): ${text}`);
  }

  return await resp.json();
}

// -------------------------------------------------------
// POST /submit  (this is what Mechanic / ngrok / etc will call)
app.post("/submit", async (req, res) => {
  try {
    // pull data from request body
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts,
      imageClean, // base64 (dataURL string)
      imageLogo,  // base64 (dataURL string)
      timestamp,
    } = req.body || {};

    // 1. upload both images to Shopify Files
    const { cleanUrl, logoUrl } = await uploadImagesToShopify({
      imageClean_b64: imageClean,
      imageLogo_b64: imageLogo,
      nickname,
    });

    // 2. build HTML for blog post
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

    // 3. choose a title
    const article_title = nickname
      ? `${nickname} – Brick Art Mosaic`
      : "Brick Art Mosaic";

    // 4. create tags
    // category, grid, baseplate are nice as tags
    const tag_list = [
      category || "Uncategorized",
      grid ? `${grid}x${grid}` : null,
      baseplate || null,
    ]
      .filter(Boolean)
      .join(", ");

    // 5. send to Shopify blog
    const newArticle = await createShopifyArticle({
      title: article_title,
      html: article_html,
      tags: tag_list,
    });

    // respond
    res.json({
      ok: true,
      article: newArticle,
      cleanUrl,
      logoUrl,
      receivedAt: new Date().toISOString(),
      originalTimestamp: timestamp || null,
    });
  } catch (err) {
    console.error("ERROR /submit:", err);
    res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

// -------------------------------------------------------
// health check
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "Brick Art Publisher API running" });
});

// -------------------------------------------------------
// local dev only
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Brick Art Publisher listening on port ${PORT}`);
});
