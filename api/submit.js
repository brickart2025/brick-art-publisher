// /api/submit.js — Brick Art Publisher (Vercel serverless)
// Staged uploads to Shopify Files → create Blog Article (published).

export default async function handler(req, res) {
  // --- 1) CORS ---
  const ORIGINS = new Set([
    "https://www.brick-art.com",
    "https://brick-art.com",
    "https://brick-art.myshopify.com", // theme preview (optional)
    "http://localhost:3000",           // local dev (optional)
  ]);
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();

  // --- 2) Method guard ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- 3) Env vars ---
  const STORE   = process.env.SHOPIFY_STORE_DOMAIN;     // e.g. brick-art.myshopify.com
  const TOKEN   = process.env.SHOPIFY_ADMIN_API_TOKEN;  // needs: write_files, read_files, write_content
  const BLOG_ID = process.env.BLOG_ID;                  // numeric blog ID

  if (!STORE || !TOKEN || !BLOG_ID) {
    console.error("[BrickArt] Missing envs", {
      STORE: !!STORE,
      TOKEN: !!TOKEN,
      BLOG_ID: !!BLOG_ID,
    });
    return res
      .status(500)
      .json({ ok: false, error: "Server not configured" });
  }

  const REST_BASE = `https://${STORE}/admin/api/2024-07`;
  const GQL_URL   = `https://${STORE}/admin/api/2024-07/graphql.json`;

  // --- 4) Helpers ---
  const esc = (s = "") =>
    String(s).replace(/[&<>"]/g, (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      }[m])
    );

  // turn "Nature / Science" → "nature-science", "Blue 16x16" → "blue-16x16"
  const slug = (s = "") =>
    String(s)
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const toRawBase64 = (src = "") =>
    src.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function shopifyREST(path, init = {}) {
    const url = `${REST_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    };
    console.log("[BrickArt] Shopify REST →", url);
    return fetch(url, { ...init, headers });
  }

  async function shopifyGQL(query, variables = {}) {
    const r = await fetch(GQL_URL, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await r.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {}
    if (!r.ok || json.errors) {
      console.error(
        "[BrickArt] GQL FAILED",
        r.status,
        json.errors || text?.slice(0, 300)
      );
      throw new Error(
        JSON.stringify({
          step: "graphql",
          status: r.status,
          errors: json.errors || text,
        })
      );
    }
    return json.data;
  }

  // Lookup a file URL by filename (GraphQL search), to handle delayed indexing.
  async function getFileUrlByFilename(filename, tries = 5) {
    const QUERY = `
      query files($q: String!) {
        files(first: 5, query: $q) {
          edges {
            node {
              __typename
              ... on MediaImage { id alt image { url } }
              ... on GenericFile { id url }
            }
          }
        }
      }
    `;
    const q = `filename:${filename}`;
    for (let i = 0; i < tries; i++) {
      const data = await shopifyGQL(QUERY, { q });
      const node = data?.files?.edges?.[0]?.node;
      if (node) {
        if (node.__typename === "MediaImage" && node.image?.url) {
          return node.image.url;
        }
        if (node.__typename === "GenericFile" && node.url) {
          return node.url;
        }
      }
      await sleep(500 + i * 250);
    }
    return null;
  }

  // Staged upload → S3 → fileCreate. Returns the CDN URL (polls if needed).
  async function uploadImageB64ToFiles(base64, filename, altText) {
    if (!base64) return null;
    const raw = toRawBase64(base64);
    if (!raw) return null;

    // 1) stagedUploadsCreate (IMAGE)
    const STAGED_UPLOADS_CREATE = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `;
    const input = [
      {
        resource: "IMAGE",
        filename,
        mimeType: "image/png",
        httpMethod: "POST",
      },
    ];
    const data1 = await shopifyGQL(STAGED_UPLOADS_CREATE, { input });
    const target = data1?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      throw new Error(
        JSON.stringify({
          step: "stagedUploadsCreate",
          errors: data1?.stagedUploadsCreate?.userErrors,
        })
      );
    }

    // 2) POST bytes to S3
    const bytes = Buffer.from(raw, "base64");
    const fileBlob = new Blob([bytes], { type: "image/png" });
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append("file", fileBlob, filename);

    const s3Resp = await fetch(target.url, { method: "POST", body: form });
    if (!s3Resp.ok) {
      const t = await s3Resp.text().catch(() => "");
      console.error(
        "[BrickArt] S3 upload FAILED",
        s3Resp.status,
        t?.slice(0, 300)
      );
      throw new Error(
        JSON.stringify({
          step: "s3Upload",
          status: s3Resp.status,
          error: t,
        })
      );
    }

    // 3) fileCreate
    const FILE_CREATE = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            __typename
            ... on MediaImage { id alt image { url } }
            ... on GenericFile { id url }
          }
          userErrors { field message }
        }
      }
    `;
    const data2 = await shopifyGQL(FILE_CREATE, {
      files: [
        {
          contentType: "IMAGE",
          originalSource: target.resourceUrl,
          alt: altText || "Brick Art submission",
        },
      ],
    });

    const created = data2?.fileCreate?.files?.[0] || null;
    let url = null;
    if (created) {
      if (created.__typename === "MediaImage") {
        url = created.image?.url || null;
      } else if (created.__typename === "GenericFile") {
        url = created.url || null;
      }
    }

    if (!url) {
      console.warn(
        "[BrickArt] fileCreate returned no URL; polling by filename…"
      );
      url = await getFileUrlByFilename(filename);
    }

    if (!url) {
      console.error(
        "[BrickArt] fileCreate userErrors:",
        data2?.fileCreate?.userErrors
      );
      throw new Error(
        JSON.stringify({
          step: "fileCreate",
          errors: data2?.fileCreate?.userErrors || "no url after create",
        })
      );
    }

    console.log("[BrickArt] File ready:", url);
    return url;
  }

  try {
    // --- 5) Parse body (tolerate stringified JSON) ---
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts,      // { red: 10, blue: 5, ... }
      brickCountsText,  // optional one-line string (for future use)
      timestamp,
      imageClean_b64,   // base64 with or without data: prefix
      imageLogo_b64,
      submitterEmail,
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (timestamp and image)",
      });
    }

    console.log("[BrickArt] Submission received:", {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      timestamp,
      cleanLen: imageClean_b64?.length || 0,
      logoLen: imageLogo_b64?.length || 0,
      hasEmail: !!submitterEmail,
    });

    // --- 6) Upload images ---
    const safeNameBase = `${String(timestamp)
      .replace(/[:.Z\-]/g, "")}-${String(nickname || "anon")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`.replace(/-+/g, "-");

    const cleanUrl = await uploadImageB64ToFiles(
      imageClean_b64,
      `${safeNameBase}-clean.png`,
      "Brick Art design (clean)"
    );
    const logoUrl = await uploadImageB64ToFiles(
      imageLogo_b64,
      `${safeNameBase}-logo.png`,
      "Brick Art design (watermarked)"
    );

    // --- 7) Build article HTML (includes brick color tally) ---
    const escHTML = esc; // alias

    const meta = [
      grid ? `Grid: ${grid}` : "",
      baseplate ? `Baseplate: ${baseplate}` : "",
      typeof totalBricks === "number"
        ? `Total Bricks: ${totalBricks}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");

    // normalize brickCounts to a plain object
    let countsObj = {};
    try {
      if (brickCounts) {
        countsObj =
          typeof brickCounts === "string"
            ? JSON.parse(brickCounts)
            : brickCounts || {};
      }
    } catch {
      countsObj = {};
    }

    const entries = Object.entries(countsObj)
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1])); // highest first

    const countsHtml = entries.length
      ? `
        <div style="margin:8px 0 14px 0;">
          <strong>Brick counts:</strong>
          <ul style="margin:.35rem 0 0 0; padding-left:1.15rem; line-height:1.3;">
            ${entries
              .map(
                ([color, n]) =>
                  `<li>${escHTML(String(color))}: ${Number(n)}</li>`
              )
              .join("")}
          </ul>
        </div>
      `.trim()
      : "";

    const body_html = `
      <p><strong>Nickname:</strong> ${escHTML(nickname || "Anonymous")}</p>
      ${meta ? `<p>${escHTML(meta)}</p>` : ""}
      ${countsHtml}
      ${
        cleanUrl
          ? `<p><img src="${cleanUrl}" alt="Brick Art design (clean)"/></p>`
          : ""
      }
      ${
        logoUrl
          ? `<p><img src="${logoUrl}" alt="Brick Art design (watermarked)"/></p>`
          : ""
      }
    `.trim();

    // --- 7b) Tags for gallery filtering ---
    const catTag   = category ? slug(category) : null;          // e.g. "space"
    const sizeTag  =
      grid && /\b32\b/.test(String(grid))
        ? "32x32"
        : grid && /\b16\b/.test(String(grid))
        ? "16x16"
        : grid
        ? String(grid)
        : null;
    const plateTag = baseplate ? `plate-${slug(baseplate)}` : null; // e.g. "plate-blue-16x16"
    const tags = [catTag, sizeTag, plateTag].filter(Boolean).join(", ");

  // --- 8) Create blog article (hidden by default) ---
