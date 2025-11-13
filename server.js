// VIBEXPERT BACKEND - COMPLETE WITH REWARDS SYSTEM

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jwt');
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

// Badge Configuration
const BADGE_TIERS = {
  VIBE_GO: {
    name: 'Vibe Go',
    tier: 1,
    weeksRequired: 3,
    icon: '🚀',
    color: '#10b981',
    rewards: [
      'Profile badge display',
      'Basic customization options',
      'Community recognition',
      'Priority in search results'
    ]
  },
  VIBE_PRO: {
    name: 'Vibe Pro',
    tier: 2,
    weeksRequired: 5,
    icon: '⭐',
    color: '#8b5cf6',
    rewards: [
      'Extended profile customization',
      'Pro badge display',
      'Priority in community',
      'Custom profile themes',
      'Early access to new features'
    ]
  },
  VIBE_X: {
    name: 'Vibe X',
    tier: 3,
    weeksRequired: 7,
    icon: '👑',
    color: '#f59e0b',
    rewards: [
      'Monetization enabled',
      'Premium profile badge',
      'Priority support',
      'Exclusive content access',
      'Revenue sharing program',
      'UPI integration for earnings'
    ]
  }
};

const availableSongs = [
  { id: 1, name: 'Chill Vibes', artist: 'LoFi Beats', duration: '2:30', emoji: '🎧', url: 'https://assets.mixkit.co/music/preview/mixkit-chill-vibes-239.mp3' },
  { id: 2, name: 'Upbeat Energy', artist: 'Electronic Pop', duration: '3:15', emoji: '⚡', url: 'https://assets.mixkit.co/music/preview/mixkit-upbeat-energy-225.mp3' },
  { id: 3, name: 'Dreamy Piano', artist: 'Classical', duration: '2:45', emoji: '🎹', url: 'https://assets.mixkit.co/music/preview/mixkit-dreamy-piano-1171.mp3' },
  { id: 4, name: 'Summer Vibes', artist: 'Tropical', duration: '3:30', emoji: '🏖️', url: 'https://assets.mixkit.co/music/preview/mixkit-summer-vibes-129.mp3' },
  { id: 5, name: 'Happy Day', artist: 'Pop Rock', duration: '2:50', emoji: '😊', url: 'https://assets.mixkit.co/music/preview/mixkit-happy-day-583.mp3' },
  { id: 6, name: 'Relaxing Guitar', artist: 'Acoustic', duration: '3:10', emoji: '🎸', url: 'https://assets.mixkit.co/music/preview/mixkit-relaxing-guitar-243.mp3' }
];

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

// Calculate badge tier based on account age
function calculateBadgeTier(createdAt) {
  const now = new Date();
  const accountCreated = new Date(createdAt);
  const diffTime = Math.abs(now - accountCreated);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  const weeks = Math.floor(diffDays / 7);
  
  if (weeks >= BADGE_TIERS.VIBE_X.weeksRequired) return 3;
  if (weeks >= BADGE_TIERS.VIBE_PRO.weeksRequired) return 2;
  if (weeks >= BADGE_TIERS.VIBE_GO.weeksRequired) return 1;
  return 0;
}

// Get badge info from tier
function getBadgeInfo(tier) {
  switch(tier) {
    case 3: return BADGE_TIERS.VIBE_X;
    case 2: return BADGE_TIERS.VIBE_PRO;
    case 1: return BADGE_TIERS.VIBE_GO;
    default: return null;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/post-assets', (req, res) => {
  res.json({ success: true, songs: availableSongs });
});

app.get('/api/music-library', (req, res) => {
  res.json({ success: true, music: availableSongs });
});

