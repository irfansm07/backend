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
  cors: {
    origin: 'http://www.vibexpert.online',  // Frontend URL allowed
    methods: ['GET', 'POST']
  }
});

app.use(cors({
  origin: 'http://www.vibexpert.online',
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.use(express.json());

// Environment / config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const JWT_SECRET = process.env.JWT_SECRET || 'change_this';
const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL;
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || 'CampusApp';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'public';

// File upload middleware (single definition)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Helper: JWT signing
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

// Helper: send email via Brevo
async function sendEmail({ to, subject, html, text }) {
  if (!BREVO_KEY || !BREVO_FROM_EMAIL) {
    console.warn('Brevo API key or from email not configured. Skipping email send.');
    return null;
  }

  const url = 'https://api.brevo.com/v3/smtp/email';
  const payload = {
    sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
    to: [{ email: to }],
    subject,
    htmlContent: html || text,
    textContent: text || html
  };

  try {
    const res = await axios.post(url, payload, {
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' }
    });
    console.log('📧 Email sent:', to, 'status:', res.status);
    return res.data;
  } catch (err) {
    console.error('❌ Error sending email:', err.response?.data || err.message);
    throw err;
  }
}

// Auth middleware
async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { data: users, error } = await supabase.from('users').select('*').eq('id', decoded.id).single();
    if (error || !users) return res.status(401).json({ error: 'User not found' });
    req.user = users;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// --- ROUTES ---

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    const { data: existing, error: existErr } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existErr) throw existErr;
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const pwHash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('users').insert({
      username, email, password_hash: pwHash
    }).select().single();
    if (error) throw error;

    const subject = 'Welcome to Campus Vibe 🎉';
    const html = `<p>Hey ${username},</p><p>Congratulations — your account was created! Welcome to the community.</p>`;
    try {
      await sendEmail({ to: email, subject, html });
    } catch (mailErr) {
      console.error('Warning: welcome email failed to send:', mailErr.message || mailErr);
    }

    const token = signToken(data);
    res.json({ user: { id: data.id, username: data.username, email: data.email }, token });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
    if (error || !user) return res.status(400).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
    const token = signToken(user);
    res.json({ user: { id: user.id, username: user.username, email: user.email, college: user.college, communityJoined: user.community_joined }, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Forgot password - create reset code & email it
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });
    const { data: user, error: userErr } = await supabase.from('users').select('*').eq('email', email).single();
    if (userErr || !user) return res.status(400).json({ error: 'Email not found' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 1000 * 60 * 15);

    await supabase.from('codes').insert({
      user_id: user.id,
      code, type: 'reset', expires_at: expires.toISOString()
    });

    const subject = 'Your password reset code';
    const html = `<p>Your password reset code is <b>${code}</b>. It expires in 15 minutes.</p>`;

    try {
      await sendEmail({ to: email, subject, html });
    } catch (mailErr) {
      console.error('Forgot-password email failed:', mailErr.message || mailErr);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Could not send reset code' });
  }
});

// Verify reset code & reset password
app.post('/api/verify-reset-code', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Missing fields' });

    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) return res.status(400).json({ error: 'User not found' });

    const { data: codeRow } = await supabase.from('codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .eq('type', 'reset')
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!codeRow) return res.status(400).json({ error: 'Invalid code' });
    if (new Date(codeRow.expires_at) < new Date()) return res.status(400).json({ error: 'Code expired' });

    const pwHash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: pwHash }).eq('id', user.id);
    await supabase.from('codes').update({ used: true }).eq('id', codeRow.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('Verify reset code error:', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// select college - sends confirmation code to user's email
app.post('/api/select-college', authMiddleware, async (req, res) => {
  try {
    const { college } = req.body;
    if (!college) return res.status(400).json({ error: 'Missing college' });

    if (req.user.community_joined) return res.status(400).json({ error: 'Already joined a community' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 1000 * 60 * 30);

    await supabase.from('codes').insert({
      user_id: req.user.id,
      code,
      type: 'college',
      meta: { college },
      expires_at: expires.toISOString()
    });

    const subject = `Confirm joining ${college}`;
    const html = `<p>To confirm joining <b>${college}</b>, enter this code on the website: <b>${code}</b>. Expires in 30 minutes.</p>`;

    try {
      await sendEmail({ to: req.user.email, subject, html });
    } catch (mailErr) {
      console.error('Select-college email failed:', mailErr.message || mailErr);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Select college error:', err);
    res.status(500).json({ error: 'Could not send confirmation code' });
  }
});

// verify college code
app.post('/api/verify-college-code', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const { data: codeRow } = await supabase.from('codes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('code', code)
      .eq('type', 'college')
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!codeRow) return res.status(400).json({ error: 'Invalid code' });
    if (new Date(codeRow.expires_at) < new Date()) return res.status(400).json({ error: 'Code expired' });

    const college = codeRow.meta && codeRow.meta.college ? codeRow.meta.college : null;
    await supabase.from('users').update({ college, community_joined: true }).eq('id', req.user.id);
    await supabase.from('codes').update({ used: true }).eq('id', codeRow.id);

    res.json({ ok: true, message: `Congratulations! You’ve connected to ${college}`});
  } catch (err) {
    console.error('Verify college code error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// get community chat messages (paginated)
app.get('/api/community/chat', authMiddleware, async (req, res) => {
  try {
    if (!req.user.community_joined) return res.status(403).json({ error: 'Not part of a community' });
    const { data } = await supabase.from('messages').select('*').order('timestamp', { ascending: true }).limit(500);
    res.json({ messages: data || [] });
  } catch (err) {
    console.error('Community chat fetch error:', err);
    res.status(500).json({ error: 'Could not fetch messages' });
  }
});

// post community message (text/image)
app.post('/api/community/message', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.user.community_joined) return res.status(403).json({ error: 'Not part of a community' });

    let imageUrl = null;
    if (req.file) {
      const filename = `chat/${req.user.id}/${Date.now()}_${uuidv4()}`;
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
      if (error) throw error;
      const publicUrl = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filename).data.publicUrl;
      imageUrl = publicUrl;
    }

    const { content } = req.body;
    const insert = {
      sender_id: req.user.id,
      content: content || null,
      image_url: imageUrl
    };
    const { data } = await supabase.from('messages').insert(insert).select().single();
    io.emit('new_message', data);
    res.json({ message: data });
  } catch (err) {
    console.error('Post community message error:', err);
    res.status(500).json({ error: 'Could not send message' });
  }
});

// upload post
app.post('/api/post/upload', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image required' });
    const { caption, postedTo } = req.body;
    if (!['profile','community'].includes(postedTo)) return res.status(400).json({ error: 'Invalid postedTo' });

    const filename = `posts/${req.user.id}/${Date.now()}_${uuidv4()}`;
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });
    if (error) throw error;
    const publicUrl = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filename).data.publicUrl;

    const { data: post } = await supabase.from('posts').insert({
      user_id: req.user.id,
      image_url: publicUrl,
      caption: caption || '',
      posted_to: postedTo
    }).select().single();

    res.json({ post });
  } catch (err) {
    console.error('Upload post error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// get user profile
app.get('/api/user/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    const { data: user } = await supabase.from('users').select('id,username,email,profile_pic,liked_profiles,college').eq('id', userId).single();
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ user });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// like a user profile
app.post('/api/user/:id/like', authMiddleware, async (req, res) => {
  try {
    const targetId = req.params.id;
    const user = req.user;
    const liked = user.liked_profiles || [];
    if (liked.includes(targetId)) return res.json({ ok: true, message: 'Already liked' });
    liked.push(targetId);
    await supabase.from('users').update({ liked_profiles: liked }).eq('id', user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Like user error:', err);
    res.status(500).json({ error: 'Could not like' });
  }
});

// delete account
app.delete('/api/user/delete', authMiddleware, async (req, res) => {
  try {
    await supabase.from('users').delete().eq('id', req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// --- SOCKET.IO realtime messages and reactions ---
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('send_message', async (payload) => {
    try {
      const { token, content } = payload;
      const decoded = jwt.verify(token, JWT_SECRET);
      const { data: user } = await supabase.from('users').select('*').eq('id', decoded.id).single();
      if (!user || !user.community_joined) return socket.emit('error', { error: 'Not allowed' });

      const insert = { sender_id: user.id, content: content || null };
      const { data } = await supabase.from('messages').insert(insert).select().single();
      io.emit('new_message', data);
    } catch (err) {
      console.error('socket send_message err', err);
      socket.emit('error', { error: 'send failed' });
    }
  });

  socket.on('react', async ({ token, messageId, type }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      const { data: msg } = await supabase.from('messages').select('*').eq('id', messageId).single();
      if (!msg) return;
      const reactions = Array.isArray(msg.reactions) ? msg.reactions : [];
      reactions.push({ userId, type, at: new Date().toISOString() });
      await supabase.from('messages').update({ reactions }).eq('id', messageId);
      io.emit('reaction', { messageId, reactions });
    } catch (err) {
      console.error('socket react err', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("==============================================");
  console.log(`🚀 VibeXpert Server Started Successfully!`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "production"}`);
  console.log(`🔗 API ready at: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log("==============================================");
});
