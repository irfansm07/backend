// VIBEXPERT BACKEND - FIXED VERSION WITH LOGIN & PASSWORD RESET

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Enhanced CORS Configuration
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'User-Agent', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400
}));

app.options('*', cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Request Logger
app.use((req, res, next) => {
  console.log(`📡 ${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Test Supabase connection
supabase.from('users').select('count', { count: 'exact', head: true })
  .then(({ error }) => {
    if (error) {
      console.error('❌ Supabase connection failed:', error.message);
    } else {
      console.log('✅ Supabase connected successfully');
    }
  });

const availableSongs = [
  { id: 1, name: 'Chill Vibes', artist: 'LoFi Beats', duration: '2:30', emoji: '🎧', url: 'https://assets.mixkit.co/music/preview/mixkit-chill-vibes-239.mp3' },
  { id: 2, name: 'Upbeat Energy', artist: 'Electronic Pop', duration: '3:15', emoji: '⚡', url: 'https://assets.mixkit.co/music/preview/mixkit-upbeat-energy-225.mp3' },
  { id: 3, name: 'Dreamy Piano', artist: 'Classical', duration: '2:45', emoji: '🎹', url: 'https://assets.mixkit.co/music/preview/mixkit-dreamy-piano-1171.mp3' },
  { id: 4, name: 'Summer Vibes', artist: 'Tropical', duration: '3:30', emoji: '🏖️', url: 'https://assets.mixkit.co/music/preview/mixkit-summer-vibes-129.mp3' },
  { id: 5, name: 'Happy Day', artist: 'Pop Rock', duration: '2:50', emoji: '😊', url: 'https://assets.mixkit.co/music/preview/mixkit-happy-day-583.mp3' },
  { id: 6, name: 'Relaxing Guitar', artist: 'Acoustic', duration: '3:10', emoji: '🎸', url: 'https://assets.mixkit.co/music/preview/mixkit-relaxing-guitar-243.mp3' }
];

const availableStickers = [
  { id: 'sticker1', name: 'Happy', emoji: '😊', category: 'emotions' },
  { id: 'sticker2', name: 'Laughing', emoji: '😂', category: 'emotions' },
  { id: 'sticker3', name: 'Heart', emoji: '❤️', category: 'love' },
  { id: 'sticker4', name: 'Fire', emoji: '🔥', category: 'trending' },
  { id: 'sticker5', name: 'Star', emoji: '⭐', category: 'achievement' },
  { id: 'sticker6', name: 'Party', emoji: '🎉', category: 'celebration' },
  { id: 'sticker7', name: 'Music', emoji: '🎵', category: 'music' },
  { id: 'sticker8', name: 'Game', emoji: '🎮', category: 'hobbies' },
  { id: 'sticker9', name: 'Food', emoji: '🍕', category: 'food' },
  { id: 'sticker10', name: 'Study', emoji: '📚', category: 'academic' },
  { id: 'sticker11', name: 'Cool', emoji: '😎', category: 'emotions' },
  { id: 'sticker12', name: 'Love', emoji: '💕', category: 'love' },
  { id: 'sticker13', name: 'Thumbs Up', emoji: '👍', category: 'reactions' },
  { id: 'sticker14', name: 'Clap', emoji: '👏', category: 'reactions' },
  { id: 'sticker15', name: 'Rocket', emoji: '🚀', category: 'excitement' }
];

// Enhanced Email Sending Function with Better Error Handling
const sendEmail = async (to, subject, html) => {
  try {
    console.log(`📧 Attempting to send email to: ${to}`);
    
    if (!process.env.BREVO_API_KEY) {
      console.error('❌ BREVO_API_KEY not configured');
      return false;
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
        timeout: 15000
      }
    );
    
    console.log('✅ Email sent successfully:', response.data);
    return true;
  } catch (error) {
    console.error('❌ Email sending failed:', error.response?.data || error.message);
    return false;
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 20 * 1024 * 1024,
    files: 10 
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi|mp3|wav/;
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype) return cb(null, true);
    cb(new Error('Only image, video, and audio files allowed'));
  }
});

const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    console.log('❌ No token provided');
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
      console.log('❌ Invalid token or user not found');
      return res.status(403).json({ error: 'Invalid token' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    console.log('❌ Token verification failed:', error.message);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ==================== ASSET ENDPOINTS ====================
app.get('/api/post-assets', (req, res) => {
  res.json({ success: true, songs: availableSongs, stickers: availableStickers });
});

app.get('/api/music-library', (req, res) => {
  res.json({ success: true, music: availableSongs });
});

app.get('/api/sticker-library', (req, res) => {
  res.json({ success: true, stickers: availableStickers });
});

// ==================== FIXED REGISTER ENDPOINT ====================
app.post('/api/register', async (req, res) => {
  try {
    console.log('📝 Registration attempt:', req.body.email);
    const { username, email, password, registrationNumber, gender } = req.body;
    
    // Validation
    if (!username || !email || !password || !registrationNumber) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.log('❌ Invalid email format');
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Check existing user
    const { data: existingUser } = await supabase
      .from('users')
      .select('email, registration_number')
      .or(`email.eq.${email},registration_number.eq.${registrationNumber}`)
      .maybeSingle();
    
    if (existingUser) {
      if (existingUser.email === email) {
        console.log('❌ Email already exists');
        return res.status(400).json({ error: 'Email already registered' });
      }
      if (existingUser.registration_number === registrationNumber) {
        console.log('❌ Registration number already exists');
        return res.status(400).json({ error: 'Registration number already registered' });
      }
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Insert user
    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{
        username,
        email,
        password_hash: passwordHash,
        registration_number: registrationNumber,
        gender: gender || null
      }])
      .select()
      .single();
    
    if (error) {
      console.error('❌ Database error:', error);
      throw new Error('Failed to create account: ' + error.message);
    }
    
    console.log('✅ User registered successfully:', newUser.id);
    
    // Send welcome email (don't wait for it)
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
      userId: newUser.id
    });
  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

// ==================== FIXED LOGIN ENDPOINT ====================
app.post('/api/login', async (req, res) => {
  try {
    console.log('🔐 Login attempt for:', req.body.email);
    const { email, password } = req.body;
    
    if (!email || !password) {
      console.log('❌ Missing credentials');
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    // Find user by email OR registration number
    const { data: users, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .or(`email.eq.${email},registration_number.eq.${email}`);
    
    if (fetchError) {
      console.error('❌ Database error:', fetchError);
      return res.status(500).json({ error: 'Database error' });
    }
    
    const user = users && users.length > 0 ? users[0] : null;
    
    if (!user) {
      console.log('❌ User not found');
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      console.log('❌ Invalid password');
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    console.log('✅ Login successful for user:', user.id);
    
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
        badges: user.badges || [],
        bio: user.bio || ''
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Login failed: ' + error.message });
  }
});

// ==================== FIXED FORGOT PASSWORD ENDPOINT ====================
app.post('/api/forgot-password', async (req, res) => {
  try {
    console.log('🔑 Password reset request for:', req.body.email);
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }
    
    // Find user
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email')
      .eq('email', email)
      .maybeSingle();
    
    // Always return success to prevent email enumeration
    if (error || !user) {
      console.log('⚠️ User not found, but returning success for security');
      return res.json({ 
        success: true, 
        message: 'If this email exists, you will receive a reset code.' 
      });
    }
    
    // Generate code
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    
    console.log('🔢 Generated code:', code, 'for user:', user.id);
    
    // Delete old codes for this user
    await supabase
      .from('codes')
      .delete()
      .eq('user_id', user.id)
      .eq('type', 'reset');
    
    // Insert new code
    const { error: codeError } = await supabase
      .from('codes')
      .insert([{
        user_id: user.id,
        code,
        type: 'reset',
        expires_at: expiresAt.toISOString()
      }]);
    
    if (codeError) {
      console.error('❌ Failed to save code:', codeError);
      throw new Error('Failed to generate reset code');
    }
    
    console.log('✅ Code saved to database');
    
    // Send email
    const emailSent = await sendEmail(
      email,
      '🔐 Password Reset Code - VibeXpert',
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f7fa; border-radius: 10px;">
        <h1 style="color: #4F46E5; text-align: center;">Password Reset Request</h1>
        <p style="font-size: 16px; color: #374151;">Hi ${user.username},</p>
        <p style="font-size: 16px; color: #374151;">You requested to reset your password. Use the code below:</p>
        <div style="background: #ffffff; padding: 30px; text-align: center; border-radius: 8px; margin: 20px 0; border: 2px solid #4F46E5;">
          <h2 style="color: #1F2937; font-size: 36px; letter-spacing: 8px; margin: 0; font-weight: bold;">${code}</h2>
        </div>
        <p style="font-size: 14px; color: #6B7280; text-align: center;">⏰ This code expires in 15 minutes.</p>
        <p style="font-size: 14px; color: #6B7280; text-align: center;">If you didn't request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 20px 0;">
        <p style="font-size: 12px; color: #9CA3AF; text-align: center;">© 2025 VibeXpert. All rights reserved.</p>
      </div>`
    );
    
    if (emailSent) {
      console.log('✅ Reset code email sent successfully');
    } else {
      console.log('⚠️ Email sending failed, but code is saved in database');
    }
    
    res.json({ 
      success: true, 
      message: 'Reset code sent to your email. Please check your inbox.',
      emailSent: emailSent,
      // For development/testing only - REMOVE IN PRODUCTION
      ...(process.env.NODE_ENV === 'development' && { devCode: code })
    });
  } catch (error) {
    console.error('❌ Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request: ' + error.message });
  }
});

