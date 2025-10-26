require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize Socket.io with CORS
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Enhanced CORS - ALLOW ALL for testing
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Simplified Email - Brevo API ONLY (no SMTP fallback)
const sendEmail = async (to, subject, html) => {
  try {
    console.log(`📧 Sending email to: ${to}`);
    
    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: {
          name: process.env.BREVO_FROM_NAME || 'VibeXpert',
          email: process.env.BREVO_FROM_EMAIL || 'noreply@vibexpert.online'
        },
        to: [{ email: to }],
        subject: subject,
        htmlContent: html
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log(`✅ Email sent via Brevo API`);
    return true;
  } catch (error) {
    console.error('❌ Email failed:', error.message);
    return false;
  }
};

// Multer configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 5
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi/;
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only image and video files allowed'));
  }
});

// Helper Functions
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// Middleware: Verify JWT Token
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// ============================================
// USER AUTHENTICATION ROUTES
// ============================================

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{
        username,
        email,
        password_hash: passwordHash
      }])
      .select()
      .single();

    if (error) {
      console.error('Database error:', error);
      throw new Error('Failed to create account');
    }

    // Send welcome email (non-blocking)
    sendEmail(
      email,
      '🎉 Welcome to VibeXpert!',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1>
          <p style="font-size: 16px; color: #374151;">
            Congratulations on creating your account!
          </p>
          <p style="font-size: 16px; color: #374151;">Ready to vibe? Let's go! 🚀</p>
        </div>
      `
    ).catch(err => console.error('Email send failed:', err));

    res.status(201).json({
      message: 'Account created successfully! Please log in.',
      userId: newUser.id
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        college: user.college,
        communityJoined: user.community_joined,
        profilePic: user.profile_pic
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Forgot Password
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email')
      .eq('email', email)
      .maybeSingle();

    if (error || !user) {
      return res.json({ 
        success: true,
        message: 'If this email exists, you will receive a reset code.' 
      });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    console.log(`🔑 Reset code for ${email}: ${code}`);

    const { error: codeError } = await supabase.from('codes').insert([{
      user_id: user.id,
      code,
      type: 'reset',
      expires_at: expiresAt.toISOString()
    }]);

    if (codeError) {
      throw new Error('Failed to generate reset code');
    }

    sendEmail(
      email,
      '🔐 Password Reset Code - VibeXpert',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #4F46E5;">Password Reset Request</h1>
          <p>Hi ${user.username},</p>
          <div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <h2 style="color: #1F2937; font-size: 32px; letter-spacing: 4px; margin: 0;">${code}</h2>
          </div>
          <p style="font-size: 14px; color: #6B7280;">This code expires in 15 minutes.</p>
        </div>
      `
    ).catch(err => console.error('Email failed:', err));

    res.json({ 
      success: true,
      message: 'Reset code sent to your email' 
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send reset code' });
  }
});

// Reset Password
app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const { data: codeData } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .eq('type', 'reset')
      .gte('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!codeData) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', user.id);

    await supabase
      .from('codes')
      .delete()
      .eq('id', codeData.id);

    res.json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ============================================
// POST ROUTES - SIMPLIFIED
// ============================================

// Create Post with Media
app.post('/api/posts', authenticateToken, upload.array('media', 5), async (req, res) => {
  try {
    const { content } = req.body;
    const files = req.files;

    if (!content && (!files || files.length === 0)) {
      return res.status(400).json({ error: 'Post must have content or media' });
    }

    const mediaUrls = [];
    
    if (files && files.length > 0) {
      for (const file of files) {
        const fileExt = file.originalname.split('.').pop();
        const fileName = `${req.user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('posts-media')
          .upload(fileName, file.buffer, {
            contentType: file.mimetype,
            cacheControl: '3600'
          });

        if (uploadError) {
          console.error('Upload error:', uploadError);
          throw new Error('Failed to upload media');
        }

        const { data: urlData } = supabase.storage
          .from('posts-media')
          .getPublicUrl(fileName);

        mediaUrls.push({
          url: urlData.publicUrl,
          type: file.mimetype.startsWith('image') ? 'image' : 'video'
        });
      }
    }

    const { data: newPost, error: postError } = await supabase
      .from('posts')
      .insert([{
        user_id: req.user.id,
        content: content || '',
        media: mediaUrls
      }])
      .select(`
        *,
        users (
          id,
          username,
          profile_pic
        )
      `)
      .single();

    if (postError) {
      console.error('Post creation error:', postError);
      throw new Error('Failed to create post');
    }

    io.emit('new_post', newPost);

    res.status(201).json({
      success: true,
      post: newPost,
      message: 'Post created successfully!'
    });

  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: error.message || 'Failed to create post' });
  }
});

// Get Posts - FIXED
app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        users (
          id,
          username,
          profile_pic
        )
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) {
      console.error('Get posts error:', error);
      throw new Error('Failed to fetch posts');
    }

    res.json({
      success: true,
      posts: posts || []
    });

  } catch (error) {
    console.error('Get posts error:', error);
    res.status(500).json({ 
      success: true,
      posts: [] // Return empty array instead of error
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString()
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'VibeXpert API v2.1 - Simplified & Fixed',
    features: ['Auth', 'Posts', 'Media Upload']
  });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Email: Brevo API`);
  console.log(`🗄️  Database: Supabase`);
});
