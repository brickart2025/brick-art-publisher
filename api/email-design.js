// /api/email-design.js
// Vercel serverless function for emailing Brick Art design PDFs via SendGrid,
// implemented using the SendGrid HTTP API (no @sendgrid/mail package needed).

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "designs@brick-art.com";
const BCC_EMAIL = process.env.BCC_EMAIL || "gallery@brick-art.com";

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
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!SENDGRID_API_KEY) {
    console.error("[BrickArt] SENDGRID_API_KEY is not set");
    return res
      .status(500)
      .json({ ok: false, error: "Email service not configured" });
  }

  try {
    const {
      email,       // recipient (user)
      nickname,    // optional design name / student name
      whichGrid,   // "16" or "32"
      baseplate,   // baseplate label
      totalBricks, // integer
      pdfBase64,   // PDF as base64 (no data: prefix)
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
      typeof totalBricks === "number" ? `Total Bricks: ${totalBricks}` : "",
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

    // --- Build SendGrid HTTP payload ---
    const sgPayload = {
      personalizations: [
        {
          to: [{ email }],
          ...(BCC_EMAIL
            ? { bcc: [{ email: BCC_EMAIL }] }
            : {}),
          subject,
        },
      ],
      from: { email: FROM_EMAIL, name: "Brick Art" },
      content: [
        { type: "text/plain", value: textBody },
        { type: "text/html", value: htmlBody },
      ],
      attachments: [
        {
          content: pdfBase64,              // base64 string without data: prefix
          filename,
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    };

    // --- Call SendGrid HTTP API ---
    const sgRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sgPayload),
    });

    if (!sgRes.ok) {
      const errText = await sgRes.text().catch(() => "");
      console.error("[BrickArt] SendGrid API error:", sgRes.status, errText);
      return res
        .status(502)
        .json({ ok: false, error: "Upstream email service error" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[BrickArt] /api/email-design error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
