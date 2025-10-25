// server.js — VibeXpert Backend (Supabase + Brevo)
// Author: Irfan & GPT-5 Team
// Date: 2025

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import multer from "multer";
import http from "http";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { sendEmail } from "./utils/sendEmail.js";

dotenv.config();

// ==================== CONFIG ====================

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.vibexpert.online";
const JWT_SECRET = process.env.JWT_SECRET || "vibexpert-secret-2025";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== MIDDLEWARE ====================

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// File uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Helper utilities
const hashPassword = (pw) => crypto.createHash("sha256").update(pw).digest("hex");
const genCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const signToken = (user) => jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

// ==================== ROUTES ====================

// Health check
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date() }));

// Signup
app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "All fields required" });

    const hash = hashPassword(password);

    const { data: existing } = await supabase.from("users").select("id").eq("email", email).single();
    if (existing) return res.status(400).json({ error: "Email already exists" });

    const { data: user, error } = await supabase
      .from("users")
      .insert([{ username, email, password_hash: hash }])
      .select()
      .single();

    if (error) throw error;

    // Send welcome email
    await sendEmail({
      to: email,
      subject: "🎉 Welcome to VibeXpert!",
      html: `<p>Hey ${username},</p><p>Your account has been successfully created! Start vibing with your college community 🎓</p>`,
    });

    const token = signToken(user);
    res.json({ message: "Registered successfully", token, user });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: "Signup failed" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const hash = hashPassword(password);

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .eq("password_hash", hash)
      .single();

    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const token = signToken(user);
    res.json({ message: "Login successful", token, user });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// Forgot Password
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const { data: user } = await supabase.from("users").select("id,username").eq("email", email).single();

    if (!user) return res.status(404).json({ error: "No account found" });

    const code = genCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await supabase.from("codes").insert([{ user_id: user.id, code, type: "reset", expires_at: expiresAt }]);

    await sendEmail({
      to: email,
      subject: "🔐 Password Reset Code",
      html: `<p>Hello ${user.username},</p><p>Your password reset code is:</p><h2>${code}</h2><p>This code expires in 15 minutes.</p>`,
    });

    res.json({ message: "Reset code sent" });
  } catch (err) {
    res.status(500).json({ error: "Could not send reset code" });
  }
});

// Verify Reset Code
app.post("/api/verify-reset", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const { data: user } = await supabase.from("users").select("id").eq("email", email).single();

    const { data: codeRow } = await supabase
      .from("codes")
      .select("*")
      .eq("user_id", user.id)
      .eq("code", code)
      .eq("type", "reset")
      .eq("used", false)
      .single();

    if (!codeRow) return res.status(400).json({ error: "Invalid or expired code" });

    const hash = hashPassword(newPassword);
    await supabase.from("users").update({ password_hash: hash }).eq("id", user.id);
    await supabase.from("codes").update({ used: true }).eq("id", codeRow.id);

    res.json({ message: "Password reset successful" });
  } catch {
    res.status(500).json({ error: "Reset failed" });
  }
});

// College verification mail
app.post("/api/send-college-code", async (req, res) => {
  try {
    const { email, college } = req.body;
    const { data: user } = await supabase.from("users").select("id,username").eq("email", email).single();

    const code = genCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from("codes").insert([
      { user_id: user.id, code, type: "college", meta: { college }, expires_at: expiresAt },
    ]);

    await sendEmail({
      to: email,
      subject: "🎓 Confirm College Connection",
      html: `<p>Hi ${user.username},</p><p>Your college connection code is:</p><h2>${code}</h2><p>Use this to join <b>${college}</b> in VibeXpert!</p>`,
    });

    res.json({ message: "College code sent" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send college code" });
  }
});

// Verify College Code
app.post("/api/verify-college", async (req, res) => {
  try {
    const { email, code } = req.body;
    const { data: user } = await supabase.from("users").select("id").eq("email", email).single();

    const { data: codeRow } = await supabase
      .from("codes")
      .select("*")
      .eq("user_id", user.id)
      .eq("code", code)
      .eq("type", "college")
      .eq("used", false)
      .single();

    if (!codeRow) return res.status(400).json({ error: "Invalid or expired code" });

    const collegeName = codeRow.meta?.college;
    await supabase
      .from("users")
      .update({ college: collegeName, community_joined: true })
      .eq("id", user.id);
    await supabase.from("codes").update({ used: true }).eq("id", codeRow.id);

    res.json({ message: "College verified successfully" });
  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

// ==================== SOCKET.IO ====================
const io = new Server(server, { cors: { origin: FRONTEND_URL } });

io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);

  socket.on("join_college", (college) => socket.join(college));

  socket.on("send_message", async ({ college, senderId, message }) => {
    const { data } = await supabase
      .from("messages")
      .insert([{ sender_id: senderId, content: message }])
      .select("*")
      .single();

    io.to(college).emit("new_message", data);
  });

  socket.on("disconnect", () => console.log("❌ Socket disconnected"));
});

// ==================== START SERVER ====================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
══════════════════════════════════════════════════════════════════════
🚀 VibeXpert Backend is running on port ${PORT}
🌐 Frontend: ${FRONTEND_URL}
💾 Database: Supabase connected
📧 Brevo Email API active
══════════════════════════════════════════════════════════════════════`);
});
