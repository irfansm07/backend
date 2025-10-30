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
const fs = require('fs');

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
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Enhanced available songs with actual working URLs
const availableSongs = [
  { 
    id: 1, 
    name: 'Chill Vibes', 
    artist: 'LoFi Beats',
    duration: '2:30',
    emoji: '🎧',
    url: 'https://assets.mixkit.co/music/preview/mixkit-chill-vibes-239.mp3'
  },
  { 
    id: 2, 
    name: 'Upbeat Energy', 
    artist: 'Electronic Pop',
    duration: '3:15',
    emoji: '⚡',
    url: 'https://assets.mixkit.co/music/preview/mixkit-upbeat-energy-225.mp3'
  },
  { 
    id: 3, 
    name: 'Dreamy Piano', 
    artist: 'Classical',
    duration: '2:45',
    emoji: '🎹',
    url: 'https://assets.mixkit.co/music/preview/mixkit-dreamy-piano-1171.mp3'
  },
  { 
    id: 4, 
    name: 'Summer Vibes', 
    artist: 'Tropical',
    duration: '3:30',
    emoji: '🏖️',
    url: 'https://assets.mixkit.co/music/preview/mixkit-summer-vibes-129.mp3'
  },
  { 
    id: 5, 
    name: 'Happy Day', 
    artist: 'Pop Rock',
    duration: '2:50',
    emoji: '😊',
    url: 'https://assets.mixkit.co/music/preview/mixkit-happy-day-583.mp3'
  },
  { 
    id: 6, 
    name: 'Relaxing Guitar', 
    artist: 'Acoustic',
    duration: '3:10',
    emoji: '🎸',
    url: 'https://assets.mixkit.co/music/preview/mixkit-relaxing-guitar-243.mp3'
  }
];

// Enhanced available stickers with emoji support
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

