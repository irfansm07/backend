// ENHANCED VIBEXPERT BACKEND WITH WHATSAPP-LIKE FEATURES
// Complete Server Implementation

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
  console.log(`📡 ${req.method} ${req.path}`);
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 20 * 1024 * 1024,
    files: 10 
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi|mp3|wav|webm/;
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype) return cb(null, true);
    cb(new Error('Only image, video, and audio files allowed'));
  }
});

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

// Enhanced Community Messages with Reply Support
app.post('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    const { content, replyTo } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }
    
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    
    const messageData = {
      sender_id: req.user.id,
      content: content.trim(),
      college: req.user.college,
      reply_to: replyTo || null
    };
    
    const { data: newMessage, error } = await supabase
      .from('messages')
      .insert([messageData])
      .select(`*, users (id, username, profile_pic)`)
      .single();
    
    if (error) throw error;
    
    // Emit to all users in the college
    io.to(req.user.college).emit('new_message', newMessage);
    
    res.json({ success: true, message: newMessage });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get Community Messages with Pagination
app.get('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    
    const { limit = 50, offset = 0, before } = req.query;
    
    let query = supabase
      .from('messages')
      .select(`*, users (id, username, profile_pic), message_reactions (*)`)
      .eq('college', req.user.college)
      .order('timestamp', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (before) {
      query = query.lt('timestamp', before);
    }
    
    const { data: messages, error } = await query;
    
    if (error) throw error;
    
    res.json({ success: true, messages: messages || [] });
  } catch (error) {
    console.error('❌ Get messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Edit Message (within 15 minutes)
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
    
    if (diffMinutes > 15) {
      return res.status(403).json({ error: 'Can only edit message within 15 minutes of sending' });
    }
    
    const { data: updatedMessage, error: updateError } = await supabase
      .from('messages')
      .update({ content: content.trim(), is_edited: true })
      .eq('id', id)
      .select(`*, users (id, username, profile_pic)`)
      .single();
    
    if (updateError) throw updateError;
    
    io.to(message.college).emit('message_updated', updatedMessage);
    
    res.json({ success: true, message: updatedMessage });
  } catch (error) {
    console.error('❌ Edit message error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// Delete Message
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
    
    // Delete reactions first
    await supabase.from('message_reactions').delete().eq('message_id', id);
    
    // Delete message
    await supabase.from('messages').delete().eq('id', id);
    
    io.to(message.college).emit('message_deleted', { id, college: message.college });
    
    res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('❌ Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// React to Message
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
    
    // Check if user already reacted with this emoji
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
      // Remove reaction
      await supabase.from('message_reactions').delete().eq('id', existing.id);
      action = 'removed';
    } else {
      // Add reaction
      const { data: newReaction, error } = await supabase
        .from('message_reactions')
        .insert([{ message_id: id, user_id: req.user.id, emoji: emoji }])
        .select()
        .single();
      
      if (error) throw error;
      reaction = newReaction;
    }
    
    // Get updated reactions
    const { data: allReactions } = await supabase
      .from('message_reactions')
      .select('*')
      .eq('message_id', id);
    
    io.to(message.college).emit('message_reaction_updated', {
      messageId: id,
      userId: req.user.id,
      emoji,
      action,
      reactions: allReactions
    });
    
    res.json({ success: true, action, reaction, reactions: allReactions });
  } catch (error) {
    console.error('❌ React to message error:', error);
    res.status(500).json({ error: 'Failed to react to message' });
  }
});

// Voice Message Upload
app.post('/api/community/messages/voice', authenticateToken, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Audio file required' });
    }
    
    if (!req.user.community_joined || !req.user.college) {
      return res.status(403).json({ error: 'Join a college community first' });
    }
    
    // Upload to Supabase storage
    const fileName = `voice/${req.user.id}/${Date.now()}.webm`;
    
    const { error: uploadError } = await supabase.storage
      .from('voice-messages')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600'
      });
    
    if (uploadError) throw uploadError;
    
    const { data: urlData } = supabase.storage
      .from('voice-messages')
      .getPublicUrl(fileName);
    
    // Save message with voice URL
    const { data: newMessage, error } = await supabase
      .from('messages')
      .insert([{
        sender_id: req.user.id,
        content: '[Voice Message]',
        college: req.user.college,
        voice_url: urlData.publicUrl,
        message_type: 'voice'
      }])
      .select(`*, users (id, username, profile_pic)`)
      .single();
    
    if (error) throw error;
    
    io.to(req.user.college).emit('new_message', newMessage);
    
    res.json({ success: true, message: newMessage });
  } catch (error) {
    console.error('❌ Voice message error:', error);
    res.status(500).json({ error: 'Failed to send voice message' });
  }
});

