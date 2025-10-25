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

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize Socket.io with CORS
const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://www.vibexpert.online',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://www.vibexpert.online',
  credentials: true
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
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Multer configuration for file uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_BYTES) || 5242880 }
});

// Helper Functions
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

const sendEmail = async (to, subject, html) => {
  try {
    await transporter.sendMail({
      from: `${process.env.BREVO_FROM_NAME} <${process.env.BREVO_FROM_EMAIL}>`,
      to,
      subject,
      html
    });
    return true;
  } catch (error) {
    console.error('Email error:', error);
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
// 🧱 1. USER AUTHENTICATION ROUTES
// ============================================

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if user exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('email')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{
        username,
        email,
        password_hash: passwordHash
      }])
      .select()
      .single();

    if (error) throw error;

    // Send congratulations email
    await sendEmail(
      email,
      '🎉 Welcome to VibeXpert!',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1>
          <p style="font-size: 16px; color: #374151;">
            Congratulations on creating your account! You're now part of an amazing college community platform.
          </p>
          <p style="font-size: 16px; color: #374151;">
            Next steps:
          </p>
          <ol style="font-size: 16px; color: #374151;">
            <li>Log in to your account</li>
            <li>Select your college</li>
            <li>Start connecting with your community!</li>
          </ol>
          <p style="font-size: 16px; color: #374151;">
            Ready to vibe? Let's go! 🚀
          </p>
        </div>
      `
    );

    res.status(201).json({
      message: 'Account created successfully! Check your email.',
      userId: newUser.id
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Get user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
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

    // Check if user exists
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Generate 6-digit code
    const code = generateCode();
    const expiresAt = new Date(Date.now() + parseInt(process.env.RESET_CODE_TTL_MIN) * 60 * 1000);

    // Store code
    await supabase.from('codes').insert([{
      user_id: user.id,
      code,
      type: 'reset',
      expires_at: expiresAt.toISOString()
    }]);

    // Send email
    await sendEmail(
      email,
      '🔐 Password Reset Code - VibeXpert',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #4F46E5;">Password Reset Request</h1>
          <p style="font-size: 16px; color: #374151;">
            Hi ${user.username},
          </p>
          <p style="font-size: 16px; color: #374151;">
            You requested to reset your password. Use the code below:
          </p>
          <div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <h2 style="color: #1F2937; font-size: 32px; letter-spacing: 4px; margin: 0;">${code}</h2>
          </div>
          <p style="font-size: 14px; color: #6B7280;">
            This code expires in ${process.env.RESET_CODE_TTL_MIN} minutes.
          </p>
          <p style="font-size: 14px; color: #6B7280;">
            If you didn't request this, please ignore this email.
          </p>
        </div>
      `
    );

    res.json({ message: 'Reset code sent to your email' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send reset code' });
  }
});

