// VIBEXPERT BACKEND - COMPLETE WITH REWARDS SYSTEM

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

app.use((req, res, next) => {
  console.log(`📡 ${req.method} ${req.path} - ${req.get('user-agent')}`);
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

// REWARD SYSTEM CONFIGURATION
const REWARD_BADGES = {
  VIBE_GO: {
    name: 'Vibe Go',
    emoji: '🌟',
    weeksRequired: 3,
    rewards: ['Early access to new features', 'Custom profile themes', 'Priority support'],
    color: '#4f74a3'
  },
  VIBE_PRO: {
    name: 'Vibe Pro',
    emoji: '💎',
    weeksRequired: 5,
    rewards: ['All Vibe Go benefits', 'Ad-free experience', 'Exclusive stickers pack', 'Profile badge'],
    color: '#8b5cf6'
  },
  VIBE_X: {
    name: 'Vibe X',
    emoji: '👑',
    weeksRequired: 7,
    rewards: ['All Vibe Pro benefits', 'Monetization eligibility', 'Revenue sharing program', 'VIP community access', 'Direct creator support'],
    color: '#f59e0b'
  }
};

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
    console.log(`✅ Email sent successfully`);
    return true;
  } catch (error) {
    console.error('❌ Email failed:', error.message);
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

// Helper function to check and award badges based on activity
async function checkAndAwardBadges(userId) {
  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('created_at, reward_badge, last_active, activity_streak')
      .eq('id', userId)
      .single();
    
    if (userError || !user) return null;
    
    const createdDate = new Date(user.created_at);
    const now = new Date();
    const weeksActive = Math.floor((now - createdDate) / (7 * 24 * 60 * 60 * 1000));
    
    let newBadge = null;
    let badgeAwarded = false;
    
    // Check for Vibe X (7 weeks)
    if (weeksActive >= REWARD_BADGES.VIBE_X.weeksRequired && user.reward_badge !== 'VIBE_X') {
      newBadge = 'VIBE_X';
      badgeAwarded = true;
    }
    // Check for Vibe Pro (5 weeks)
    else if (weeksActive >= REWARD_BADGES.VIBE_PRO.weeksRequired && user.reward_badge !== 'VIBE_PRO' && user.reward_badge !== 'VIBE_X') {
      newBadge = 'VIBE_PRO';
      badgeAwarded = true;
    }
    // Check for Vibe Go (3 weeks)
    else if (weeksActive >= REWARD_BADGES.VIBE_GO.weeksRequired && !user.reward_badge) {
      newBadge = 'VIBE_GO';
      badgeAwarded = true;
    }
    
    if (badgeAwarded && newBadge) {
      await supabase
        .from('users')
        .update({ 
          reward_badge: newBadge,
          badge_earned_at: new Date().toISOString()
        })
        .eq('id', userId);
      
      return {
        badge: newBadge,
        badgeInfo: REWARD_BADGES[newBadge],
        isNew: true
      };
    }
    
    return null;
  } catch (error) {
    console.error('Badge check error:', error);
    return null;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/post-assets', (req, res) => {
  res.json({ success: true, songs: availableSongs, stickers: availableStickers });
});

app.get('/api/music-library', (req, res) => {
  res.json({ success: true, music: availableSongs });
});

app.get('/api/sticker-library', (req, res) => {
  res.json({ success: true, stickers: availableStickers });
});

// NEW: Get reward badges info
app.get('/api/rewards/badges', (req, res) => {
  res.json({ success: true, badges: REWARD_BADGES });
});

// NEW: Get user's reward status
app.get('/api/rewards/status', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('created_at, reward_badge, badge_earned_at')
      .eq('id', req.user.id)
      .single();
    
    if (error) throw error;
    
    const createdDate = new Date(user.created_at);
    const now = new Date();
    const weeksActive = Math.floor((now - createdDate) / (7 * 24 * 60 * 60 * 1000));
    
    let currentBadge = null;
    let nextBadge = null;
    let weeksUntilNext = 0;
    
    if (user.reward_badge) {
      currentBadge = {
        type: user.reward_badge,
        ...REWARD_BADGES[user.reward_badge],
        earnedAt: user.badge_earned_at
      };
    }
    
    // Determine next badge
    if (!user.reward_badge || user.reward_badge === 'VIBE_GO') {
      const targetBadge = !user.reward_badge ? 'VIBE_GO' : 'VIBE_PRO';
      nextBadge = {
        type: targetBadge,
        ...REWARD_BADGES[targetBadge]
      };
      weeksUntilNext = REWARD_BADGES[targetBadge].weeksRequired - weeksActive;
    } else if (user.reward_badge === 'VIBE_PRO') {
      nextBadge = {
        type: 'VIBE_X',
        ...REWARD_BADGES.VIBE_X
      };
      weeksUntilNext = REWARD_BADGES.VIBE_X.weeksRequired - weeksActive;
    }
    
    res.json({
      success: true,
      weeksActive,
      currentBadge,
      nextBadge,
      weeksUntilNext: Math.max(0, weeksUntilNext),
      canSubmitUPI: user.reward_badge === 'VIBE_X'
    });
  } catch (error) {
    console.error('Reward status error:', error);
    res.status(500).json({ error: 'Failed to get reward status' });
  }
});

