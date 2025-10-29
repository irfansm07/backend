require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://your-frontend-domain.vercel.app', // Replace with your actual frontend URL
    '*'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Socket.io with enhanced CORS
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// PostgreSQL connection pool for Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test database connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
  } else {
    console.log('✅ Database connected successfully');
  }
});

// Enhanced email service
const sendEmail = async (to, subject, html) => {
  try {
    console.log(`📧 Sending email to: ${to}`);
    
    if (!process.env.BREVO_API_KEY) {
      console.log(`📧 [DEV MODE] Email would be sent to: ${to}`);
      console.log(`📧 [DEV MODE] Subject: ${subject}`);
      return true;
    }

    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: {
          name: process.env.BREVO_FROM_NAME || 'VibeXpert',
          email: process.env.BREVO_FROM_EMAIL || 'noreply@vibexpert.com'
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
    
    console.log(`✅ Email sent successfully to ${to}`);
    return true;
  } catch (error) {
    console.error('❌ Email failed:', error.response?.data || error.message);
    return false;
  }
};

// File upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi/;
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype) return cb(null, true);
    cb(new Error('Only image and video files allowed'));
  }
});

// Utility functions
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// Authentication middleware for PostgreSQL
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret-key');
    const { rows: users } = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    if (users.length === 0) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    
    req.user = users[0];
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Enhanced registration with PostgreSQL
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, registrationNumber } = req.body;
    
    if (!username || !email || !password || !registrationNumber) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check for existing user
    const { rows: existingUsers } = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR registration_number = $2',
      [email, registrationNumber]
    );

    if (existingUsers.length > 0) {
      const existing = existingUsers[0];
      if (existing.email === email) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      if (existing.registration_number === registrationNumber) {
        return res.status(400).json({ error: 'Registration number already registered' });
      }
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    
    await pool.query(
      'INSERT INTO users (id, username, email, password_hash, registration_number, badges) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, username, email, passwordHash, registrationNumber, JSON.stringify([])]
    );

    // Send welcome email
    await sendEmail(
      email, 
      '🎉 Welcome to VibeXpert!', 
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1>
        <p style="font-size: 16px; color: #374151;">Congratulations on creating your account!</p>
        <p style="font-size: 16px; color: #374151;">Ready to vibe? Let's go! 🚀</p>
      </div>`
    );

    res.status(201).json({ 
      success: true, 
      message: 'Account created successfully! Please log in.', 
      userId: userId 
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

// Login with PostgreSQL
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { rows: users } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email }, 
      process.env.JWT_SECRET || 'fallback-secret-key', 
      { expiresIn: '30d' }
    );

    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        email: user.email, 
        college: user.college, 
        community_joined: user.community_joined, 
        profile_pic: user.profile_pic,
        registration_number: user.registration_number,
        badges: user.badges ? JSON.parse(user.badges) : [],
        bio: user.bio || ''
      } 
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Password reset flow with PostgreSQL
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const { rows: users } = await pool.query(
      'SELECT id, username, email FROM users WHERE email = $1',
      [email]
    );

    // Always return success to prevent email enumeration
    if (users.length === 0) {
      return res.json({ 
        success: true, 
        message: 'If this email exists, you will receive a reset code.' 
      });
    }

    const user = users[0];
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    console.log(`🔑 Reset code for ${email}: ${code}`);

    await pool.query(
      'INSERT INTO codes (id, user_id, code, type, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [uuidv4(), user.id, code, 'reset', expiresAt]
    );

    // Send reset email
    await sendEmail(
      email, 
      '🔐 Password Reset Code - VibeXpert', 
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #4F46E5;">Password Reset Request</h1>
        <p>Hi ${user.username},</p>
        <div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
          <h2 style="color: #1F2937; font-size: 32px; letter-spacing: 4px; margin: 0;">${code}</h2>
        </div>
        <p style="font-size: 14px; color: #6B7280;">This code expires in 15 minutes.</p>
      </div>`
    );

    res.json({ success: true, message: 'Reset code sent to your email' });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send reset code' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const { rows: users } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (users.length === 0) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const user = users[0];
    const { rows: codes } = await pool.query(
      'SELECT * FROM codes WHERE user_id = $1 AND code = $2 AND type = $3 AND expires_at > $4',
      [user.id, code, 'reset', new Date()]
    );

    if (codes.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, user.id]
    );

    await pool.query(
      'DELETE FROM codes WHERE id = $1',
      [codes[0].id]
    );

    res.json({ success: true, message: 'Password reset successful' });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// Mock endpoints for frontend compatibility
app.get('/posts', async (req, res) => {
  try {
    const { rows: posts } = await pool.query(`
      SELECT p.*, u.username, u.profile_pic 
      FROM posts p 
      JOIN users u ON p.user_id = u.id 
      ORDER BY p.created_at DESC 
      LIMIT 20
    `);
    
    const formattedPosts = posts.map(post => ({
      id: post.id,
      text: post.content,
      image: post.media ? JSON.parse(post.media)[0]?.url : null,
      userName: post.username,
      createdAt: post.created_at,
      likes: 0,
      comments: 0,
      shares: 0
    }));
    
    res.json({ success: true, posts: formattedPosts });
  } catch (error) {
    console.error('Get posts error:', error);
    res.json({ success: true, posts: [] });
  }
});

app.get('/trending', (req, res) => {
  // Mock trending data
  const trending = [
    {
      title: "Campus Events",
      content: "Annual tech fest starting next week!",
      engagement: "🔥 245"
    },
    {
      title: "Study Groups",
      content: "Forming study groups for finals",
      engagement: "📚 189"
    },
    {
      title: "Sports",
      content: "Inter-college cricket tournament",
      engagement: "🏏 156"
    }
  ];
  
  res.json({ success: true, trending });
});

app.get('/live-stats', (req, res) => {
  // Mock live stats
  res.json({
    success: true,
    onlineUsers: Math.floor(Math.random() * 100) + 50,
    postsToday: Math.floor(Math.random() * 50) + 20,
    activeChats: Math.floor(Math.random() * 30) + 10,
    liveActivity: "5 new posts in last 10 minutes"
  });
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      success: true, 
      message: 'VibeXpert API is running!', 
      database: 'Connected',
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'API is running but database connection failed',
      database: 'Disconnected',
      timestamp: new Date().toISOString() 
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'VibeXpert Backend API', 
    status: 'Running',
    version: '1.0.0'
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  
  // Join college room for community features
  socket.on('join_college', (college) => {
    if (college) {
      socket.join(college);
      console.log(`🏫 User ${socket.id} joined college: ${college}`);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 VibeXpert PostgreSQL server running on port ${PORT}`);
  console.log(`📧 Email service: ${process.env.BREVO_API_KEY ? 'Enabled' : 'Development mode'}`);
  console.log(`🗄️  Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`🔐 JWT secret: ${process.env.JWT_SECRET ? 'Set' : 'Using fallback'}`);
  console.log(`🌐 CORS: Enabled for all origins`);
});
