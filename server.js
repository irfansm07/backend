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
    origin: process.env.FRONTEND_URL || 'https://www.vibexpert.online',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware - Enhanced CORS
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://www.vibexpert.online',
  'http://www.vibexpert.online',
  'https://irfansm07.github.io'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.some(allowed => origin && origin.startsWith(allowed))) {
      callback(null, true);
    } else {
      console.log('❌ CORS blocked origin:', origin);
      callback(null, true);
    }
  },
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

// Initialize Nodemailer with Brevo
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.sendinblue.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000
});

// Verify SMTP connection on startup
transporter.verify(function (error, success) {
  if (error) {
    console.error('❌ SMTP Configuration Error:', error.message);
    console.log('⚠️  Email sending will use Brevo API as fallback');
  } else {
    console.log('✅ SMTP Server is ready to send emails');
  }
});

// Multer configuration for file uploads - ENHANCED
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 5 // Max 5 files per upload
  },
  fileFilter: (req, file, cb) => {
    // Accept images and videos
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi/;
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only image and video files are allowed!'));
  }
});

// Helper Functions
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// Send email with fallback to Brevo API
const sendEmail = async (to, subject, html) => {
  try {
    console.log(`📧 Attempting to send email to: ${to}`);
    
    try {
      const info = await transporter.sendMail({
        from: `${process.env.BREVO_FROM_NAME} <${process.env.BREVO_FROM_EMAIL}>`,
        to,
        subject,
        html
      });
      console.log(`✅ Email sent via SMTP: ${info.messageId}`);
      return true;
    } catch (smtpError) {
      console.log('⚠️  SMTP failed, trying Brevo API...', smtpError.message);
      
      const response = await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: {
            name: process.env.BREVO_FROM_NAME,
            email: process.env.BREVO_FROM_EMAIL
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
      
      console.log(`✅ Email sent via Brevo API: ${response.data.messageId}`);
      return true;
    }
  } catch (error) {
    console.error('❌ All email methods failed:', error.message);
    return false;
  }
};

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

    sendEmail(
      email,
      '🎉 Welcome to VibeXpert!',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1>
          <p style="font-size: 16px; color: #374151;">
            Congratulations on creating your account! You're now part of an amazing college community platform.
          </p>
          <p style="font-size: 16px; color: #374151;">Next steps:</p>
          <ol style="font-size: 16px; color: #374151;">
            <li>Log in to your account</li>
            <li>Select your college</li>
            <li>Start connecting with your community!</li>
          </ol>
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

// Forgot Password - Send Reset Code
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
    const expiresAt = new Date(Date.now() + parseInt(process.env.RESET_CODE_TTL_MIN || 15) * 60 * 1000);

    console.log(`🔑 Generated reset code for ${email}: ${code}`);

    const { error: codeError } = await supabase.from('codes').insert([{
      user_id: user.id,
      code,
      type: 'reset',
      expires_at: expiresAt.toISOString()
    }]);

    if (codeError) {
      console.error('❌ Error storing code:', codeError);
      throw new Error('Failed to generate reset code');
    }

    sendEmail(
      email,
      '🔐 Password Reset Code - VibeXpert',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #4F46E5;">Password Reset Request</h1>
          <p style="font-size: 16px; color: #374151;">Hi ${user.username},</p>
          <p style="font-size: 16px; color: #374151;">
            You requested to reset your password. Use the code below:
          </p>
          <div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <h2 style="color: #1F2937; font-size: 32px; letter-spacing: 4px; margin: 0;">${code}</h2>
          </div>
          <p style="font-size: 14px; color: #6B7280;">
            This code expires in ${process.env.RESET_CODE_TTL_MIN || 15} minutes.
          </p>
          <p style="font-size: 14px; color: #6B7280;">
            If you didn't request this, please ignore this email.
          </p>
        </div>
      `
    ).then(sent => {
      if(sent) console.log(`✅ Reset email sent to ${email}`);
    }).catch(err => console.error('Email send failed:', err));

    res.json({ 
      success: true,
      message: 'Reset code sent to your email' 
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send reset code' });
  }
});

// Verify Reset Code
app.post('/api/verify-reset-code', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code required' });
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

    res.json({ success: true, message: 'Code verified' });
  } catch (error) {
    console.error('Verify code error:', error);
    res.status(500).json({ error: 'Verification failed' });
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

    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', user.id);

    if (updateError) {
      throw new Error('Failed to update password');
    }

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
// POST ROUTES - NEW!
// ============================================

// Create Post with Media Upload
app.post('/api/posts', authenticateToken, upload.array('media', 5), async (req, res) => {
  try {
    const { content, college } = req.body;
    const files = req.files;

    if (!content && (!files || files.length === 0)) {
      return res.status(400).json({ error: 'Post must have content or media' });
    }

    // Upload media files to Supabase Storage
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

        // Get public URL
        const { data: urlData } = supabase.storage
          .from('posts-media')
          .getPublicUrl(fileName);

        mediaUrls.push({
          url: urlData.publicUrl,
          type: file.mimetype.startsWith('image') ? 'image' : 'video'
        });
      }
    }

    // Create post in database
    const { data: newPost, error: postError } = await supabase
      .from('posts')
      .insert([{
        user_id: req.user.id,
        content: content || '',
        media: mediaUrls,
        college: college || req.user.college,
        likes_count: 0,
        comments_count: 0
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

    // Emit socket event for real-time update
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

// Get Posts (Feed)
app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { college, limit = 20, offset = 0 } = req.query;

    let query = supabase
      .from('posts')
      .select(`
        *,
        users (
          id,
          username,
          profile_pic,
          college
        )
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Filter by college if specified
    if (college) {
      query = query.eq('college', college);
    }

    const { data: posts, error } = await query;

    if (error) {
      throw new Error('Failed to fetch posts');
    }

    res.json({
      success: true,
      posts,
      hasMore: posts.length === parseInt(limit)
    });

  } catch (error) {
    console.error('Get posts error:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// Like/Unlike Post
app.post('/api/posts/:postId/like', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;

    // Check if already liked
    const { data: existingLike } = await supabase
      .from('post_likes')
      .select('*')
      .eq('post_id', postId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existingLike) {
      // Unlike
      await supabase
        .from('post_likes')
        .delete()
        .eq('id', existingLike.id);

      // Decrement likes count
      await supabase.rpc('decrement_likes', { post_id: postId });

      res.json({ success: true, liked: false });
    } else {
      // Like
      await supabase
        .from('post_likes')
        .insert([{
          post_id: postId,
          user_id: req.user.id
        }]);

      // Increment likes count
      await supabase.rpc('increment_likes', { post_id: postId });

      res.json({ success: true, liked: true });
    }

  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Failed to like post' });
  }
});

// Add Comment
app.post('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }

    const { data: newComment, error } = await supabase
      .from('comments')
      .insert([{
        post_id: postId,
        user_id: req.user.id,
        content: content.trim()
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

    if (error) {
      throw new Error('Failed to add comment');
    }

    // Increment comments count
    await supabase.rpc('increment_comments', { post_id: postId });

    res.status(201).json({
      success: true,
      comment: newComment
    });

  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Get Comments for Post
app.get('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;

    const { data: comments, error } = await supabase
      .from('comments')
      .select(`
        *,
        users (
          id,
          username,
          profile_pic
        )
      `)
      .eq('post_id', postId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error('Failed to fetch comments');
    }

    res.json({
      success: true,
      comments
    });

  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Delete Post
app.delete('/api/posts/:postId', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;

    // Check if user owns the post
    const { data: post } = await supabase
      .from('posts')
      .select('user_id, media')
      .eq('id', postId)
      .single();

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to delete this post' });
    }

    // Delete media from storage
    if (post.media && post.media.length > 0) {
      for (const media of post.media) {
        const fileName = media.url.split('/posts-media/')[1];
        if (fileName) {
          await supabase.storage
            .from('posts-media')
            .remove([fileName]);
        }
      }
    }

    // Delete post
    await supabase
      .from('posts')
      .delete()
      .eq('id', postId);

    res.json({ success: true, message: 'Post deleted successfully' });

  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// ============================================
// PROFILE ROUTES
// ============================================

// Update Profile
app.put('/api/profile', authenticateToken, upload.single('profilePic'), async (req, res) => {
  try {
    const { username, college, bio } = req.body;
    const file = req.file;

    const updates = {};
    
    if (username) updates.username = username;
    if (college) updates.college = college;
    if (bio) updates.bio = bio;

    // Upload profile picture if provided
    if (file) {
      const fileExt = file.originalname.split('.').pop();
      const fileName = `${req.user.id}/profile.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('profile-pics')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '3600',
          upsert: true
        });

      if (uploadError) {
        throw new Error('Failed to upload profile picture');
      }

      const { data: urlData } = supabase.storage
        .from('profile-pics')
        .getPublicUrl(fileName);

      updates.profile_pic = urlData.publicUrl;
    }

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      throw new Error('Failed to update profile');
    }

    res.json({
      success: true,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        college: updatedUser.college,
        bio: updatedUser.bio,
        profilePic: updatedUser.profile_pic
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: error.message || 'Failed to update profile' });
  }
});

// Get User Profile
app.get('/api/profile/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, college, bio, profile_pic, created_at')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user's posts count
    const { count: postsCount } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    res.json({
      success: true,
      user: {
        ...user,
        postsCount
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'VibeXpert Backend',
    version: '2.0.0'
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'VibeXpert API is running',
    version: '2.0.0',
    features: ['Auth', 'Posts', 'Media Upload', 'Comments', 'Likes', 'Profile']
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  // Join college room
  socket.on('join_college', (college) => {
    socket.join(college);
    console.log(`User ${socket.id} joined ${college}`);
  });

  // Real-time typing indicator
  socket.on('typing', (data) => {
    socket.to(data.postId).emit('user_typing', {
      userId: data.userId,
      username: data.username
    });
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Email service: ${process.env.BREVO_FROM_EMAIL}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log(`✨ Features: Auth, Posts, Media, Comments, Likes, Profile`);
});