app.get('/api/search/users', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    console.log('🔍 Search request:', { query, userId: req.user.id });
    
    if (!query || query.trim().length < 2) {
      return res.json({ success: true, users: [], count: 0 });
    }
    
    const searchTerm = query.trim().toLowerCase();
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Search timeout')), 25000)
    );
    
    const searchPromise = supabase
      .from('users')
      .select('id, username, email, registration_number, college, profile_pic, bio, reward_badge')
      .limit(100);
    
    const { data: allUsers, error } = await Promise.race([searchPromise, timeoutPromise]);
    
    if (error) {
      console.error('❌ Supabase search error:', error);
      throw error;
    }
    
    const matchedUsers = (allUsers || []).filter(user => {
      if (user.id === req.user.id) return false;
      
      const usernameMatch = user.username?.toLowerCase().includes(searchTerm);
      const emailMatch = user.email?.toLowerCase().includes(searchTerm);
      const regMatch = user.registration_number?.toLowerCase().includes(searchTerm);
      
      return usernameMatch || emailMatch || regMatch;
    });
    
    console.log(`✅ Found ${matchedUsers.length} matching users`);
    
    res.json({ 
      success: true, 
      users: matchedUsers.slice(0, 20),
      count: matchedUsers.length
    });
  } catch (error) {
    console.error('❌ User search error:', error);
    res.status(500).json({ 
      error: 'Search failed. Please try again.',
      success: false, 
      users: [],
      count: 0
    });
  }
});