// Verify Reset Code & Reset Password
app.post('/api/verify-reset-code', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }

    // Get user
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify code
    const { data: codeData, error } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .eq('type', 'reset')
      .eq('used', false)
      .single();

    if (error || !codeData) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    // Check expiration
    if (new Date() > new Date(codeData.expires_at)) {
      return res.status(400).json({ error: 'Code expired' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', user.id);

    // Mark code as used
    await supabase
      .from('codes')
      .update({ used: true })
      .eq('id', codeData.id);

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ============================================
// 🏫 2. COLLEGE COMMUNITY CONNECTION
// ============================================

// Get available colleges (you can expand this list)
app.get('/api/colleges', (req, res) => {
  const colleges = [
    'IIT Bombay',
    'IIT Delhi',
    'BITS Pilani',
    'NIT Trichy',
    'Delhi University',
    'Mumbai University',
    'Anna University',
    'VIT Vellore',
    'Manipal Institute of Technology',
    'SRM Institute of Science and Technology'
  ];
  res.json({ colleges });
});

// Select College - Send Verification Code
app.post('/api/select-college', authenticateToken, async (req, res) => {
  try {
    const { college } = req.body;

    if (!college) {
      return res.status(400).json({ error: 'College name required' });
    }

    // Check if user already joined a community
    if (req.user.community_joined) {
      return res.status(400).json({ error: 'You are already part of a community' });
    }

    // Generate 6-digit code
    const code = generateCode();
    const expiresAt = new Date(Date.now() + parseInt(process.env.JOIN_CODE_TTL_MIN) * 60 * 1000);

    // Store code
    await supabase.from('codes').insert([{
      user_id: req.user.id,
      code,
      type: 'college',
      meta: { college },
      expires_at: expiresAt.toISOString()
    }]);

    // Send email
    await sendEmail(
      req.user.email,
      `🎓 Join ${college} Community - VibeXpert`,
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #4F46E5;">Join Your College Community! 🎓</h1>
          <p style="font-size: 16px; color: #374151;">
            Hi ${req.user.username},
          </p>
          <p style="font-size: 16px; color: #374151;">
            You're about to join <strong>${college}</strong> community on VibeXpert!
          </p>
          <p style="font-size: 16px; color: #374151;">
            Enter this code on the website to confirm:
          </p>
          <div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <h2 style="color: #1F2937; font-size: 32px; letter-spacing: 4px; margin: 0;">${code}</h2>
          </div>
          <p style="font-size: 14px; color: #6B7280;">
            This code expires in ${process.env.JOIN_CODE_TTL_MIN} minutes.
          </p>
        </div>
      `
    );

    res.json({ message: 'Verification code sent to your email' });
  } catch (error) {
    console.error('Select college error:', error);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

// Verify College Code
app.post('/api/verify-college-code', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Code required' });
    }

    // Check if user already joined
    if (req.user.community_joined) {
      return res.status(400).json({ error: 'Already part of a community' });
    }

    // Verify code
    const { data: codeData, error } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('code', code)
      .eq('type', 'college')
      .eq('used', false)
      .single();

    if (error || !codeData) {
      return res.status(400).json({ error: 'Invalid code' });
    }

    // Check expiration
    if (new Date() > new Date(codeData.expires_at)) {
      return res.status(400).json({ error: 'Code expired' });
    }

    const college = codeData.meta.college;

    // Update user
    await supabase
      .from('users')
      .update({
        college,
        community_joined: true
      })
      .eq('id', req.user.id);

    // Mark code as used
    await supabase
      .from('codes')
      .update({ used: true })
      .eq('id', codeData.id);

    res.json({
      message: `Congratulations! You've connected to ${college} community 🎉`,
      college
    });
  } catch (error) {
    console.error('Verify college code error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ============================================
// 💬 3. COMMUNITY CHAT (Socket.io)
// ============================================

// Get Chat History
app.get('/api/community/chat', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined) {
      return res.status(403).json({ error: 'Not part of any community' });
    }

    const { data: messages, error } = await supabase
      .from('messages')
      .select(`
        *,
        users:sender_id (username, profile_pic)
      `)
      .order('timestamp', { ascending: true })
      .limit(100);

    if (error) throw error;

    res.json({ messages: messages || [] });
  } catch (error) {
    console.error('Get chat error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Get Community Members
app.get('/api/community/members', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined) {
      return res.status(403).json({ error: 'Not part of any community' });
    }

    const { data: members, error } = await supabase
      .from('users')
      .select('id, username, profile_pic, created_at')
      .eq('college', req.user.college)
      .eq('community_joined', true);

    if (error) throw error;

    res.json({ members: members || [] });
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join community room
  socket.on('join-community', (userId) => {
    socket.join(`community-${userId}`);
  });

  // Send message
  socket.on('send-message', async (data) => {
    try {
      const { userId, content, imageUrl } = data;

      // Insert message
      const { data: message, error } = await supabase
        .from('messages')
        .insert([{
          sender_id: userId,
          content: content || null,
          image_url: imageUrl || null
        }])
        .select(`
          *,
          users:sender_id (username, profile_pic)
        `)
        .single();

      if (error) throw error;

      // Broadcast to all clients
      io.emit('new-message', message);
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // React to message
  socket.on('react-message', async (data) => {
    try {
      const { messageId, userId, reactionType } = data;

      // Get current message
      const { data: message } = await supabase
        .from('messages')
        .select('reactions')
        .eq('id', messageId)
        .single();

      if (message) {
        const reactions = message.reactions || [];
        const existingIndex = reactions.findIndex(r => r.userId === userId);

        if (existingIndex >= 0) {
          reactions[existingIndex].type = reactionType;
        } else {
          reactions.push({ userId, type: reactionType });
        }

        await supabase
          .from('messages')
          .update({ reactions })
          .eq('id', messageId);

        io.emit('message-reacted', { messageId, reactions });
      }
    } catch (error) {
      console.error('React message error:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// ============================================
// 📸 4. POST SECTION
// ============================================

// Upload image to Supabase Storage
const uploadImageToStorage = async (file, folder) => {
  try {
    const fileName = `${Date.now()}-${file.originalname}`;
    const { data, error } = await supabase.storage
      .from(process.env.SUPABASE_STORAGE_BUCKET)
      .upload(`${folder}/${fileName}`, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (error) throw error;

    const { data: publicUrl } = supabase.storage
      .from(process.env.SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(`${folder}/${fileName}`);

    return publicUrl.publicUrl;
  } catch (error) {
    console.error('Upload error:', error);
    throw error;
  }
};

// Create Post
app.post('/api/post/upload', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { caption, postedTo } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Image required' });
    }

    if (!postedTo || !['profile', 'community'].includes(postedTo)) {
      return res.status(400).json({ error: 'Invalid postedTo value' });
    }

    if (postedTo === 'community' && !req.user.community_joined) {
      return res.status(403).json({ error: 'Not part of any community' });
    }

    // Upload image
    const imageUrl = await uploadImageToStorage(req.file, 'posts');

    // Create post
    const { data: post, error } = await supabase
      .from('posts')
      .insert([{
        user_id: req.user.id,
        image_url: imageUrl,
        caption: caption || null,
        posted_to: postedTo
      }])
      .select(`
        *,
        users:user_id (username, profile_pic)
      `)
      .single();

    if (error) throw error;

    res.status(201).json({ message: 'Post created successfully', post });
  } catch (error) {
    console.error('Upload post error:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// Get Community Posts
app.get('/api/posts/community', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined) {
      return res.status(403).json({ error: 'Not part of any community' });
    }

    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        users:user_id (username, profile_pic, college)
      `)
      .eq('posted_to', 'community')
      .order('timestamp', { ascending: false });

    if (error) throw error;

    // Filter posts from same college
    const filteredPosts = posts.filter(p => p.users?.college === req.user.college);

    res.json({ posts: filteredPosts });
  } catch (error) {
    console.error('Get community posts error:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// Get User Profile Posts
app.get('/api/posts/profile/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        users:user_id (username, profile_pic)
      `)
      .eq('user_id', userId)
      .eq('posted_to', 'profile')
      .order('timestamp', { ascending: false });

    if (error) throw error;

    res.json({ posts: posts || [] });
  } catch (error) {
    console.error('Get profile posts error:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// ============================================
// 👤 USER PROFILE
// ============================================

// Get User Profile
app.get('/api/user/profile/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, profile_pic, college, created_at, liked_profiles')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Like User Profile
app.post('/api/user/like/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot like own profile' });
    }

    const likedProfiles = req.user.liked_profiles || [];

    if (likedProfiles.includes(userId)) {
      return res.status(400).json({ error: 'Already liked this profile' });
    }

    likedProfiles.push(userId);

    await supabase
      .from('users')
      .update({ liked_profiles: likedProfiles })
      .eq('id', req.user.id);

    res.json({ message: 'Profile liked successfully' });
  } catch (error) {
    console.error('Like profile error:', error);
    res.status(500).json({ error: 'Failed to like profile' });
  }
});

// Update Profile Picture
app.post('/api/user/profile-pic', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image required' });
    }

    // Upload image
    const imageUrl = await uploadImageToStorage(req.file, 'profile-pics');

    // Update user
    await supabase
      .from('users')
      .update({ profile_pic: imageUrl })
      .eq('id', req.user.id);

    res.json({ message: 'Profile picture updated', profilePic: imageUrl });
  } catch (error) {
    console.error('Update profile pic error:', error);
    res.status(500).json({ error: 'Failed to update profile picture' });
  }
});

// Delete Account
app.delete('/api/user/account', authenticateToken, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, req.user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Delete user (cascade will delete related data)
    await supabase
      .from('users')
      .delete()
      .eq('id', req.user.id);

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'VibeXpert Backend API',
    version: '1.0.0',
    status: 'Running'
  });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.io enabled`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
