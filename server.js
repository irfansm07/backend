require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mysql = require('mysql2/promise');
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// MySQL connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'vibexpert',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
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
    
    console.log(`✅ Email sent successfully to ${to}`);
    return true;
  } catch (error) {
    console.error('❌ Email failed:', error.response?.data || error.message);
    return true;
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

// Authentication middleware for MySQL
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE id = ?',
      [decoded.userId]
    );
    
    if (users.length === 0) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    
    req.user = users[0];
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Enhanced registration with MySQL
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
    const [existingUsers] = await pool.execute(
      'SELECT * FROM users WHERE email = ? OR registration_number = ?',
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
    
    await pool.execute(
      'INSERT INTO users (id, username, email, password_hash, registration_number, badges) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, username, email, passwordHash, registrationNumber, JSON.stringify([])]
    );

    // Send welcome email
    sendEmail(
      email, 
      '🎉 Welcome to VibeXpert!', 
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1>
        <p style="font-size: 16px; color: #374151;">Congratulations on creating your account!</p>
        <p style="font-size: 16px; color: #374151;">Ready to vibe? Let's go! 🚀</p>
      </div>`
    ).catch(err => console.error('Email send failed:', err));

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

// Login with MySQL
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const [users] = await pool.execute(
      'SELECT * FROM users WHERE email = ?',
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
      process.env.JWT_SECRET, 
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
        communityJoined: user.community_joined, 
        profilePic: user.profile_pic,
        registrationNumber: user.registration_number,
        badges: user.badges ? JSON.parse(user.badges) : [],
        bio: user.bio || ''
      } 
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Password reset flow with MySQL
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const [users] = await pool.execute(
      'SELECT id, username, email FROM users WHERE email = ?',
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

    await pool.execute(
      'INSERT INTO codes (id, user_id, code, type, expires_at) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), user.id, code, 'reset', expiresAt]
    );

    // Send reset email
    sendEmail(
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
    ).catch(err => console.error('Email failed:', err));

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

    const [users] = await pool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const user = users[0];
    const [codes] = await pool.execute(
      'SELECT * FROM codes WHERE user_id = ? AND code = ? AND type = ? AND expires_at > ?',
      [user.id, code, 'reset', new Date()]
    );

    if (codes.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    
    await pool.execute(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, user.id]
    );

    await pool.execute(
      'DELETE FROM codes WHERE id = ?',
      [codes[0].id]
    );

    res.json({ success: true, message: 'Password reset successful' });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// College verification with MySQL
app.post('/api/college/request-verification', authenticateToken, async (req, res) => {
  try {
    const { collegeName, collegeEmail } = req.body;
    
    if (!collegeName || !collegeEmail) {
      return res.status(400).json({ error: 'College name and email required' });
    }

    // Protection: Check if user already has a college
    if (req.user.college) {
      return res.status(400).json({ 
        error: 'You are already connected to a college community' 
      });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    console.log(`🎓 College verification code for ${req.user.email}: ${code}`);

    await pool.execute(
      'INSERT INTO codes (id, user_id, code, type, meta, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, code, 'college', JSON.stringify({ collegeName, collegeEmail }), expiresAt]
    );

    sendEmail(
      collegeEmail, 
      `🎓 College Verification Code - VibeXpert`, 
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #4F46E5;">College Verification</h1>
        <p>Hi ${req.user.username},</p>
        <p>Here's your verification code to connect to <strong>${collegeName}</strong>:</p>
        <div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
          <h2 style="color: #1F2937; font-size: 32px; letter-spacing: 4px; margin: 0;">${code}</h2>
        </div>
        <p style="font-size: 14px; color: #6B7280;">This code expires in 15 minutes.</p>
      </div>`
    ).catch(err => console.error('Email failed:', err));

    res.json({ success: true, message: 'Verification code sent to your college email' });

  } catch (error) {
    console.error('College verification request error:', error);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/college/verify', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'Verification code required' });
    }

    const [codes] = await pool.execute(
      'SELECT * FROM codes WHERE user_id = ? AND code = ? AND type = ? AND expires_at > ?',
      [req.user.id, code, 'college', new Date()]
    );

    if (codes.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const codeData = codes[0];
    const { collegeName } = JSON.parse(codeData.meta);
    const currentBadges = req.user.badges ? JSON.parse(req.user.badges) : [];
    
    // Award community member badge if not already earned
    if (!currentBadges.includes('🎓 Community Member')) {
      currentBadges.push('🎓 Community Member');
    }

    await pool.execute(
      'UPDATE users SET college = ?, community_joined = TRUE, badges = ? WHERE id = ?',
      [collegeName, JSON.stringify(currentBadges), req.user.id]
    );

    await pool.execute(
      'DELETE FROM codes WHERE id = ?',
      [codeData.id]
    );

    res.json({ 
      success: true, 
      message: `Successfully connected to ${collegeName}!`, 
      college: collegeName, 
      badges: currentBadges 
    });

  } catch (error) {
    console.error('College verification error:', error);
    res.status(500).json({ error: 'College verification failed' });
  }
});

