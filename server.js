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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Enhanced email service with better error handling
const sendEmail = async (to, subject, html) => {
  try {
    console.log(`📧 Sending email to: ${to}`);
    
    // If Brevo API key is not available, log and return success for development
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
    // Don't fail the request if email fails
    return true;
  }
};

// Enhanced file upload configuration
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

// Enhanced authentication middleware
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

// Enhanced registration with better validation
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, registrationNumber } = req.body;
    
    // Validate required fields
    if (!username || !email || !password || !registrationNumber) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check for existing user
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('email, registration_number')
      .or(`email.eq.${email},registration_number.eq.${registrationNumber}`)
      .maybeSingle();

    if (checkError) {
      console.error('Check existing user error:', checkError);
    }

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      if (existingUser.registration_number === registrationNumber) {
        return res.status(400).json({ error: 'Registration number already registered' });
      }
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, 10);
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert([{ 
        username, 
        email, 
        password_hash: passwordHash,
        registration_number: registrationNumber,
        badges: [] // Initialize empty badges array
      }])
      .select()
      .single();

    if (createError) {
      console.error('Create user error:', createError);
      throw new Error('Failed to create account');
    }

    // Send welcome email (non-blocking)
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

// Enhanced login
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
        bio: user.bio || ''
      } 
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Password reset flow
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

    // Always return success to prevent email enumeration
    if (error || !user) {
      return res.json({ 
        success: true, 
        message: 'If this email exists, you will receive a reset code.' 
      });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    console.log(`🔑 Reset code for ${email}: ${code}`);

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

// Enhanced college verification with protection
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
    
    // Award community member badge if not already earned
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

// Enhanced posts with destination selection
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
    
    // Upload media files if any
    if (files && files.length > 0) {
      for (const file of files) {
        const fileExt = file.originalname.split('.').pop();
        const fileName = `${req.user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        
        const { data: uploadData, error: uploadError } = await supabase
          .storage
          .from('posts-media')
          .upload(fileName, file.buffer, { 
            contentType: file.mimetype, 
            cacheControl: '3600' 
          });
          
        if (uploadError) {
          throw new Error('Failed to upload media');
        }
        
        const { data: urlData } = supabase
          .storage
          .from('posts-media')
          .getPublicUrl(fileName);
          
        mediaUrls.push({ 
          url: urlData.publicUrl, 
          type: file.mimetype.startsWith('image') ? 'image' : 'video' 
        });
      }
    }
    
    // Create post
    const { data: newPost, error: postError } = await supabase
      .from('posts')
      .insert([{ 
        user_id: req.user.id, 
        content: content || '', 
        media: mediaUrls, 
        college: req.user.college, 
        posted_to: postTo 
      }])
      .select(`*, users (id, username, profile_pic, college, registration_number)`)
      .single();
    
    if (postError) {
      throw new Error('Failed to create post');
    }
    
    // Award badges based on post count
    const currentBadges = req.user.badges || [];
    const { data: userPosts } = await supabase
      .from('posts')
      .select('id')
      .eq('user_id', req.user.id);
      
    const postCount = userPosts?.length || 0;
    
    if (postCount === 1 && !currentBadges.includes('🎨 First Post')) {
      currentBadges.push('🎨 First Post');
      await supabase
        .from('users')
        .update({ badges: currentBadges })
        .eq('id', req.user.id);
    } else if (postCount === 10 && !currentBadges.includes('⭐ Content Creator')) {
      currentBadges.push('⭐ Content Creator');
      await supabase
        .from('users')
        .update({ badges: currentBadges })
        .eq('id', req.user.id);
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

// Enhanced posts retrieval with filtering
app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0, type = 'all' } = req.query;
    let query = supabase
      .from('posts')
      .select(`*, users (id, username, profile_pic, college, registration_number)`)
      .order('created_at', { ascending: false });
    
    if (type === 'my') {
      query = query.eq('user_id', req.user.id);
    } else if (type === 'community' && req.user.community_joined && req.user.college) {
      query = query.eq('college', req.user.college).eq('posted_to', 'community');
    } else if (type === 'profile') {
      query = query.eq('user_id', req.user.id).eq('posted_to', 'profile');
    }
    
    const { data: posts, error } = await query.range(offset, offset + parseInt(limit) - 1);
    
    if (error) {
      throw new Error('Failed to fetch posts');
    }
    
    res.json({ success: true, posts: posts || [] });
    
  } catch (error) {
    console.error('Get posts error:', error);
    res.json({ success: true, posts: [] });
  }
});

app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: post } = await supabase
      .from('posts')
      .select('user_id, media')
      .eq('id', id)
      .single();
      
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    if (post.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Delete associated media files
    if (post.media && post.media.length > 0) {
      for (const media of post.media) {
        const fileName = media.url.split('/').pop();
        await supabase
          .storage
          .from('posts-media')
          .remove([`${req.user.id}/${fileName}`]);
      }
    }
    
    await supabase
      .from('posts')
      .delete()
      .eq('id', id);
      
    res.json({ success: true, message: 'Post deleted successfully' });
    
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// Enhanced community messages with reactions and views
app.get('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    
    const { limit = 50 } = req.query;
    
    const { data: messages, error } = await supabase
      .from('messages')
      .select(`*, users (id, username, profile_pic), message_reactions (*)`)
      .eq('college', req.user.college)
      .order('timestamp', { ascending: false })
      .limit(limit);
      
    if (error) throw error;
    
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
    
    const { data: newMessage, error } = await supabase
      .from('messages')
      .insert([{ 
        sender_id: req.user.id, 
        content: content.trim(),
        college: req.user.college 
      }])
      .select(`*, users (id, username, profile_pic)`)
      .single();
    
    if (error) throw error;
    
    // Emit socket event for real-time messaging
    io.to(req.user.college).emit('new_message', newMessage);
    
    res.json({ success: true, message: newMessage });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Enhanced message editing with time limit
app.patch('/api/community/messages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }
    
    const { data: message } = await supabase
      .from('messages')
      .select('*')
      .eq('id', id)
      .single();
      
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
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
    
    const { data: updated, error } = await supabase
      .from('messages')
      .update({ 
        content: content.trim(), 
        edited: true 
      })
      .eq('id', id)
      .select(`*, users (id, username, profile_pic)`)
      .single();
    
    if (error) throw error;
    
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
    
    const { data: message } = await supabase
      .from('messages')
      .select('sender_id')
      .eq('id', id)
      .single();
      
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await supabase
      .from('messages')
      .delete()
      .eq('id', id);
      
    // Emit socket event for real-time deletion
    io.to(req.user.college).emit('message_deleted', { id });
    
    res.json({ success: true, message: 'Message deleted' });
    
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Message reactions
app.post('/api/community/messages/:id/react', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji required' });
    }
    
    // Check if reaction already exists
    const { data: existing } = await supabase
      .from('message_reactions')
      .select('*')
      .eq('message_id', id)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .maybeSingle();
    
    // If exists, remove it (toggle)
    if (existing) {
      await supabase
        .from('message_reactions')
        .delete()
        .eq('id', existing.id);
        
      return res.json({ success: true, action: 'removed' });
    }
    
    // Add new reaction
    const { data: reaction, error } = await supabase
      .from('message_reactions')
      .insert([{
        message_id: id,
        user_id: req.user.id,
        emoji: emoji
      }])
      .select()
      .single();
    
    if (error) throw error;
    
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

// Message views tracking
app.post('/api/community/messages/:id/view', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if already viewed
    const { data: existing } = await supabase
      .from('message_views')
      .select('*')
      .eq('message_id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    
    if (existing) {
      return res.json({ success: true });
    }
    
    // Record view
    await supabase
      .from('message_views')
      .insert([{
        message_id: id,
        user_id: req.user.id
      }]);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Mark view error:', error);
    res.status(500).json({ error: 'Failed to mark view' });
  }
});

app.get('/api/community/messages/:id/views', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: views, error } = await supabase
      .from('message_views')
      .select('user_id, users (username, profile_pic)', { count: 'exact' })
      .eq('message_id', id);
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      views: views || [], 
      count: views?.length || 0 
    });
    
  } catch (error) {
    console.error('Get views error:', error);
    res.status(500).json({ error: 'Failed to get views' });
  }
});

// Enhanced profile management
app.patch('/api/profile', authenticateToken, upload.single('profilePic'), async (req, res) => {
  try {
    const { username, bio } = req.body;
    const updates = {};
    
    if (username) updates.username = username;
    if (bio !== undefined) updates.bio = bio;
    
    // Handle profile picture upload
    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop();
      const fileName = `${req.user.id}/profile.${fileExt}`;
      
      const { error: uploadError } = await supabase
        .storage
        .from('profile-pics')
        .upload(fileName, req.file.buffer, { 
          contentType: req.file.mimetype, 
          cacheControl: '3600',
          upsert: true 
        });
      
      if (uploadError) {
        throw new Error('Failed to upload profile picture');
      }
      
      const { data: urlData } = supabase
        .storage
        .from('profile-pics')
        .getPublicUrl(fileName);
        
      updates.profile_pic = urlData.publicUrl;
    }
    
    const { data: updated, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, user: updated });
    
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// User search
app.get('/api/search/users', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ 
        error: 'Search query must be at least 2 characters' 
      });
    }
    
    const searchTerm = query.trim().toLowerCase();
    
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, email, college, profile_pic, registration_number')
      .or(`username.ilike.%${searchTerm}%,registration_number.ilike.%${searchTerm}%`)
      .limit(10);
    
    if (error) throw error;
    
    res.json({ success: true, users: users || [] });
    
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Feedback system
app.post('/api/feedback', authenticateToken, async (req, res) => {
  try {
    const { subject, message } = req.body;
    
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message required' });
    }
    
    const { data: feedback, error } = await supabase
      .from('feedback')
      .insert([{
        user_id: req.user.id,
        subject: subject.trim(),
        message: message.trim()
      }])
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      message: 'Feedback submitted successfully!', 
      feedback 
    });
    
  } catch (error) {
    console.error('Feedback error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// Get user profile
app.get('/api/profile/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, college, profile_pic, bio, badges, created_at, registration_number')
      .eq('id', userId)
      .single();
    
    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user's post count
    const { data: posts } = await supabase
      .from('posts')
      .select('id', { count: 'exact' })
      .eq('user_id', userId);
    
    res.json({ 
      success: true, 
      user: {
        ...user,
        postCount: posts?.length || 0
      }
    });
    
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
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
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'VibeXpert API is running!', 
    timestamp: new Date().toISOString() 
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
server.listen(PORT, () => {
  console.log(`🚀 VibeXpert server running on port ${PORT}`);
  console.log(`📧 Email service: ${process.env.BREVO_API_KEY ? 'Enabled' : 'Development mode'}`);
  console.log(`🔐 JWT secret: ${process.env.JWT_SECRET ? 'Set' : 'Not set'}`);
});
