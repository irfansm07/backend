// ============================================================
// 🎓 VibeXpert Backend - Full Production Version
// Frontend: https://www.vibexpert.online
// Backend:  Render-hosted
// ============================================================

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import http from "http";
import { Server } from "socket.io";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

dotenv.config();

// ============================================================
// 🌐 Environment Config
// ============================================================
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.vibexpert.online";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || "vibexpert-secret-2025";

// ============================================================
// 💾 Initialize Services
// ============================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ["GET", "POST"], credentials: true },
});

// ============================================================
// ⚙️ Middleware
// ============================================================
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// 🔐 Helper Functions
// ============================================================
const generateToken = (user) =>
  jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

const sendEmail = async ({ to, subject, html }) => {
  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { email: "noreply@vibexpert.online", name: "VibeXpert" },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      },
      { headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json" } }
    );
    console.log(`📧 Email sent to ${to}`);
  } catch (err) {
    console.error("❌ Brevo Error:", err.response?.data || err.message);
  }
};

// ============================================================
// 🚀 Routes
// ============================================================

// Root route
app.get("/", (req, res) => {
  res.json({ message: "🎓 VibeXpert Backend running successfully!" });
});

// ------------------------------------------------------------
// 🧍 Register User
// ------------------------------------------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "All fields required" });

    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .single();
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
      html: `<p>Hey ${username},</p><p>Welcome to <strong>VibeXpert</strong>! Your account was successfully created.</p>`,
    });

    const token = generateToken(user);
    res.json({ success: true, token, user });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ------------------------------------------------------------
// 🔑 Login
// ------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (error || !user) return res.status(400).json({ error: "Invalid email or password" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Invalid credentials" });

    const token = generateToken(user);
    res.json({ success: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ------------------------------------------------------------
// 🔁 Forgot Password
// ------------------------------------------------------------
app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  const { error } = await supabase
    .from("reset_codes")
    .insert([{ email, code }]);

  if (error) return res.status(500).json({ error: "Failed to save reset code" });

  await sendEmail({
    to: email,
    subject: "🔑 Your VibeXpert Password Reset Code",
    html: `<p>Your password reset code is: <strong>${code}</strong></p>`,
  });

  res.json({ success: true, message: "Reset code sent to email" });
});

// ------------------------------------------------------------
// 🏫 Select & Verify College
// ------------------------------------------------------------
app.post("/api/select-college", async (req, res) => {
  const { email, college } = req.body;
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await sendEmail({
    to: email,
    subject: "🎓 Confirm College Connection",
    html: `<p>Your verification code for ${college} is <strong>${code}</strong></p>`,
  });

  const { error } = await supabase.from("college_codes").insert([{ email, college, code }]);
  if (error) return res.status(500).json({ error: "Failed to save college code" });

  res.json({ success: true });
});

app.post("/api/verify-college", async (req, res) => {
  const { email, code } = req.body;

  const { data, error } = await supabase
    .from("college_codes")
    .select("*")
    .eq("email", email)
    .eq("code", code)
    .single();

  if (error || !data) return res.status(400).json({ error: "Invalid code" });

  await supabase
    .from("users")
    .update({ college: data.college, communityJoined: true })
    .eq("email", email);

  res.json({ success: true, message: "College verified successfully" });
});

// ------------------------------------------------------------
// 💬 Real-Time Chat
// ------------------------------------------------------------
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.on("join_community", (college) => socket.join(college));

  socket.on("send_message", async ({ college, senderId, content, imageUrl }) => {
    const { data, error } = await supabase
      .from("messages")
      .insert([{ senderId, content, imageUrl, college }])
      .select()
      .single();
    if (!error) io.to(college).emit("new_message", data);
  });

  socket.on("disconnect", () => console.log("❌ User disconnected:", socket.id));
});

// ------------------------------------------------------------
// 📸 Post Upload
// ------------------------------------------------------------
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

    const { error: postError } = await supabase
      .from("posts")
      .insert([{ userId, imageUrl: publicUrl, caption, postedTo }]);
    if (postError) throw postError;

    res.json({ success: true, imageUrl: publicUrl });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ============================================================
// 🟢 Server Start
// ============================================================
server.listen(PORT, "0.0.0.0", () => {
  console.log("===========================================");
  console.log("🚀 VibeXpert Backend Live on Render");
  console.log(`🌐 URL: https://vibexpert-backend-main.onrender.com`);
  console.log(`💾 DB: Supabase Connected`);
  console.log(`📧 Brevo: ${BREVO_API_KEY ? "Active" : "Missing"}`);
  console.log(`🔗 Frontend: ${FRONTEND_URL}`);
  console.log("===========================================");
});
