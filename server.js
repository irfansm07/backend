// VIBEXPERT BACKEND - COMPLETE WITH PAYMENT INTEGRATION
// This is the COMPLETE server.js file - Nothing is missing!

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
const Razorpay = require('razorpay');
const crypto = require('crypto');

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

// ==================== RAZORPAY INITIALIZATION ====================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
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

// ==================== PAYMENT ENDPOINTS ====================

app.post('/api/payment/create-order', authenticateToken, async (req, res) => {
  try {
    const { amount, planType, isFirstTime } = req.body;
    
    if (!amount || !planType) {
      return res.status(400).json({ error: 'Amount and plan type required' });
    }
    
    if (amount < 1 || amount > 10000) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    const options = {
      amount: amount * 100,
      currency: 'INR',
      receipt: `order_${req.user.id}_${Date.now()}`,
      notes: {
        userId: req.user.id,
        username: req.user.username,
        planType: planType,
        isFirstTime: isFirstTime
      }
    };
    
    const order = await razorpay.orders.create(options);
    
    await supabase.from('payment_orders').insert([{
      user_id: req.user.id,
      order_id: order.id,
      amount: amount,
      plan_type: planType,
      status: 'created'
    }]);
    
    console.log(`💳 Payment order created: ${order.id} for user ${req.user.username}`);
    
    res.json({
      success: true,
      orderId: order.id,
      amount: amount,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID
    });
    
  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

app.post('/api/payment/verify', authenticateToken, async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature,
      planType 
    } = req.body;
    
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }
    
    const generated_signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');
    
    if (generated_signature !== razorpay_signature) {
      console.error('❌ Invalid payment signature');
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid payment signature' 
      });
    }
    
    console.log(`✅ Payment verified: ${razorpay_payment_id}`);
    
    const plans = {
      noble: { posters: 5, videos: 1, days: 15 },
      royal: { posters: 5, videos: 3, days: 23 }
    };
    
    const plan = plans[planType];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }
    
    const endDate = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
    
    await supabase
      .from('users')
      .update({
        subscription_plan: planType,
        subscription_start: new Date(),
        subscription_end: endDate,
        is_premium: true,
        has_subscribed: true,
        posters_quota: plan.posters,
        videos_quota: plan.videos
      })
      .eq('id', req.user.id);
    
    await supabase
      .from('payment_orders')
      .update({
        payment_id: razorpay_payment_id,
        signature: razorpay_signature,
        status: 'completed',
        updated_at: new Date()
      })
      .eq('order_id', razorpay_order_id);
    
    sendEmail(
      req.user.email,
      '🎉 Subscription Activated - VibeXpert',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #4F46E5;">Welcome to ${planType === 'royal' ? 'Royal' : 'Noble'} Plan! 👑</h1>
          <p style="font-size: 16px;">Hi ${req.user.username},</p>
          <p>Your subscription has been activated successfully!</p>
          
          <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Subscription Details:</h3>
            <ul style="list-style: none; padding: 0;">
              <li>📦 Plan: <strong>${planType.toUpperCase()}</strong></li>
              <li>📸 Advertisement Posters: <strong>${plan.posters}</strong></li>
              <li>🎥 Advertisement Videos: <strong>${plan.videos}</strong></li>
              <li>⏰ Valid until: <strong>${endDate.toLocaleDateString()}</strong></li>
            </ul>
          </div>
          
          <p style="font-size: 14px; color: #6B7280;">
            Payment ID: ${razorpay_payment_id}
          </p>
          
          <p>Start creating your advertisements now and reach thousands of students!</p>
          
          <p style="margin-top: 30px;">
            Best regards,<br>
            Team VibeXpert
          </p>
        </div>
      `
    );
    
    console.log(`🎉 Subscription activated for user ${req.user.username} - Plan: ${planType}`);
    
    res.json({
      success: true,
      message: 'Payment verified and subscription activated',
      subscription: {
        plan: planType,
        endDate: endDate,
        posters: plan.posters,
        videos: plan.videos
      }
    });
    
  } catch (error) {
    console.error('❌ Payment verification error:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

app.get('/api/payment/history', authenticateToken, async (req, res) => {
  try {
    const { data: payments } = await supabase
      .from('payment_orders')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    
    res.json({ success: true, payments: payments || [] });
  } catch (error) {
    console.error('❌ Payment history error:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

app.get('/api/subscription/status', authenticateToken, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('subscription_plan, subscription_start, subscription_end, is_premium, posters_quota, videos_quota')
      .eq('id', req.user.id)
      .single();
    
    if (!user || !user.is_premium) {
      return res.json({ 
        success: true, 
        subscription: null,
        message: 'No active subscription'
      });
    }
    
    const now = new Date();
    const endDate = new Date(user.subscription_end);
    
    if (now > endDate) {
      await supabase
        .from('users')
        .update({
          is_premium: false,
          subscription_plan: null
        })
        .eq('id', req.user.id);
      
      return res.json({ 
        success: true, 
        subscription: null,
        message: 'Subscription expired'
      });
    }
    
    res.json({
      success: true,
      subscription: {
        plan: user.subscription_plan,
        startDate: user.subscription_start,
        endDate: user.subscription_end,
        postersQuota: user.posters_quota,
        videosQuota: user.videos_quota,
        daysRemaining: Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
      }
    });
    
  } catch (error) {
    console.error('❌ Subscription status error:', error);
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ==================== USER & AUTH ENDPOINTS ====================

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
      error: 'Search failed',
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
      .select('id, username, email, registration_number, college, profile_pic, bio, badges, community_joined, created_at')
      .eq('id', userId)
      .single();
    
    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const { count: postCount } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count: likeCount } = await supabase
      .from('profile_likes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { data: isLiked } = await supabase
      .from('profile_likes')
      .select('id')
      .eq('user_id', userId)
      .eq('liker_id', req.user.id)
      .maybeSingle();
    
    res.json({ 
      success: true, 
      user: { 
        ...user, 
        postCount: postCount || 0,
        profileLikes: likeCount || 0,
        isProfileLiked: !!isLiked
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
        isPremium: user.is_premium || false,
        subscriptionPlan: user.subscription_plan || null
      }
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
    
    res.json({ success: true, message: 'Verification code sent' });
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
    
    const newBadges = [...(req.user.badges || []), 'verified_student'];
    
    await supabase
      .from('users')
      .update({
        college: collegeName,
        community_joined: true,
        badges: newBadges
      })
      .eq('id', req.user.id);
    
    await supabase
      .from('codes')
      .delete()
      .eq('id', codeData.id);
    
    res.json({
      success: true,
      message: 'College verification successful',
      college: collegeName,
      badges: newBadges
    });
  } catch (error) {
    console.error('College verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ==================== POSTS ENDPOINTS ====================

app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        users:user_id (
          id,
          username,
          profile_pic,
          college
        )
      `)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    
    const postsWithCounts = await Promise.all(
      (posts || []).map(async (post) => {
        const { count: likeCount } = await supabase
          .from('post_likes')
          .select('id', { count: 'exact', head: true })
          .eq('post_id', post.id);
        
        const { count: commentCount } = await supabase
          .from('post_comments')
          .select('id', { count: 'exact', head: true })
          .eq('post_id', post.id);
        
        const { count: shareCount } = await supabase
          .from('post_shares')
          .select('id', { count: 'exact', head: true })
          .eq('post_id', post.id);
        
        const { data: isLiked } = await supabase
          .from('post_likes')
          .select('id')
          .eq('post_id', post.id)
          .eq('user_id', req.user.id)
          .maybeSingle();
        
        return {
          ...post,
          like_count: likeCount || 0,
          comment_count: commentCount || 0,
          share_count: shareCount || 0,
          is_liked: !!isLiked
        };
      })
    );
    
    res.json({ success: true, posts: postsWithCounts });
  } catch (error) {
    console.error('❌ Load posts error:', error);
    res.status(500).json({ error: 'Failed to load posts' });
  }
});

