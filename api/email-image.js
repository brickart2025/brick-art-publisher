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

    // Build brick breakdown for text + HTML
    const brickEntries = brickCounts
      ? Object.entries(brickCounts)
      : [];

    const brickLinesArray = brickEntries.map(
      ([id, n]) => `${id}: ${n}`
    );

    const brickListText = brickEntries.length
      ? ["Brick counts:", ...brickLinesArray.map((line) => `- ${line}`)].join("\n")
      : "";

    const brickListHtml = brickEntries.length
      ? `<p><strong>Brick counts:</strong></p><ul>${brickEntries
          .map(
            ([id, n]) =>
              `<li><strong>${id}:</strong> ${n}</li>`
          )
          .join("")}</ul>`
      : "";

    const subject = "Your Brick Art mosaic design";

    // --------- TEXT BODY ---------
    const textBodyLines = [
      "🎉 Your Brick Art mosaic is ready!",
      "",
      "Here is a PNG image of your Brick Art mosaic design.",
      "",
      grid ? `Grid: ${sizeLabel}` : "",
      typeof totalBricks === "number"
        ? `Total Bricks: ${totalBricks}`
        : "",
      brickListText,
      "",
      "Have fun building!",
      "",
      "🧱 About Brick Art",
      "Brick Art turns your designs into real brick mosaics.",
      "Explore kits, digital tools, and more at https://www.brick-art.com",
      "",
      "📲 Share your design & join the Brick Art Challenge!",
      "Build your best mosaic using your Brick Art kit, snap a clear photo, and share it on Instagram, TikTok, or Facebook with the hashtag #BrickArtChallenge.",
      "Follow @BrickArtOfficial so we can see your entry.",
      "",
      "Monthly winners earn new design kits and surprise Brick Art prizes.",
      "Each season, one builder wins a Mega Brick Art Bundle packed with creative goodies!",
      "",
      "Every design is unique — whether it’s a portrait, a pattern, or something wild, we want to see it!",
      "The more you share, the more chances you have to win.",
      "Be sure your profile is public so we can see your entry.",
      "",
      "👉 Ready to build, snap, and share?",
      "Join the #BrickArtChallenge today and bring your mosaics to life!",
      "",
      "Thanks again for designing with Brick Art!",
    ].filter(Boolean);

    const textBody = textBodyLines.join("\n");

    // --------- HTML BODY ---------
    const htmlBody = `
      <p><strong>🎉 Your Brick Art mosaic is ready!</strong></p>

      <p>Here is a PNG image of your Brick Art mosaic design.</p>

      <p>
        ${grid ? `<strong>Grid:</strong> ${sizeLabel}<br/>` : ""}
        ${
          typeof totalBricks === "number"
            ? `<strong>Total Bricks:</strong> ${totalBricks}<br/>`
            : ""
        }
      </p>

      ${brickListHtml || ""}

      <p>Have fun building!</p>

      <hr/>

      <p>
        <strong>🧱 About Brick Art</strong><br/>
        Brick Art turns your creativity into hands-on mosaic fun at home and in the classroom.
        Explore kits, digital tools, and more at
        <a href="https://www.brick-art.com" target="_blank">www.Brick-Art.com</a>.
      </p>

      <hr/>

      <p><strong>The Brick Art Challenge — Turn your creativity into prizes!</strong></p>

      <p>
        You’ve got the MEGA MOSAIC BUNDLE BOX or a BRICK ART MOSAIC DESIGN KIT — now it’s your turn
        to show the world what you can build. Share your mosaic masterpiece on social media for a
        chance to win exclusive Brick Art design kits and other awesome prizes.
      </p>

      <p><strong>🎉 How to Enter</strong></p>
      <ul>
        <li>Build your best mosaic design using your Brick Art kit.</li>
        <li>Earn extra points by having related "props" in your photo!</li>
        <li>Snap a clear photo of your creation.</li>
        <li>Share it on Instagram, TikTok, or Facebook with the hashtag <strong>#BrickArtChallenge</strong>.</li>
        <li>Follow <strong>@BrickArtOfficial</strong> so we can see your entry.</li>
      </ul>

      <p><strong>🏆 Prizes</strong></p>
      <ul>
        <li><strong>Monthly Winners</strong> – New design kits &amp; surprise Brick Art prizes.</li>
        <li><strong>Grand Prize</strong> – One lucky builder each season wins a
          <em>Mega Brick Art Bundle</em> packed with creative goodies!</li>
      </ul>

      <p>
        <strong>💡 Inspiration</strong><br/>
        Need ideas to get started? Check out our exclusive design gallery (only available to bundle
        owners) for patterns, guides, and creative prompts.
      </p>

      <p><strong>📲 Don’t Forget!</strong></p>
      <ul>
        <li>Every design is unique — whether it’s a portrait, a pattern, or something wild, we want to see it!</li>
        <li>The more you share, the more chances you have to win.</li>
        <li>Be sure your profile is public so we can see your entry.</li>
      </ul>

      <p>
        <strong>👉 Ready to build, snap, and share?</strong><br/>
        Join the <strong>#BrickArtChallenge</strong> today and bring your mosaics to life!
      </p>
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
