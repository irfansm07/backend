// ============================================================
// 🎓 VibeXpert Backend - Render Compatible Version
// ============================================================
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
require("dotenv").config();

// ============================================================
// 🔧 Configuration
// ============================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL, methods: ["GET", "POST"], credentials: true },
});

const PORT = process.env.PORT || 10000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.vibexpert.online";
const JWT_SECRET = process.env.JWT_SECRET || "vibexpert_secret";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ============================================================
// 🧩 Middleware
// ============================================================
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// ✉️ Email Sender
// ============================================================
async function sendEmail({ to, subject, html }) {
  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { email: "noreply@vibexpert.online", name: "VibeXpert" },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("📧 Email sent to:", to);
  } catch (err) {
    console.error("❌ Email Error:", err.response?.data || err.message);
  }
}

// ============================================================
// 🔐 JWT Helper
// ============================================================
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

// ============================================================
// 🧍 Authentication Routes
// ============================================================
app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "All fields are required" });

    const { data: existing } = await supabase.from("users").select("*").eq("email", email).single();
    if (existing) return res.status(400).json({ error: "Email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase
      .from("users")
      .insert([{ username, email, password: hashed, communityJoined: false }])
      .select()
      .single();
    if (error) throw error;

    await sendEmail({
      to: email,
      subject: "🎉 Welcome to VibeXpert!",
      html: `<p>Hey ${username},</p><p>Your account was created successfully. Start vibing now!</p>`,
    });

    const token = signToken(user);
    res.json({ success: true, token, user });
  } catch (err) {
    console.error("Register Error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user } = await supabase.from("users").select("*").eq("email", email).single();
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Invalid credentials" });

    const token = signToken(user);
    res.json({ success: true, token, user });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

// ============================================================
// 🔑 Forgot Password
// ============================================================
app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase.from("reset_codes").insert([{ email, code }]);

  await sendEmail({
    to: email,
    subject: "🔑 Reset your VibeXpert password",
    html: `<p>Your reset code is: <b>${code}</b></p>`,
  });

  res.json({ success: true });
});

// ============================================================
// 🏫 College Join & Verification
// ============================================================
app.post("/api/select-college", async (req, res) => {
  const { email, college } = req.body;
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase.from("college_codes").insert([{ email, college, code }]);

  await sendEmail({
    to: email,
    subject: "🎓 Confirm your College",
    html: `<p>Your verification code for <b>${college}</b> is: <b>${code}</b></p>`,
  });

  res.json({ success: true });
});

app.post("/api/verify-college", async (req, res) => {
  const { email, code } = req.body;
  const { data } = await supabase
    .from("college_codes")
    .select("*")
    .eq("email", email)
    .eq("code", code)
    .single();

  if (!data) return res.status(400).json({ error: "Invalid code" });

  await supabase
    .from("users")
    .update({ college: data.college, communityJoined: true })
    .eq("email", email);

  res.json({ success: true });
});

// ============================================================
// 💬 Chat System (Socket.io)
// ============================================================
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.on("join", (college) => socket.join(college));

  socket.on("message", async (msg) => {
    const { college, senderId, content, imageUrl } = msg;
    const { data } = await supabase
      .from("messages")
      .insert([{ college, senderId, content, imageUrl }])
      .select()
      .single();
    io.to(college).emit("new_message", data);
  });

  socket.on("disconnect", () => console.log("❌ Disconnected:", socket.id));
});

// ============================================================
// 📸 Post System
// ============================================================
app.post("/api/post/upload", upload.single("image"), async (req, res) => {
  try {
    const { userId, caption, postedTo } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const fileName = `posts/${crypto.randomUUID()}-${file.originalname}`;
    const { data, error } = await supabase.storage
      .from("images")
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (error) throw error;
    const { publicUrl } = supabase.storage.from("images").getPublicUrl(fileName).data;

    await supabase.from("posts").insert([{ userId, imageUrl: publicUrl, caption, postedTo }]);

    res.json({ success: true, imageUrl: publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ============================================================
// ✅ Server Start
// ============================================================
server.listen(PORT, () => {
  console.log(`🚀 VibeXpert backend live on port ${PORT}`);
});