app.get('/api/posts/community', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.json({ 
        success: false, 
        needsJoinCommunity: true,
        message: 'Join a college community first' 
      });
    }
    
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        users:user_id (
          id,
          username,
          profile_pic,
          college
        )
      `)
      .eq('posted_to', 'community')
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    
    const communityPosts = (posts || []).filter(
      post => post.users?.college === req.user.college
    );
    
    const postsWithCounts = await Promise.all(
      communityPosts.map(async (post) => {
        const { count: likeCount } = await supabase
          .from('post_likes')
          .select('id', { count: 'exact', head: true })
          .eq('post_id', post.id);
        
        const { count: commentCount } = await supabase
          .from('post_comments')
          .select('id', { count: 'exact', head: true })
          .eq('post_id', post.id);
        
        const { data: isLiked } = await supabase
          .from('post_likes')
          .select('id')
          .eq('post_id', post.id)
          .eq('user_id', req.user.id)
          .maybeSingle();
        
        return {
          ...post,
          like_count: likeCount || 0,
          comment_count: commentCount || 0,
          is_liked: !!isLiked
        };
      })
    );
    
    res.json({ success: true, posts: postsWithCounts });
  } catch (error) {
    console.error('❌ Community posts error:', error);
    res.status(500).json({ error: 'Failed to load community posts' });
  }
});

app.post('/api/posts', authenticateToken, upload.array('media', 10), async (req, res) => {
  try {
    const { content, postTo, music, stickers } = req.body;
    
    if (!content && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ error: 'Post content or media required' });
    }
    
    if (postTo === 'community' && (!req.user.community_joined || !req.user.college)) {
      return res.status(400).json({ error: 'Join a university community first' });
    }
    
    let mediaUrls = [];
    
    if (req.files && req.files.length > 0) {
      mediaUrls = await Promise.all(
        req.files.map(async (file) => {
          const fileName = `${Date.now()}_${file.originalname}`;
          const { data, error } = await supabase.storage
            .from('posts')
            .upload(fileName, file.buffer, {
              contentType: file.mimetype
            });
          
          if (error) throw error;
          
          const { data: { publicUrl } } = supabase.storage
            .from('posts')
            .getPublicUrl(fileName);
          
          return {
            url: publicUrl,
            type: file.mimetype.startsWith('video/') ? 'video' : 
                  file.mimetype.startsWith('audio/') ? 'audio' : 'image'
          };
        })
      );
    }
    
    const { data: post, error } = await supabase
      .from('posts')
      .insert([{
        user_id: req.user.id,
        content: content || '',
        media: mediaUrls,
        posted_to: postTo || 'profile',
        music: music ? JSON.parse(music) : null,
        stickers: stickers ? JSON.parse(stickers) : []
      }])
      .select()
      .single();
    
    if (error) throw error;
    
    const { count: postCount } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id);
    
    res.json({
      success: true,
      post,
      postCount: postCount || 1,
      message: 'Post created successfully'
    });
  } catch (error) {
    console.error('❌ Create post error:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

app.delete('/api/posts/:postId', authenticateToken, async (req, res) => {
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
    
    await supabase
      .from('posts')
      .delete()
      .eq('id', postId);
    
    res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    console.error('❌ Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

app.post('/api/posts/:postId/like', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    const { data: existingLike } = await supabase
      .from('post_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    
    if (existingLike) {
      await supabase
        .from('post_likes')
        .delete()
        .eq('id', existingLike.id);
      
      const { count: likeCount } = await supabase
        .from('post_likes')
        .select('id', { count: 'exact', head: true })
        .eq('post_id', postId);
      
      return res.json({ success: true, liked: false, likeCount: likeCount || 0 });
    }
    
    await supabase
      .from('post_likes')
      .insert([{
        post_id: postId,
        user_id: req.user.id
      }]);
    
    const { count: likeCount } = await supabase
      .from('post_likes')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId);
    
    res.json({ success: true, liked: true, likeCount: likeCount || 0 });
  } catch (error) {
    console.error('❌ Like post error:', error);
    res.status(500).json({ error: 'Failed to like post' });
  }
});

app.get('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    const { data: comments, error } = await supabase
      .from('post_comments')
      .select(`
        *,
        users:user_id (
          id,
          username,
          profile_pic
        )
      `)
      .eq('post_id', postId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({ success: true, comments: comments || [] });
  } catch (error) {
    console.error('❌ Get comments error:', error);
    res.status(500).json({ error: 'Failed to load comments' });
  }
});

app.post('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content required' });
    }
    
    const { data: comment, error } = await supabase
      .from('post_comments')
      .insert([{
        post_id: postId,
        user_id: req.user.id,
        content: content.trim()
      }])
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, comment });
  } catch (error) {
    console.error('❌ Comment error:', error);
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

app.delete('/api/posts/:postId/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const { commentId } = req.params;
    
    const { data: comment } = await supabase
      .from('post_comments')
      .select('user_id')
      .eq('id', commentId)
      .single();
    
    if (!comment || comment.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await supabase
      .from('post_comments')
      .delete()
      .eq('id', commentId);
    
    res.json({ success: true, message: 'Comment deleted' });
  } catch (error) {
    console.error('❌ Delete comment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

app.post('/api/posts/:postId/share', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    await supabase
      .from('post_shares')
      .insert([{
        post_id: postId,
        user_id: req.user.id
      }]);
    
    const { count: shareCount } = await supabase
      .from('post_shares')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId);
    
    res.json({ success: true, shareCount: shareCount || 0 });
  } catch (error) {
    console.error('❌ Share error:', error);
    res.status(500).json({ error: 'Failed to share post' });
  }
});

// ==================== ENHANCED COMMUNITY CHAT ENDPOINTS ====================

// Get online users count
app.get('/api/community/online-users', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.json({ 
        success: false, 
        needsJoinCommunity: true,
        onlineCount: 0
      });
    }

    // Get active users in last 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const { count } = await supabase
      .from('community_messages')
      .select('sender_id', { count: 'exact', head: true })
      .eq('college_name', req.user.college)
      .gte('created_at', fiveMinutesAgo.toISOString());
    
    res.json({
      success: true,
      onlineCount: count || 1 // At least current user
    });
  } catch (error) {
    console.error('❌ Online users error:', error);
    res.status(500).json({ error: 'Failed to get online users' });
  }
});

// Get chat statistics
app.get('/api/community/stats', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.json({ 
        success: false, 
        needsJoinCommunity: true,
        stats: { totalMessages: 0, activeMembers: 0, todayMessages: 0 }
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Total messages
    const { count: totalMessages } = await supabase
      .from('community_messages')
      .select('id', { count: 'exact', head: true })
      .eq('college_name', req.user.college);
    
    // Today's messages
    const { count: todayMessages } = await supabase
      .from('community_messages')
      .select('id', { count: 'exact', head: true })
      .eq('college_name', req.user.college)
      .gte('created_at', today.toISOString());
    
    // Active members (last 24 hours)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { data: activeUsers } = await supabase
      .from('community_messages')
      .select('sender_id')
      .eq('college_name', req.user.college)
      .gte('created_at', yesterday.toISOString());
    
    const activeMembers = new Set(activeUsers?.map(u => u.sender_id)).size;
    
    res.json({
      success: true,
      stats: {
        totalMessages: totalMessages || 0,
        todayMessages: todayMessages || 0,
        activeMembers: activeMembers || 0
      }
    });
  } catch (error) {
    console.error('❌ Chat stats error:', error);
    res.status(500).json({ error: 'Failed to get chat stats' });
  }
});

// Search messages
app.get('/api/community/search', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.json({ success: true, messages: [] });
    }
    
    if (!req.user.community_joined || !req.user.college) {
      return res.json({ 
        success: false, 
        needsJoinCommunity: true,
        messages: []
      });
    }

    const searchTerm = query.trim();
    
    const { data: messages, error } = await supabase
      .from('community_messages')
      .select(`
        *,
        users:sender_id (
          id,
          username,
          profile_pic
        )
      `)
      .eq('college_name', req.user.college)
      .or(`content.ilike.%${searchTerm}%,users.username.ilike.%${searchTerm}%`)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    
    res.json({
      success: true,
      messages: messages || []
    });
  } catch (error) {
    console.error('❌ Search messages error:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

// Upload media for chat
app.post('/api/community/upload-media', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    if (!req.user.community_joined || !req.user.college) {
      return res.status(400).json({ error: 'Join a college community first' });
    }
    
    const fileName = `chat-media/${req.user.college}/${Date.now()}_${req.file.originalname}`;
    
    const { data, error } = await supabase.storage
      .from('chat-media')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
    
    if (error) throw error;
    
    const { data: { publicUrl } } = supabase.storage
      .from('chat-media')
      .getPublicUrl(fileName);
    
    res.json({
      success: true,
      mediaUrl: publicUrl,
      mediaType: req.file.mimetype,
      fileName: req.file.originalname
    });
  } catch (error) {
    console.error('❌ Media upload error:', error);
    res.status(500).json({ error: 'Failed to upload media' });
  }
});

// Send message with media
app.post('/api/community/messages-with-media', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const { content } = req.body;
    let mediaUrl = null;
    let mediaType = null;
    
    if (req.file) {
      const fileName = `chat-media/${req.user.college}/${Date.now()}_${req.file.originalname}`;
      
      const { data, error } = await supabase.storage
        .from('chat-media')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });
      
      if (error) throw error;
      
      const { data: { publicUrl } } = supabase.storage
        .from('chat-media')
        .getPublicUrl(fileName);
      
      mediaUrl = publicUrl;
      mediaType = req.file.mimetype;
    }
    
    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'Message content or media required' });
    }
    
    if (!req.user.community_joined || !req.user.college) {
      return res.status(400).json({ error: 'Join a college community first' });
    }
    
    const { data: message, error } = await supabase
      .from('community_messages')
      .insert([{
        sender_id: req.user.id,
        college_name: req.user.college,
        content: content || null,
        media_url: mediaUrl,
        media_type: mediaType,
        created_at: new Date().toISOString()
      }])
      .select(`
        *,
        users:sender_id (
          id,
          username,
          profile_pic
        )
      `)
      .single();
    
    if (error) throw error;
    
    console.log('✅ Media message saved:', message.id);
    
    // Broadcast via Socket.IO
    io.to(req.user.college).emit('new_message', message);
    
    res.json({ success: true, message });
    
  } catch (error) {
    console.error('❌ Send media message error:', error);
    res.status(500).json({
      error: 'Failed to send message',
      details: error.message
    });
  }
});

// Delete message (enhanced)
app.delete('/api/community/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    const { data: message } = await supabase
      .from('community_messages')
      .select('sender_id, college_name, media_url')
      .eq('id', messageId)
      .single();
    
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Delete media from storage if exists
    if (message.media_url) {
      try {
        const filePath = message.media_url.split('/chat-media/public/')[1];
        if (filePath) {
          await supabase.storage
            .from('chat-media')
            .remove([filePath]);
        }
      } catch (storageError) {
        console.error('Failed to delete media:', storageError);
      }
    }
    
    // Delete message from database
    await supabase
      .from('community_messages')
      .delete()
      .eq('id', messageId);
    
    // Emit deletion via Socket.IO
    io.to(message.college_name).emit('message_deleted', { id: messageId });
    
    res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('❌ Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Enhanced Socket.IO Chat Events
io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);
  
  // Join college room
  socket.on('join_college', (data) => {
    const { collegeName, username } = data;
    if (collegeName) {
      socket.join(collegeName);
      console.log(`👤 ${username} joined ${collegeName}`);
      
      // Notify others
      socket.to(collegeName).emit('user_joined', {
        username: username,
        message: `${username} joined the chat`
      });
    }
  });
  
  // Handle typing indicators
  socket.on('typing', (data) => {
    const { collegeName, username } = data;
    if (collegeName) {
      socket.to(collegeName).emit('user_typing', { username });
    }
  });
  
  socket.on('stop_typing', (data) => {
    const { collegeName, username } = data;
    if (collegeName) {
      socket.to(collegeName).emit('user_stop_typing', { username });
    }
  });
  
  // Handle message reactions
  socket.on('add_reaction', (data) => {
    const { collegeName, messageId, emoji, username } = data;
    if (collegeName) {
      socket.to(collegeName).emit('reaction_added', {
        messageId,
        emoji,
        username
      });
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`👋 User disconnected: ${socket.id}`);
  });
});

// ==================== COMMUNITY CHAT ENDPOINTS ====================

app.get('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    console.log('📥 GET Messages:', {
      user: req.user.username,
      college: req.user.college
    });

    if (!req.user.community_joined || !req.user.college) {
      return res.json({
        success: false,
        needsJoinCommunity: true,
        messages: []
      });
    }

    const { data: messages, error } = await supabase
      .from('community_messages')
      .select(`
        *,
        users:sender_id (
          id,
          username,
          profile_pic
        )
      `)
      .eq('college_name', req.user.college)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) throw error;

    console.log(`✅ Loaded ${messages?.length || 0} messages`);

    res.json({
      success: true,
      messages: messages || []
    });

  } catch (error) {
    console.error('❌ Get messages error:', error);
    res.status(500).json({
      error: 'Failed to load messages',
      details: error.message
    });
  }
});

app.post('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    const { content } = req.body;

    console.log('📨 POST Message:', {
      user: req.user.username,
      college: req.user.college,
      contentLength: content?.length
    });

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    if (!req.user.community_joined || !req.user.college) {
      return res.status(400).json({ error: 'Join a college community first' });
    }

    const { data: message, error } = await supabase
      .from('community_messages')
      .insert([{
        sender_id: req.user.id,
        college_name: req.user.college,
        content: content.trim()
      }])
      .select(`
        *,
        users:sender_id (
          id,
          username,
          profile_pic
        )
      `)
      .single();

    if (error) {
      console.error('❌ Database error:', error);
      throw error;
    }

    console.log('✅ Message saved:', message.id);

    // Broadcast via Socket.IO
    io.to(req.user.college).emit('new_message', message);

    res.json({ success: true, message });

  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({
      error: 'Failed to send message',
      details: error.message
    });
  }
});

app.delete('/api/community/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    const { data: message } = await supabase
      .from('community_messages')
      .select('sender_id, college_name')
      .eq('id', messageId)
      .single();
    
    if (!message || message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await supabase
      .from('community_messages')
      .delete()
      .eq('id', messageId);
    
    // Emit deletion via Socket.IO
    io.to(message.college_name).emit('message_deleted', { id: messageId });
    
    res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('❌ Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

app.post('/api/community/messages/:messageId/react', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji required' });
    }
    
    const { data: existingReaction } = await supabase
      .from('message_reactions')
      .select('id')
      .eq('message_id', messageId)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .maybeSingle();
    
    if (existingReaction) {
      await supabase
        .from('message_reactions')
        .delete()
        .eq('id', existingReaction.id);
      
      return res.json({ success: true, action: 'removed' });
    }
    
    await supabase
      .from('message_reactions')
      .insert([{
        message_id: messageId,
        user_id: req.user.id,
        emoji
      }]);
    
    res.json({ success: true, action: 'added' });
  } catch (error) {
    console.error('❌ React error:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// ==================== FEEDBACK ENDPOINT ====================

app.post('/api/feedback', authenticateToken, async (req, res) => {
  try {
    const { subject, message } = req.body;
    
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message required' });
    }
    
    await supabase
      .from('feedback')
      .insert([{
        user_id: req.user.id,
        subject,
        message
      }]);
    
    res.json({ success: true, message: 'Feedback submitted' });
  } catch (error) {
    console.error('❌ Feedback error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log('⚡ User connected:', socket.id);
  
  socket.on('join_college', (collegeName) => {
    if (collegeName && typeof collegeName === 'string') {
      Object.keys(socket.rooms).forEach(room => {
        if (room !== socket.id) socket.leave(room);
      });
      socket.join(collegeName);
      socket.data.college = collegeName;
      console.log(`🧑‍🤝‍🧑 User ${socket.id} joined: ${collegeName}`);
      
      // Send online count
      const roomSize = io.sockets.adapter.rooms.get(collegeName)?.size || 0;
      io.to(collegeName).emit('online_count', roomSize);
    }
  });
  
  socket.on('user_online', (userId) => {
    socket.data.userId = userId;
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
      const roomSize = io.sockets.adapter.rooms.get(socket.data.college)?.size || 0;
      io.to(socket.data.college).emit('online_count', roomSize);
    }
  });
});

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

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ==================== SERVER START ====================

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 VibeXperts Backend running on port ${PORT}`);
  console.log(`✅ Mobile-optimized with enhanced timeout handling`);
  console.log(`✅ CORS configured for all devices`);
  console.log(`✅ Image upload support: 20MB max per file, 10 files max`);
  console.log(`✅ Like, Comment, Share functionality enabled`);
  console.log(`✅ Real-time updates via Socket.IO`);
  console.log(`💳 Razorpay payment integration enabled`);
  console.log(`👑 Premium subscription system active`);
});
