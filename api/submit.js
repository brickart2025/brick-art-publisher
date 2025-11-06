async function uploadImageB64ToFiles(base64, filename, altText) {
  if (!base64) return null;
  const raw = toRawBase64(base64);
  if (!raw) return null;

  // Step 1: Ask Shopify for a staged upload target
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
    resource: "IMAGE",              // 👈 CHANGED from "FILE" to "IMAGE"
    filename,
    mimeType: "image/png",
    httpMethod: "POST"
  }];
  const data1 = await shopifyGQL(STAGED_UPLOADS_CREATE, { input });
  const target = data1?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    throw new Error(JSON.stringify({ step: "stagedUploadsCreate", errors: data1?.stagedUploadsCreate?.userErrors }));
  }

  // Step 2: Upload PNG to the provided S3 URL
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

  // Step 3: Register that image in Shopify Files
  const FILE_CREATE = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          __typename
          ... on MediaImage {
            id
            alt
            image { url }
          }
        }
        userErrors { field message }
      }
    }
  `;
  const data2 = await shopifyGQL(FILE_CREATE, {
    files: [{
      alt: altText || "Brick Art submission",
      contentType: "IMAGE",
      originalSource: target.resourceUrl   // 👈 the resourceUrl from staged upload
    }]
  });
  const created = data2?.fileCreate?.files?.[0];
  if (!created || !created.image?.url) {
    console.error("[BrickArt] fileCreate userErrors:", data2?.fileCreate?.userErrors);
    throw new Error(JSON.stringify({ step: "fileCreate", errors: data2?.fileCreate?.userErrors }));
  }

  const url = created.image.url;
  console.log("[BrickArt] File created:", url);
  return url;
}