app.get('/api/profile/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, registration_number, college, profile_pic, bio, badges, community_joined, created_at, reward_badge, badge_earned_at')
      .eq('id', userId)
      .single();
    
    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const { data: posts } = await supabase
      .from('posts')
      .select('id')
      .eq('user_id', userId);
    
    res.json({ 
      success: true, 
      user: { ...user, postCount: posts?.length || 0 } 
    });
  } catch (error) {
    console.error('❌ Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

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
    
    const { data: existingUser } = await supabase
      .from('users')
      .select('email, registration_number')
      .or(`email.eq.${email},registration_number.eq.${registrationNumber}`)
      .maybeSingle();
    
    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      if (existingUser.registration_number === registrationNumber) {
        return res.status(400).json({ error: 'Registration number already registered' });
      }
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    
    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{
        username,
        email,
        password_hash: passwordHash,
        registration_number: registrationNumber,
        last_active: new Date().toISOString()
      }])
      .select()
      .single();
    
    if (error) {
      throw new Error('Failed to create account');
    }
    
    sendEmail(
      email,
      '🎉 Welcome to VibeXpert!',
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1>
        <p style="font-size: 16px; color: #374151;">Congratulations on creating your account!</p>
        <p style="font-size: 16px; color: #374151;">Stay active for 3 weeks to earn your first reward badge: <strong>Vibe Go 🌟</strong></p>
        <p style="font-size: 16px; color: #374151;">Ready to vibe? Let's go! 🚀</p>
      </div>`
    ).catch(err => console.error('Email send failed:', err));
    
    res.status(201).json({
      success: true,
      message: 'Account created successfully! Please log in.',
      userId: newUser.id
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

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
    
    // Update last active
    await supabase
      .from('users')
      .update({ last_active: new Date().toISOString() })
      .eq('id', user.id);
    
    // Check for badge awards
    const badgeUpdate = await checkAndAwardBadges(user.id);
    
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
        badges: user.badges || [],
        bio: user.bio || '',
        rewardBadge: user.reward_badge,
        badgeEarnedAt: user.badge_earned_at
      },
      newBadge: badgeUpdate
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

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
    
    const { error: codeError } = await supabase
      .from('codes')
      .insert([{
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

app.post('/api/college/request-verification', authenticateToken, async (req, res) => {
  try {
    const { collegeName, collegeEmail } = req.body;
    
    if (!collegeName || !collegeEmail) {
      return res.status(400).json({ error: 'College name and email required' });
    }
    
    if (req.user.college) {
      return res.status(400).json({ error: 'You are already connected to a college community' });
    }
    
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    const { error: codeError } = await supabase
      .from('codes')
      .insert([{
        user_id: req.user.id,
        code,
        type: 'college',
        meta: { collegeName, collegeEmail },
        expires_at: expiresAt.toISOString()
      }]);
    
    if (codeError) {
      throw new Error('Failed to generate verification code');
    }
    
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
    
    const { data: codeData } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('code', code)
      .eq('type', 'college')
      .gte('expires_at', new Date().toISOString())
      .maybeSingle();
    
    if (!codeData) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }
    
    const { collegeName } = codeData.meta;
    const currentBadges = req.user.badges || [];
    
    if (!currentBadges.includes('🎓 Community Member')) {
      currentBadges.push('🎓 Community Member');
    }
    
    await supabase
      .from('users')
      .update({
        college: collegeName,
        community_joined: true,
        badges: currentBadges
      })
      .eq('id', req.user.id);
    
    await supabase
      .from('codes')
      .delete()
      .eq('id', codeData.id);
    
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

app.post('/api/posts', authenticateToken, upload.array('media', 10), async (req, res) => {
  try {
    const { content = '', postTo = 'profile', music, stickers = '[]' } = req.body;
    const files = req.files;
    
    console.log('📝 Creating post:', { userId: req.user.id, postTo, hasFiles: !!files?.length });
    
    const hasContent = content && content.trim().length > 0;
    const hasFiles = files && files.length > 0;
    const hasMusic = music && music !== 'null' && music !== 'undefined';
    const hasStickers = stickers && stickers !== '[]' && stickers !== 'null';
    
    if (!hasContent && !hasFiles && !hasMusic && !hasStickers) {
      return res.status(400).json({ error: 'Post must have content' });
    }
    
    if (!['profile', 'community'].includes(postTo)) {
      return res.status(400).json({ error: 'Invalid post destination' });
    }
    
    if (postTo === 'community') {
      if (!req.user.community_joined || !req.user.college) {
        return res.status(403).json({
          error: 'Please connect to your university first',
          needsJoinCommunity: true
        });
      }
    }
    
    let parsedMusic = null;
    if (hasMusic) {
      try {
        parsedMusic = JSON.parse(music);
        if (!parsedMusic?.id || !parsedMusic?.name) parsedMusic = null;
      } catch (e) {
        parsedMusic = null;
      }
    }
    
    let parsedStickers = [];
    if (hasStickers) {
      try {
        parsedStickers = JSON.parse(stickers);
        if (!Array.isArray(parsedStickers)) parsedStickers = [];
        parsedStickers = parsedStickers.slice(0, 5);
      } catch (e) {
        parsedStickers = [];
      }
    }

    const mediaUrls = [];
    if (hasFiles) {
      for (const file of files) {
        try {
          const fileExt = file.originalname.split('.').pop();
          const fileName = `${req.user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
          
          const { error: uploadError } = await supabase.storage
            .from('posts-media')
            .upload(fileName, file.buffer, {
              contentType: file.mimetype,
              cacheControl: '3600'
            });
          
          if (!uploadError) {
            const { data: urlData } = supabase.storage
              .from('posts-media')
              .getPublicUrl(fileName);
            
            const mediaType = file.mimetype.startsWith('image') 
              ? 'image' 
              : file.mimetype.startsWith('video') 
              ? 'video' 
              : 'audio';
            
            mediaUrls.push({ url: urlData.publicUrl, type: mediaType });
          }
        } catch (err) {
          console.error('File upload error:', err);
        }
      }
    }
    
    const postData = {
      user_id: req.user.id,
      content: content?.trim() || '',
      media: mediaUrls,
      college: req.user.college || null,
      posted_to: postTo,
      music: parsedMusic,
      stickers: parsedStickers
    };
    
    const { data: newPost, error: postError } = await supabase
      .from('posts')
      .insert([postData])
      .select(`*, users (id, username, profile_pic, college, registration_number, reward_badge)`)
      .single();
    
    if (postError) {
      console.error('❌ Database error:', postError);
      return res.status(500).json({ error: 'Failed to create post: ' + postError.message });
    }

    const currentBadges = req.user.badges || [];
    const { data: userPosts } = await supabase
      .from('posts')
      .select('id')
      .eq('user_id', req.user.id);
    
    const postCount = userPosts?.length || 0;
    
    let badgeUpdated = false;
    const newBadges = [];
    
    if (postCount === 1 && !currentBadges.includes('🎨 First Post')) {
      currentBadges.push('🎨 First Post');
      newBadges.push('🎨 First Post');
      badgeUpdated = true;
    }
    
    if (postCount === 10 && !currentBadges.includes('⭐ Content Creator')) {
      currentBadges.push('⭐ Content Creator');
      newBadges.push('⭐ Content Creator');
      badgeUpdated = true;
    }
    
    if (badgeUpdated) {
      await supabase
        .from('users')
        .update({ badges: currentBadges })
        .eq('id', req.user.id);
    }
    
    const rewardBadgeUpdate = await checkAndAwardBadges(req.user.id);
    
    if (postTo === 'community' && req.user.college) {
      io.to(req.user.college).emit('new_post', newPost);
    } else {
      io.emit('new_profile_post', { userId: req.user.id, post: newPost });
    }
    
    res.status(201).json({
      success: true,
      post: newPost,
      message: postTo === 'community' ? 'Posted to community!' : 'Posted to profile!',
      badges: currentBadges,
      badgeUpdated,
      newBadges,
      postCount: postCount,
      rewardBadgeUpdate
    });
  } catch (error) {
    console.error('❌ Post creation error:', error);
    res.status(500).json({ error: error.message || 'Failed to create post' });
  }
});