// Enhanced posts with MySQL
app.post('/api/posts', authenticateToken, upload.array('media', 5), async (req, res) => {
  try {
    const { content, postTo = 'profile' } = req.body;
    const files = req.files;
    
    if (!content && (!files || files.length === 0)) {
      return res.status(400).json({ error: 'Post must have content or media' });
    }
    
    if (!['profile', 'community'].includes(postTo)) {
      return res.status(400).json({ error: 'Invalid post destination' });
    }
    
    // If posting to community, verify user has joined a college
    if (postTo === 'community' && (!req.user.community_joined || !req.user.college)) {
      return res.status(403).json({ 
        error: 'Join a college community first to post there' 
      });
    }
    
    const mediaUrls = [];
    
    // For MySQL, we'll store media URLs as JSON string
    // In production, you'd upload to cloud storage and store URLs
    if (files && files.length > 0) {
      for (const file of files) {
        // Simulate file upload - in production, upload to S3/Cloud Storage
        const mockUrl = `https://example.com/media/${file.originalname}`;
        mediaUrls.push({ 
          url: mockUrl, 
          type: file.mimetype.startsWith('image') ? 'image' : 'video' 
        });
      }
    }
    
    // Create post
    const postId = uuidv4();
    await pool.execute(
      'INSERT INTO posts (id, user_id, content, media, college, posted_to) VALUES (?, ?, ?, ?, ?, ?)',
      [postId, req.user.id, content || '', JSON.stringify(mediaUrls), req.user.college, postTo]
    );

    // Get the created post with user info
    const [posts] = await pool.execute(
      `SELECT p.*, u.username, u.profile_pic, u.college, u.registration_number 
       FROM posts p 
       JOIN users u ON p.user_id = u.id 
       WHERE p.id = ?`,
      [postId]
    );

    const newPost = posts[0];
    
    // Award badges based on post count
    const [userPosts] = await pool.execute(
      'SELECT id FROM posts WHERE user_id = ?',
      [req.user.id]
    );
      
    const postCount = userPosts.length;
    const currentBadges = req.user.badges ? JSON.parse(req.user.badges) : [];
    
    if (postCount === 1 && !currentBadges.includes('🎨 First Post')) {
      currentBadges.push('🎨 First Post');
      await pool.execute(
        'UPDATE users SET badges = ? WHERE id = ?',
        [JSON.stringify(currentBadges), req.user.id]
      );
    } else if (postCount === 10 && !currentBadges.includes('⭐ Content Creator')) {
      currentBadges.push('⭐ Content Creator');
      await pool.execute(
        'UPDATE users SET badges = ? WHERE id = ?',
        [JSON.stringify(currentBadges), req.user.id]
      );
    }
    
    // Emit socket event for real-time updates (only for community posts)
    if (postTo === 'community' && req.user.college) {
      io.to(req.user.college).emit('new_post', newPost);
    }
    
    res.status(201).json({ 
      success: true, 
      post: newPost, 
      message: 'Post created successfully!', 
      badges: currentBadges 
    });
    
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: error.message || 'Failed to create post' });
  }
});

// Enhanced posts retrieval with MySQL
app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0, type = 'all' } = req.query;
    
    let query = `
      SELECT p.*, u.username, u.profile_pic, u.college, u.registration_number 
      FROM posts p 
      JOIN users u ON p.user_id = u.id 
    `;
    let params = [];
    
    if (type === 'my') {
      query += ' WHERE p.user_id = ? ';
      params.push(req.user.id);
    } else if (type === 'community' && req.user.community_joined && req.user.college) {
      query += ' WHERE p.college = ? AND p.posted_to = ? ';
      params.push(req.user.college, 'community');
    } else if (type === 'profile') {
      query += ' WHERE p.user_id = ? AND p.posted_to = ? ';
      params.push(req.user.id, 'profile');
    }
    
    query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ? ';
    params.push(parseInt(limit), parseInt(offset));
    
    const [posts] = await pool.execute(query, params);
    
    // Parse JSON fields
    const parsedPosts = posts.map(post => ({
      ...post,
      media: post.media ? JSON.parse(post.media) : []
    }));
    
    res.json({ success: true, posts: parsedPosts });
    
  } catch (error) {
    console.error('Get posts error:', error);
    res.json({ success: true, posts: [] });
  }
});

