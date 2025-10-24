// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['https://www.vibexpert.online'], methods: ['GET', 'POST'] }
});

// ==================== MIDDLEWARE ====================
app.use(cors({
  origin: ['https://www.vibexpert.online'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

// ==================== ENV / SUPABASE ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const JWT_SECRET = process.env.JWT_SECRET || 'change_this';
const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL;
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || 'CampusApp';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'public';

// ==================== FILE UPLOAD ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ==================== HELPERS ====================
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

// ==================== EMAIL FUNCTION ====================
async function sendEmail({ to, subject, html, text }) {
  if (!BREVO_KEY || !BREVO_FROM_EMAIL) {
    console.warn('⚠️ Brevo config missing — skipping email send.');
    return;
  }

  try {
    const res = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: html || text,
        textContent: text || html,
      },
      { headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' } }
    );
    console.log(`📧 Email sent to ${to} (status ${res.status})`);
  } catch (err) {
    console.error('❌ Email send failed:', err.response?.data || err.message);
  }
}

// ==================== AUTH MIDDLEWARE ====================
async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .single();
    if (error || !user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== ROUTES ====================

// ✅ Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: 'Missing fields' });

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const pwHash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('users')
      .insert({ username, email, password_hash: pwHash })
      .select()
      .single();
    if (error) throw error;

    // Send welcome email
    const subject = 'Welcome to Campus Vibe 🎉';
    const html = `<p>Hey ${username},</p><p>Congratulations — your account was created! Welcome to the community.</p>`;
    await sendEmail({ to: email, subject, html });

    const token = signToken(data);
    res.json({
      user: { id: data.id, username: data.username, email: data.email },
      token,
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ✅ Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    if (error || !user) return res.status(400).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        college: user.college,
        communityJoined: user.community_joined,
      },
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ✅ Forgot Password
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    if (!user) return res.status(400).json({ error: 'Email not found' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await supabase.from('codes').insert({
      user_id: user.id,
      code,
      type: 'reset',
      expires_at: expires.toISOString(),
    });

    await sendEmail({
      to: email,
      subject: 'Password Reset Code',
      html: `<p>Your password reset code is <b>${code}</b>. It expires in 15 minutes.</p>`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Could not send reset code' });
  }
});

// ✅ Example protected route
app.get('/api/profile', authMiddleware, async (req, res) => {
  res.json({ user: req.user });
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('✅ Socket connected:', socket.id);
  socket.on('disconnect', () => console.log('❌ Socket disconnected:', socket.id));
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log(`🚀 VibeXpert Backend running on Render`);
  console.log(`🌍 Frontend: https://www.vibexpert.online`);
  console.log(`🔗 API: https://vibexpert-backend-main.onrender.com`);
  console.log('==============================================');
});