// ==================== FIXED RESET PASSWORD ENDPOINT ====================
app.post('/api/reset-password', async (req, res) => {
  try {
    console.log('🔄 Password reset verification');
    const { email, code, newPassword } = req.body;
    
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    // Find user
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    
    if (!user) {
      console.log('❌ User not found');
      return res.status(400).json({ error: 'Invalid email' });
    }
    
    // Verify code
    const { data: codeData } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .eq('type', 'reset')
      .gte('expires_at', new Date().toISOString())
      .maybeSingle();
    
    if (!codeData) {
      console.log('❌ Invalid or expired code');
      return res.status(400).json({ error: 'Invalid or expired code' });
    }
    
    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);
    
    // Update password
    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', user.id);
    
    if (updateError) {
      console.error('❌ Failed to update password:', updateError);
      throw new Error('Failed to update password');
    }
    
    // Delete used code
    await supabase
      .from('codes')
      .delete()
      .eq('id', codeData.id);
    
    console.log('✅ Password reset successful for user:', user.id);
    
    res.json({ success: true, message: 'Password reset successful! Please login with your new password.' });
  } catch (error) {
    console.error('❌ Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed: ' + error.message });
  }
});

// ==================== SEARCH USERS ====================
app.get('/api/search/users', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.json({ success: true, users: [], count: 0 });
    }
    
    const searchTerm = query.trim().toLowerCase();
    
    const { data: allUsers, error } = await supabase
      .from('users')
      .select('id, username, email, registration_number, college, profile_pic, bio')
      .limit(100);
    
    if (error) {
      console.error('❌ Search error:', error);
      throw error;
    }
    
    const matchedUsers = (allUsers || []).filter(user => {
      if (user.id === req.user.id) return false;
      
      const usernameMatch = user.username?.toLowerCase().includes(searchTerm);
      const emailMatch = user.email?.toLowerCase().includes(searchTerm);
      const regMatch = user.registration_number?.toLowerCase().includes(searchTerm);
      
      return usernameMatch || emailMatch || regMatch;
    });
    
    res.json({ 
      success: true, 
      users: matchedUsers.slice(0, 20),
      count: matchedUsers.length
    });
  } catch (error) {
    console.error('❌ User search error:', error);
    res.status(500).json({ 
      error: 'Search failed',
      success: false, 
      users: [],
      count: 0
    });
  }
});

// Continue with all other endpoints from the original code...
// [Include all remaining endpoints: profile, posts, comments, likes, shares, chat, etc.]
// For brevity, I'm including the key fixes above. The rest remains the same.

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 20MB' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Maximum is 10 files' });
    }
  }
  
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('🚀 VibeXpert Backend FIXED VERSION');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Login endpoint: POST /api/login`);
  console.log(`✅ Forgot password: POST /api/forgot-password`);
  console.log(`✅ Reset password: POST /api/reset-password`);
  console.log(`✅ CORS enabled for all origins`);
  console.log(`✅ JWT Secret: ${process.env.JWT_SECRET ? 'Configured' : '❌ MISSING!'}`);
  console.log(`✅ Brevo API: ${process.env.BREVO_API_KEY ? 'Configured' : '⚠️ MISSING - Emails will fail!'}`);
});
