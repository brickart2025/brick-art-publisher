// api/axios-lite.js
// Tiny helper that imitates axios.post using fetch.
// We do this so we don't have to depend on axios in Vercel's runtime.

export async function axiosPost(url, data, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(data),
  });

  const rawText = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // not JSON (Shopify sometimes returns HTML error if auth fails badly)
    parsed = rawText;
  }

  return {
    ok: res.ok,
    status: res.status,
    data: parsed,
  };
}
