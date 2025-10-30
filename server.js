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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

// Enhanced multer configuration for posts
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 11 // 10 images/videos + 1 music file
  },
  fileFilter: (req, file, cb) => {
    const imageVideoTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi/;
    const audioTypes = /mp3|wav|m4a|aac/;
    
    if (file.fieldname === 'media') {
      const isValid = imageVideoTypes.test(file.mimetype);
      if (isValid) return cb(null, true);
      cb(new Error('Only image and video files allowed for media'));
    } else if (file.fieldname === 'music') {
      const isValid = audioTypes.test(file.mimetype);
      if (isValid) return cb(null, true);
      cb(new Error('Only audio files allowed for music'));
    } else {
      cb(null, true);
    }
  }
});

const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: user, error } = await supabase.from('users').select('*').eq('id', decoded.userId).single();
    if (error || !user) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, registrationNumber } = req.body;
    if (!username || !email || !password || !registrationNumber) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    
    const { data: existingUser } = await supabase.from('users').select('email, registration_number').or(`email.eq.${email},registration_number.eq.${registrationNumber}`).maybeSingle();
    if (existingUser) {
      if (existingUser.email === email) return res.status(400).json({ error: 'Email already registered' });
      if (existingUser.registration_number === registrationNumber) return res.status(400).json({ error: 'Registration number already registered' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const { data: newUser, error } = await supabase.from('users').insert([{ 
      username, 
      email, 
      password_hash: passwordHash,
      registration_number: registrationNumber 
    }]).select().single();
    
    if (error) throw new Error('Failed to create account');
    
    sendEmail(email, '🎉 Welcome to VibeXpert!', `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;"><h1 style="color: #4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1><p style="font-size: 16px; color: #374151;">Congratulations on creating your account!</p><p style="font-size: 16px; color: #374151;">Ready to vibe? Let's go! 🚀</p></div>`).catch(err => console.error('Email send failed:', err));
    
    res.status(201).json({ success: true, message: 'Account created successfully! Please log in.', userId: newUser.id });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    if (error || !user) return res.status(401).json({ error: 'Invalid email or password' });
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { 
      id: user.id, 
      username: user.username, 
      email: user.email, 
      college: user.college, 
      communityJoined: user.community_joined, 
      profilePic: user.profile_pic,
      registrationNumber: user.registration_number,
      badges: user.badges || []
    } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const { data: user, error } = await supabase.from('users').select('id, username, email').eq('email', email).maybeSingle();
    if (error || !user) return res.json({ success: true, message: 'If this email exists, you will receive a reset code.' });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    console.log(`🔑 Reset code for ${email}: ${code}`);
    const { error: codeError } = await supabase.from('codes').insert([{ user_id: user.id, code, type: 'reset', expires_at: expiresAt.toISOString() }]);
    if (codeError) throw new Error('Failed to generate reset code');
    sendEmail(email, '🔐 Password Reset Code - VibeXpert', `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;"><h1 style="color: #4F46E5;">Password Reset Request</h1><p>Hi ${user.username},</p><div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;"><h2 style="color: #1F2937; font-size: 32px; letter-spacing: 4px; margin: 0;">${code}</h2></div><p style="font-size: 14px; color: #6B7280;">This code expires in 15 minutes.</p></div>`).catch(err => console.error('Email failed:', err));
    res.json({ success: true, message: 'Reset code sent to your email' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send reset code' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
    const { data: user } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (!user) return res.status(400).json({ error: 'Invalid email' });
    const { data: codeData } = await supabase.from('codes').select('*').eq('user_id', user.id).eq('code', code).eq('type', 'reset').gte('expires_at', new Date().toISOString()).maybeSingle();
    if (!codeData) return res.status(400).json({ error: 'Invalid or expired code' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: passwordHash }).eq('id', user.id);
    await supabase.from('codes').delete().eq('id', codeData.id);
    res.json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

app.post('/api/college/request-verification', authenticateToken, async (req, res) => {
  try {
    const { collegeName, collegeEmail } = req.body;
    if (!collegeName || !collegeEmail) return res.status(400).json({ error: 'College name and email required' });
    if (req.user.college) return res.status(400).json({ error: 'You are already connected to a college community' });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    console.log(`🎓 College verification code for ${req.user.email}: ${code}`);
    const { error: codeError } = await supabase.from('codes').insert([{ user_id: req.user.id, code, type: 'college', meta: { collegeName, collegeEmail }, expires_at: expiresAt.toISOString() }]);
    if (codeError) throw new Error('Failed to generate verification code');
    sendEmail(collegeEmail, `🎓 College Verification Code - VibeXpert`, `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;"><h1 style="color: #4F46E5;">College Verification</h1><p>Hi ${req.user.username},</p><p>Here's your verification code to connect to <strong>${collegeName}</strong>:</p><div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;"><h2 style="color: #1F2937; font-size: 32px; letter-spacing: 4px; margin: 0;">${code}</h2></div><p style="font-size: 14px; color: #6B7280;">This code expires in 15 minutes.</p></div>`).catch(err => console.error('Email failed:', err));
    res.json({ success: true, message: 'Verification code sent to your college email' });
  } catch (error) {
    console.error('College verification request error:', error);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/college/verify', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code required' });
    const { data: codeData } = await supabase.from('codes').select('*').eq('user_id', req.user.id).eq('code', code).eq('type', 'college').gte('expires_at', new Date().toISOString()).maybeSingle();
    if (!codeData) return res.status(400).json({ error: 'Invalid or expired code' });
    const { collegeName } = codeData.meta;
    const currentBadges = req.user.badges || [];
    if (!currentBadges.includes('🎓 Community Member')) {
      currentBadges.push('🎓 Community Member');
    }
    await supabase.from('users').update({ college: collegeName, community_joined: true, badges: currentBadges }).eq('id', req.user.id);
    await supabase.from('codes').delete().eq('id', codeData.id);
    res.json({ success: true, message: `Successfully connected to ${collegeName}!`, college: collegeName, badges: currentBadges });
  } catch (error) {
    console.error('College verification error:', error);
    res.status(500).json({ error: 'College verification failed' });
  }
});

// ENHANCED POST CREATION WITH MUSIC SUPPORT
app.post('/api/posts', authenticateToken, upload.fields([
  { name: 'media', maxCount: 10 },
  { name: 'music', maxCount: 1 }
]), async (req, res) => {
  try {
    const { content, postTo = 'profile', musicTitle, musicArtist } = req.body;
    const mediaFiles = req.files?.media || [];
    const musicFiles = req.files?.music || [];
    
    if (!content && mediaFiles.length === 0) {
      return res.status(400).json({ error: 'Post must have content or media' });
    }
    
    if (!['profile', 'community'].includes(postTo)) {
      return res.status(400).json({ error: 'Invalid post destination' });
    }
    
    // Upload media files
    const mediaUrls = [];
    for (const file of mediaFiles) {
      const fileExt = file.originalname.split('.').pop();
      const fileName = `${req.user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('posts-media')
        .upload(fileName, file.buffer, { 
          contentType: file.mimetype, 
          cacheControl: '3600' 
        });
      
      if (uploadError) throw new Error('Failed to upload media');
      
      const { data: urlData } = supabase.storage.from('posts-media').getPublicUrl(fileName);
      mediaUrls.push({ 
        url: urlData.publicUrl, 
        type: file.mimetype.startsWith('image') ? 'image' : 'video' 
      });
    }
    
    // Upload music file if provided
    let musicUrl = null;
    if (musicFiles.length > 0) {
      const musicFile = musicFiles[0];
      const fileExt = musicFile.originalname.split('.').pop();
      const fileName = `${req.user.id}/music/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('posts-media')
        .upload(fileName, musicFile.buffer, { 
          contentType: musicFile.mimetype, 
          cacheControl: '3600' 
        });
      
      if (uploadError) throw new Error('Failed to upload music');
      
      const { data: urlData } = supabase.storage.from('posts-media').getPublicUrl(fileName);
      musicUrl = urlData.publicUrl;
    }
    
    // Create post
    const postData = { 
      user_id: req.user.id, 
      content: content || '', 
      media: mediaUrls, 
      college: req.user.college, 
      posted_to: postTo
    };
    
    if (musicTitle) {
      postData.music_title = musicTitle;
      postData.music_artist = musicArtist || 'Unknown Artist';
      if (musicUrl) {
        postData.music_url = musicUrl;
      }
    }
    
    const { data: newPost, error: postError } = await supabase
      .from('posts')
      .insert([postData])
      .select(`*, users (id, username, profile_pic, college, registration_number)`)
      .single();
    
    if (postError) throw new Error('Failed to create post');
    
    // Award badges
    const currentBadges = req.user.badges || [];
    const { data: userPosts } = await supabase.from('posts').select('id').eq('user_id', req.user.id);
    const postCount = userPosts?.length || 0;
    
    if (postCount === 1 && !currentBadges.includes('🎨 First Post')) {
      currentBadges.push('🎨 First Post');
      await supabase.from('users').update({ badges: currentBadges }).eq('id', req.user.id);
    } else if (postCount === 10 && !currentBadges.includes('⭐ Content Creator')) {
      currentBadges.push('⭐ Content Creator');
      await supabase.from('users').update({ badges: currentBadges }).eq('id', req.user.id);
    }
    
    io.emit('new_post', newPost);
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

// OPTIMIZED GET POSTS WITH PAGINATION
app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0, type = 'all' } = req.query;
    let query = supabase
      .from('posts')
      .select(`*, users (id, username, profile_pic, college, registration_number)`, { count: 'exact' })
      .order('created_at', { ascending: false });
    
    if (type === 'my') {
      query = query.eq('user_id', req.user.id);
    } else if (type === 'community' && req.user.community_joined && req.user.college) {
      query = query.eq('college', req.user.college).eq('posted_to', 'community');
    } else if (type === 'profile') {
      query = query.eq('user_id', req.user.id).eq('posted_to', 'profile');
    }
    
    const { data: posts, error, count } = await query.range(
      parseInt(offset), 
      parseInt(offset) + parseInt(limit) - 1
    );
    
    if (error) throw new Error('Failed to fetch posts');
    
    res.json({ 
      success: true, 
      posts: posts || [], 
      total: count,
      hasMore: count > parseInt(offset) + parseInt(limit)
    });
  } catch (error) {
    console.error('Get posts error:', error);
    res.json({ success: true, posts: [], total: 0, hasMore: false });
  }
});

app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: post } = await supabase.from('posts').select('user_id, media, music_url').eq('id', id).single();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    
    // Delete media files
    if (post.media && post.media.length > 0) {
      for (const media of post.media) {
        const urlParts = media.url.split('/');
        const fileName = `${req.user.id}/${urlParts[urlParts.length - 1]}`;
        await supabase.storage.from('posts-media').remove([fileName]);
      }
    }
    
    // Delete music file
    if (post.music_url) {
      const urlParts = post.music_url.split('/');
      const fileName = `${req.user.id}/music/${urlParts[urlParts.length - 1]}`;
      await supabase.storage.from('posts-media').remove([fileName]);
    }
    
    await supabase.from('posts').delete().eq('id', id);
    res.json({ success: true, message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// Keep all other existing endpoints from original server.js
// (community messages, reactions, views, profile, search, feedback, etc.)

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '3.1' });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'VibeXpert API v3.1 - Enhanced Post Features', 
    features: [
      'Auth', 
      'College Verification', 
      'Enhanced Posts with Music', 
      'Advanced Image Editor',
      'Media Upload (10 files)',
      'Music Library Integration',
      'Community Chat',
      'User Search',
      'Profile Management',
      'Badge System'
    ] 
  });
});

let onlineUsers = {};
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  
  socket.on('join_college', (college) => {
    if (college) {
      socket.join(college);
      console.log(`User ${socket.id} joined college: ${college}`);
    }
  });
  
  socket.on('user_online', (userId) => {
    onlineUsers[socket.id] = userId;
    io.emit('online_count', Object.keys(onlineUsers).length);
  });
  
  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    console.log('❌ User disconnected:', socket.id, '| Online:', Object.keys(onlineUsers).length);
    io.emit('online_count', Object.keys(onlineUsers).length);
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Email: Brevo API`);
  console.log(`🗄️ Database: Supabase`);
  console.log(`✅ Enhanced post features enabled`);
});