app.post('/api/posts/:postId/like', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    const { data: existingLike } = await supabase
      .from('post_likes')
      .select('*')
      .eq('post_id', postId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    
    let liked = false;
    
    if (existingLike) {
      await supabase
        .from('post_likes')
        .delete()
        .eq('id', existingLike.id);
      
      liked = false;
    } else {
      await supabase
        .from('post_likes')
        .insert([{
          post_id: postId,
          user_id: req.user.id
        }]);
      
      liked = true;
    }
    
    const { data: likes } = await supabase
      .from('post_likes')
      .select('id')
      .eq('post_id', postId);
    
    const likeCount = likes?.length || 0;
    
    const { data: post } = await supabase
      .from('posts')
      .select('college, posted_to')
      .eq('id', postId)
      .single();
    
    if (post) {
      if (post.posted_to === 'community' && post.college) {
        io.to(post.college).emit('post_liked', { postId, likeCount });
      } else {
        io.emit('post_liked', { postId, likeCount });
      }
    }
    
    res.json({ success: true, liked, likeCount });
  } catch (error) {
    console.error('❌ Like error:', error);
    res.status(500).json({ error: 'Failed to like post' });
  }
});

app.get('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    const { data: comments, error } = await supabase
      .from('post_comments')
      .select(`*, users (id, username, profile_pic, reward_badge)`)
      .eq('post_id', postId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({ success: true, comments: comments || [] });
  } catch (error) {
    console.error('❌ Get comments error:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

app.post('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content required' });
    }
    
    const { data: newComment, error } = await supabase
      .from('post_comments')
      .insert([{
        post_id: postId,
        user_id: req.user.id,
        content: content.trim()
      }])
      .select(`*, users (id, username, profile_pic, reward_badge)`)
      .single();
    
    if (error) throw error;
    
    const { data: comments } = await supabase
      .from('post_comments')
      .select('id')
      .eq('post_id', postId);
    
    const commentCount = comments?.length || 0;
    
    const { data: post } = await supabase
      .from('posts')
      .select('college, posted_to')
      .eq('id', postId)
      .single();
    
    if (post) {
      if (post.posted_to === 'community' && post.college) {
        io.to(post.college).emit('post_commented', { postId, commentCount });
      } else {
        io.emit('post_commented', { postId, commentCount });
      }
    }
    
    res.json({ success: true, comment: newComment, commentCount });
  } catch (error) {
    console.error('❌ Comment error:', error);
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

app.delete('/api/posts/:postId/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    
    const { data: comment } = await supabase
      .from('post_comments')
      .select('user_id')
      .eq('id', commentId)
      .single();
    
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    if (comment.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await supabase
      .from('post_comments')
      .delete()
      .eq('id', commentId);
    
    const { data: comments } = await supabase
      .from('post_comments')
      .select('id')
      .eq('post_id', postId);
    
    const commentCount = comments?.length || 0;
    
    const { data: post } = await supabase
      .from('posts')
      .select('college, posted_to')
      .eq('id', postId)
      .single();
    
    if (post) {
      if (post.posted_to === 'community' && post.college) {
        io.to(post.college).emit('post_commented', { postId, commentCount });
      } else {
        io.emit('post_commented', { postId, commentCount });
      }
    }
    
    res.json({ success: true, message: 'Comment deleted' });
  } catch (error) {
    console.error('❌ Delete comment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

app.post('/api/posts/:postId/share', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    const { data: existingShare } = await supabase
      .from('post_shares')
      .select('*')
      .eq('post_id', postId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    
    if (!existingShare) {
      await supabase
        .from('post_shares')
        .insert([{
          post_id: postId,
          user_id: req.user.id
        }]);
    }
    
    const { data: shares } = await supabase
      .from('post_shares')
      .select('id')
      .eq('post_id', postId);
    
    const shareCount = shares?.length || 0;
    
    const { data: post } = await supabase
      .from('posts')
      .select('college, posted_to')
      .eq('id', postId)
      .single();
    
    if (post) {
      if (post.posted_to === 'community' && post.college) {
        io.to(post.college).emit('post_shared', { postId, shareCount });
      } else {
        io.emit('post_shared', { postId, shareCount });
      }
    }
    
    res.json({ success: true, shareCount });
  } catch (error) {
    console.error('❌ Share error:', error);
    res.status(500).json({ error: 'Failed to share post' });
  }
});

app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    
    const { data: profilePosts, error: profileError } = await supabase
      .from('posts')
      .select(`*, users (id, username, profile_pic, college, registration_number, reward_badge)`)
      .eq('user_id', req.user.id)
      .eq('posted_to', 'profile')
      .order('created_at', { ascending: false });
    
    if (profileError) console.error('❌ Profile posts error:', profileError);
    
    let communityPosts = [];
    if (req.user.community_joined && req.user.college) {
      const { data: commPosts, error: commError } = await supabase
        .from('posts')
        .select(`*, users (id, username, profile_pic, college, registration_number, reward_badge)`)
        .eq('college', req.user.college)
        .eq('posted_to', 'community')
        .order('created_at', { ascending: false });
      
      if (commError) {
        console.error('❌ Community posts error:', commError);
      } else {
        communityPosts = commPosts || [];
      }
    }
    
    const allPosts = [...(profilePosts || []), ...communityPosts]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    
    const postsWithInteractions = await Promise.all(allPosts.map(async (post) => {
      const { data: likes } = await supabase
        .from('post_likes')
        .select('user_id')
        .eq('post_id', post.id);
      
      const likeCount = likes?.length || 0;
      const isLiked = likes?.some(like => like.user_id === req.user.id) || false;
      
      const { data: comments } = await supabase
        .from('post_comments')
        .select('id')
        .eq('post_id', post.id);
      
      const commentCount = comments?.length || 0;
      
      const { data: shares } = await supabase
        .from('post_shares')
        .select('id')
        .eq('post_id', post.id);
      
      const shareCount = shares?.length || 0;
      
      return {
        ...post,
        music: post.music || null,
        stickers: post.stickers || [],
        like_count: likeCount,
        comment_count: commentCount,
        share_count: shareCount,
        is_liked: isLiked
      };
    }));
    
    res.json({ success: true, posts: postsWithInteractions });
  } catch (error) {
    console.error('❌ Get posts error:', error);
    res.json({ success: true, posts: [] });
  }
});

