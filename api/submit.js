// api/submit.js

const ALLOWED_ORIGINS = [
  "https://www.brick-art.com",
  "https://brick-art.com",
];

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json"
});

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method Not Allowed" }), { status: 405, headers });
  }

  try {
    const body = await req.json();
    const { nickname, timestamp, imageClean_b64, imageLogo_b64 } = body || {};
    if (!nickname || !timestamp) {
      return new Response(JSON.stringify({ ok: false, error: "Missing required fields (nickname, timestamp)" }), { status: 400, headers });
    }

    // ... your Shopify post logic ...

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: "Server error" }), { status: 500, headers });
  }
}
