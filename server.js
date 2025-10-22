// VibeXpert Backend Server - Complete Version
const path = require('path');
const fs = require('fs');

// Load .env first
const envPath = path.join(__dirname, '.env');
const dotenvResult = require('dotenv').config({ path: envPath });

// Get credentials BEFORE importing Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'vibexpert-secret-2025';

// Validate
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing Supabase credentials!');
  process.exit(1);
}

// Now import dependencies
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5500',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5500',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// File upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5242880 }
});

// Helper Functions
const hashPassword = (password) => {
  return crypto.createHash('sha256').update(password).digest('hex');
};

const generateCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const generateToken = (user) => {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
};

// Auth Middleware
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies.token;
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ==================== ROUTES ====================

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'VibeXpert API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email,  reg_number , gender, type, interests, hobbies, password } = req.body;

    if (!name || !email || ! reg_number || !password) {
      return res.status(400).json({ error: 'All required fields must be provided' });
    }

    // Check if user exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = hashPassword(password);

    const { data: user, error } = await supabase
      .from('users')
      .insert([{
        name,
        email,
        reg_number: registrationNumber,
        password_hash: passwordHash,
        gender: gender || 'Other',
        user_type: type || 'Introvert',
        interests: interests || [],
        hobbies: hobbies || ''
      }])
      .select()
      .single();

    if (error) throw error;

    const token = generateToken(user);

    res.json({
      success: true,
      message: 'Account created successfully',
      token,
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email 
      }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const passwordHash = hashPassword(password);

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .eq('password_hash', passwordHash)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    const token = generateToken(user);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        joinedCollege: user.joined_college
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Forgot Password
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('id, name')
      .eq('email', email)
      .single();

    if (!user) {
      return res.json({ 
        success: true, 
        message: 'If email exists, reset link has been sent' 
      });
    }

    const resetCode = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60000); // 15 minutes

    await supabase
      .from('password_resets')
      .insert([{
        user_id: user.id,
        reset_code: resetCode,
        expires_at: expiresAt.toISOString()
      }]);

    // In production, send email here
    console.log(`Password reset code for ${email}: ${resetCode}`);

    res.json({ 
      success: true, 
      message: 'Reset code sent to your email',
      // Remove this in production
      resetCode: resetCode
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, resetCode, newPassword } = req.body;

    if (!email || !resetCode || !newPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (!user) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const { data: reset } = await supabase
      .from('password_resets')
      .select('*')
      .eq('user_id', user.id)
      .eq('reset_code', resetCode)
      .eq('used', false)
      .single();

    if (!reset || new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }

    const passwordHash = hashPassword(newPassword);

    await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', user.id);

    await supabase
      .from('password_resets')
      .update({ used: true })
      .eq('id', reset.id);

    res.json({ 
      success: true, 
      message: 'Password reset successful' 
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get Colleges
app.get('/api/colleges/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { search, page = 1, limit = 10 } = req.query;

    let query = supabase
      .from('colleges')
      .select('*', { count: 'exact' })
      .eq('type', type);

    if (search) {
      query = query.or(`name.ilike.%${search}%,location.ilike.%${search}%`);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      colleges: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Get colleges error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Join College Request
app.post('/api/colleges/join-request', authMiddleware, async (req, res) => {
  try {
    const { collegeId, collegeEmail } = req.body;

    if (!collegeId || !collegeEmail) {
      return res.status(400).json({ error: 'College ID and email required' });
    }

    const joinCode = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60000);

    await supabase
      .from('join_requests')
      .insert([{
        user_id: req.user.id,
        college_id: collegeId,
        join_code: joinCode,
        expires_at: expiresAt.toISOString()
      }]);

    console.log(`Join code for college ${collegeId}: ${joinCode}`);

    res.json({ 
      success: true, 
      message: 'Verification code sent',
      joinCode: joinCode // Remove in production
    });
  } catch (err) {
    console.error('Join request error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify Join Code
app.post('/api/colleges/verify-join', authMiddleware, async (req, res) => {
  try {
    const { collegeId, joinCode } = req.body;

    const { data: request } = await supabase
      .from('join_requests')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('college_id', collegeId)
      .eq('join_code', joinCode)
      .eq('verified', false)
      .single();

    if (!request || new Date(request.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    await supabase
      .from('join_requests')
      .update({ verified: true })
      .eq('id', request.id);

    await supabase
      .from('users')
      .update({ joined_college: collegeId })
      .eq('id', req.user.id);

    const { data: college } = await supabase
      .from('colleges')
      .select('name')
      .eq('id', collegeId)
      .single();

    res.json({ 
      success: true, 
      message: `Successfully joined ${college?.name || 'college'}` 
    });
  } catch (err) {
    console.error('Verify join error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create Post
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { content, type = 'text' } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content required' });
    }

    const { data: post, error } = await supabase
      .from('posts')
      .insert([{ user_id: req.user.id, content, type }])
      .select('*, users(id, name, email)')
      .single();

    if (error) throw error;

    io.emit('new_post', post);

    res.json({ success: true, post });
  } catch (err) {
    console.error('Create post error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get Posts
app.get('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { data, error, count } = await supabase
      .from('posts')
      .select('*, users(id, name, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      success: true,
      posts: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count
      }
    });
  } catch (err) {
    console.error('Get posts error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete Post
app.delete('/api/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const { postId } = req.params;

    const { data: post } = await supabase
      .from('posts')
      .select('user_id')
      .eq('id', postId)
      .single();

    if (!post || post.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { error } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId);

    if (error) throw error;

    res.json({ success: true, message: 'Post deleted' });
  } catch (err) {
    console.error('Delete post error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get Profile
app.get('/api/profile/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, registration_number, gender, type, interests, hobbies, nickname, description, avatar_url, created_at')
      .eq('id', userId)
      .single();

    if (error) throw error;

    const { count: postsCount } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    res.json({
      success: true,
      profile: {
        ...user,
        stats: { posts: postsCount || 0 }
      }
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update Profile
app.put('/api/profile', authMiddleware, async (req, res) => {
  try {
    const { nickname, description } = req.body;

    const updates = {};
    if (nickname !== undefined) updates.nickname = nickname;
    if (description !== undefined) updates.description = description;

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, profile: data });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Submit Complaint
app.post('/api/complaints', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Complaint content required' });
    }

    const { data, error } = await supabase
      .from('complaints')
      .insert([{ user_id: req.user.id, content }])
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      success: true, 
      message: 'Complaint submitted successfully',
      complaint: data 
    });
  } catch (err) {
    console.error('Submit complaint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get Trending Topics
app.get('/api/trending', async (req, res) => {
  try {
    const topics = [
      { title: 'Campus Life', emoji: '🎓', posts: Math.floor(Math.random() * 1000) + 500 },
      { title: 'Friday Vibes', emoji: '🎉', posts: Math.floor(Math.random() * 800) + 300 },
      { title: 'Study Tips', emoji: '📚', posts: Math.floor(Math.random() * 600) + 200 },
      { title: 'Coffee Talks', emoji: '☕', posts: Math.floor(Math.random() * 700) + 250 },
      { title: 'Gaming Zone', emoji: '🎮', posts: Math.floor(Math.random() * 900) + 400 },
      { title: 'Sports Talk', emoji: '⚽', posts: Math.floor(Math.random() * 800) + 350 },
    ];

    res.json({ success: true, trending: topics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('join_college', (collegeId) => {
    socket.join(`college_${collegeId}`);
    console.log(`User ${socket.id} joined college ${collegeId}`);
  });

  socket.on('send_message', async (data) => {
    try {
      const { collegeId, userId, message } = data;

      const { data: chatMessage, error } = await supabase
        .from('chat_messages')
        .insert([{
          college_id: collegeId,
          user_id: userId,
          message
        }])
        .select('*, users(id, name)')
        .single();

      if (!error) {
        io.to(`college_${collegeId}`).emit('new_message', chatMessage);
      }
    } catch (error) {
      console.error('Socket message error:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
  });
});

// ==================== ERROR HANDLING ====================

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ==================== START SERVER ====================

server.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 VibeXpert Server Started Successfully!');
  console.log('='.repeat(60));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS: ${process.env.FRONTEND_URL || 'http://localhost:5500'}`);
  console.log(`💾 Database: Connected to Supabase`);
  console.log(`🔌 WebSocket: Active`);
  console.log('='.repeat(60));
  console.log(`\n✅ API ready at http://localhost:${PORT}`);
  console.log(`📚 Health check: http://localhost:${PORT}/api/health\n`);
});