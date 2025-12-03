// /api/email-image.js
// Vercel function to email a PNG of the Brick Art design via SendGrid HTTP API

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "designs@brick-art.com";

if (!SENDGRID_API_KEY) {
  console.error(
    "[BrickArt] SENDGRID_API_KEY is not set. Email route will fail until this is configured."
  );
}

export default async function handler(req, res) {
  // --------------- CORS CONFIGURATION ---------------
  const allowedOrigins = [
    "https://www.brick-art.com",
    "https://brick-art.com",
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight (OPTIONS)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  // --------------------------------------------------

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ ok: false, error: "Method not allowed" });
  }

  if (!SENDGRID_API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "Email service not configured" });
  }

  // ---- Read & parse JSON body manually ----
  let rawBody = "";
  try {
    for await (const chunk of req) {
      rawBody += chunk;
      // safety guard ~2MB (image should be small)
      if (rawBody.length > 2 * 1024 * 1024) {
        return res
          .status(413)
          .json({ ok: false, error: "Payload too large" });
      }
    }
  } catch (e) {
    console.error("[BrickArt] Error reading request body:", e);
    return res
      .status(400)
      .json({ ok: false, error: "Unable to read request body" });
  }

  let data = {};
  try {
    data = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    console.error("[BrickArt] Invalid JSON body:", e);
    return res
      .status(400)
      .json({ ok: false, error: "Invalid JSON body" });
  }

  const {
    email,
    nickname,
    grid,
    totalBricks,
    brickCounts,  // object { red: 10, blue: 5, ... }
    imageBase64,  // PNG as base64 (no data: prefix)
  } = data || {};

  if (!email || !imageBase64) {
    console.error(
      "[BrickArt] Missing required fields. email:",
      email,
      "imageBase64 present:",
      !!imageBase64
    );
    return res
      .status(400)
      .json({ ok: false, error: "Missing 'email' or 'imageBase64' in body" });
  }

  try {
    const safeNickname = (nickname || "design").replace(
      /[^a-z0-9_\-]+/gi,
      "_"
    );
    const sizeLabel = grid ? `${grid}x${grid}` : "mosaic";

    const brickLines = brickCounts
      ? Object.entries(brickCounts)
          .map(([id, n]) => `${id}: ${n}`)
          .join(", ")
      : "";

    const subject = "Your Brick Art mosaic design";

    const textBodyLines = [
      "Here is a PNG image of your Brick Art mosaic design.",
      "",
      grid ? `Grid: ${sizeLabel}` : "",
      typeof totalBricks === "number"
        ? `Total Bricks: ${totalBricks}`
        : "",
      brickLines ? `Brick counts: ${brickLines}` : "",
      "",
      "Have fun building!",
    ].filter(Boolean);

    const textBody = textBodyLines.join("\n");

    const htmlBody = `
      <p>Here is a PNG image of your Brick Art mosaic design.</p>
      <p>
        ${grid ? `<strong>Grid:</strong> ${sizeLabel}<br/>` : ""}
        ${
          typeof totalBricks === "number"
            ? `<strong>Total Bricks:</strong> ${totalBricks}<br/>`
            : ""
        }
        ${
          brickLines
            ? `<strong>Brick counts:</strong> ${brickLines}<br/>`
            : ""
        }
      </p>
      <p>Have fun building!</p>
    `;

    const payload = {
      personalizations: [
        {
          to: [{ email }],
        },
      ],
      from: { email: FROM_EMAIL },
      subject,
      content: [
        { type: "text/plain", value: textBody },
        { type: "text/html", value: htmlBody },
      ],
      attachments: [
        {
          content: imageBase64,
          filename: `BrickArt-${safeNickname}-${sizeLabel}.png`,
          type: "image/png",
          disposition: "attachment",
        },
      ],
    };

    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[BrickArt] SendGrid error:",
        resp.status,
        resp.statusText,
        errText
      );
      return res
        .status(500)
        .json({ ok: false, error: "SendGrid error" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[BrickArt] /api/email-image error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