app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [posts] = await pool.execute(
      'SELECT user_id, media FROM posts WHERE id = ?',
      [id]
    );
      
    if (posts.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const post = posts[0];
    if (post.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await pool.execute(
      'DELETE FROM posts WHERE id = ?',
      [id]
    );
      
    res.json({ success: true, message: 'Post deleted successfully' });
    
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// Enhanced community messages with MySQL
app.get('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    
    const { limit = 50 } = req.query;
    
    const [messages] = await pool.execute(
      `SELECT m.*, u.username, u.profile_pic 
       FROM messages m 
       JOIN users u ON m.sender_id = u.id 
       WHERE m.college = ? 
       ORDER BY m.timestamp DESC 
       LIMIT ?`,
      [req.user.college, parseInt(limit)]
    );
      
    // Get reactions for each message
    for (let message of messages) {
      const [reactions] = await pool.execute(
        'SELECT * FROM message_reactions WHERE message_id = ?',
        [message.id]
      );
      message.message_reactions = reactions;
    }
    
    res.json({ success: true, messages: messages || [] });
    
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }
    
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    
    const messageId = uuidv4();
    await pool.execute(
      'INSERT INTO messages (id, sender_id, content, college) VALUES (?, ?, ?, ?)',
      [messageId, req.user.id, content.trim(), req.user.college]
    );

    // Get the created message with user info
    const [messages] = await pool.execute(
      `SELECT m.*, u.username, u.profile_pic 
       FROM messages m 
       JOIN users u ON m.sender_id = u.id 
       WHERE m.id = ?`,
      [messageId]
    );

    const newMessage = messages[0];
    
    // Emit socket event for real-time messaging
    io.to(req.user.college).emit('new_message', newMessage);
    
    res.json({ success: true, message: newMessage });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Enhanced message editing with MySQL
app.patch('/api/community/messages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }
    
    const [messages] = await pool.execute(
      'SELECT * FROM messages WHERE id = ?',
      [id]
    );
      
    if (messages.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    const message = messages[0];
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Check if message can be edited (within 2 minutes)
    const messageTime = new Date(message.timestamp);
    const now = new Date();
    const diffMinutes = (now - messageTime) / 1000 / 60;
    
    if (diffMinutes > 2) {
      return res.status(403).json({ error: 'Can only edit messages within 2 minutes' });
    }
    
    await pool.execute(
      'UPDATE messages SET content = ?, edited = TRUE WHERE id = ?',
      [content.trim(), id]
    );

    // Get the updated message
    const [updatedMessages] = await pool.execute(
      `SELECT m.*, u.username, u.profile_pic 
       FROM messages m 
       JOIN users u ON m.sender_id = u.id 
       WHERE m.id = ?`,
      [id]
    );

    const updated = updatedMessages[0];
    
    // Emit socket event for real-time update
    io.to(req.user.college).emit('message_updated', updated);
    
    res.json({ success: true, message: updated });
    
  } catch (error) {
    console.error('Edit message error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

app.delete('/api/community/messages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [messages] = await pool.execute(
      'SELECT sender_id FROM messages WHERE id = ?',
      [id]
    );
      
    if (messages.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    const message = messages[0];
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await pool.execute(
      'DELETE FROM messages WHERE id = ?',
      [id]
    );
      
    // Emit socket event for real-time deletion
    io.to(req.user.college).emit('message_deleted', { id });
    
    res.json({ success: true, message: 'Message deleted' });
    
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Message reactions with MySQL
app.post('/api/community/messages/:id/react', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji required' });
    }
    
    // Check if reaction already exists
    const [existing] = await pool.execute(
      'SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      [id, req.user.id, emoji]
    );
    
    // If exists, remove it (toggle)
    if (existing.length > 0) {
      await pool.execute(
        'DELETE FROM message_reactions WHERE id = ?',
        [existing[0].id]
      );
        
      return res.json({ success: true, action: 'removed' });
    }
    
    // Add new reaction
    const reactionId = uuidv4();
    await pool.execute(
      'INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES (?, ?, ?, ?)',
      [reactionId, id, req.user.id, emoji]
    );

    const [reactions] = await pool.execute(
      'SELECT * FROM message_reactions WHERE id = ?',
      [reactionId]
    );

    const reaction = reactions[0];
    
    // Emit socket event for real-time reaction
    io.to(req.user.college).emit('message_reaction', { 
      messageId: id, 
      reaction 
    });
    
    res.json({ success: true, action: 'added', reaction });
    
  } catch (error) {
    console.error('React to message error:', error);
    res.status(500).json({ error: 'Failed to react' });
  }
});

// Message views tracking with MySQL
app.post('/api/community/messages/:id/view', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if already viewed
    const [existing] = await pool.execute(
      'SELECT * FROM message_views WHERE message_id = ? AND user_id = ?',
      [id, req.user.id]
    );
    
    if (existing.length > 0) {
      return res.json({ success: true });
    }
    
    // Record view
    await pool.execute(
      'INSERT INTO message_views (id, message_id, user_id) VALUES (?, ?, ?)',
      [uuidv4(), id, req.user.id]
    );
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Mark view error:', error);
    res.status(500).json({ error: 'Failed to mark view' });
  }
});

app.get('/api/community/messages/:id/views', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [views] = await pool.execute(
      `SELECT mv.user_id, u.username, u.profile_pic 
       FROM message_views mv 
       JOIN users u ON mv.user_id = u.id 
       WHERE mv.message_id = ?`,
      [id]
    );
    
    res.json({ 
      success: true, 
      views: views || [], 
      count: views.length 
    });
    
  } catch (error) {
    console.error('Get views error:', error);
    res.status(500).json({ error: 'Failed to get views' });
  }
});

