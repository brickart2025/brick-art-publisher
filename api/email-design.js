// /api/email-design.js
// Vercel serverless function for emailing Brick Art design PDFs via SendGrid

import sgMail from "@sendgrid/mail";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

// Default FROM / BCC, can be overridden with env vars
const FROM_EMAIL = process.env.FROM_EMAIL || "designs@brick-art.com";
const BCC_EMAIL = process.env.BCC_EMAIL || "gallery@brick-art.com";

// Basic CORS – allow your Shopify storefront to call this route
// --------------- CORS CONFIGURATION ---------------
// Allow frontend calls from your Shopify storefront

const allowedOrigins = [
  "https://www.brick-art.com",
  "https://brick-art.com"
];

res.setHeader("Access-Control-Allow-Credentials", "true");
res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");

// Echo back the requesting origin ONLY if it's allowed
const origin = req.headers.origin;
if (allowedOrigins.includes(origin)) {
  res.setHeader("Access-Control-Allow-Origin", origin);
}

// Preflight (OPTIONS)
if (req.method === "OPTIONS") {
  return res.status(200).end();
}

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!SENDGRID_API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "Email service not configured" });
  }

  try {
    const {
      email,          // recipient (user)
      nickname,       // optional design name / student name
      whichGrid,      // "16" or "32"
      baseplate,      // baseplate label (e.g. "Green 16x16")
      totalBricks,    // integer
      pdfBase64,      // PDF as base64 (no data: prefix)
    } = req.body || {};

    if (!email || !pdfBase64) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing 'email' or 'pdfBase64' in body" });
    }

    const safeNickname = (nickname || "design").replace(/[^a-z0-9_\-]+/gi, "_");
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

    const msg = {
      to: email,
      from: FROM_EMAIL,
      bcc: BCC_EMAIL,
      subject,
      text: textBody,
      html: htmlBody,
      attachments: [
        {
          content: pdfBase64,
          filename,
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    };

    await sgMail.send(msg);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[BrickArt] /api/email-design error:", err);

    // SendGrid sometimes returns an array of errors in err.response.body
    if (err.response && err.response.body) {
      console.error("[BrickArt] SendGrid response body:", err.response.body);
    }

    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