app.get('/api/posts/profile', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`*, users (id, username, profile_pic, college, registration_number, reward_badge)`)
      .eq('user_id', req.user.id)
      .eq('posted_to', 'profile')
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (error) throw error;
    
    const postsWithInteractions = await Promise.all((posts || []).map(async (post) => {
      const { data: likes } = await supabase
        .from('post_likes')
        .select('user_id')
        .eq('post_id', post.id);
      
      const { data: comments } = await supabase
        .from('post_comments')
        .select('id')
        .eq('post_id', post.id);
      
      const { data: shares } = await supabase
        .from('post_shares')
        .select('id')
        .eq('post_id', post.id);
      
      return {
        ...post,
        music: post.music || null,
        stickers: post.stickers || [],
        like_count: likes?.length || 0,
        comment_count: comments?.length || 0,
        share_count: shares?.length || 0,
        is_liked: likes?.some(like => like.user_id === req.user.id) || false
      };
    }));
    
    res.json({ success: true, posts: postsWithInteractions });
  } catch (error) {
    console.error('❌ Get profile posts error:', error);
    res.status(500).json({ error: 'Failed to fetch profile posts' });
  }
});

app.get('/api/posts/community', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({
        error: 'Please join a college community first to view community posts',
        needsJoinCommunity: true
      });
    }
    
    const { limit = 20, offset = 0 } = req.query;
    
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`*, users (id, username, profile_pic, college, registration_number, reward_badge)`)
      .eq('college', req.user.college)
      .eq('posted_to', 'community')
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (error) throw error;
    
    const postsWithInteractions = await Promise.all((posts || []).map(async (post) => {
      const { data: likes } = await supabase
        .from('post_likes')
        .select('user_id')
        .eq('post_id', post.id);
      
      const { data: comments } = await supabase
        .from('post_comments')
        .select('id')
        .eq('post_id', post.id);
      
      const { data: shares } = await supabase
        .from('post_shares')
        .select('id')
        .eq('post_id', post.id);
      
      return {
        ...post,
        music: post.music || null,
        stickers: post.stickers || [],
        like_count: likes?.length || 0,
        comment_count: comments?.length || 0,
        share_count: shares?.length || 0,
        is_liked: likes?.some(like => like.user_id === req.user.id) || false
      };
    }));
    
    res.json({ success: true, posts: postsWithInteractions });
  } catch (error) {
    console.error('❌ Get community posts error:', error);
    res.status(500).json({ error: 'Failed to fetch community posts' });
  }
});

