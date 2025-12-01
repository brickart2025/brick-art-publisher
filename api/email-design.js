// /api/email-design.js
// Vercel serverless function for emailing Brick Art design PDFs via SendGrid HTTP API (using axios, ESM)

import axios from "axios";

// --- Config from environment variables ---
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "designs@brick-art.com";
const BCC_EMAIL = process.env.BCC_EMAIL || "gallery@brick-art.com";

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
      // safety guard ~4MB
      if (rawBody.length > 4 * 1024 * 1024) {
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
    email,       // recipient (user)
    nickname,    // optional design name / student name
    whichGrid,   // "16" or "32"
    baseplate,   // baseplate label
    totalBricks, // integer
    pdfBase64,   // PDF as base64 (no data: prefix)
  } = data || {};

  if (!email || !pdfBase64) {
    console.error(
      "[BrickArt] Missing required fields. email:",
      email,
      "pdfBase64 present:",
      !!pdfBase64
    );
    return res
      .status(400)
      .json({ ok: false, error: "Missing 'email' or 'pdfBase64' in body" });
  }

  try {
    const safeNickname = (nickname || "design").replace(
      /[^a-z0-9_\-]+/gi,
      "_"
    );
    const sizeLabel = whichGrid ? `${whichGrid}x${whichGrid}` : "mosaic";
    const filename = `BrickArt-${safeNickname}-${sizeLabel}.pdf`;

    const subject = "Your Brick Art mosaic design";

    const textBody = [
      "Here is the PDF of your Brick Art mosaic design.",
      "",
      whichGrid ? `Grid: ${sizeLabel}` : "",
      baseplate ? `Baseplate: ${baseplate}` : "",
      typeof totalBricks === "number"
        ? `Total Bricks: ${totalBricks}`
        : "",
      "",
      "Have fun building!",
    ]
      .filter(Boolean)
      .join("\n");

    const htmlBody = `
      <p>Here is the PDF of your Brick Art mosaic design.</p>
      <p>
        ${whichGrid ? `<strong>Grid:</strong> ${sizeLabel}<br/>` : ""}
        ${baseplate ? `<strong>Baseplate:</strong> ${baseplate}<br/>` : ""}
        ${
          typeof totalBricks === "number"
            ? `<strong>Total Bricks:</strong> ${totalBricks}<br/>`
            : ""
        }
      </p>
      <p>Have fun building!</p>
    `;

    // Build SendGrid v3 API payload
    const personalization = {
      to: [{ email }],
    };
    if (BCC_EMAIL) {
      personalization.bcc = [{ email: BCC_EMAIL }];
    }

    const payload = {
      personalizations: [personalization],
      from: { email: FROM_EMAIL },
      subject,
      content: [
        { type: "text/plain", value: textBody },
        { type: "text/html", value: htmlBody },
      ],
      attachments: [
        {
          content: pdfBase64,
          filename,
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    };

    await axios.post("https://api.sendgrid.com/v3/mail/send", payload, {
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[BrickArt] /api/email-design error:", err?.message || err);
    if (err.response) {
      console.error(
        "[BrickArt] SendGrid status:",
        err.response.status,
        "data:",
        err.response.data
      );
    }
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