const articlePayload = {
  article: {
    title: `Brick Art submission — ${nickname || "Anonymous"} (${new Date(
      timestamp
    ).toLocaleString()})`,
    body_html,
    tags,

    // keep new submissions OFF the public gallery until you approve them
    published: false,
    published_at: null,
  },
};

const ar = await shopifyREST(`/blogs/${BLOG_ID}/articles.json`, {
  method: "POST",
  body: JSON.stringify(articlePayload),
});

const articleText = await ar.text();
let articleJson = {};
try {
  articleJson = articleText ? JSON.parse(articleText) : {};
} catch {}

    if (!ar.ok) {
      console.error(
        "[BrickArt] Blog create FAILED",
        ar.status,
        articleJson?.errors || articleText?.slice(0, 300)
      );
      return res.status(500).json({
        ok: false,
        error: "Failed to create blog post",
        detail: articleJson?.errors || articleText,
        cleanUrl,
        logoUrl,
      });
    }

    const articleId  = articleJson?.article?.id;
    const handle     = articleJson?.article?.handle;
    const blogHandle = articleJson?.article?.blog?.handle;

    // --- 8b) Save brick color tally in metafield ---
    try {
      if (articleId && countsObj && Object.keys(countsObj).length) {
        await shopifyREST(`/articles/${articleId}/metafields.json`, {
          method: "POST",
          body: JSON.stringify({
            metafield: {
              namespace: "brickart",
              key: "brick_counts",
              type: "json",
              value: JSON.stringify(countsObj),
            },
          }),
        });
        console.log("[BrickArt] brick_counts metafield saved");
      }
    } catch (mfErr) {
      console.error("[BrickArt] brick_counts metafield error", mfErr);
    }

    // --- 8c) Save submitter email in metafield ---
    try {
      if (articleId && submitterEmail) {
        await shopifyREST(`/articles/${articleId}/metafields.json`, {
          method: "POST",
          body: JSON.stringify({
            metafield: {
              namespace: "brickart",
              key: "submitter_email",
              type: "single_line_text_field",
              value: String(submitterEmail).trim(),
            },
          }),
        });
        console.log("[BrickArt] submitter_email metafield saved");
      }
    } catch (mfErr) {
      console.error("[BrickArt] submitter_email metafield error", mfErr);
    }

    const storefrontUrl =
      handle && blogHandle
        ? `https://${STORE}/blogs/${blogHandle}/${handle}`
        : null;

    return res.status(200).json({
      ok: true,
      articleId,
      cleanUrl,
      logoUrl,
      storefrontUrl,
      emailSaved: !!submitterEmail,
    });
  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      detail: err?.message || String(err),
    });
  }
}