app.get('/api/posts/user/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`*, users (id, username, profile_pic, college, registration_number, reward_badge)`)
      .eq('user_id', userId)
      .eq('posted_to', 'profile')
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (error) throw error;
    
    const postsWithInteractions = await Promise.all((posts || []).map(async (post) => {
      const { data: likes } = await supabase
        .from('post_likes')
        .select('user_id')
        .eq('post_id', post.id);
      
      const { data: comments } = await supabase
        .from('post_comments')
        .select('id')
        .eq('post_id', post.id);
      
      const { data: shares } = await supabase
        .from('post_shares')
        .select('id')
        .eq('post_id', post.id);
      
      return {
        ...post,
        music: post.music || null,
        stickers: post.stickers || [],
        like_count: likes?.length || 0,
        comment_count: comments?.length || 0,
        share_count: shares?.length || 0,
        is_liked: likes?.some(like => like.user_id === req.user.id) || false
      };
    }));
    
    res.json({ success: true, posts: postsWithInteractions });
  } catch (error) {
    console.error('❌ Get user profile posts error:', error);
    res.status(500).json({ error: 'Failed to fetch user profile posts' });
  }
});

app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: post } = await supabase
      .from('posts')
      .select('user_id, media, posted_to, college')
      .eq('id', id)
      .single();
    
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    if (post.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await supabase.from('post_likes').delete().eq('post_id', id);
    await supabase.from('post_comments').delete().eq('post_id', id);
    await supabase.from('post_shares').delete().eq('post_id', id);
    
    if (post.media && post.media.length > 0) {
      for (const media of post.media) {
        try {
          const urlParts = media.url.split('/');
          const fileNameWithUUID = urlParts.pop();
          const filePath = `${req.user.id}/${fileNameWithUUID}`;
          await supabase.storage.from('posts-media').remove([filePath]);
        } catch (mediaError) {
          console.warn('⚠️ Could not delete media file:', mediaError.message);
        }
      }
    }
    
    await supabase.from('posts').delete().eq('id', id);
    
    if (post.posted_to === 'community' && post.college) {
      io.to(post.college).emit('post_deleted', { id });
    } else {
      io.emit('profile_post_deleted', { userId: req.user.id, postId: id });
    }
    
    res.json({ success: true, message: 'Post deleted successfully' });
  } catch (error) {
    console.error('❌ Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

app.get('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    
    const { limit = 50 } = req.query;
    
    const { data: messages, error } = await supabase
      .from('messages')
      .select(`*, users (id, username, profile_pic, reward_badge), message_reactions (*)`)
      .eq('college', req.user.college)
      .order('timestamp', { ascending: false })
      .limit(limit);
    
    if (error) throw error;
    
    res.json({ success: true, messages: messages || [] });
  } catch (error) {
    console.error('❌ Get messages error:', error);
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
    
    const { data: newMessage, error } = await supabase
      .from('messages')
      .insert([{
        sender_id: req.user.id,
        content: content.trim(),
        college: req.user.college
      }])
      .select(`*, users (id, username, profile_pic, reward_badge)`)
      .single();
    
    if (error) throw error;
    
    io.to(req.user.college).emit('new_message', newMessage);
    
    res.json({ success: true, message: newMessage });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.patch('/api/community/messages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }
    
    const { data: message } = await supabase
      .from('messages')
      .select('timestamp, college, sender_id')
      .eq('id', id)
      .single();
    
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to edit this message' });
    }
    
    const messageTime = new Date(message.timestamp);
    const now = new Date();
    const diffMinutes = (now - messageTime) / 1000 / 60;
    
    if (diffMinutes > 2) {
      return res.status(403).json({ error: 'Can only edit message within 2 minutes of sending' });
    }
    
    const { data: updatedMessage, error: updateError } = await supabase
      .from('messages')
      .update({ content: content.trim(), is_edited: true })
      .eq('id', id)
      .select(`*, users (id, username, profile_pic, reward_badge)`)
      .single();
    
    if (updateError) throw updateError;
    
    io.to(message.college).emit('message_updated', updatedMessage);
    
    res.json({ success: true, message: updatedMessage });
  } catch (error) {
    console.error('❌ Edit message error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

app.delete('/api/community/messages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: message } = await supabase
      .from('messages')
      .select('college, sender_id')
      .eq('id', id)
      .maybeSingle();
    
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this message' });
    }
    
    await supabase.from('message_reactions').delete().eq('message_id', id);
    await supabase.from('messages').delete().eq('id', id);
    
    io.to(message.college).emit('message_deleted', { id, college: message.college });
    
    res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('❌ Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

app.post('/api/community/messages/:id/react', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji required' });
    }
    
    const { data: message } = await supabase
      .from('messages')
      .select('college')
      .eq('id', id)
      .maybeSingle();
    
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    const { data: existing } = await supabase
      .from('message_reactions')
      .select('*')
      .eq('message_id', id)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .maybeSingle();
    
    let action = 'added';
    let reaction = null;
    
    if (existing) {
      await supabase.from('message_reactions').delete().eq('id', existing.id);
      action = 'removed';
    } else {
      const { data: newReaction, error } = await supabase
        .from('message_reactions')
        .insert([{ message_id: id, user_id: req.user.id, emoji: emoji }])
        .select()
        .single();
      
      if (error) throw error;
      reaction = newReaction;
    }
    
    io.to(message.college).emit('message_reaction_updated', {
      messageId: id,
      userId: req.user.id,
      emoji,
      action
    });
    
    res.json({ success: true, action, reaction });
  } catch (error) {
    console.error('❌ React to message error:', error);
    res.status(500).json({ error: 'Failed to react to message' });
  }
});

app.post('/api/community/messages/:id/view', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: existing } = await supabase
      .from('message_views')
      .select('*')
      .eq('message_id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    
    if (!existing) {
      await supabase
        .from('message_views')
        .insert([{ message_id: id, user_id: req.user.id }]);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Mark view error:', error);
    res.status(500).json({ error: 'Failed to mark as viewed' });
  }
});

app.get('/api/community/messages/:id/views', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: views, error } = await supabase
      .from('message_views')
      .select(`*, users (id, username, profile_pic, reward_badge)`)
      .eq('message_id', id);
    
    if (error) throw error;
    
    res.json({ success: true, views: views || [], count: views?.length || 0 });
  } catch (error) {
    console.error('❌ Get views error:', error);
    res.status(500).json({ error: 'Failed to fetch views' });
  }
});