app.get('/api/search/users', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.json({ success: true, users: [], count: 0 });
    }
    
    const searchTerm = query.trim().toLowerCase();
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Search timeout')), 25000)
    );
    
    const searchPromise = supabase
      .from('users')
      .select('id, username, email, registration_number, college, profile_pic, bio, current_badge, badge_tier')
      .limit(100);
    
    const { data: allUsers, error } = await Promise.race([searchPromise, timeoutPromise]);
    
    if (error) throw error;
    
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
      .select('id, username, email, registration_number, college, profile_pic, bio, badges, community_joined, created_at, current_badge, badge_tier, monetization_enabled')
      .eq('id', userId)
      .single();
    
    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const { data: posts } = await supabase
      .from('posts')
      .select('id')
      .eq('user_id', userId);
    
    // Calculate current badge eligibility
    const currentTier = calculateBadgeTier(user.created_at);
    const badgeInfo = getBadgeInfo(currentTier);
    
    res.json({ 
      success: true, 
      user: { 
        ...user, 
        postCount: posts?.length || 0,
        currentBadgeTier: currentTier,
        badgeInfo: badgeInfo
      } 
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
        registration_number: registrationNumber
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
        <p style="font-size: 16px; color: #374151;">Use the platform consistently to unlock exclusive badges:</p>
        <ul>
          <li>🚀 Vibe Go (3 weeks) - Basic rewards</li>
          <li>⭐ Vibe Pro (5 weeks) - Extended features</li>
          <li>👑 Vibe X (7 weeks) - Monetization enabled</li>
        </ul>
        <p>Ready to vibe? Let's go! 🚀</p>
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
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', user.id);
    
    // Calculate current badge tier
    const currentTier = calculateBadgeTier(user.created_at);
    const previousTier = user.badge_tier || 0;
    
    let badgeUpgrade = null;
    if (currentTier > previousTier) {
      // User earned a new badge!
      const badgeInfo = getBadgeInfo(currentTier);
      
      await supabase
        .from('users')
        .update({ 
          badge_tier: currentTier,
          current_badge: badgeInfo.name,
          monetization_enabled: currentTier === 3
        })
        .eq('id', user.id);
      
      await supabase
        .from('user_rewards')
        .insert([{
          user_id: user.id,
          badge_name: badgeInfo.name,
          badge_tier: currentTier,
          reward_description: badgeInfo.rewards.join(', ')
        }]);
      
      badgeUpgrade = badgeInfo;
    }
    
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({
      success: true,
      token,
      badgeUpgrade,
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
        currentBadge: badgeInfo ? badgeInfo.name : null,
        badgeTier: currentTier,
        badgeInfo: getBadgeInfo(currentTier),
        monetizationEnabled: currentTier === 3
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Check badge eligibility endpoint
app.get('/api/rewards/check', authenticateToken, async (req, res) => {
  try {
    const currentTier = calculateBadgeTier(req.user.created_at);
    const previousTier = req.user.badge_tier || 0;
    
    const badgeInfo = getBadgeInfo(currentTier);
    const nextBadge = getBadgeInfo(currentTier + 1);
    
    // Calculate days until next badge
    const accountAge = Math.floor((new Date() - new Date(req.user.created_at)) / (1000 * 60 * 60 * 24));
    const currentWeeks = Math.floor(accountAge / 7);
    const nextBadgeWeeks = nextBadge ? nextBadge.weeksRequired : null;
    const daysUntilNext = nextBadgeWeeks ? (nextBadgeWeeks * 7) - accountAge : null;
    
    res.json({
      success: true,
      currentTier,
      previousTier,
      newBadgeEarned: currentTier > previousTier,
      currentBadge: badgeInfo,
      nextBadge: nextBadge,
      daysUntilNext,
      accountAgeWeeks: currentWeeks,
      accountAgeDays: accountAge
    });
  } catch (error) {
    console.error('Check rewards error:', error);
    res.status(500).json({ error: 'Failed to check rewards' });
  }
});

// Submit UPI ID for Vibe X users
app.post('/api/feedback', authenticateToken, async (req, res) => {
  try {
    const { subject, message, upiId, badgeRelated } = req.body;
    
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message required' });
    }
    
    // Check if user is eligible to submit UPI (Vibe X)
    const currentTier = calculateBadgeTier(req.user.created_at);
    
    if (badgeRelated && upiId) {
      if (currentTier !== 3) {
        return res.status(403).json({ error: 'Only Vibe X badge holders can submit UPI ID' });
      }
      
      // Update user's UPI ID
      await supabase
        .from('users')
        .update({ upi_id: upiId })
        .eq('id', req.user.id);
    }
    
    const { error } = await supabase
      .from('feedback')
      .insert([{
        user_id: req.user.id,
        subject: subject.trim(),
        message: message.trim(),
        upi_id: upiId || null,
        badge_related: badgeRelated || false
      }]);
    
    if (error) throw error;
    
    res.json({ success: true, message: 'Feedback submitted successfully' });
  } catch (error) {
    console.error('❌ Submit feedback error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// Get all badges info
app.get('/api/badges/info', (req, res) => {
  res.json({
    success: true,
    badges: [
      BADGE_TIERS.VIBE_GO,
      BADGE_TIERS.VIBE_PRO,
      BADGE_TIERS.VIBE_X
    ]
  });
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
    
    if (codeError) throw new Error('Failed to generate reset code');
    
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

// College verification endpoints (unchanged)
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
    
    if (codeError) throw new Error('Failed to generate verification code');
    
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

// Posts endpoints with all features (Like, Comment, Share - keeping existing functionality)
app.post('/api/posts', authenticateToken, upload.array('media', 10), async (req, res) => {
  try {
    const { content = '', postTo = 'profile', music, stickers = '[]' } = req.body;
    const files = req.files;
    
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
        return
