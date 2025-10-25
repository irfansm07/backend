// utils/sendEmail.js
import axios from "axios";

export async function sendEmail({ to, subject, html }) {
  try {
    const apiKey = process.env.BREVO_API_KEY;
    const fromEmail = process.env.BREVO_FROM_EMAIL || "vibexpert06@gmail.com";
    const fromName = process.env.BREVO_FROM_NAME || "VibeXpert";

    if (!apiKey) {
      console.error("❌ Missing BREVO_API_KEY in environment");
      return false;
    }

    const response = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: fromName, email: fromEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      },
      {
        headers: {
          accept: "application/json",
          "api-key": apiKey,
          "content-type": "application/json",
        },
      }
    );

    console.log(`✅ Email sent to ${to} — ${subject}`);
    return response.data;
  } catch (error) {
    console.error("❌ Email sending failed:", error.response?.data || error.message);
    return false;
  }
}