// Enhanced profile management with MySQL
app.patch('/api/profile', authenticateToken, upload.single('profilePic'), async (req, res) => {
  try {
    const { username, bio } = req.body;
    const updates = {};
    const params = [];
    
    if (username) {
      updates.username = username;
      params.push(username);
    }
    if (bio !== undefined) {
      updates.bio = bio;
      params.push(bio);
    }
    
    // Handle profile picture upload
    if (req.file) {
      // In production, upload to cloud storage and get URL
      const profilePicUrl = `https://example.com/profile-pics/${req.user.id}.jpg`;
      updates.profile_pic = profilePicUrl;
      params.push(profilePicUrl);
    }
    
    // Build dynamic update query
    if (params.length > 0) {
      const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
      params.push(req.user.id);
      
      await pool.execute(
        `UPDATE users SET ${setClause} WHERE id = ?`,
        params
      );
    }
    
    // Get updated user
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE id = ?',
      [req.user.id]
    );

    const updated = users[0];
    
    res.json({ success: true, user: updated });
    
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// User search with MySQL
app.get('/api/search/users', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ 
        error: 'Search query must be at least 2 characters' 
      });
    }
    
    const searchTerm = `%${query.trim().toLowerCase()}%`;
    
    const [users] = await pool.execute(
      `SELECT id, username, email, college, profile_pic, registration_number 
       FROM users 
       WHERE LOWER(username) LIKE ? OR LOWER(registration_number) LIKE ? 
       LIMIT 10`,
      [searchTerm, searchTerm]
    );
    
    res.json({ success: true, users: users || [] });
    
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Feedback system with MySQL
app.post('/api/feedback', authenticateToken, async (req, res) => {
  try {
    const { subject, message } = req.body;
    
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message required' });
    }
    
    await pool.execute(
      'INSERT INTO feedback (id, user_id, subject, message) VALUES (?, ?, ?, ?)',
      [uuidv4(), req.user.id, subject.trim(), message.trim()]
    );

    // Get the created feedback
    const [feedback] = await pool.execute(
      'SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );

    const newFeedback = feedback[0];
    
    res.json({ 
      success: true, 
      message: 'Feedback submitted successfully!', 
      feedback: newFeedback 
    });
    
  } catch (error) {
    console.error('Feedback error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// Get user profile with MySQL
app.get('/api/profile/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const [users] = await pool.execute(
      'SELECT id, username, email, college, profile_pic, bio, badges, created_at, registration_number FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = users[0];
    
    // Get user's post count
    const [posts] = await pool.execute(
      'SELECT id FROM posts WHERE user_id = ?',
      [userId]
    );
    
    res.json({ 
      success: true, 
      user: {
        ...user,
        badges: user.badges ? JSON.parse(user.badges) : [],
        postCount: posts.length
      }
    });
    
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Badges endpoint with MySQL
app.get('/api/badges', authenticateToken, async (req, res) => {
  try {
    const badges = req.user.badges ? JSON.parse(req.user.badges) : [];
    
    res.json({ 
      success: true, 
      badges: badges,
      availableBadges: [
        { emoji: '🎓', name: 'Community Member', description: 'Joined a college community' },
        { emoji: '🎨', name: 'First Post', description: 'Created your first post' },
        { emoji: '⭐', name: 'Content Creator', description: 'Posted 10 times' },
        { emoji: '💬', name: 'Chatty', description: 'Sent 50 messages' },
        { emoji: '🔥', name: 'On Fire', description: '7 day streak' }
      ]
    });
  } catch (error) {
    console.error('Get badges error:', error);
    res.status(500).json({ error: 'Failed to get badges' });
  }
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

// Health check
app.get('/api/health', async (req, res) => {
  try {
    // Test database connection
    await pool.execute('SELECT 1');
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
server.listen(PORT, () => {
  console.log(`🚀 VibeXpert MySQL server running on port ${PORT}`);
  console.log(`📧 Email service: ${process.env.BREVO_API_KEY ? 'Enabled' : 'Development mode'}`);
  console.log(`🗄️  Database: MySQL`);
  console.log(`🔐 JWT secret: ${process.env.JWT_SECRET ? 'Set' : 'Not set'}`);
});
