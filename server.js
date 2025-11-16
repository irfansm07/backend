// VIBEXPERT BACKEND - COMPLETE FIXED VERSION
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
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// CORS Configuration
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());

// Body parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`📡 ${req.method} ${req.path}`);
  next();
});

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// File upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 20 * 1024 * 1024,
    files: 10 
  }
});

// Helper functions
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }
    
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
    console.error('Auth error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Rewards helper functions
async function awardPoints(userId, points, reason) {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('reward_points, reward_level')
      .eq('id', userId)
      .single();
    
    const newPoints = (user?.reward_points || 0) + points;
    const newLevel = calculateLevel(newPoints);
    
    await supabase
      .from('users')
      .update({ 
        reward_points: newPoints,
        reward_level: newLevel
      })
      .eq('id', userId);
    
    await supabase
      .from('reward_history')
      .insert({
        user_id: userId,
        points: points,
        reason: reason,
        timestamp: new Date().toISOString()
      });
    
    return { points: newPoints, level: newLevel, earned: points };
  } catch (error) {
    console.error('Award points error:', error);
    return null;
  }
}

function calculateLevel(points) {
  if (points >= 3000) return 'Platinum';
  if (points >= 1500) return 'Gold';
  if (points >= 500) return 'Silver';
  return 'Bronze';
}

async function calculateLoginStreak(userId) {
  try {
    const { data: logins } = await supabase
      .from('daily_logins')
      .select('login_date')
      .eq('user_id', userId)
      .order('login_date', { ascending: false })
      .limit(30);
    
    if (!logins || logins.length === 0) return 1;
    
    let streak = 1;
    for (let i = 1; i < logins.length; i++) {
      const currentDate = new Date(logins[i].login_date);
      const previousDate = new Date(logins[i-1].login_date);
      const diffDays = Math.floor((previousDate - currentDate) / (1000 * 60 * 60 * 24));
      
      if (diffDays === 1) {
        streak++;
      } else {
        break;
      }
    }
    
    return streak;
  } catch (error) {
    console.error('Calculate streak error:', error);
    return 1;
  }
}