// Mark Message as Read
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

// Get Message Views
app.get('/api/community/messages/:id/views', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: views, error } = await supabase
      .from('message_views')
      .select(`*, users (id, username, profile_pic)`)
      .eq('message_id', id);
    
    if (error) throw error;
    
    res.json({ success: true, views: views || [], count: views?.length || 0 });
  } catch (error) {
    console.error('❌ Get views error:', error);
    res.status(500).json({ error: 'Failed to fetch views' });
  }
});

// All other existing endpoints remain the same...
// (I'll include the essential ones)

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, registrationNumber, gender } = req.body;
    
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
        gender
      }])
      .select()
      .single();
    
    if (error) {
      throw new Error('Failed to create account');
    }
    
    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
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
        bio: user.bio || ''
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Socket.IO Enhanced Event Handling
const onlineUsers = new Map(); // userId -> { socketId, college }
const typingUsers = new Map(); // college -> Set of usernames

io.on('connection', (socket) => {
  console.log('⚡ User connected:', socket.id);
  
  socket.on('user_online', (userId) => {
    onlineUsers.set(userId, { socketId: socket.id, userId });
    socket.data.userId = userId;
  });
  
  socket.on('join_college', (collegeName) => {
    if (collegeName && typeof collegeName === 'string') {
      // Leave all other rooms
      Object.keys(socket.rooms).forEach(room => {
        if (room !== socket.id) socket.leave(room);
      });
      
      socket.join(collegeName);
      socket.data.college = collegeName;
      console.log(`👥 User ${socket.id} joined community: ${collegeName}`);
      
      // Send online count
      const roomSize = io.sockets.adapter.rooms.get(collegeName)?.size || 0;
      io.to(collegeName).emit('online_count', roomSize);
      
      socket.emit('community_joined', collegeName);
    }
  });
  
  socket.on('typing', (data) => {
    if (data.collegeName && data.username) {
      if (!typingUsers.has(data.collegeName)) {
        typingUsers.set(data.collegeName, new Set());
      }
      typingUsers.get(data.collegeName).add(data.username);
      
      socket.to(data.collegeName).emit('user_typing', { username: data.username });
      
      // Auto-stop typing after 3 seconds
      setTimeout(() => {
        if (typingUsers.has(data.collegeName)) {
          typingUsers.get(data.collegeName).delete(data.username);
          socket.to(data.collegeName).emit('user_stop_typing', { username: data.username });
        }
      }, 3000);
    }
  });
  
  socket.on('stop_typing', (data) => {
    if (data.collegeName && data.username) {
      if (typingUsers.has(data.collegeName)) {
        typingUsers.get(data.collegeName).delete(data.username);
      }
      socket.to(data.collegeName).emit('user_stop_typing', { username: data.username });
    }
  });
  
  socket.on('message_read', (data) => {
    if (data.messageId && data.collegeName) {
      socket.to(data.collegeName).emit('message_read_receipt', {
        messageId: data.messageId,
        userId: socket.data.userId
      });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('👋 User disconnected:', socket.id);
    
    if (socket.data.userId) {
      onlineUsers.delete(socket.data.userId);
    }
    
    if (socket.data.college) {
      const roomSize = io.sockets.adapter.rooms.get(socket.data.college)?.size || 0;
      io.to(socket.data.college).emit('online_count', roomSize);
    }
  });
});

// Error handling middleware
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 VibeXpert Enhanced Backend running on port ${PORT}`);
  console.log(`✅ WhatsApp-like chat features enabled`);
  console.log(`✅ Reply, Reactions, Voice messages supported`);
  console.log(`✅ Typing indicators & Read receipts`);
  console.log(`✅ Real-time updates via Socket.IO`);
});
