// /api/submit.js — Brick Art Publisher (Vercel serverless)
// Upload images (staged uploads) → Shopify Files → Create Blog Article.
// Store submitter email privately as an article metafield (not shown publicly).

export default async function handler(req, res) {
  // --- CORS ---
  const ORIGINS = new Set([
    "https://www.brick-art.com",
    "https://brick-art.com",
    "https://brick-art.myshopify.com",
    "http://localhost:3000",
  ]);
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- Env ---
  const STORE   = process.env.SHOPIFY_STORE_DOMAIN;     // e.g. brick-art.myshopify.com
  const TOKEN   = process.env.SHOPIFY_ADMIN_API_TOKEN;  // write_files, read_files, write_content
  const BLOG_ID = process.env.BLOG_ID;                  // numeric blog ID
  if (!STORE || !TOKEN || !BLOG_ID) {
    console.error("[BrickArt] Missing envs", { STORE: !!STORE, TOKEN: !!TOKEN, BLOG_ID: !!BLOG_ID });
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const API_VERSION = "2024-07";
  const REST_BASE   = `https://${STORE}/admin/api/${API_VERSION}`;
  const GQL_URL     = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

  // --- Helpers ---
  const esc = (s = "") => String(s).replace(/[&<>"]/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));
  const toRawBase64 = (src = "") => src.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function shopifyREST(path, init = {}) {
    const url = `${REST_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    };
    console.log("[BrickArt] REST →", url);
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
    const t = await r.text();
    let j = {};
    try { j = t ? JSON.parse(t) : {}; } catch {}
    if (!r.ok || j.errors) {
      console.error("[BrickArt] GQL FAILED", r.status, j.errors || t?.slice(0, 300));
      throw new Error(JSON.stringify({ step: "graphql", status: r.status, errors: j.errors || t }));
    }
    return j.data;
  }

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
        if (node.__typename === "MediaImage" && node.image?.url) return node.image.url;
        if (node.__typename === "GenericFile" && node.url) return node.url;
      }
      await sleep(500 + i * 250);
    }
    return null;
  }

  async function uploadImageB64ToFiles(base64, filename, altText) {
    if (!base64) return null;
    const raw = toRawBase64(base64);
    if (!raw) return null;

    // 1) stagedUploadsCreate
    const STAGED_UPLOADS_CREATE = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }
    `;
    const input = [{ resource: "IMAGE", filename, mimeType: "image/png", httpMethod: "POST" }];
    const d1 = await shopifyGQL(STAGED_UPLOADS_CREATE, { input });
    const target = d1?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      throw new Error(JSON.stringify({ step: "stagedUploadsCreate", errors: d1?.stagedUploadsCreate?.userErrors }));
    }

    // 2) POST bytes to S3
    const bytes = Buffer.from(raw, "base64");
    const fileBlob = new Blob([bytes], { type: "image/png" });
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append("file", fileBlob, filename);
    const s3 = await fetch(target.url, { method: "POST", body: form });
    if (!s3.ok) {
      const tt = await s3.text().catch(() => "");
      console.error("[BrickArt] S3 upload FAILED", s3.status, tt?.slice(0,300));
      throw new Error(JSON.stringify({ step: "s3Upload", status: s3.status, error: tt }));
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
    const d2 = await shopifyGQL(FILE_CREATE, {
      files: [{ contentType: "IMAGE", originalSource: target.resourceUrl, alt: altText || "Brick Art submission" }]
    });

    let url = null;
    const created = d2?.fileCreate?.files?.[0] || null;
    if (created) {
      if (created.__typename === "MediaImage") url = created.image?.url || null;
      else if (created.__typename === "GenericFile") url = created.url || null;
    }
    if (!url) {
      console.warn("[BrickArt] fileCreate returned no URL; polling by filename…");
      url = await getFileUrlByFilename(filename);
    }
    if (!url) {
      console.error("[BrickArt] fileCreate userErrors:", d2?.fileCreate?.userErrors);
      throw new Error(JSON.stringify({ step: "fileCreate", errors: d2?.fileCreate?.userErrors || "no url after create" }));
    }

    console.log("[BrickArt] File ready:", url);
    return url;
  }

  try {
    // --- Parse body ---
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      nickname,
      category,
      grid,
      baseplate,
      totalBricks,
      brickCounts,
      timestamp,
      imageClean_b64,
      imageLogo_b64,
      submitterEmail, // ← from frontend; stored privately
    } = body;

    if (!timestamp || (!imageClean_b64 && !imageLogo_b64)) {
      return res.status(400).json({ ok: false, error: "Missing required fields (timestamp and image)" });
    }

    console.log("[BrickArt] Submission received:", {
      nickname, category, grid, baseplate, totalBricks, timestamp,
      cleanLen: imageClean_b64?.length || 0,
      logoLen:  imageLogo_b64?.length  || 0,
      hasEmail: !!userEmail
    });

    // --- Upload images (parallel) ---
    const safe =
      `${String(timestamp).replace(/[:.Z\-]/g,"")}-${String(nickname||"anon").toLowerCase().replace(/[^a-z0-9]+/g,"-")}`.replace(/-+/g,"-");

    const [cleanUrl, logoUrl] = await Promise.all([
      uploadImageB64ToFiles(imageClean_b64, `${safe}-clean.png`, "Brick Art design (clean)"),
      uploadImageB64ToFiles(imageLogo_b64,  `${safe}-logo.png`,  "Brick Art design (watermarked)"),
    ]);

    // --- Article body (no public email) ---
    const meta = [
      grid ? `Grid: ${grid}` : "",
      baseplate ? `Baseplate: ${baseplate}` : "",
      (typeof totalBricks === "number" ? `Total Bricks: ${totalBricks}` : ""),
    ].filter(Boolean).join(" · ");

    const body_html = `
      <p><strong>Nickname:</strong> ${esc(nickname || "Anonymous")}</p>
      ${meta ? `<p>${esc(meta)}</p>` : ""}
      ${cleanUrl ? `<p><img src="${cleanUrl}" alt="Brick Art design (clean)"/></p>` : ""}
      ${logoUrl  ? `<p><img src="${logoUrl}"  alt="Brick Art design (watermarked)"/></p>` : ""}
    `.trim();

    // --- Create article (publish now; set featured card image) ---
    const articlePayload = {
      article: {
        title: `Brick Art submission — ${nickname || "Anonymous"} (${new Date(timestamp).toLocaleString()})`,
        body_html,
        tags: category || undefined,
        published: true,
        image: cleanUrl ? { src: cleanUrl } : undefined,
      },
    };

    const ar = await shopifyREST(`/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      body: JSON.stringify(articlePayload),
    });

    const articleText = await ar.text();
    let articleJson = {};
    try { articleJson = articleText ? JSON.parse(articleText) : {}; } catch {}
    if (!ar.ok) {
      console.error("[BrickArt] Blog create FAILED", ar.status, articleJson?.errors || articleText?.slice(0,300));
      return res.status(500).json({ ok: false, error: "Failed to create blog post", detail: articleJson?.errors || articleText, cleanUrl, logoUrl });
    }

    const articleId = articleJson?.article?.id;
    // --- Save submitter email privately as a metafield ---
try {
  const articleId = aj?.article?.id;

  if (articleId && userEmail) {
    const mfBody = {
      metafield: {
        namespace: "brickart",
        key: "submitter_email",
        type: "single_line_text_field",
        value: String(userEmail),
        owner_resource: "article",
        owner_id: articleId
      }
    };

    const mfRes = await shopifyFetch("/metafields.json", {
      method: "POST",
      body: JSON.stringify(mfBody)
    });

    const mfText = await mfRes.text();
    if (!mfRes.ok) {
      console.warn("[BrickArt] metafield save failed", mfRes.status, mfRes.statusText, mfText?.slice(0,300));
    } else {
      console.log("[BrickArt] metafield saved for article", articleId);
    }
  }
} catch (mfErr) {
  console.error("[BrickArt] metafield creation error", mfErr);
}

  // --- Store submitter email privately as a metafield on the article ---
try {
  if (articleId && submitterEmail) {   // or: (articleId && userEmail)
    const mfBody = {
      metafield: {
        namespace: "brickart",
        key: "submitter_email",
        type: "single_line_text_field",
        value: String(submitterEmail), // or: String(userEmail)
      },
    };

    const mfRes = await shopifyREST(`/articles/${articleId}/metafields.json`, {
      method: "POST",
      body: JSON.stringify(mfBody),
    });

    const mfText = await mfRes.text();
    if (!mfRes.ok) {
      console.warn("[BrickArt] metafield save failed",
        mfRes.status, mfRes.statusText, mfText?.slice(0,300));
    } else {
      console.log("[BrickArt] metafield saved for article", articleId);
    }
  }
} catch (mfErr) {
  console.error("[BrickArt] metafield creation error", mfErr);
}  

    const handle = articleJson?.article?.handle;
    const blogHandle = articleJson?.article?.blog?.handle;
    const storefrontUrl = (handle && blogHandle) ? `https://${STORE}/blogs/${blogHandle}/${handle}` : null;

    return res.status(200).json({ ok: true, articleId, cleanUrl, logoUrl, storefrontUrl });
  } catch (err) {
    console.error("[BrickArt] Submit server error:", err);
    return res.status(500).json({ ok: false, error: "Server error", detail: err?.message || String(err) });
  }
}