// ==================== ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    message: 'VibeXpert Backend Running'
  });
});

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, registrationNumber } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    
    // Check existing user
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .or(`email.eq.${email},username.eq.${username}`)
      .single();
    
    if (existing) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        username,
        email,
        password: hashedPassword,
        registration_number: registrationNumber,
        reward_points: 0,
        reward_level: 'Bronze'
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      message: 'Registration successful!',
      userId: user.id 
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .or(`email.eq.${email},registration_number.eq.${email}`)
      .single();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    // Check daily login
    const today = new Date().toISOString().split('T')[0];
    const { data: loginRecord } = await supabase
      .from('daily_logins')
      .select('*')
      .eq('user_id', user.id)
      .eq('login_date', today)
      .single();
    
    let dailyReward = null;
    if (!loginRecord) {
      await supabase
        .from('daily_logins')
        .insert({ user_id: user.id, login_date: today });
      
      const streak = await calculateLoginStreak(user.id);
      const bonusPoints = streak >= 7 ? 20 : streak >= 3 ? 15 : 10;
      dailyReward = await awardPoints(user.id, bonusPoints, `Daily Login (${streak} day streak)`);
    }
    
    delete user.password;
    
    res.json({ 
      success: true,
      token,
      user,
      dailyReward
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get ALL posts (both profile and community)
app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    console.log('📨 Fetching all posts for user:', req.user.username);
    
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        users (id, username, profile_pic, college),
        post_likes (user_id),
        post_comments (id)
      `)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) {
      console.error('❌ Posts query error:', error);
      throw error;
    }
    
    // Add interaction counts and user's like status
    const postsWithCounts = posts.map(post => ({
      ...post,
      like_count: post.post_likes?.length || 0,
      comment_count: post.post_comments?.length || 0,
      share_count: post.share_count || 0,
      is_liked: post.post_likes?.some(like => like.user_id === req.user.id) || false
    }));
    
    console.log(`✅ Found ${posts.length} posts`);
    
    res.json({ 
      success: true, 
      posts: postsWithCounts
    });
  } catch (error) {
    console.error('❌ Get posts error:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// Get user profile posts
app.get('/api/posts/user/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        users (id, username, profile_pic, college),
        post_likes (user_id),
        post_comments (id)
      `)
      .eq('user_id', userId)
      .eq('posted_to', 'profile')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    const postsWithCounts = posts.map(post => ({
      ...post,
      like_count: post.post_likes?.length || 0,
      comment_count: post.post_comments?.length || 0,
      share_count: post.share_count || 0,
      is_liked: post.post_likes?.some(like => like.user_id === req.user.id) || false
    }));
    
    res.json({ success: true, posts: postsWithCounts });
  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// Get community posts
app.get('/api/posts/community', authenticateToken, async (req, res) => {
  try {
    if (!req.user.college) {
      return res.json({ 
        success: true,
        needsJoinCommunity: true,
        posts: [] 
      });
    }
    
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        users!inner (id, username, profile_pic, college),
        post_likes (user_id),
        post_comments (id)
      `)
      .eq('users.college', req.user.college)
      .eq('posted_to', 'community')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    const postsWithCounts = posts.map(post => ({
      ...post,
      like_count: post.post_likes?.length || 0,
      comment_count: post.post_comments?.length || 0,
      share_count: post.share_count || 0,
      is_liked: post.post_likes?.some(like => like.user_id === req.user.id) || false
    }));
    
    res.json({ success: true, posts: postsWithCounts });
  } catch (error) {
    console.error('Get community posts error:', error);
    res.status(500).json({ error: 'Failed to fetch community posts' });
  }
});

// Create post
app.post('/api/posts', authenticateToken, upload.array('media', 5), async (req, res) => {
  try {
    const { content, postTo = 'profile', music, stickers } = req.body;
    
    console.log('📝 Creating post:', {
      user: req.user.username,
      postTo,
      hasMedia: !!req.files?.length,
      hasMusic: !!music,
      hasStickers: !!stickers
    });
    
    // Validate community post
    if (postTo === 'community' && !req.user.college) {
      return res.status(400).json({ 
        error: 'Please connect to your university first to post to community!' 
      });
    }
    
    // Upload media files
    let mediaUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.${file.mimetype.split('/')[1]}`;
        const { data, error } = await supabase.storage
          .from('post-media')
          .upload(filename, file.buffer, {
            contentType: file.mimetype
          });
        
        if (error) {
          console.error('Media upload error:', error);
          continue;
        }
        
        const { data: urlData } = supabase.storage
          .from('post-media')
          .getPublicUrl(filename);
        
        mediaUrls.push({
          url: urlData.publicUrl,
          type: file.mimetype.startsWith('image/') ? 'image' : 
                file.mimetype.startsWith('video/') ? 'video' : 'audio'
        });
      }
    }
    
    // Create post
    const { data: post, error } = await supabase
      .from('posts')
      .insert({
        user_id: req.user.id,
        content: content || '',
        media: mediaUrls,
        music: music ? JSON.parse(music) : null,
        stickers: stickers ? JSON.parse(stickers) : [],
        posted_to: postTo
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Award points
    const pointsEarned = postTo === 'community' ? 25 : 15;
    const reward = await awardPoints(
      req.user.id, 
      pointsEarned, 
      `Created ${postTo} post`
    );
    
    // Get post count
    const { count } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id);
    
    console.log('✅ Post created successfully');
    
    res.json({ 
      success: true, 
      post,
      reward,
      postCount: count
    });
  } catch (error) {
    console.error('❌ Create post error:', error);
    res.status(500).json({ error: 'Failed to create post: ' + error.message });
  }
});

// Delete post
app.delete('/api/posts/:postId', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    const { error } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId)
      .eq('user_id', req.user.id);
    
    if (error) throw error;
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// Like post
app.post('/api/posts/:postId/like', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    // Check if already liked
    const { data: existing } = await supabase
      .from('post_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', req.user.id)
      .single();
    
    if (existing) {
      // Unlike
      await supabase
        .from('post_likes')
        .delete()
        .eq('post_id', postId)
        .eq('user_id', req.user.id);
      
      const { count } = await supabase
        .from('post_likes')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', postId);
      
      return res.json({ success: true, liked: false, likeCount: count });
    }
    
    // Like
    await supabase
      .from('post_likes')
      .insert({
        post_id: postId,
        user_id: req.user.id
      });
    
    // Award points
    await awardPoints(req.user.id, 5, 'Liked a post');
    
    const { count } = await supabase
      .from('post_likes')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', postId);
    
    res.json({ success: true, liked: true, likeCount: count });
  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ error: 'Failed to like post' });
  }
});