app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, username, email, registration_number, college, profile_pic, bio, badges, community_joined, created_at, reward_badge, badge_earned_at')
      .eq('id', req.user.id)
      .single();
    
    const { data: posts } = await supabase
      .from('posts')
      .select('id')
      .eq('user_id', req.user.id);
    
    res.json({ success: true, user: { ...user, postCount: posts?.length || 0 } });
  } catch (error) {
    console.error('❌ Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.patch('/api/profile', authenticateToken, upload.single('profilePic'), async (req, res) => {
  try {
    const updates = {};
    
    if (req.body.username) {
      updates.username = req.body.username.trim();
    }
    
    if (req.body.bio !== undefined) {
      updates.bio = req.body.bio.trim();
    }
    
    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop();
      const fileName = `${req.user.id}/profile-${Date.now()}.${fileExt}`;
      
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('profile-pics')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
          cacheControl: '3600',
          upsert: true
        });
      
      if (uploadError) throw uploadError;
      
      const { data: urlData } = supabase.storage
        .from('profile-pics')
        .getPublicUrl(fileName);
      
      updates.profile_pic = urlData.publicUrl;
    }
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }
    
    const { data: updatedUser, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, username, email, registration_number, college, profile_pic, bio, badges, community_joined, reward_badge, badge_earned_at')
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    console.error('❌ Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.post('/api/feedback', authenticateToken, async (req, res) => {
  try {
    const { subject, message, upiId } = req.body;
    
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message required' });
    }
    
    if (upiId) {
      if (req.user.reward_badge !== 'VIBE_X') {
        return res.status(403).json({ error: 'UPI ID submission only available for Vibe X badge holders' });
      }
    }
    
    const { error } = await supabase
      .from('feedback')
      .insert([{
        user_id: req.user.id,
        subject: subject.trim(),
        message: message.trim(),
        upi_id: upiId ? upiId.trim() : null
      }]);
    
    if (error) throw error;
    
    if (upiId) {
      sendEmail(
        process.env.ADMIN_EMAIL || 'admin@vibexpert.online',
        `🎉 Vibe X Badge Holder - UPI Submission from ${req.user.username}`,
        `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #f59e0b;">👑 Vibe X Badge Holder UPI Submission</h1>
          <p><strong>User:</strong> ${req.user.username}</p>
          <p><strong>Email:</strong> ${req.user.email}</p>
          <p><strong>UPI ID:</strong> ${upiId}</p>
          <p><strong>Subject:</strong> ${subject}</p>
          <p><strong>Message:</strong></p>
          <div style="background: #f3f4f6; padding: 15px; border-radius: 8px;">
            ${message}
          </div>
        </div>`
      ).catch(err => console.error('Admin email failed:', err));
    }
    
    res.json({ 
      success: true, 
      message: upiId ? 'Feedback and UPI details submitted successfully!' : 'Feedback submitted successfully!' 
    });
  } catch (error) {
    console.error('❌ Submit feedback error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

io.on('connection', (socket) => {
  console.log('⚡ User connected:', socket.id);
  
  socket.on('join_community', (collegeName) => {
    if (collegeName && typeof collegeName === 'string') {
      Object.keys(socket.rooms).forEach(room => {
        if (room !== socket.id) socket.leave(room);
      });
      socket.join(collegeName);
      socket.data.college = collegeName;
      console.log(`🧑‍🤝‍🧑 User ${socket.id} joined community: ${collegeName}`);
      socket.emit('community_joined', collegeName);
    }
  });
  
  socket.on('typing', (data) => {
    if (data.collegeName && data.username) {
      socket.to(data.collegeName).emit('user_typing', { username: data.username });
    }
  });
  
  socket.on('stop_typing', (data) => {
    if (data.collegeName && data.username) {
      socket.to(data.collegeName).emit('user_stop_typing', { username: data.username });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('👋 User disconnected:', socket.id);
    if (socket.data.college) {
      console.log(`- User left community: ${socket.data.college}`);
    }
  });
});

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

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 VibeXpert Backend running on port ${PORT}`);
  console.log(`✅ Mobile-optimized with enhanced timeout handling`);
  console.log(`✅ CORS configured for all devices`);
  console.log(`✅ Image upload support: 20MB max per file, 10 files max`);
  console.log(`✅ Like, Comment, Share functionality enabled`);
  console.log(`✅ Reward System: Vibe Go (3w), Vibe Pro (5w), Vibe X (7w)`);
  console.log(`✅ Real-time updates via Socket.IO`);
});
