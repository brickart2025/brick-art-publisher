// /api/submit.js — Brick Art Publisher (Vercel serverless)
// Robust staged uploads: if fileCreate returns no URL, we look it up by filename.
// Then we create the blog article (published: true so it appears immediately).

export default async function handler(req, res) {
  // --- 1) CORS ---
  const ORIGINS = [
    "https://www.brick-art.com",
    "https://brick-art.myshopify.com", // optional for theme preview
  ];
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
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
  const TOKEN   = process.env.SHOPIFY_ADMIN_API_TOKEN;  // requires: write_files, read_files, write_content
  const BLOG_ID = process.env.BLOG_ID;                  // numeric blog id
  if (!STORE || !TOKEN || !BLOG_ID) {
    console.error("[BrickArt] Missing envs", { STORE: !!STORE, TOKEN: !!TOKEN, BLOG_ID: !!BLOG_ID });
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const REST_BASE = `https://${STORE}/admin/api/2024-07`;
  const GQL_URL   = `https://${STORE}/admin/api/2024-07/graphql.json`;

  // --- 4) Helpers ---
  const esc = (s = "") =>
    String(s).replace(/[&<>"]/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));
  const toRawBase64 = (src = "") =>
    src.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function shopifyREST(path, init = {}) {
    const url = `${REST_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Accept": "application/json",
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
        "Accept": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await r.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {}
    if (!r.ok || json.errors) {
      console.error("[BrickArt] GQL FAILED", r.status, json.errors || text?.slice(0, 300));
      throw new Error(JSON.stringify({ step: "graphql", status: r.status, errors: json.errors || text }));
    }
    return json.data;
  }

  // Look up a file URL by filename (GraphQL search)
  async function getFileUrlByFilename(filename, tries = 4) {
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
      let url = null;
      if (node) {
        if (node.__typename === "MediaImage") url = node.image?.url || null;
        else if (node.__typename === "GenericFile") url = node.url || null;
      }
      if (url) return url;
      await sleep(500 + i * 250); // small backoff while CDN index catches up
    }
    return null;
  }

  // Upload PNG via staged uploads; tolerate empty fileCreate response by polling filename
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
    const input = [{
      resource: "IMAGE",
      filename,
      mimeType: "image/png",
      httpMethod: "POST",
    }];
    const data1 = await shopifyGQL(STAGED_UPLOADS_CREATE, { input });
    const target = data1?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      throw new Error(JSON.stringify({ step: "stagedUploadsCreate", errors: data1?.stagedUploadsCreate?.userErrors }));
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
      console.error("[BrickArt] S3 upload FAILED", s3Resp.status, t?.slice(0,300));
      throw new Error(JSON.stringify({ step: "s3Upload", status: s3Resp.status, error: t }));
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
      files: [{
        contentType: "IMAGE",
        originalSource: target.resourceUrl,
        alt: altText || "Brick Art submission",
      }]
    });

    // Prefer URL from fileCreate if present
    let created = data2?.fileCreate?.files?.[0] || null;
    let url = null;
    if (created) {
      if (created.__typename === "MediaImage") url = created.image?.url || null;
      else if (created.__typename === "GenericFile") url = created.url || null;
    }

    // If no URL returned (common on some stores), look it up by filename
    if (!url) {
      console.warn("[BrickArt] fileCreate returned no URL; polling by filename…");
      url = await getFileUrlByFilename(filename);
    }

    if (!url) {
      console.error("[BrickArt] fileCreate userErrors:", data2?.fileCreate?.userErrors);
      throw new Error(JSON.stringify({ step: "fileCreate", errors: data2?.fileCreate?.userErrors || "no url after create" }));
    }

    console.log("[BrickArt] File ready:", url);
    return url;
  }

  try {
    // --- 5) Parse body ---
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      timestamp,
      imageClean_b64,
      imageLogo_b64,
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing required fields (timestamp and image)" });
    }

    console.log("[BrickArt] Submission received:", { nickname, category, grid, baseplate, totalBricks, timestamp });

    // --- 6) Upload images (robust) ---
    const safeNameBase =
      `${String(timestamp).replace(/[:.Z\-]/g,"")}-${String(nickname||"anon").toLowerCase().replace(/[^a-z0-9]+/g,"-")}`.replace(/-+/g,"-");

    const cleanUrl = await uploadImageB64ToFiles(imageClean_b64, `${safeNameBase}-clean.png`, "Brick Art design (clean)");
    const logoUrl  = await uploadImageB64ToFiles(imageLogo_b64,  `${safeNameBase}-logo.png`,  "Brick Art design (watermarked)");

    // --- 7) Build article HTML ---
    const meta = [
      grid ? `Grid: ${grid}` : "",
      baseplate ? `Baseplate: ${baseplate}` : "",
      (typeof totalBricks === "number" ? `Total Bricks: ${totalBricks}` : ""),
    ].filter(Boolean).join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Anonymous")}</p>
      ${meta ? `<p>${esc(meta)}</p>` : ""}
      ${category ? `<p><em>Category:</em> ${esc(category)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Brick Art design (clean)"/></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}" alt="Brick Art design (watermarked)"/></p>` : ""}
    `.trim();

    // --- 8) Create blog article — publish immediately (like yesterday) ---
    const articlePayload = {
      article: {
        title: `Brick Art submission — ${nickname || "Anonymous"} (${new Date(timestamp).toLocaleString()})`,
        body_html,
        tags: category || undefined,
        published: true, // 👈 make it appear right away
      },
    };

    const r = await shopifyREST(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(articlePayload),
    });

    const t = await r.text();
    let articleJson = {};
    try { articleJson = t ? JSON.parse(t) : {}; } catch {}

    if (!r.ok) {
      console.error("[BrickArt] Blog create FAILED", r.status, articleJson?.errors || t?.slice(0,300));
      return res.status(500).json({
        ok: false,
        error: "Failed to create blog post",
        detail: articleJson?.errors || t,
        cleanUrl,
        logoUrl,
      });
    }

    const articleId = articleJson?.article?.id;
    const handle = articleJson?.article?.handle;
    const blogHandle = articleJson?.article?.blog?.handle;
    const storefrontUrl = (handle && blogHandle)
      ? `https://${STORE}/blogs/${blogHandle}/${handle}`
      : null;

    return res.status(200).json({
      ok: true,
      articleId,
      cleanUrl,
      logoUrl,
      storefrontUrl,
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
