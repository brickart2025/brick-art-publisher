// Replace your current uploadToFiles() with this:
async function uploadToFiles(b64MaybePrefixed, filename) {
  if (!b64MaybePrefixed) return null;

  // Clean: strip data URL prefix and whitespace/newlines
  const raw = String(b64MaybePrefixed)
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
    .replace(/\s+/g, "");

  if (!raw || raw.length < 50) {
    console.warn("[BrickArt] base64 too short for", filename, raw.length);
    return null;
  }

  // --- Build multipart form data ---
  const formData = new FormData();
  formData.append("file[attachment]", raw);
  formData.append("file[filename]", filename);

  const resp = await fetch(`https://${STORE}/admin/api/${API_VERSION}/files.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN,
      Accept: "application/json",
    },
    body: formData,
  });

  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  console.log("[BrickArt] /files.json (multipart) ->", { status: resp.status, ok: resp.ok, preview: (text || "").slice(0, 140) });

  let url = json?.file?.url || (Array.isArray(json?.files) ? json.files[0]?.url : null) || null;
  if (!resp.ok && !url) throw new Error(`File upload failed: ${resp.status} ${resp.statusText}`);
  console.log("[BrickArt] File ready:", url);
  return url;
}