// Available image filters
const availableFilters = [
  { id: 'normal', name: 'Original', emoji: '🔄' },
  { id: 'vintage', name: 'Vintage', emoji: '🟤' },
  { id: 'clarendon', name: 'Clarendon', emoji: '🌈' },
  { id: 'moon', name: 'Moon', emoji: '🌙' },
  { id: 'lark', name: 'Lark', emoji: '🐦' },
  { id: 'reyes', name: 'Reyes', emoji: '📸' }
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
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
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

// Get available songs, stickers, and filters - ENHANCED
app.get('/api/post-assets', (req, res) => {
  res.json({
    success: true,
    songs: availableSongs,
    stickers: availableStickers,
    filters: availableFilters
  });
});

// Get music library
app.get('/api/music-library', (req, res) => {
  res.json({
    success: true,
    music: availableSongs
  });
});

// Get sticker library
app.get('/api/sticker-library', (req, res) => {
  res.json({
    success: true,
    stickers: availableStickers
  });
});

// Get available filters
app.get('/api/filters', (req, res) => {
  res.json({
    success: true,
    filters: availableFilters
  });
});

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
      badges: user.badges || [],
      bio: user.bio || ''
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

// FIXED POST CREATION WITH BETTER VALIDATION AND ERROR HANDLING
app.post('/api/posts', authenticateToken, upload.array('media', 10), async (req, res) => {
  try {
    const { content = '', postTo = 'profile', music, stickers = '[]', imageFilter = 'normal' } = req.body;
    const files = req.files;
    
    console.log('📝 Creating post with data:', {
      hasContent: !!content && content.trim().length > 0,
      postTo,
      hasMusic: !!music && music !== 'null',
      hasStickers: stickers !== '[]' && stickers !== 'null',
      filesCount: files?.length || 0,
      imageFilter
    });

    // FIXED VALIDATION - Allow post with ANY content type
    const hasContent = content && content.trim().length > 0;
    const hasFiles = files && files.length > 0;
    const hasMusic = music && music !== 'null' && music !== 'undefined';
    const hasStickers = stickers && stickers !== '[]' && stickers !== 'null';
    
    if (!hasContent && !hasFiles && !hasMusic && !hasStickers) {
      console.log('❌ Validation failed: No content provided');
      return res.status(400).json({ 
        error: 'Post must have at least one of: text content, media files, music, or stickers',
        debug: { hasContent, hasFiles, hasMusic, hasStickers }
      });
    }
    
    // Validate post destination
    if (!['profile', 'community'].includes(postTo)) {
      console.log('❌ Invalid post destination:', postTo);
      return res.status(400).json({ error: 'Invalid post destination. Must be "profile" or "community"' });
    }
    
    // Parse and validate music
    let parsedMusic = null;
    if (hasMusic) {
      try {
        parsedMusic = JSON.parse(music);
        console.log('🎵 Parsed music:', parsedMusic);
        
        // Validate music structure
        if (!parsedMusic || !parsedMusic.id || !parsedMusic.name || !parsedMusic.url) {
          console.warn('⚠️ Invalid music format - missing required fields');
          parsedMusic = null;
        } else {
          // Verify music exists in library
          const validMusic = availableSongs.find(song => song.id === parseInt(parsedMusic.id));
          if (!validMusic) {
            console.warn('⚠️ Music not found in available songs');
            parsedMusic = null;
          } else {
            console.log('✅ Valid music selected:', validMusic.name);
          }
        }
      } catch (e) {
        console.warn('⚠️ Invalid music JSON format:', e.message);
        parsedMusic = null;
      }
    }
    
    // Parse and validate stickers
    let parsedStickers = [];
    if (hasStickers) {
      try {
        parsedStickers = JSON.parse(stickers);
        console.log('🎨 Parsed stickers:', parsedStickers);
        
        // Validate stickers array
        if (!Array.isArray(parsedStickers)) {
          console.warn('⚠️ Invalid stickers format - not an array');
          parsedStickers = [];
        } else {
          // Limit to 5 stickers and validate each
          parsedStickers = parsedStickers.slice(0, 5).filter(sticker => {
            if (typeof sticker === 'string' && sticker.length > 0) {
              return true;
            } else if (typeof sticker === 'object' && sticker.emoji) {
              return true;
            }
            return false;
          });
          console.log(`✅ Valid stickers: ${parsedStickers.length}`);
        }
      } catch (e) {
        console.warn('⚠️ Invalid stickers JSON format:', e.message);
        parsedStickers = [];
      }
    }
    
    // Validate image filter
    const validFilter = availableFilters.find(f => f.id === imageFilter) ? imageFilter : 'normal';
    if (validFilter !== imageFilter) {
      console.warn(`⚠️ Invalid filter "${imageFilter}", using "normal"`);
    }

    // Process media files
    const mediaUrls = [];
    if (hasFiles) {
      console.log(`📁 Processing ${files.length} files...`);
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const fileExt = file.originalname.split('.').pop();
          const fileName = `${req.user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
          
          console.log(`📤 Uploading file ${i + 1}/${files.length}: ${fileName}`);
          
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('posts-media')
            .upload(fileName, file.buffer, { 
              contentType: file.mimetype, 
              cacheControl: '3600',
              upsert: false
            });
            
          if (uploadError) {
            console.error(`❌ Upload error for file ${i + 1}:`, uploadError);
            // Continue with other files
            continue;
          }
          
          const { data: urlData } = supabase.storage.from('posts-media').getPublicUrl(fileName);
          
          const mediaType = file.mimetype.startsWith('image') ? 'image' : 
                           file.mimetype.startsWith('video') ? 'video' : 'audio';
                           
          mediaUrls.push({ 
            url: urlData.publicUrl, 
            type: mediaType,
            filter: mediaType === 'image' ? validFilter : null
          });
          
          console.log(`✅ File ${i + 1} uploaded successfully`);
        } catch (fileError) {
          console.error(`❌ File ${i + 1} processing error:`, fileError);
          // Continue with other files
        }
      }
      
      console.log(`📊 Successfully processed ${mediaUrls.length}/${files.length} files`);
    }
    
    // Create post data
    const postData = { 
      user_id: req.user.id, 
      content: content?.trim() || '', 
      media: mediaUrls, 
      college: req.user.college || null, 
      posted_to: postTo,
      music: parsedMusic,
      stickers: parsedStickers,
      image_filter: validFilter
    };
    
    console.log('💾 Saving post to database:', {
      userId: req.user.id,
      contentLength: postData.content.length,
      mediaCount: postData.media.length,
      hasMusic: !!postData.music,
      stickersCount: postData.stickers.length,
      postedTo: postData.posted_to,
      college: postData.college
    });

    const { data: newPost, error: postError } = await supabase
      .from('posts')
      .insert([postData])
      .select(`*, users (id, username, profile_pic, college, registration_number)`)
      .single();
    
    if (postError) {
      console.error('❌ Database error:', postError);
      throw new Error(`Failed to create post: ${postError.message}`);
    }
    
    console.log('✅ Post created successfully with ID:', newPost.id);

    // Handle badges
    const currentBadges = req.user.badges || [];
    const { data: userPosts } = await supabase.from('posts').select('id').eq('user_id', req.user.id);
    const postCount = userPosts?.length || 0;
    
    let badgeUpdated = false;
    let newBadges = [];
    
    // First post badge
    if (postCount === 1 && !currentBadges.includes('🎨 First Post')) {
      currentBadges.push('🎨 First Post');
      newBadges.push('🎨 First Post');
      badgeUpdated = true;
    }
    
    // Content creator badge
    if (postCount === 10 && !currentBadges.includes('⭐ Content Creator')) {
      currentBadges.push('⭐ Content Creator');
      newBadges.push('⭐ Content Creator');
      badgeUpdated = true;
    }
    
    // Music lover badge
    if (parsedMusic && !currentBadges.includes('🎵 Music Lover')) {
      currentBadges.push('🎵 Music Lover');
      newBadges.push('🎵 Music Lover');
      badgeUpdated = true;
    }
    
    // Creative badge for stickers
    if (parsedStickers.length > 0 && !currentBadges.includes('🎨 Creative')) {
      currentBadges.push('🎨 Creative');
      newBadges.push('🎨 Creative');
      badgeUpdated = true;
    }
    
    // Photo editor badge for filters
    if (validFilter !== 'normal' && !currentBadges.includes('🖼️ Photo Editor')) {
      currentBadges.push('🖼️ Photo Editor');
      newBadges.push('🖼️ Photo Editor');
      badgeUpdated = true;
    }
    
    if (badgeUpdated) {
      await supabase.from('users').update({ badges: currentBadges }).eq('id', req.user.id);
      console.log('🏆 Badges updated:', newBadges.join(', '));
    }
    
    // Emit socket events for new posts
    if (postTo === 'community' && req.user.college) {
      io.to(req.user.college).emit('new_post', newPost);
      console.log('📢 Emitted new post to community:', req.user.college);
    } else {
      io.emit('new_profile_post', { userId: req.user.id, post: newPost });
      console.log('📢 Emitted new profile post for user:', req.user.id);
    }
    
    const successMessage = postTo === 'community' 
      ? '✅ Your post has been shared to the community feed!' 
      : '✅ Your post has been added to your profile!';
    
    console.log('🎉 Post creation completed successfully!');
    
    res.status(201).json({ 
      success: true, 
      post: newPost, 
      message: successMessage, 
      badges: currentBadges,
      badgeUpdated: badgeUpdated,
      newBadges: newBadges
    });
    
  } catch (error) {
    console.error('❌ Create post error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to create post',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Enhanced get posts with filtering - FIXED
app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0, type = 'all', destination } = req.query;
    
    console.log('📨 Fetching posts:', { type, destination, limit, offset, userId: req.user.id });
    
    let query = supabase
      .from('posts')
      .select(`*, users (id, username, profile_pic, college, registration_number)`)
      .order('created_at', { ascending: false });
    
    if (type === 'my') {
      query = query.eq('user_id', req.user.id);
      console.log('🔍 Fetching user posts for:', req.user.id);
    } else if (type === 'community' && req.user.community_joined && req.user.college) {
      query = query.eq('college', req.user.college).eq('posted_to', 'community');
      console.log('🔍 Fetching community posts for:', req.user.college);
    } else if (type === 'profile') {
      query = query.eq('user_id', req.user.id).eq('posted_to', 'profile');
      console.log('🔍 Fetching profile posts for:', req.user.id);
    }
    
    // Filter by destination if specified
    if (destination && ['profile', 'community'].includes(destination)) {
      query = query.eq('posted_to', destination);
      console.log('🔍 Filtering by destination:', destination);
    }
    
    const { data: posts, error } = await query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (error) {
      console.error('❌ Database error:', error);
      throw new Error('Failed to fetch posts');
    }
    
    // Ensure music, stickers, and filters are properly formatted
    const formattedPosts = (posts || []).map(post => ({
      ...post,
      music: post.music || null,
      stickers: post.stickers || [],
      image_filter: post.image_filter || 'normal'
    }));
    
    console.log(`✅ Fetched ${formattedPosts.length} posts`);
    
    res.json({ success: true, posts: formattedPosts });
  } catch (error) {
    console.error('❌ Get posts error:', error);
    res.json({ success: true, posts: [] });
  }
});

app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('🗑️ Deleting post:', id);
    
    const { data: post } = await supabase.from('posts').select('user_id, media, posted_to, college').eq('id', id).single();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    
    // Delete media files if they exist
    if (post.media && post.media.length > 0) {
      for (const media of post.media) {
        try {
          const urlParts = media.url.split('/');
          // Supabase public URL structure might need adjustment here, focusing on the last segment for now
          const fileNameWithUUID = urlParts.pop();
          const filePath = `${req.user.id}/${fileNameWithUUID}`; // Assuming bucket structure is posts-media/user_id/filename
          await supabase.storage.from('posts-media').remove([filePath]);
          console.log('✅ Deleted media file:', filePath);
        } catch (mediaError) {
          console.warn('⚠️ Could not delete media file:', mediaError.message);
        }
      }
    }
    
    await supabase.from('posts').delete().eq('id', id);
    
    // Emit socket event for post deletion
    if (post.posted_to === 'community' && post.college) {
      io.to(post.college).emit('post_deleted', { id });
    } else {
      io.emit('profile_post_deleted', { userId: req.user.id, postId: id });
    }
    
    console.log('✅ Post deleted successfully');
    res.json({ success: true, message: 'Post deleted successfully' });
  } catch (error) {
    console.error('❌ Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// Enhanced post reactions
app.post('/api/posts/:id/react', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    
    if (!emoji) return res.status(400).json({ error: 'Emoji required' });
    
    const { data: existing } = await supabase.from('post_reactions')
      .select('*')
      .eq('post_id', id)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .maybeSingle();
    
    if (existing) {
      await supabase.from('post_reactions').delete().eq('id', existing.id);
      // Emit action to remove reaction
      const { data: post } = await supabase.from('posts').select('posted_to, college, user_id').eq('id', id).single();
      if (post) {
        io.to(post.college || 'global').emit('post_reaction_updated', { postId: id, userId: req.user.id, emoji, action: 'removed' });
      }
      return res.json({ success: true, action: 'removed' });
    }
    
    const { data: reaction, error } = await supabase.from('post_reactions').insert([{
      post_id: id,
      user_id: req.user.id,
      emoji: emoji
    }]).select().single();
    
    if (error) throw error;
    
    // Emit socket event for post reaction
    const { data: post } = await supabase.from('posts').select('posted_to, college, user_id').eq('id', id).single();
    if (post) {
      io.to(post.college || 'global').emit('post_reaction_updated', { postId: id, userId: req.user.id, emoji, action: 'added' });
    }
    
    res.json({ success: true, action: 'added', reaction });
  } catch (error) {
    console.error('❌ React to post error:', error);
    res.status(500).json({ error: 'Failed to react' });
  }
});

app.get('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    const { limit = 50 } = req.query;
    const { data: messages, error } = await supabase.from('messages')
      .select(`*, users (id, username, profile_pic), message_reactions (*)`)
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
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required' });
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    const { data: newMessage, error } = await supabase.from('messages').insert([{ 
      sender_id: req.user.id, 
      content: content.trim(),
      college: req.user.college 
    }]).select(`*, users (id, username, profile_pic)`).single();
    
    if (error) throw error;
    
    io.to(req.user.college).emit('new_message', newMessage);
    res.json({ success: true, message: newMessage });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// --- PATCH /api/community/messages/:id (Edit Message) - CONTINUED ---
app.patch('/api/community/messages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }
    
    const { data: message } = await supabase.from('messages').select('timestamp, college, sender_id').eq('id', id).single();
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized to edit this message' });
    
    const messageTime = new Date(message.timestamp);
    const now = new Date();
    const diffMinutes = (now - messageTime) / 1000 / 60;
    
    if (diffMinutes > 2) {
      return res.status(403).json({ error: 'Can only edit message within 2 minutes of sending' });
    }
    
    const { data: updatedMessage, error: updateError } = await supabase.from('messages')
      .update({ content: content.trim(), is_edited: true })
      .eq('id', id)
      .select(`*, users (id, username, profile_pic)`)
      .single();
    
    if (updateError) throw updateError;
    
    // Notify the community about the edit
    io.to(message.college).emit('message_updated', updatedMessage);
    res.json({ success: true, message: updatedMessage });
  } catch (error) {
    console.error('❌ Edit message error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// --- DELETE /api/community/messages/:id (Delete Message) ---
app.delete('/api/community/messages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: message } = await supabase.from('messages').select('college, sender_id').eq('id', id).maybeSingle();
    if (!message) return res.status(404).json({ error: 'Message not found' });
    // Only the sender can delete
    if (message.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized to delete this message' });
    
    // Delete the message and all its reactions
    await supabase.from('message_reactions').delete().eq('message_id', id);
    await supabase.from('messages').delete().eq('id', id);
    
    // Notify the community about the deletion
    io.to(message.college).emit('message_deleted', { id, college: message.college });
    res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('❌ Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// --- POST /api/community/messages/:id/react (React to Message) ---
app.post('/api/community/messages/:id/react', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji required' });
    
    const { data: message } = await supabase.from('messages').select('college').eq('id', id).maybeSingle();
    if (!message) return res.status(404).json({ error: 'Message not found' });
    
    const { data: existing } = await supabase.from('message_reactions')
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
      const { data: newReaction, error } = await supabase.from('message_reactions').insert([{
        message_id: id,
        user_id: req.user.id,
        emoji: emoji
      }]).select().single();
      if (error) throw error;
      reaction = newReaction;
    }
    
    // Notify the community chat about the reaction change
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


// ==========================================================
//                     SOCKET.IO IMPLEMENTATION
// ==========================================================

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log('⚡ User connected:', socket.id);
  
  // Client sends this event after authentication to join their college room
  socket.on('join_community', (collegeName) => {
    if (collegeName && typeof collegeName === 'string') {
      // Leave any previous rooms to prevent cross-community chat mixing
      Object.keys(socket.rooms).forEach(room => {
        if (room !== socket.id) socket.leave(room);
      });
      
      socket.join(collegeName);
      socket.data.college = collegeName;
      console.log(`🧑‍🤝‍🧑 User ${socket.id} joined community: ${collegeName}`);
      
      // Optionally emit a welcome message to the user only
      socket.emit('community_joined', collegeName);
    }
  });

  // Handle real-time typing indicators
  socket.on('typing', (data) => {
    // Data: { collegeName, username }
    if (data.collegeName && data.username) {
      socket.to(data.collegeName).emit('user_typing', { username: data.username });
    }
  });

  // Handle stop typing
  socket.on('stop_typing', (data) => {
    // Data: { collegeName, username }
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

// --- Start Server ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 VibeXpert Backend running on port ${PORT}`);
});