// Get comments
app.get('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    const { data: comments, error } = await supabase
      .from('post_comments')
      .select(`
        *,
        users (id, username, profile_pic)
      `)
      .eq('post_id', postId)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    
    res.json({ success: true, comments });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Add comment
app.post('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    const { content } = req.body;
    
    const { data: comment, error } = await supabase
      .from('post_comments')
      .insert({
        post_id: postId,
        user_id: req.user.id,
        content
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Award points
    await awardPoints(req.user.id, 10, 'Commented on a post');
    
    res.json({ success: true, comment });
  } catch (error) {
    console.error('Comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Delete comment
app.delete('/api/posts/:postId/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const { commentId } = req.params;
    
    await supabase
      .from('post_comments')
      .delete()
      .eq('id', commentId)
      .eq('user_id', req.user.id);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// Share post
app.post('/api/posts/:postId/share', authenticateToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    // Increment share count
    const { data: post } = await supabase
      .from('posts')
      .select('share_count')
      .eq('id', postId)
      .single();
    
    const newCount = (post?.share_count || 0) + 1;
    
    await supabase
      .from('posts')
      .update({ share_count: newCount })
      .eq('id', postId);
    
    res.json({ success: true, shareCount: newCount });
  } catch (error) {
    console.error('Share error:', error);
    res.status(500).json({ error: 'Failed to share post' });
  }
});

// Search users
app.get('/api/search/users', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.length < 2) {
      return res.json({ success: true, users: [] });
    }
    
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, email, registration_number, profile_pic, college')
      .or(`username.ilike.%${query}%,email.ilike.%${query}%,registration_number.ilike.%${query}%`)
      .limit(10);
    
    if (error) throw error;
    
    res.json({ success: true, users });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get user profile
app.get('/api/profile/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, registration_number, profile_pic, bio, college, reward_points, reward_level')
      .eq('id', userId)
      .single();
    
    if (error) throw error;
    
    // Get post count
    const { count: postCount } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    
    res.json({ 
      success: true, 
      user: {
        ...user,
        postCount,
        rewardPoints: user.reward_points,
        rewardLevel: user.reward_level
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update profile
app.patch('/api/profile', authenticateToken, upload.single('profilePic'), async (req, res) => {
  try {
    const updates = {};
    
    if (req.body.username) updates.username = req.body.username;
    if (req.body.bio !== undefined) updates.bio = req.body.bio;
    
    if (req.file) {
      const filename = `${req.user.id}-${Date.now()}.${req.file.mimetype.split('/')[1]}`;
      const { error: uploadError } = await supabase.storage
        .from('profile-pics')
        .upload(filename, req.file.buffer, {
          contentType: req.file.mimetype
        });
      
      if (!uploadError) {
        const { data: urlData } = supabase.storage
          .from('profile-pics')
          .getPublicUrl(filename);
        
        updates.profile_pic = urlData.publicUrl;
      }
    }
    
    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();
    
    if (error) throw error;
    
    delete user.password;
    
    res.json({ success: true, user });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ==================== REWARDS ROUTES ====================

app.get('/api/rewards/status', authenticateToken, async (req, res) => {
  try {
    console.log('📊 Fetching rewards for:', req.user.username);
    
    const { data: user } = await supabase
      .from('users')
      .select('reward_points, reward_level')
      .eq('id', req.user.id)
      .single();
    
    const { data: history } = await supabase
      .from('reward_history')
      .select('*')
      .eq('user_id', req.user.id)
      .order('timestamp', { ascending: false })
      .limit(10);
    
    const streak = await calculateLoginStreak(req.user.id);
    
    const today = new Date().toISOString().split('T')[0];
    const { data: dailyLogin } = await supabase
      .from('daily_logins')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('login_date', today)
      .single();
    
    const { data: shareRecord } = await supabase
      .from('share_tracking')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('share_date', today)
      .single();
    
    const points = user?.reward_points || 0;
    const level = user?.reward_level || 'Bronze';
    
    const levels = {
      'Bronze': { min: 0, max: 500 },
      'Silver': { min: 500, max: 1500 },
      'Gold': { min: 1500, max: 3000 },
      'Platinum': { min: 3000, max: Infinity }
    };
    
    const currentLevel = levels[level];
    const progress = currentLevel.max === Infinity 
      ? 100 
      : ((points - currentLevel.min) / (currentLevel.max - currentLevel.min)) * 100;
    
    const nextLevel = level === 'Platinum' ? null : Object.keys(levels)[Object.keys(levels).indexOf(level) + 1];
    const pointsToNext = level === 'Platinum' ? 0 : currentLevel.max - points;
    
    console.log('✅ Rewards fetched successfully');
    
    res.json({
      success: true,
      points,
      level,
      progress: Math.min(progress, 100),
      nextLevel,
      pointsToNext,
      streak,
      dailyClaimed: !!dailyLogin,
      shareClaimed: !!shareRecord,
      history: history || []
    });
  } catch (error) {
    console.error('❌ Rewards status error:', error);
    res.status(500).json({ error: 'Failed to fetch rewards: ' + error.message });
  }
});

app.post('/api/rewards/daily-login', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const { data: loginRecord } = await supabase
      .from('daily_logins')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('login_date', today)
      .single();
    
    if (loginRecord) {
      return res.json({
        success: false,
        message: 'Already claimed today!'
      });
    }
    
    await supabase
      .from('daily_logins')
      .insert({ user_id: req.user.id, login_date: today });
    
    const streak = await calculateLoginStreak(req.user.id);
    const bonusPoints = streak >= 7 ? 20 : streak >= 3 ? 15 : 10;
    const reward = await awardPoints(req.user.id, bonusPoints, `Daily Login (${streak} day streak)`);
    
    res.json({
      success: true,
      message: `+${bonusPoints} points earned!`,
      reward
    });
  } catch (error) {
    console.error('Daily login error:', error);
    res.status(500).json({ error: 'Failed to claim daily reward' });
  }
});

app.post('/api/rewards/share', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const { data: shareRecord } = await supabase
      .from('share_tracking')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('share_date', today)
      .single();
    
    if (shareRecord) {
      return res.json({ 
        success: false, 
        message: 'You already earned share points today!' 
      });
    }
    
    await supabase
      .from('share_tracking')
      .insert({ user_id: req.user.id, share_date: today });
    
    const result = await awardPoints(req.user.id, 50, 'Shared VibeXpert');
    
    res.json({
      success: true,
      message: '🎉 +50 points for sharing!',
      reward: result
    });
  } catch (error) {
    console.error('Share reward error:', error);
    res.status(500).json({ error: 'Failed to process share reward' });
  }
});

app.get('/api/rewards/leaderboard', authenticateToken, async (req, res) => {
  try {
    const { period = 'weekly' } = req.query;
    
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, profile_pic, college, reward_points')
      .order('reward_points', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    
    res.json({
      success: true,
      users: users || [],
      period
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

app.get('/api/rewards/shop', authenticateToken, async (req, res) => {
  try {
    const shopItems = [
      {
        id: 'profile_frame_gold',
        name: 'Golden Profile Frame',
        description: 'Stand out with a luxurious golden frame',
        price: 500,
        category: 'profile',
        icon: '🖼️',
        preview: '✨'
      },
      {
        id: 'username_color_blue',
        name: 'Blue Username Color',
        description: 'Change your username color to vibrant blue',
        price: 300,
        category: 'username',
        icon: '🔵',
        preview: '🎨'
      },
      {
        id: 'badge_verified',
        name: 'Verified Badge',
        description: 'Get the exclusive verified checkmark',
        price: 1000,
        category: 'badge',
        icon: '✅',
        preview: '✓'
      }
    ];
    
    const { data: purchases } = await supabase
      .from('shop_purchases')
      .select('item_id')
      .eq('user_id', req.user.id);
    
    const purchasedIds = purchases?.map(p => p.item_id) || [];
    
    const itemsWithOwnership = shopItems.map(item => ({
      ...item,
      owned: purchasedIds.includes(item.id)
    }));
    
    res.json({
      success: true,
      items: itemsWithOwnership
    });
  } catch (error) {
    console.error('Shop items error:', error);
    res.status(500).json({ error: 'Failed to fetch shop items' });
  }
});

app.post('/api/rewards/shop/purchase', authenticateToken, async (req, res) => {
  try {
    const { itemId } = req.body;
    
    const shopItems = [
      { id: 'profile_frame_gold', name: 'Golden Profile Frame', price: 500 },
      { id: 'username_color_blue', name: 'Blue Username Color', price: 300 },
      { id: 'badge_verified', name: 'Verified Badge', price: 1000 }
    ];
    
    const item = shopItems.find(i => i.id === itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    const { data: existing } = await supabase
      .from('shop_purchases')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('item_id', itemId)
      .single();
    
    if (existing) {
      return res.status(400).json({ error: 'You already own this item' });
    }
    
    const { data: user } = await supabase
      .from('users')
      .select('reward_points')
      .eq('id', req.user.id)
      .single();
    
    if (user.reward_points < item.price) {
      return res.status(400).json({ error: 'Not enough points' });
    }
    
    const newPoints = user.reward_points - item.price;
    await supabase
      .from('users')
      .update({ reward_points: newPoints })
      .eq('id', req.user.id);
    
    await supabase
      .from('shop_purchases')
      .insert({
        user_id: req.user.id,
        item_id: itemId,
        price: item.price
      });
    
    await supabase
      .from('reward_history')
      .insert({
        user_id: req.user.id,
        points: -item.price,
        reason: `Purchased ${item.name}`,
        timestamp: new Date().toISOString()
      });
    
    res.json({
      success: true,
      message: `${item.name} purchased!`,
      item,
      newBalance: newPoints
    });
  } catch (error) {
    console.error('Purchase error:', error);
    res.status(500).json({ error: 'Purchase failed' });
  }
});

// College verification
app.post('/api/college/request-verification', authenticateToken, async (req, res) => {
  try {
    const { collegeName, collegeEmail } = req.body;
    const code = generateCode();
    
    await supabase
      .from('verification_codes')
      .insert({
        user_id: req.user.id,
        code,
        college_name: collegeName,
        college_email: collegeEmail,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });
    
    // Send email (you'll need to implement this with your email service)
    console.log(`Verification code for ${collegeEmail}: ${code}`);
    
    res.json({ success: true, message: 'Verification code sent!' });
  } catch (error) {
    console.error('Request verification error:', error);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/college/verify', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    const { data: verification, error } = await supabase
      .from('verification_codes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('code', code)
      .single();
    
    if (error || !verification) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }
    
    if (new Date(verification.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Verification code expired' });
    }
    
    await supabase
      .from('users')
      .update({ 
        college: verification.college_name,
        communityJoined: true 
      })
      .eq('id', req.user.id);
    
    await supabase
      .from('verification_codes')
      .delete()
      .eq('user_id', req.user.id);
    
    // Award points for joining college
    const reward = await awardPoints(req.user.id, 100, 'Joined college community');
    
    res.json({ 
      success: true, 
      message: 'College verified!',
      college: verification.college_name,
      reward
    });
  } catch (error) {
    console.error('Verify college error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Forgot password
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    const { data: user } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', email)
      .single();
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const code = generateCode();
    
    await supabase
      .from('password_reset_codes')
      .insert({
        user_id: user.id,
        code,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });
    
    console.log(`Password reset code for ${email}: ${code}`);
    
    res.json({ success: true, message: 'Reset code sent to email' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send reset code' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const { data: resetCode } = await supabase
      .from('password_reset_codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .single();
    
    if (!resetCode) {
      return res.status(400).json({ error: 'Invalid reset code' });
    }
    
    if (new Date(resetCode.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Reset code expired' });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    await supabase
      .from('users')
      .update({ password: hashedPassword })
      .eq('id', user.id);
    
    await supabase
      .from('password_reset_codes')
      .delete()
      .eq('user_id', user.id);
    
    res.json({ success: true, message: 'Password reset successful!' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// Community messages
app.get('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    if (!req.user.college) {
      return res.json({ success: true, messages: [] });
    }
    
    const { data: messages, error } = await supabase
      .from('community_messages')
      .select(`
        *,
        users (id, username, profile_pic)
      `)
      .eq('college', req.user.college)
      .order('timestamp', { ascending: true })
      .limit(100);
    
    if (error) throw error;
    
    res.json({ success: true, messages });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/community/messages', authenticateToken, async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!req.user.college) {
      return res.status(400).json({ error: 'Join a college first' });
    }
    
    const { data: message, error } = await supabase
      .from('community_messages')
      .insert({
        sender_id: req.user.id,
        college: req.user.college,
        content,
        timestamp: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, message });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join_college', (college) => {
    socket.join(college);
    console.log(`User joined college: ${college}`);
  });
  
  socket.on('user_online', (userId) => {
    socket.userId = userId;
    io.emit('online_count', io.engine.clientsCount);
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    io.emit('online_count', io.engine.clientsCount);
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 VibeXpert Backend running on port ${PORT}`);
  console.log(`✅ All routes initialized`);
  console.log(`✅ Rewards system active`);
});
