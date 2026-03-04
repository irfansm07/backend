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

// Add at top of server.js after io initialization
const userSockets = new Map(); // userId -> socketId
// Ghost name uniqueness tracking per college: Map<collegeName, Map<ghostName_lowercase, userId>>
const collegeGhostNames = new Map();

function registerGhostName(userId, collegeName, ghostName) {
    if (!collegeName || !ghostName) return { success: false, error: 'Missing college or ghost name' };
    const lower = ghostName.trim().toLowerCase();
    if (!collegeGhostNames.has(collegeName)) collegeGhostNames.set(collegeName, new Map());
    const collegeMap = collegeGhostNames.get(collegeName);
    // Check if this ghost name is already taken by someone else
    const existingUserId = collegeMap.get(lower);
    if (existingUserId && existingUserId !== userId) {
        return { success: false, error: `Ghost name "${ghostName}" is already taken in your college. Choose a different name!` };
    }
    // Release any old ghost name this user had in this college
    for (const [name, uid] of collegeMap.entries()) {
        if (uid === userId) { collegeMap.delete(name); break; }
    }
    collegeMap.set(lower, userId);
    return { success: true };
}

function releaseGhostName(userId, collegeName) {
    if (!collegeName || !collegeGhostNames.has(collegeName)) return;
    const collegeMap = collegeGhostNames.get(collegeName);
    for (const [name, uid] of collegeMap.entries()) {
        if (uid === userId) { collegeMap.delete(name); break; }
    }
}


io.on('connection', (socket) => {
    console.log('⚡ User connected:', socket.id);

    // user_online is handled later in this block (see presence sync section)

    socket.on('join_college', (collegeName) => {
        if (collegeName && typeof collegeName === 'string') {
            [...socket.rooms].forEach(room => {
                if (room !== socket.id) socket.leave(room);
            });
            socket.join(collegeName);
            socket.data.college = collegeName;
            console.log(`🧑‍🤝‍🧑 User ${socket.id} joined: ${collegeName}`);

            const roomSize = io.sockets.adapter.rooms.get(collegeName)?.size || 0;
            io.to(collegeName).emit('online_count', roomSize);
        }
    });

    // Ghost name registration from client
    socket.on('register_ghost_name', ({ userId, collegeName, ghostName }) => {
        if (!userId || !collegeName || !ghostName) return;
        const result = registerGhostName(userId, collegeName, ghostName);
        socket.emit('ghost_name_result', result);
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

    // ✅ SEEN BY — when a user views the chat, broadcast to the room
    socket.on('mark_seen', (data) => {
        if (data.collegeName && data.username && data.lastMsgId) {
            socket.data.username = data.username;
            // Broadcast to everyone ELSE in the room so sender sees blue ticks
            socket.to(data.collegeName).emit('messages_seen', {
                username: data.username,
                avatar: data.avatar || '👤',
                lastMsgId: data.lastMsgId
            });
        }
    });

    // ── Presence: mark user online (null last_seen = online) ──────────────────
    socket.on('user_online', async (userId) => {
        socket.data.userId = userId;
        userSockets.set(userId, socket.id);
        console.log(`📍 User ${userId} mapped to socket ${socket.id}`);
        await supabase.from('users').update({ last_seen: null }).eq('id', userId);
        io.emit('user_online_broadcast', { userId });
    });

    // ── DM Typing proxy ────────────────────────────────────────────────────────
    socket.on('dm_typing', ({ receiverId }) => {
        const receiverSocketId = userSockets.get(receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('dm_typing', { senderId: socket.data.userId });
        }
    });
    socket.on('dm_stop_typing', ({ receiverId }) => {
        const receiverSocketId = userSockets.get(receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('dm_stop_typing', { senderId: socket.data.userId });
        }
    });

    // ── Executive Chat: join college executive room ────────────────
    socket.on('join_executive', (collegeName) => {
        if (collegeName && typeof collegeName === 'string') {
            socket.join(`exec_${collegeName}`);
            socket.data.execCollege = collegeName;
            console.log(`🎓 User ${socket.id} joined executive room: exec_${collegeName}`);
        }
    });

    // ── Executive Chat: typing events ─────────────────────────────
    socket.on('exec_typing', (data) => {
        if (data.collegeName && data.username) {
            socket.to(`exec_${data.collegeName}`).emit('exec_user_typing', {
                username: data.username,
                avatar: data.avatar || null
            });
        }
    });

    socket.on('exec_stop_typing', (data) => {
        if (data.collegeName && data.username) {
            socket.to(`exec_${data.collegeName}`).emit('exec_user_stop_typing', {
                username: data.username
            });
        }
    });

    // ── Executive Chat: read receipts ──────────────────────────────
    socket.on('exec_mark_seen', (data) => {
        if (data.collegeName && data.userId && data.messageIds?.length) {
            socket.to(`exec_${data.collegeName}`).emit('exec_messages_seen', {
                userId: data.userId,
                username: data.username,
                avatar: data.avatar || null,
                messageIds: data.messageIds
            });
        }
    });

    // ── Executive Chat: reaction broadcast ────────────────────────
    socket.on('exec_reaction_update', (data) => {
        if (data.collegeName && data.messageId) {
            socket.to(`exec_${data.collegeName}`).emit('exec_reaction_update', data);
        }
    });

    // ── Executive Chat: poll vote broadcast ───────────────────────
    socket.on('exec_poll_voted', (data) => {
        if (data.collegeName && data.pollId) {
            socket.to(`exec_${data.collegeName}`).emit('exec_poll_voted', data);
        }
    });

    socket.on('disconnect', () => {
        console.log('👋 User disconnected:', socket.id);
        // ✅ UPDATED: Clean up user socket mapping + mark offline
        if (socket.data.userId) {
            const offlineUserId = socket.data.userId;
            userSockets.delete(offlineUserId);
            console.log(`🗑️ Removed mapping for user ${offlineUserId}`);
            supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', offlineUserId)
                .then(() => io.emit('user_offline', { userId: offlineUserId }))
                .catch(console.error);
        }
        if (socket.data.college) {
            // Release ghost name on disconnect
            if (socket.data.userId) {
                releaseGhostName(socket.data.userId, socket.data.college);
            }
            const roomSize = io.sockets.adapter.rooms.get(socket.data.college)?.size || 0;
            io.to(socket.data.college).emit('online_count', roomSize);
        }
    });
});

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'User-Agent', 'X-Requested-With', 'x-admin-secret'],
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
        fileSize: 100 * 1024 * 1024, // 100 MB (matches Supabase bucket limit)
        files: 10
    },
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = [
            // Images
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'image/svg+xml', 'image/bmp', 'image/tiff', 'image/heic',
            // Videos
            'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
            'video/x-msvideo', 'video/x-matroska', 'video/mov',
            // Audio
            'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/webm',
            'audio/aac', 'audio/flac', 'audio/mp4', 'audio/x-wav',
            // Documents
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain', 'text/csv',
            // Archives
            'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed'
        ];
        if (allowedMimeTypes.includes(file.mimetype)) return cb(null, true);
        cb(new Error(`File type "${file.mimetype}" is not allowed. Supported: images, videos, audio, PDFs, documents, archives.`));
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

// ==================== MEDIA PROXY (fixes mobile data ISP blocking) ====================
// Indian mobile carriers (Jio/Airtel/Vi) often block/throttle *.supabase.co storage URLs.
// This proxy fetches media server-side (Render is unaffected) and streams it to the client.

app.get('/api/proxy/media', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'Missing url param' });

        // Only allow proxying from our own Supabase project to prevent abuse
        const supabaseHost = new URL(process.env.SUPABASE_URL).hostname;
        let targetUrl;
        try {
            targetUrl = new URL(url);
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }
        if (!targetUrl.hostname.endsWith('supabase.co') && targetUrl.hostname !== supabaseHost) {
            return res.status(403).json({ error: 'Only Supabase storage URLs are allowed' });
        }

        const response = await axios.get(url, {
            responseType: 'stream',
            timeout: 30000,
            headers: { 'User-Agent': 'VibeXpert-Proxy/1.0' }
        });

        // Pass through content type and cache headers
        res.set('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=86400'); // cache 24h on client
        res.set('Access-Control-Allow-Origin', '*');
        if (response.headers['content-length']) {
            res.set('Content-Length', response.headers['content-length']);
        }

        response.data.pipe(res);
    } catch (error) {
        console.error('❌ Media proxy error:', error.message);
        res.status(502).json({ error: 'Failed to fetch media' });
    }
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
            receipt: `rcpt_${req.user.id.slice(-8)}_${Date.now()}`,
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

// ==================== SHOP ORDER ENDPOINTS ====================

// Create order for vibexpert.shop product purchases
app.post('/api/shop/create-order', authenticateToken, async (req, res) => {
    try {
        const { items, totalAmount, shippingAddress } = req.body;

        if (!items || !items.length || !totalAmount) {
            return res.status(400).json({ error: 'Cart items and total amount are required' });
        }

        if (totalAmount < 1 || totalAmount > 500000) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        const options = {
            amount: Math.round(totalAmount * 100), // Razorpay expects paise
            currency: 'INR',
            receipt: `shop_${req.user.id.slice(-8)}_${Date.now()}`,
            notes: {
                userId: req.user.id,
                username: req.user.username,
                itemCount: items.length,
                source: 'vibexpert.shop'
            }
        };

        const order = await razorpay.orders.create(options);

        // Save order to database
        await supabase.from('shop_orders').insert([{
            user_id: req.user.id,
            order_id: order.id,
            items: JSON.stringify(items),
            total_amount: totalAmount,
            shipping_address: shippingAddress ? JSON.stringify(shippingAddress) : null,
            status: 'created'
        }]);

        console.log(`🛒 Shop order created: ${order.id} for user ${req.user.username} — ₹${totalAmount}`);

        res.json({
            success: true,
            orderId: order.id,
            amount: totalAmount,
            currency: 'INR',
            razorpayKeyId: process.env.RAZORPAY_KEY_ID
        });

    } catch (error) {
        console.error('❌ Shop create order error:', error);
        res.status(500).json({ error: 'Failed to create shop order' });
    }
});

// Verify payment for vibexpert.shop product purchases
app.post('/api/shop/verify-payment', authenticateToken, async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            shippingAddress
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment details' });
        }

        // Verify signature
        const generated_signature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            console.error('❌ Invalid shop payment signature');
            await supabase
                .from('shop_orders')
                .update({ status: 'failed', updated_at: new Date().toISOString() })
                .eq('order_id', razorpay_order_id);

            return res.status(400).json({ success: false, error: 'Invalid payment signature' });
        }

        // Update order status
        const updateData = {
            payment_id: razorpay_payment_id,
            signature: razorpay_signature,
            status: 'paid',
            updated_at: new Date().toISOString()
        };
        if (shippingAddress) {
            updateData.shipping_address = JSON.stringify(shippingAddress);
        }

        await supabase
            .from('shop_orders')
            .update(updateData)
            .eq('order_id', razorpay_order_id);

        // Fetch order details for email
        const { data: orderData } = await supabase
            .from('shop_orders')
            .select('*')
            .eq('order_id', razorpay_order_id)
            .single();

        let itemsList = '';
        try {
            const items = JSON.parse(orderData.items);
            itemsList = items.map(i =>
                `<li>${i.name} × ${i.quantity} — ₹${(i.price * i.quantity).toLocaleString()}</li>`
            ).join('');
        } catch { itemsList = '<li>Your items</li>'; }

        // Send confirmation email
        sendEmail(
            req.user.email,
            '🛍️ Order Confirmed — VibExpert Shop',
            `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h1 style="color: #7c3aed;">Order Confirmed! 🎉</h1>
              <p style="font-size: 16px;">Hi ${req.user.username},</p>
              <p>Your order has been placed successfully.</p>
              
              <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin-top: 0;">Order Details:</h3>
                <ul>${itemsList}</ul>
                <p style="font-weight: bold; font-size: 18px; margin-bottom: 0;">
                  Total: ₹${orderData.total_amount.toLocaleString()}
                </p>
              </div>
              
              <p style="font-size: 14px; color: #6B7280;">
                Order ID: ${razorpay_order_id}<br>
                Payment ID: ${razorpay_payment_id}
              </p>
              
              <p>We'll notify you once your order ships!</p>
              
              <p style="margin-top: 30px;">
                Best regards,<br>
                Team VibExpert Shop
              </p>
            </div>
          `
        );

        console.log(`✅ Shop payment verified: ${razorpay_payment_id} for user ${req.user.username}`);

        res.json({
            success: true,
            message: 'Payment verified — your order has been placed!',
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id
        });

    } catch (error) {
        console.error('❌ Shop payment verification error:', error);
        res.status(500).json({ error: 'Payment verification failed' });
    }
});

// Get order history for vibexpert.shop
app.get('/api/shop/orders', authenticateToken, async (req, res) => {
    try {
        const { data: orders } = await supabase
            .from('shop_orders')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        res.json({ success: true, orders: orders || [] });
    } catch (error) {
        console.error('❌ Shop orders fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch order history' });
    }
});

// ==================== ADMIN ENDPOINTS ====================

// Get all shop orders for Admin Panel
app.get('/api/admin/shop-orders', authenticateToken, async (req, res) => {
    try {
        // SECURITY: Hardcoded admin email
        const ADMIN_EMAIL = 'smirfan9247@gmail.com';

        if (req.user.email !== ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Access denied. Only admins can view this data.' });
        }

        const { data: orders, error } = await supabase
            .from('shop_orders')
            .select(`
                *,
                users (
                    username,
                    email
                )
            `)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Supabase error:', error);
            throw error;
        }

        res.json({ success: true, orders: orders || [] });
    } catch (error) {
        console.error('❌ Admin fetch orders error:', error);
        res.status(500).json({ error: 'Failed to fetch all orders for admin' });
    }
});

// Update order status (Admin Panel)
app.put('/api/admin/shop-orders/:orderId/status', authenticateToken, async (req, res) => {
    try {
        // SECURITY: Hardcoded admin email
        const ADMIN_EMAIL = 'smirfan9247@gmail.com';

        if (req.user.email !== ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Access denied. Only admins can update orders.' });
        }

        const { orderId } = req.params;
        const { status } = req.body;

        const { error } = await supabase
            .from('shop_orders')
            .update({ status, updated_at: new Date().toISOString() })
            .eq('order_id', orderId);

        if (error) {
            console.error('Supabase error:', error);
            throw error;
        }

        res.json({ success: true, message: 'Order status successfully updated!' });
    } catch (error) {
        console.error('❌ Admin order update error:', error);
        res.status(500).json({ error: 'Failed to update order status' });
    }
});


// ==================== SSO (SINGLE SIGN-ON) ENDPOINTS ====================

// Generate a short-lived SSO token for cross-domain authentication
app.post('/api/sso/generate-token', authenticateToken, async (req, res) => {
    try {
        const ssoToken = jwt.sign(
            { userId: req.user.id, email: req.user.email, purpose: 'sso' },
            process.env.JWT_SECRET,
            { expiresIn: '60s' } // Very short-lived for security
        );

        console.log(`🔐 SSO token generated for user ${req.user.username}`);
        res.json({ success: true, ssoToken });
    } catch (error) {
        console.error('❌ SSO token generation error:', error);
        res.status(500).json({ error: 'Failed to generate SSO token' });
    }
});

// Verify SSO token and return full user session (public endpoint — no auth required)
app.post('/api/sso/verify-token', async (req, res) => {
    try {
        const { ssoToken } = req.body;

        if (!ssoToken) {
            return res.status(400).json({ error: 'SSO token required' });
        }

        // Verify the SSO token
        const decoded = jwt.verify(ssoToken, process.env.JWT_SECRET);

        // Ensure this is an SSO-purpose token
        if (decoded.purpose !== 'sso') {
            return res.status(403).json({ error: 'Invalid token purpose' });
        }

        // Fetch user from database
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', decoded.userId)
            .single();

        if (error || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Generate a regular auth token for the shop session
        const authToken = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log(`✅ SSO verified for user ${user.username} → vibexpert.shop`);

        res.json({
            success: true,
            token: authToken,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                college: user.college,
                profile_pic: user.profile_pic,
                bio: user.bio || '',
                isPremium: user.is_premium || false
            }
        });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'SSO token expired. Please try again from vibexpert.online.' });
        }
        console.error('❌ SSO verification error:', error);
        res.status(403).json({ error: 'Invalid SSO token' });
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

        // Run ALL queries in parallel instead of sequentially (7x faster)
        const [
            userResult,
            postCountResult,
            likeCountResult,
            isLikedResult,
            followersCountResult,
            followingCountResult,
            isFollowingResult,
            isFollowedByResult
        ] = await Promise.all([
            supabase.from('users')
                .select('id, username, email, registration_number, college, profile_pic, bio, badges, community_joined, created_at, note')
                .eq('id', userId).single(),
            supabase.from('posts')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', userId),
            supabase.from('profile_likes')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', userId),
            supabase.from('profile_likes')
                .select('id')
                .eq('user_id', userId)
                .eq('liker_id', req.user.id)
                .maybeSingle(),
            supabase.from('followers')
                .select('id', { count: 'exact', head: true })
                .eq('following_id', userId),
            supabase.from('followers')
                .select('id', { count: 'exact', head: true })
                .eq('follower_id', userId),
            supabase.from('followers')
                .select('id')
                .eq('follower_id', req.user.id)
                .eq('following_id', userId)
                .maybeSingle(),
            supabase.from('followers')
                .select('id')
                .eq('follower_id', userId)
                .eq('following_id', req.user.id)
                .maybeSingle()
        ]);

        const user = userResult.data;
        if (userResult.error || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const isMutualFollow = !!isFollowingResult.data && !!isFollowedByResult.data;

        res.json({
            success: true,
            user: {
                ...user,
                postCount: postCountResult.count || 0,
                followersCount: followersCountResult.count || 0,
                followingCount: followingCountResult.count || 0,
                profileLikes: likeCountResult.count || 0,
                isProfileLiked: !!isLikedResult.data,
                isFollowing: !!isFollowingResult.data,
                isFollowedBy: !!isFollowedByResult.data,
                isMutualFollow
            }
        });
    } catch (error) {
        console.error('❌ Get profile error:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// ✅ ADDED: Update User Profile
app.put('/api/profile/update', authenticateToken, async (req, res) => {
    try {
        const { username, bio, college, registration_number } = req.body;

        const updates = {};
        if (username) updates.username = username;
        if (bio !== undefined) updates.bio = bio;
        if (college) updates.college = college;
        if (registration_number) updates.registration_number = registration_number;

        const { data: updatedUser, error } = await supabase
            .from('users')
            .update(updates)
            .eq('id', req.user.id)
            .select()
            .single();

        if (error) throw error;

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user: updatedUser
        });

    } catch (error) {
        console.error('❌ Update profile error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});
// ✅ Save/Clear profile note (Instagram-style)
app.post('/api/profile/note', authenticateToken, async (req, res) => {
    try {
        const { note } = req.body;
        const cleanNote = (note || '').trim().slice(0, 30);

        await supabase
            .from('users')
            .update({ note: cleanNote || null })
            .eq('id', req.user.id);

        res.json({ success: true, note: cleanNote });
    } catch (error) {
        // note column might not exist yet — fail silently
        console.error('⚠️ Note save (non-critical):', error.message);
        res.json({ success: true, note: req.body.note || '' });
    }
});

// ✅ ADDED: Follow User
app.post('/api/follow/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;

        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot follow yourself' });
        }

        const { error } = await supabase
            .from('followers')
            .insert([{
                follower_id: req.user.id,
                following_id: userId
            }]);

        if (error) {
            if (error.code === '23505') { // Unique violation - already following, fetch real counts
                const { count: targetFollowers } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', userId);
                const { count: myFollowing } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', req.user.id);
                return res.json({ success: true, isFollowing: true, targetFollowersCount: targetFollowers || 0, myFollowingCount: myFollowing || 0 });
            }
            throw error;
        }

        // Return real counts after follow
        const { count: targetFollowers } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', userId);
        const { count: myFollowing } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', req.user.id);

        // Notify the followed user via socket (so their follower count updates live)
        const targetSocketId = userSockets.get(userId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('new_follow', {
                followerId: req.user.id,
                followerUsername: req.user.username,
                followerProfilePic: req.user.profile_pic || null,
                followingId: userId,
                newFollowersCount: targetFollowers || 0
            });
        }

        res.json({ success: true, isFollowing: true, targetFollowersCount: targetFollowers || 0, myFollowingCount: myFollowing || 0 });

    } catch (error) {
        console.error('❌ Follow error:', error);
        res.status(500).json({ error: 'Failed to follow user' });
    }
});

// ✅ ADDED: Unfollow User
app.post('/api/unfollow/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;

        const { error } = await supabase
            .from('followers')
            .delete()
            .eq('follower_id', req.user.id)
            .eq('following_id', userId);

        if (error) throw error;

        // Return real counts after unfollow
        const { count: targetFollowers } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', userId);
        const { count: myFollowing } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', req.user.id);

        // Notify the unfollowed user via socket
        const targetSocketId = userSockets.get(userId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('lost_follow', {
                followerId: req.user.id,
                followingId: userId,
                newFollowersCount: targetFollowers || 0
            });
        }

        res.json({ success: true, isFollowing: false, targetFollowersCount: targetFollowers || 0, myFollowingCount: myFollowing || 0 });

    } catch (error) {
        console.error('❌ Unfollow error:', error);
        res.status(500).json({ error: 'Failed to unfollow user' });
    }
});

// ✅ ADDED: Get Followers List
app.get('/api/followers/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;

        // Get all follower_id entries where following_id = userId
        const { data: followerRows, error } = await supabase
            .from('followers')
            .select('follower_id, created_at')
            .eq('following_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!followerRows || followerRows.length === 0) {
            return res.json({ success: true, users: [], count: 0 });
        }

        // Fetch user details for each follower
        const followerIds = followerRows.map(r => r.follower_id);
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('id, username, profile_pic, bio, college')
            .in('id', followerIds);

        if (usersError) throw usersError;

        // Check which of these followers the current user is following back
        const { data: myFollowing } = await supabase
            .from('followers')
            .select('following_id')
            .eq('follower_id', req.user.id)
            .in('following_id', followerIds);

        const myFollowingSet = new Set((myFollowing || []).map(f => f.following_id));

        // Merge and maintain order
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });

        const result = followerRows
            .filter(r => userMap[r.follower_id])
            .map(r => ({
                ...userMap[r.follower_id],
                followedAt: r.created_at,
                isFollowedByMe: myFollowingSet.has(r.follower_id)
            }));

        res.json({ success: true, users: result, count: result.length });
    } catch (error) {
        console.error('❌ Get followers list error:', error);
        res.status(500).json({ error: 'Failed to fetch followers' });
    }
});

// ✅ ADDED: Get Following List
app.get('/api/following/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;

        // Get all following_id entries where follower_id = userId
        const { data: followingRows, error } = await supabase
            .from('followers')
            .select('following_id, created_at')
            .eq('follower_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!followingRows || followingRows.length === 0) {
            return res.json({ success: true, users: [], count: 0 });
        }

        // Fetch user details for each following
        const followingIds = followingRows.map(r => r.following_id);
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('id, username, profile_pic, bio, college')
            .in('id', followingIds);

        if (usersError) throw usersError;

        // Check which of these the current user is following
        const { data: myFollowing } = await supabase
            .from('followers')
            .select('following_id')
            .eq('follower_id', req.user.id)
            .in('following_id', followingIds);

        const myFollowingSet = new Set((myFollowing || []).map(f => f.following_id));

        // Merge and maintain order
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });

        const result = followingRows
            .filter(r => userMap[r.following_id])
            .map(r => ({
                ...userMap[r.following_id],
                followedAt: r.created_at,
                isFollowedByMe: myFollowingSet.has(r.following_id)
            }));

        res.json({ success: true, users: result, count: result.length });
    } catch (error) {
        console.error('❌ Get following list error:', error);
        res.status(500).json({ error: 'Failed to fetch following' });
    }
});

// ✅ FIXED: Changed registrationNumber to phoneNumber to match frontend
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password, registrationNumber, phoneNumber } = req.body;
        const regNumber = registrationNumber || phoneNumber || `auto_${Date.now()}`;

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
                password_hash: passwordHash,
                registration_number: regNumber
            }])
            .select()
            .single();

        if (error) {
            console.error('Database error during user creation:', error);
            if (error.code === '23505') {
                return res.status(400).json({ error: 'User already exists with this email or phone number' });
            }
            if (error.message.includes('column') && error.message.includes('does not exist')) {
                return res.status(500).json({ error: 'Database schema error. Please contact support.' });
            }
            throw new Error('Failed to create account: ' + error.message);
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

        // Fetch counts
        const { count: followersCount } = await supabase
            .from('followers')
            .select('id', { count: 'exact', head: true })
            .eq('following_id', user.id);

        const { count: followingCount } = await supabase
            .from('followers')
            .select('id', { count: 'exact', head: true })
            .eq('follower_id', user.id);

        const { count: postCount } = await supabase
            .from('posts')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id);

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
                subscriptionPlan: user.subscription_plan || null,
                followersCount: followersCount || 0,
                followingCount: followingCount || 0,
                postCount: postCount || 0
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

// ── My Vibes: current user's posts only ───────────────────────
app.get('/api/posts/my', authenticateToken, async (req, res) => {
    try {
        const { data: posts, error } = await supabase
            .from('posts')
            .select(`
                *,
                users:user_id (
                  id, username, profile_pic, college
                )
            `)
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const postsWithCounts = await Promise.all(
            (posts || []).map(async (post) => {
                const [{ count: likeCount }, { count: commentCount }, { count: shareCount }] =
                    await Promise.all([
                        supabase.from('post_likes').select('id', { count: 'exact', head: true }).eq('post_id', post.id),
                        supabase.from('post_comments').select('id', { count: 'exact', head: true }).eq('post_id', post.id),
                        supabase.from('post_shares').select('id', { count: 'exact', head: true }).eq('post_id', post.id),
                    ]);
                return { ...post, like_count: likeCount || 0, comment_count: commentCount || 0, share_count: shareCount || 0, is_liked: false };
            })
        );

        res.json({ success: true, posts: postsWithCounts });
    } catch (error) {
        console.error('❌ My posts error:', error);
        res.status(500).json({ error: 'Failed to load your posts' });
    }
});

// ── Get posts by any user ID (for viewing other profiles) ──────
app.get('/api/posts/user/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;

        const { data: posts, error } = await supabase
            .from('posts')
            .select(`
                *,
                users:user_id (
                  id, username, profile_pic, college
                )
            `)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const postsWithCounts = await Promise.all(
            (posts || []).map(async (post) => {
                const [{ count: likeCount }, { count: commentCount }, { count: shareCount }] =
                    await Promise.all([
                        supabase.from('post_likes').select('id', { count: 'exact', head: true }).eq('post_id', post.id),
                        supabase.from('post_comments').select('id', { count: 'exact', head: true }).eq('post_id', post.id),
                        supabase.from('post_shares').select('id', { count: 'exact', head: true }).eq('post_id', post.id),
                    ]);
                const { data: isLiked } = await supabase
                    .from('post_likes').select('id')
                    .eq('post_id', post.id).eq('user_id', req.user.id).maybeSingle();
                return { ...post, like_count: likeCount || 0, comment_count: commentCount || 0, share_count: shareCount || 0, is_liked: !!isLiked };
            })
        );

        res.json({ success: true, posts: postsWithCounts });
    } catch (error) {
        console.error('❌ User posts error:', error);
        res.status(500).json({ error: 'Failed to load user posts' });
    }
});

// ── Edit post caption ──────────────────────────────────────────
app.patch('/api/posts/:postId', authenticateToken, async (req, res) => {
    try {
        const { postId } = req.params;
        const { content } = req.body;

        // Verify ownership
        const { data: existing } = await supabase
            .from('posts').select('user_id').eq('id', postId).single();

        if (!existing || existing.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const { data: updated, error } = await supabase
            .from('posts')
            .update({ content: content ?? '' })
            .eq('id', postId)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, post: updated });
    } catch (error) {
        console.error('❌ Edit post error:', error);
        res.status(500).json({ error: 'Failed to update post' });
    }
});

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

                // Check if current user follows this post's author
                let isFollowingAuthor = false;
                if (post.user_id && post.user_id !== req.user.id) {
                    const { data: followCheck } = await supabase
                        .from('followers')
                        .select('id')
                        .eq('follower_id', req.user.id)
                        .eq('following_id', post.user_id)
                        .maybeSingle();
                    isFollowingAuthor = !!followCheck;
                }

                return {
                    ...post,
                    like_count: likeCount || 0,
                    comment_count: commentCount || 0,
                    share_count: shareCount || 0,
                    is_liked: !!isLiked,
                    is_following_author: isFollowingAuthor
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

        // ── Real-time: build enriched post and broadcast to EVERY connected user ──
        const enrichedPost = {
            ...post,
            like_count: 0,
            comment_count: 0,
            share_count: 0,
            is_liked: false,
            users: {
                id: req.user.id,
                username: req.user.username,
                profile_pic: req.user.profile_pic || null,
                college: req.user.college || null
            }
        };
        // Emit to ALL sockets — posts are visible to everyone regardless of college
        io.emit('new_post', enrichedPost);
        console.log(`📢 [new_post] broadcast by ${req.user.username}`);

        res.json({
            success: true,
            post: enrichedPost,
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

            io.emit('post_liked', { postId, likeCount: likeCount || 0, liked: false });
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

        io.emit('post_liked', { postId, likeCount: likeCount || 0, liked: true });
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

        // Broadcast updated comment count to all users
        const { count: commentCount } = await supabase
            .from('post_comments')
            .select('id', { count: 'exact', head: true })
            .eq('post_id', postId);
        io.emit('post_commented', { postId, commentCount: commentCount || 0 });

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

        io.emit('post_shared', { postId, shareCount: shareCount || 0 });
        res.json({ success: true, shareCount: shareCount || 0 });
    } catch (error) {
        console.error('❌ Share error:', error);
        res.status(500).json({ error: 'Failed to share post' });
    }
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

        // ✅ FIXED: Only get messages from last 5 days
        const fiveDaysAgo = new Date();
        fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

        // STEP 1: Get messages (no join - avoids FK relationship errors)
        const { data: messages, error } = await supabase
            .from('community_messages')
            .select('*')
            .eq('college_name', req.user.college)
            .gte('created_at', fiveDaysAgo.toISOString())
            .order('created_at', { ascending: true })
            .limit(500);  // Show last 500 messages (10,000/day limit enforced by DB)

        if (error) {
            console.error('❌ GET messages error code:', error.code);
            console.error('❌ GET messages error:', error.message);
            throw error;
        }

        // STEP 2: Enrich with sender info
        let enrichedMessages = messages || [];
        if (enrichedMessages.length > 0) {
            const senderIds = [...new Set(enrichedMessages.map(m => m.sender_id))];
            const { data: users } = await supabase
                .from('users')
                .select('id, username, profile_pic')
                .in('id', senderIds);

            const userMap = {};
            (users || []).forEach(u => { userMap[u.id] = u; });

            enrichedMessages = enrichedMessages.map(msg => {
                const realUser = userMap[msg.sender_id] || { id: msg.sender_id, username: 'User', profile_pic: null };
                // Use anon_name for display — never expose real username/avatar in institute chat
                const displayName = msg.anon_name || '👻 Anonymous';
                return {
                    ...msg,
                    users: {
                        id: realUser.id,
                        username: displayName,   // ghost name shown to everyone
                        profile_pic: null         // no avatar in community chat
                    }
                };
            });
        }

        // STEP 3: Enrich reply_to data for messages that are replies
        const replyToIds = [...new Set(enrichedMessages.filter(m => m.reply_to_id).map(m => m.reply_to_id))];
        if (replyToIds.length > 0) {
            const { data: replyMsgs } = await supabase
                .from('community_messages')
                .select('id, content, sender_id, media_type, media_url')
                .in('id', replyToIds);

            // Build a sender name map for reply senders
            const replyMsgMap = {};
            if (replyMsgs && replyMsgs.length > 0) {
                const replySenderIds = [...new Set(replyMsgs.map(m => m.sender_id))];
                const { data: replyUsers } = await supabase
                    .from('users')
                    .select('id, username')
                    .in('id', replySenderIds);
                const replyUserMap = {};
                (replyUsers || []).forEach(u => { replyUserMap[u.id] = u; });
                replyMsgs.forEach(m => {
                    replyMsgMap[m.id] = {
                        ...m,
                        sender_username: (replyUserMap[m.sender_id] && replyUserMap[m.sender_id].username) || 'User'
                    };
                });
            }

            enrichedMessages = enrichedMessages.map(msg => ({
                ...msg,
                reply_to: msg.reply_to_id ? (replyMsgMap[msg.reply_to_id] || null) : null
            }));
        }

        console.log(`✅ Loaded ${enrichedMessages.length} messages (last 5 days)`);

        res.json({
            success: true,
            messages: enrichedMessages
        });

    } catch (error) {
        console.error('❌ Get messages error:', error);
        res.status(500).json({
            error: 'Failed to load messages',
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

app.post('/api/community/messages', authenticateToken, (req, res, next) => {
    // Only use multer if there's a file
    if (req.headers['content-type']?.includes('multipart/form-data')) {
        upload.single('media')(req, res, next);
    } else {
        next();
    }
}, async (req, res) => {
    try {
        const { content } = req.body;
        const media = req.file;

        console.log('📨 POST Message:', {
            user: req.user.username,
            college: req.user.college,
            contentLength: content?.length,
            hasMedia: !!media
        });

        if (!content && !media) {
            return res.status(400).json({ error: 'Message content or media required' });
        }

        if (!req.user.community_joined || !req.user.college) {
            return res.status(400).json({ error: 'Join a college community first' });
        }

        let mediaUrl = null;
        let mediaType = null;

        if (media) {
            // Sanitize filename — remove spaces/special chars that break Supabase URLs
            const safeName = media.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
            const fileName = `chat/${Date.now()}_${safeName}`;

            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('chat-media')
                .upload(fileName, media.buffer, {
                    contentType: media.mimetype,
                    upsert: false
                });

            if (uploadError) {
                console.error('❌ Media upload error:', uploadError);
                return res.status(500).json({
                    error: 'Media upload failed: ' + uploadError.message,
                    hint: 'Make sure the chat-media bucket exists in Supabase Storage and is set to Public.'
                });
            }

            const { data: { publicUrl } } = supabase.storage
                .from('chat-media')
                .getPublicUrl(fileName);

            mediaUrl = publicUrl;
            // media_type: used for rendering (can be 'pdf', 'image', 'video', 'audio', 'document')
            if (media.mimetype.startsWith('video/')) mediaType = 'video';
            else if (media.mimetype.startsWith('audio/')) mediaType = 'audio';
            else if (media.mimetype === 'application/pdf') mediaType = 'pdf';
            else if (media.mimetype.startsWith('application/') || media.mimetype.startsWith('text/')) mediaType = 'document';
            else mediaType = 'image';
            console.log('✅ Media uploaded to chat-media bucket:', mediaUrl, '| type:', mediaType);
        }

        // ── Ghost name: validate + uniqueness check ────
        const rawAnonName = req.body.anon_name;
        let anonName = null;
        if (rawAnonName && typeof rawAnonName === 'string') {
            anonName = rawAnonName.trim().slice(0, 30);
            if (anonName.length < 2) anonName = null;
        }
        if (!anonName) {
            return res.status(400).json({ error: 'Ghost name is required. Please set your ghost name before chatting.' });
        }
        // Enforce uniqueness per college
        const ghostCheckResult = registerGhostName(req.user.id, req.user.college, anonName);
        if (!ghostCheckResult.success) {
            return res.status(409).json({ error: ghostCheckResult.error, code: 'GHOST_NAME_TAKEN' });
        }

        // STEP 1: Insert the message first (no join - simpler, less failure points)
        const { data: insertedMsg, error: insertError } = await supabase
            .from('community_messages')
            .insert([{
                sender_id: req.user.id,
                college_name: req.user.college,
                content: content?.trim() || '',
                media_url: mediaUrl,
                media_type: mediaType,
                anon_name: anonName,
                // message_type must match DB CHECK: 'text','image','video','audio','document',...
                message_type: mediaUrl
                    ? (mediaType === 'video' ? 'video'
                        : mediaType === 'audio' ? 'audio'
                            : mediaType === 'image' ? 'image'
                                : 'document')
                    : 'text',
                media_name: media ? media.originalname : null,
                media_size: media ? media.size : null,
                reply_to_id: (req.body.reply_to_id && req.body.reply_to_id !== 'null' && req.body.reply_to_id !== 'undefined')
                    ? req.body.reply_to_id : null
            }])
            .select('*')
            .single();

        if (insertError) {
            console.error('❌ INSERT error code:', insertError.code);
            console.error('❌ INSERT error message:', insertError.message);
            console.error('❌ INSERT error details:', insertError.details);
            console.error('❌ INSERT error hint:', insertError.hint);

            // Daily limit hit — trigger raises ERRCODE 'check_violation' (23514)
            // or the message contains our custom text
            const isLimitError =
                insertError.code === '23514' ||
                (insertError.message || '').toLowerCase().includes('daily message limit');

            if (isLimitError) {
                return res.status(429).json({
                    error: '🚫 Daily limit reached! Your college has sent 10,000 messages today. Chat resets at midnight (UTC). Come back tomorrow! 🌙',
                    code: 'DAILY_LIMIT_REACHED',
                    limit: 10000,
                    resets: 'midnight UTC'
                });
            }

            throw insertError;
        }

        console.log('✅ Message saved:', insertedMsg.id);

        // STEP 2: Fetch user info separately (join done as a second query)
        const { data: senderInfo } = await supabase
            .from('users')
            .select('id, username, profile_pic')
            .eq('id', req.user.id)
            .single();

        // Fetch reply_to data if this message is a reply
        let replyToData = null;
        if (insertedMsg.reply_to_id) {
            const { data: replyMsg } = await supabase
                .from('community_messages')
                .select('id, content, sender_id, media_type, media_url')
                .eq('id', insertedMsg.reply_to_id)
                .single();
            if (replyMsg) {
                const { data: replyUser } = await supabase
                    .from('users')
                    .select('username')
                    .eq('id', replyMsg.sender_id)
                    .single();
                replyToData = { ...replyMsg, sender_username: replyUser ? replyUser.username : 'User' };
            }
        }

        // Build final message object — use anon_name, never expose real identity
        const displayName = anonName || '👻 Anonymous';
        const message = {
            ...insertedMsg,
            anon_name: anonName,
            users: {
                id: req.user.id,
                username: displayName,   // ghost name for display
                profile_pic: null         // no real avatar in community chat
            },
            reply_to: replyToData
        };

        // Broadcast to college room
        const senderSocketId = userSockets.get(req.user.id);
        if (senderSocketId) {
            io.to(req.user.college).except(senderSocketId).emit('new_message', message);
        } else {
            io.to(req.user.college).emit('new_message', message);
        }

        res.json({ success: true, message });

    } catch (error) {
        console.error('❌ Send message error:', error);
        res.status(500).json({
            error: 'Failed to send message',
            details: error.message,
            // Include Supabase-specific error info for easier debugging
            code: error.code || null,
            hint: error.hint || null
        });
    }
});


// ==================== DM ENDPOINTS ====================

// GET /api/dm/status — quick check that DM tables exist
app.get('/api/dm/status', authenticateToken, async (req, res) => {
    try {
        await supabase.from('direct_messages').select('id').limit(1);
        await supabase.from('dm_conversations').select('id').limit(1);
        res.json({ success: true, ready: true });
    } catch (error) {
        const missing = error.code === '42P01' || (error.message || '').includes('does not exist');
        res.json({ success: true, ready: false, reason: missing ? 'tables_missing' : error.message });
    }
});

// GET /api/dm/conversations — list conversations with unread counts for current user
app.get('/api/dm/conversations', authenticateToken, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: convs, error } = await supabase
            .from('dm_conversations')
            .select('*')
            .or(`user1_id.eq.${uid},user2_id.eq.${uid}`)
            .order('last_message_at', { ascending: false });

        if (error) {
            const isTableMissing = error.code === '42P01' || (error.message || '').includes('does not exist');
            if (isTableMissing) {
                console.warn('⚠️  dm_conversations table not found — run database.sql migration');
                return res.json({ success: true, conversations: [] });
            }
            throw error;
        }

        const enriched = await Promise.all((convs || []).map(async (conv) => {
            const otherId = conv.user1_id === uid ? conv.user2_id : conv.user1_id;
            const unreadCount = conv.user1_id === uid ? conv.unread_count_user1 : conv.unread_count_user2;
            const { data: other } = await supabase
                .from('users')
                .select('id, username, profile_pic, last_seen, status_text')
                .eq('id', otherId)
                .single();
            return { ...conv, otherUser: other, unreadCount };
        }));

        res.json({ success: true, conversations: enriched });
    } catch (error) {
        console.error('❌ DM conversations error:', error);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

// POST /api/dm/send — send a DM (handles media upload + upserts conversation)
app.post('/api/dm/send', authenticateToken, upload.single('media'), async (req, res) => {
    try {
        const { receiverId, content, replyToId } = req.body;
        if (!receiverId) return res.status(400).json({ error: 'receiverId required' });
        if (!content && !req.file) return res.status(400).json({ error: 'Content or media required' });

        const senderId = req.user.id;
        let mediaUrl = null;
        let mediaType = null;

        if (req.file) {
            const fileName = `dm/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const { error: upErr } = await supabase.storage.from('chat-media').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
            if (upErr) throw upErr;
            const { data: { publicUrl } } = supabase.storage.from('chat-media').getPublicUrl(fileName);
            mediaUrl = publicUrl;
            if (req.file.mimetype.startsWith('video/')) mediaType = 'video';
            else if (req.file.mimetype.startsWith('audio/')) mediaType = 'audio';
            else if (req.file.mimetype === 'application/pdf') mediaType = 'pdf';
            else mediaType = 'image';
        }

        // Insert the message
        const insertPayload = {
            sender_id: senderId,
            receiver_id: receiverId,
            content: content?.trim() || '',
            media_url: mediaUrl,
            media_type: mediaType
        };
        if (replyToId && replyToId !== 'null' && replyToId !== 'undefined') {
            insertPayload.reply_to_id = replyToId;
        }
        const { data: dm, error: dmErr } = await supabase
            .from('direct_messages')
            .insert([insertPayload])
            .select()
            .single();

        if (dmErr) {
            const isTableMissing = dmErr.code === '42P01' || (dmErr.message || '').includes('does not exist');
            if (isTableMissing) {
                return res.status(503).json({ error: 'DM tables not set up yet. Please run the database.sql migration in Supabase.' });
            }
            throw dmErr;
        }

        // Conversation tracking — non-critical, don't fail the whole request
        try {
            const [u1, u2] = [senderId, receiverId].sort();
            const isUser1Sender = u1 === senderId;
            const lastMsg = content?.trim() || (mediaType ? `[${mediaType}]` : '');

            const { data: existingConv } = await supabase
                .from('dm_conversations')
                .select('id, unread_count_user1, unread_count_user2')
                .eq('user1_id', u1)
                .eq('user2_id', u2)
                .maybeSingle();

            if (existingConv) {
                const updateData = {
                    last_message: lastMsg,
                    last_message_at: new Date().toISOString()
                };
                if (isUser1Sender) {
                    updateData.unread_count_user2 = (existingConv.unread_count_user2 || 0) + 1;
                } else {
                    updateData.unread_count_user1 = (existingConv.unread_count_user1 || 0) + 1;
                }
                await supabase.from('dm_conversations').update(updateData).eq('id', existingConv.id);
            } else {
                const insertData = {
                    user1_id: u1,
                    user2_id: u2,
                    last_message: lastMsg,
                    last_message_at: new Date().toISOString(),
                    unread_count_user1: isUser1Sender ? 0 : 1,
                    unread_count_user2: isUser1Sender ? 1 : 0
                };
                await supabase.from('dm_conversations').insert([insertData]).catch(() => {
                    return supabase.from('dm_conversations')
                        .update({ last_message: lastMsg, last_message_at: new Date().toISOString() })
                        .eq('user1_id', u1).eq('user2_id', u2);
                });
            }
        } catch (convErr) {
            console.error('⚠️ DM conversation update failed (non-critical):', convErr.message);
        }

        // Fetch reply_to data — non-critical
        let replyToData = null;
        try {
            if (dm.reply_to_id) {
                const { data: replyMsg } = await supabase
                    .from('direct_messages')
                    .select('id, content, sender_id, media_type')
                    .eq('id', dm.reply_to_id)
                    .single();
                replyToData = replyMsg || null;
            }
        } catch (replyErr) {
            console.error('⚠️ Reply fetch failed (non-critical):', replyErr.message);
        }

        // Emit DM via Socket.IO — non-critical
        const payload = {
            ...dm,
            reply_to: replyToData,
            senderUser: {
                id: req.user.id,
                username: req.user.username,
                profile_pic: req.user.profile_pic
            }
        };
        try {
            const receiverSocketId = userSockets.get(receiverId);
            if (receiverSocketId) io.to(receiverSocketId).emit('new_dm', payload);
        } catch (socketErr) {
            console.error('⚠️ Socket emit failed (non-critical):', socketErr.message);
        }

        res.json({ success: true, dm: payload });
    } catch (error) {
        console.error('❌ DM send error:', error);
        res.status(500).json({ error: 'Failed to send DM: ' + error.message });
    }
});


// POST /api/dm/react/:messageId — toggle emoji reaction on a DM
app.post('/api/dm/react/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { emoji } = req.body;
        const uid = req.user.id;

        if (!emoji) return res.status(400).json({ error: 'emoji required' });

        // Fetch current reactions
        const { data: msg, error: fetchErr } = await supabase
            .from('direct_messages')
            .select('id, reactions, sender_id, receiver_id')
            .eq('id', messageId)
            .single();

        if (fetchErr || !msg) return res.status(404).json({ error: 'Message not found' });

        // Only sender or receiver can react
        if (msg.sender_id !== uid && msg.receiver_id !== uid) {
            return res.status(403).json({ error: 'Not your conversation' });
        }

        const reactions = msg.reactions || {};
        const users = reactions[emoji] || [];
        const alreadyReacted = users.includes(uid);

        if (alreadyReacted) {
            // Remove reaction
            const newUsers = users.filter(id => id !== uid);
            if (newUsers.length === 0) delete reactions[emoji];
            else reactions[emoji] = newUsers;
        } else {
            // Add reaction
            reactions[emoji] = [...users, uid];
        }

        const { data: updated, error: updateErr } = await supabase
            .from('direct_messages')
            .update({ reactions })
            .eq('id', messageId)
            .select()
            .single();

        if (updateErr) throw updateErr;

        // Notify the other person via socket
        const otherId = msg.sender_id === uid ? msg.receiver_id : msg.sender_id;
        const otherSocket = userSockets.get(otherId);
        if (otherSocket) {
            io.to(otherSocket).emit('dm_reaction', { messageId, reactions, reactorId: uid });
        }

        res.json({ success: true, reactions });
    } catch (error) {
        console.error('❌ DM react error:', error);
        res.status(500).json({ error: 'Failed to react: ' + error.message });
    }
});

// GET /api/dm/mutual-follows — returns all users who mutually follow the current user
app.get('/api/dm/mutual-follows', authenticateToken, async (req, res) => {
    try {
        const uid = req.user.id;

        // ── Step 1: Get everyone this user follows ─────────────────────────────
        const { data: following, error: err1 } = await supabase
            .from('followers')
            .select('following_id')
            .eq('follower_id', uid);

        if (err1) {
            console.error('❌ mutual-follows step1 (get following) error:', err1);
            return res.status(500).json({ error: 'DB error fetching following list: ' + err1.message });
        }

        if (!following || following.length === 0) {
            return res.json({ success: true, mutualFollows: [], debug: 'user follows nobody' });
        }

        const followingIds = following.map(f => f.following_id);

        // ── Step 2: Of those, find who also follows this user back ────────────
        const { data: followersBack, error: err2 } = await supabase
            .from('followers')
            .select('follower_id')
            .eq('following_id', uid)
            .in('follower_id', followingIds);

        if (err2) {
            console.error('❌ mutual-follows step2 (get followers-back) error:', err2);
            return res.status(500).json({ error: 'DB error fetching followers-back: ' + err2.message });
        }

        if (!followersBack || followersBack.length === 0) {
            return res.json({ success: true, mutualFollows: [], debug: 'no one follows back yet' });
        }

        const mutualIds = followersBack.map(f => f.follower_id);

        // ── Step 3: Fetch user details for all mutual follows ─────────────────
        const { data: users, error: err3 } = await supabase
            .from('users')
            .select('id, username, profile_pic, last_seen, status_text')
            .in('id', mutualIds);

        if (err3) {
            console.error('❌ mutual-follows step3 (fetch user details) error:', err3);
            return res.status(500).json({ error: 'DB error fetching user details: ' + err3.message });
        }

        console.log(`✅ mutual-follows for ${uid}: found ${users?.length || 0} mutual(s)`);
        res.json({ success: true, mutualFollows: users || [] });

    } catch (error) {
        console.error('❌ Mutual follows fatal error:', error);
        res.status(500).json({ error: 'Failed to load mutual follows: ' + error.message });
    }
});

// GET /api/dm/debug-follows — diagnostic: shows raw follower/following rows for current user
app.get('/api/dm/debug-follows', authenticateToken, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: following, error: e1 } = await supabase.from('followers').select('*').eq('follower_id', uid);
        const { data: followers, error: e2 } = await supabase.from('followers').select('*').eq('following_id', uid);
        res.json({
            uid,
            following: following || [],
            followers: followers || [],
            followingError: e1?.message || null,
            followersError: e2?.message || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/dm/messages/:otherId — fetch history + mark as read
app.get('/api/dm/messages/:otherId', authenticateToken, async (req, res) => {
    try {
        const { otherId } = req.params;
        const uid = req.user.id;

        // Use two separate queries instead of compound .or() — far more reliable across Supabase versions
        const [{ data: sent, error: e1 }, { data: recv, error: e2 }] = await Promise.all([
            supabase.from('direct_messages').select('*').eq('sender_id', uid).eq('receiver_id', otherId).limit(200),
            supabase.from('direct_messages').select('*').eq('sender_id', otherId).eq('receiver_id', uid).limit(200)
        ]);

        // Gracefully handle table-not-yet-created
        if (e1 || e2) {
            const err = e1 || e2;
            const isTableMissing = err.code === '42P01' || (err.message || '').includes('does not exist');
            if (isTableMissing) {
                console.warn('⚠️  direct_messages table not found — run database.sql migration');
                return res.json({ success: true, messages: [] });
            }
            throw err;
        }

        // Merge + sort chronologically
        const messages = [...(sent || []), ...(recv || [])].sort(
            (a, b) => new Date(a.created_at) - new Date(b.created_at)
        );

        // Enrich with reply_to data
        const replyIds = [...new Set(messages.filter(m => m.reply_to_id).map(m => m.reply_to_id))];
        let replyMap = {};
        if (replyIds.length > 0) {
            const { data: replyMsgs } = await supabase
                .from('direct_messages')
                .select('id, content, sender_id, media_type')
                .in('id', replyIds);
            if (replyMsgs) replyMsgs.forEach(r => { replyMap[r.id] = r; });
        }
        const enriched = messages.map(m => ({
            ...m,
            reply_to: m.reply_to_id ? (replyMap[m.reply_to_id] || null) : null
        }));

        // Mark received messages as read (fire-and-forget)
        supabase.from('direct_messages').update({ is_read: true })
            .eq('sender_id', otherId).eq('receiver_id', uid).eq('is_read', false)
            .then(() => {
                // Notify sender via socket that messages are read (blue ticks)
                const senderSocketId = userSockets.get(otherId);
                if (senderSocketId) {
                    io.to(senderSocketId).emit('dm_read', { readBy: uid, conversationWith: uid });
                }
            }).catch(() => { });

        // Reset our unread counter (fire-and-forget)
        const [u1, u2] = [uid, otherId].sort();
        const unreadField = u1 === uid ? 'unread_count_user1' : 'unread_count_user2';
        supabase.from('dm_conversations').update({ [unreadField]: 0 })
            .eq('user1_id', u1).eq('user2_id', u2)
            .then(() => { }).catch(() => { });

        res.json({ success: true, messages: enriched });
    } catch (error) {
        console.error('❌ DM messages error:', error);
        res.status(500).json({ error: 'Failed to load messages' });
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

// =====================================================================
// ==================== REAL VIBES ENDPOINTS ====================

// GET all RealVibes (anyone can view, newest first, not expired)
app.get('/api/realvibes', authenticateToken, async (req, res) => {
    try {
        const now = new Date().toISOString();

        const { data: vibes, error } = await supabase
            .from('real_vibes')
            .select(`*, users:user_id (id, username, profile_pic, college)`)
            .gt('expires_at', now)
            .eq('status', 'approved')
            .order('created_at', { ascending: false })
            .limit(50);

        // Table doesn't exist yet — return empty list so UI shows "No RealVibes" not an error
        if (error) {
            const isTableMissing = error.code === '42P01' || (error.message || '').includes('does not exist');
            if (isTableMissing) {
                console.warn('⚠️  real_vibes table not found — run database.sql to create it');
                return res.json({ success: true, vibes: [] });
            }
            throw error;
        }

        const vibesWithCounts = await Promise.all((vibes || []).map(async (vibe) => {
            const [{ count: likeCount }, { count: commentCount }, { data: isLiked }] = await Promise.all([
                supabase.from('real_vibe_likes').select('id', { count: 'exact', head: true }).eq('vibe_id', vibe.id),
                supabase.from('real_vibe_comments').select('id', { count: 'exact', head: true }).eq('vibe_id', vibe.id),
                supabase.from('real_vibe_likes').select('id').eq('vibe_id', vibe.id).eq('user_id', req.user.id).maybeSingle()
            ]);
            const expiresAt = new Date(vibe.expires_at);
            const msDiff = expiresAt - new Date();
            const hoursLeft = Math.max(0, Math.ceil(msDiff / (1000 * 60 * 60)));
            return { ...vibe, like_count: likeCount || 0, comment_count: commentCount || 0, is_liked: !!isLiked, hours_left: hoursLeft };
        }));

        res.json({ success: true, vibes: vibesWithCounts });
    } catch (error) {
        console.error('❌ Get real vibes error:', error);
        res.status(500).json({ error: 'Failed to load RealVibes' });
    }
});

// POST create a new RealVibe (premium only)
app.post('/api/realvibes', authenticateToken, upload.single('media'), async (req, res) => {
    try {
        // Check premium status
        if (!req.user.is_premium || !req.user.subscription_plan) {
            return res.status(403).json({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' });
        }

        // Check subscription still active
        const now = new Date();
        if (req.user.subscription_end && new Date(req.user.subscription_end) < now) {
            return res.status(403).json({ error: 'Subscription expired', code: 'SUBSCRIPTION_EXPIRED' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Media file required' });
        }

        const { caption = '', visibility = 'public' } = req.body;
        const plan = req.user.subscription_plan; // 'noble' | 'royal'

        // Plan quota check for videos
        const isVideo = req.file.mimetype.startsWith('video/');
        if (isVideo) {
            const videoQuota = plan === 'royal' ? 3 : 1;
            // Count videos posted this plan cycle
            const { count: videoCount } = await supabase
                .from('real_vibes')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', req.user.id)
                .eq('media_type', 'video');

            if ((videoCount || 0) >= videoQuota) {
                return res.status(403).json({
                    error: `Video quota reached (${videoQuota} video${videoQuota > 1 ? 's' : ''} for ${plan} plan)`,
                    code: 'QUOTA_EXCEEDED'
                });
            }
        }

        // Upload to Supabase storage
        const ext = req.file.originalname.split('.').pop();
        const fileName = `${req.user.id}_${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
            .from('realvibes')
            .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage.from('realvibes').getPublicUrl(fileName);

        // Set expiry: noble=15 days, royal=25 days
        const daysToExpire = plan === 'royal' ? 25 : 15;
        const expiresAt = new Date(Date.now() + daysToExpire * 24 * 60 * 60 * 1000);

        const { data: vibe, error: insertError } = await supabase
            .from('real_vibes')
            .insert([{
                user_id: req.user.id,
                caption: caption.trim(),
                media_url: publicUrl,
                media_type: isVideo ? 'video' : 'image',
                plan_type: plan,
                visibility,
                expires_at: expiresAt.toISOString(),
                status: 'pending'
            }])
            .select()
            .single();

        if (insertError) throw insertError;

        const enriched = {
            ...vibe,
            like_count: 0, comment_count: 0, is_liked: false,
            hours_left: daysToExpire * 24,
            users: { id: req.user.id, username: req.user.username, profile_pic: req.user.profile_pic, college: req.user.college }
        };

        // Don't broadcast to feed — post is pending review
        console.log(`✨ RealVibe submitted by ${req.user.username} (${plan}) — awaiting moderation`);
        res.json({
            success: true,
            vibe: enriched,
            pending: true,
            message: 'Your post is under review. You will be notified once it is approved!'
        });

    } catch (error) {
        console.error('❌ Create real vibe error:', error);
        res.status(500).json({ error: 'Failed to create RealVibe' });
    }
});

// DELETE a RealVibe
app.delete('/api/realvibes/:vibeId', authenticateToken, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const { data: vibe } = await supabase.from('real_vibes').select('user_id').eq('id', vibeId).single();
        if (!vibe || vibe.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        await supabase.from('real_vibes').delete().eq('id', vibeId);
        io.emit('delete_realvibe', { id: vibeId });
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Delete real vibe error:', error);
        res.status(500).json({ error: 'Failed to delete RealVibe' });
    }
});

// LIKE / UNLIKE a RealVibe
app.post('/api/realvibes/:vibeId/like', authenticateToken, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const { data: existing } = await supabase.from('real_vibe_likes').select('id').eq('vibe_id', vibeId).eq('user_id', req.user.id).maybeSingle();

        if (existing) {
            await supabase.from('real_vibe_likes').delete().eq('id', existing.id);
        } else {
            await supabase.from('real_vibe_likes').insert([{ vibe_id: vibeId, user_id: req.user.id }]);
        }
        const { count: likeCount } = await supabase.from('real_vibe_likes').select('id', { count: 'exact', head: true }).eq('vibe_id', vibeId);
        io.emit('realvibe_liked', { vibeId, likeCount: likeCount || 0, liked: !existing });
        res.json({ success: true, liked: !existing, likeCount: likeCount || 0 });
    } catch (error) {
        console.error('❌ Like real vibe error:', error);
        res.status(500).json({ error: 'Failed to like RealVibe' });
    }
});

// GET comments for a RealVibe
app.get('/api/realvibes/:vibeId/comments', authenticateToken, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const { data: comments, error } = await supabase
            .from('real_vibe_comments')
            .select(`*, users:user_id (id, username, profile_pic)`)
            .eq('vibe_id', vibeId)
            .order('created_at', { ascending: true });
        if (error) throw error;
        res.json({ success: true, comments: comments || [] });
    } catch (error) {
        console.error('❌ Get comments error:', error);
        res.status(500).json({ error: 'Failed to load comments' });
    }
});

// POST comment on a RealVibe
app.post('/api/realvibes/:vibeId/comments', authenticateToken, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: 'Comment required' });
        const { data: comment, error } = await supabase
            .from('real_vibe_comments')
            .insert([{ vibe_id: vibeId, user_id: req.user.id, content: content.trim() }])
            .select()
            .single();
        if (error) throw error;
        const { count: commentCount } = await supabase.from('real_vibe_comments').select('id', { count: 'exact', head: true }).eq('vibe_id', vibeId);
        io.emit('realvibe_commented', { vibeId, commentCount: commentCount || 0 });
        res.json({ success: true, comment });
    } catch (error) {
        console.error('❌ Comment real vibe error:', error);
        res.status(500).json({ error: 'Failed to comment' });
    }
});


// =====================================================================
// ==================== REAL VIBES MODERATION ROUTES ====================
// ADD THESE ROUTES TO YOUR server.js
// Place them right after your existing REAL VIBES ENDPOINTS block
// =====================================================================

// ── ADMIN SECRET (add this to your .env file) ─────────────────────────────
// ADMIN_SECRET=your_super_secret_admin_key_here
// (Use a long random string — this protects all admin routes)

// ── Admin auth middleware ─────────────────────────────────────────────────
function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-secret'] || req.query.admin_secret;
    if (!adminKey || adminKey !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized — invalid admin secret' });
    }
    next();
}

// ── MODIFICATION TO EXISTING POST /api/realvibes ─────────────────────────
// In your existing POST /api/realvibes route, change the INSERT to include status: 'pending'
// Find the .insert([{...}]) call and add:    status: 'pending'
//
// ALSO change the io.emit('new_realvibe', enriched) line to:
//    io.emit('new_realvibe_pending', enriched);   // so it only shows in admin queue, not feed
//
// ALSO change the response to:
//    res.json({ success: true, vibe: enriched, message: 'Your post is under review. We will notify you once approved.' });

// ── MODIFICATION TO EXISTING GET /api/realvibes ──────────────────────────
// In your existing GET /api/realvibes route, ADD this filter after .gt('expires_at', now):
//    .eq('status', 'approved')
// This ensures only approved vibes appear in the public feed.

// ==========================================================================
// NEW ROUTE 1: Admin — GET pending queue
// GET /api/admin/realvibes/pending
// ==========================================================================
app.get('/api/admin/realvibes/pending', authenticateAdmin, async (req, res) => {
    try {
        const { data: vibes, error } = await supabase
            .from('real_vibes')
            .select(`*, users:user_id (id, username, profile_pic, college, subscription_plan)`)
            .eq('status', 'pending')
            .order('created_at', { ascending: true }); // oldest first — FIFO review

        if (error) throw error;

        res.json({ success: true, vibes: vibes || [], count: (vibes || []).length });
    } catch (err) {
        console.error('❌ Admin pending vibes error:', err);
        res.status(500).json({ error: 'Failed to load pending vibes' });
    }
});

// ==========================================================================
// NEW ROUTE 2: Admin — GET all vibes (with status filter)
// GET /api/admin/realvibes?status=pending|approved|rejected
// ==========================================================================
app.get('/api/admin/realvibes', authenticateAdmin, async (req, res) => {
    try {
        const { status, limit = 50, offset = 0 } = req.query;

        let query = supabase
            .from('real_vibes')
            .select(`*, users:user_id (id, username, profile_pic, college, subscription_plan)`)
            .order('created_at', { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);

        if (status && ['pending', 'approved', 'rejected'].includes(status)) {
            query = query.eq('status', status);
        }

        const { data: vibes, error } = await query;
        if (error) throw error;

        res.json({ success: true, vibes: vibes || [] });
    } catch (err) {
        console.error('❌ Admin get vibes error:', err);
        res.status(500).json({ error: 'Failed to load vibes' });
    }
});

// ==========================================================================
// NEW ROUTE 3: Admin — APPROVE a vibe
// POST /api/admin/realvibes/:vibeId/approve
// ==========================================================================
app.post('/api/admin/realvibes/:vibeId/approve', authenticateAdmin, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const { admin_name = 'Admin' } = req.body;

        // Get the vibe first
        const { data: vibe, error: fetchErr } = await supabase
            .from('real_vibes')
            .select(`*, users:user_id (id, username, profile_pic, college)`)
            .eq('id', vibeId)
            .single();

        if (fetchErr || !vibe) return res.status(404).json({ error: 'Vibe not found' });
        if (vibe.status !== 'pending') return res.status(400).json({ error: `Vibe is already ${vibe.status}` });

        // Update status to approved
        const { error: updateErr } = await supabase
            .from('real_vibes')
            .update({
                status: 'approved',
                reviewed_at: new Date().toISOString(),
                reviewed_by_admin: admin_name
            })
            .eq('id', vibeId);

        if (updateErr) throw updateErr;

        // Log the action
        await supabase.from('real_vibe_moderation_log').insert([{
            vibe_id: vibeId,
            admin_id: admin_name,
            action: 'approved'
        }]);

        // Notify the user
        await supabase.from('real_vibe_notifications').insert([{
            user_id: vibe.user_id,
            vibe_id: vibeId,
            type: 'approved',
            message: '✅ Your RealVibe post has been approved and is now live!'
        }]);

        // Broadcast approved vibe to all connected users (it now goes live on the feed)
        const enriched = {
            ...vibe,
            status: 'approved',
            like_count: 0,
            comment_count: 0,
            is_liked: false,
            hours_left: Math.ceil((new Date(vibe.expires_at) - new Date()) / (1000 * 60 * 60))
        };
        io.emit('new_realvibe', enriched);

        // Also notify the specific user via socket if they're connected
        const userSocketId = userSockets.get(vibe.user_id);
        if (userSocketId) {
            io.to(userSocketId).emit('realvibe_status_update', {
                vibeId,
                status: 'approved',
                message: '✅ Your RealVibe has been approved and is now live!'
            });
        }

        console.log(`✅ RealVibe ${vibeId} APPROVED by ${admin_name}`);
        res.json({ success: true, message: 'Vibe approved and published' });

    } catch (err) {
        console.error('❌ Admin approve error:', err);
        res.status(500).json({ error: 'Failed to approve vibe' });
    }
});

// ==========================================================================
// NEW ROUTE 4: Admin — REJECT a vibe
// POST /api/admin/realvibes/:vibeId/reject
// Body: { reason: 'vulgar' | 'spam' | 'irrelevant' | 'other', custom_message: '' }
// ==========================================================================
app.post('/api/admin/realvibes/:vibeId/reject', authenticateAdmin, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const { reason = 'vulgar', custom_message, admin_name = 'Admin' } = req.body;

        const rejectionMessages = {
            vulgar: '❌ Your RealVibe was rejected: Inappropriate or vulgar content is not allowed.',
            spam: '❌ Your RealVibe was rejected: Spam or repetitive content is not allowed.',
            irrelevant: '❌ Your RealVibe was rejected: Content is not relevant or does not meet posting guidelines.',
            other: `❌ Your RealVibe was rejected. ${custom_message || 'Does not meet community guidelines.'}`
        };

        const rejectionMsg = rejectionMessages[reason] || rejectionMessages.other;

        // Get the vibe
        const { data: vibe, error: fetchErr } = await supabase
            .from('real_vibes')
            .select('id, user_id, media_url, status')
            .eq('id', vibeId)
            .single();

        if (fetchErr || !vibe) return res.status(404).json({ error: 'Vibe not found' });
        if (vibe.status !== 'pending') return res.status(400).json({ error: `Vibe is already ${vibe.status}` });

        // Update status to rejected
        const { error: updateErr } = await supabase
            .from('real_vibes')
            .update({
                status: 'rejected',
                rejection_reason: rejectionMsg,
                reviewed_at: new Date().toISOString(),
                reviewed_by_admin: admin_name
            })
            .eq('id', vibeId);

        if (updateErr) throw updateErr;

        // Log the action
        await supabase.from('real_vibe_moderation_log').insert([{
            vibe_id: vibeId,
            admin_id: admin_name,
            action: 'rejected',
            rejection_reason: rejectionMsg
        }]);

        // Notify the user
        await supabase.from('real_vibe_notifications').insert([{
            user_id: vibe.user_id,
            vibe_id: vibeId,
            type: 'rejected',
            message: rejectionMsg
        }]);

        // Notify via socket if user is online
        const userSocketId = userSockets.get(vibe.user_id);
        if (userSocketId) {
            io.to(userSocketId).emit('realvibe_status_update', {
                vibeId,
                status: 'rejected',
                message: rejectionMsg
            });
        }

        console.log(`❌ RealVibe ${vibeId} REJECTED by ${admin_name} — reason: ${reason}`);
        res.json({ success: true, message: 'Vibe rejected and user notified' });

    } catch (err) {
        console.error('❌ Admin reject error:', err);
        res.status(500).json({ error: 'Failed to reject vibe' });
    }
});

// ==========================================================================
// NEW ROUTE 5: Admin — GET stats (pending count, total, etc.)
// GET /api/admin/realvibes/stats
// ==========================================================================
app.get('/api/admin/realvibes/stats', authenticateAdmin, async (req, res) => {
    try {
        const [
            { count: pending },
            { count: approved },
            { count: rejected },
            { count: total }
        ] = await Promise.all([
            supabase.from('real_vibes').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
            supabase.from('real_vibes').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
            supabase.from('real_vibes').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
            supabase.from('real_vibes').select('id', { count: 'exact', head: true })
        ]);

        res.json({ success: true, stats: { pending, approved, rejected, total } });
    } catch (err) {
        console.error('❌ Admin stats error:', err);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// ==========================================================================
// NEW ROUTE 6: User — GET their own notifications (approve/reject status)
// GET /api/realvibes/notifications
// ==========================================================================
app.get('/api/realvibes/notifications', authenticateToken, async (req, res) => {
    try {
        const { data: notifications, error } = await supabase
            .from('real_vibe_notifications')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        res.json({ success: true, notifications: notifications || [] });
    } catch (err) {
        console.error('❌ Get notifications error:', err);
        res.status(500).json({ error: 'Failed to load notifications' });
    }
});

// ==========================================================================
// NEW ROUTE 7: User — Mark notifications as read
// POST /api/realvibes/notifications/read
// ==========================================================================
app.post('/api/realvibes/notifications/read', authenticateToken, async (req, res) => {
    try {
        await supabase
            .from('real_vibe_notifications')
            .update({ is_read: true })
            .eq('user_id', req.user.id)
            .eq('is_read', false);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// ==========================================================================
// NEW ROUTE 8: User — GET their own pending/rejected vibes
// GET /api/realvibes/my-submissions
// ==========================================================================
app.get('/api/realvibes/my-submissions', authenticateToken, async (req, res) => {
    try {
        const { data: vibes, error } = await supabase
            .from('real_vibes')
            .select('id, caption, media_url, media_type, status, rejection_reason, created_at, expires_at')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, vibes: vibes || [] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load your submissions' });
    }
});

// =====================================================================
// IMPORTANT: CHANGES NEEDED IN YOUR EXISTING ROUTES
// =====================================================================
//
// 1. In POST /api/realvibes, in the .insert([{...}]) block, ADD:
//       status: 'pending',
//
// 2. In POST /api/realvibes, change:
//       io.emit('new_realvibe', enriched);
//    TO:
//       // Don't broadcast pending vibes to the feed
//       // io.emit('new_realvibe', enriched);  <-- comment out or remove
//
// 3. In POST /api/realvibes, change the success response to:
//       res.json({
//           success: true,
//           vibe: enriched,
//           pending: true,
//           message: 'Your post is under review. You will be notified once it is approved!'
//       });
//
// 4. In GET /api/realvibes, add .eq('status', 'approved') filter:
//       const { data: vibes, error } = await supabase
//           .from('real_vibes')
//           .select(`*, users:user_id (id, username, profile_pic, college)`)
//           .gt('expires_at', now)
//           .eq('status', 'approved')   // <-- ADD THIS LINE
//           .order('created_at', { ascending: false })
//           .limit(50);
//
// 5. Add ADMIN_SECRET=your_secret_here to your .env file
//
// =====================================================================







// ==================== EXECUTIVE CHAT ENDPOINTS ====================

// GET /api/executive/messages — load last 5 days of messages
app.get('/api/executive/messages', authenticateToken, async (req, res) => {
    try {
        if (!req.user.community_joined || !req.user.college) {
            return res.json({ success: false, needsJoinCommunity: true, messages: [] });
        }

        const fiveDaysAgo = new Date();
        fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

        // 1. Fetch messages
        const { data: messages, error } = await supabase
            .from('executive_messages')
            .select('*')
            .eq('college_name', req.user.college)
            .eq('is_deleted', false)
            .gte('created_at', fiveDaysAgo.toISOString())
            .order('created_at', { ascending: true })
            .limit(500);

        if (error) throw error;

        let enriched = messages || [];

        // 2. Enrich with sender info (real name + avatar)
        if (enriched.length > 0) {
            const senderIds = [...new Set(enriched.map(m => m.sender_id))];
            const { data: users } = await supabase
                .from('users')
                .select('id, username, profile_pic')
                .in('id', senderIds);

            const userMap = {};
            (users || []).forEach(u => { userMap[u.id] = u; });

            enriched = enriched.map(msg => ({
                ...msg,
                users: userMap[msg.sender_id] || { id: msg.sender_id, username: 'User', profile_pic: null }
            }));
        }

        // 3. Enrich reply_to data
        const replyIds = [...new Set(enriched.filter(m => m.reply_to_id).map(m => m.reply_to_id))];
        if (replyIds.length > 0) {
            const { data: replyMsgs } = await supabase
                .from('executive_messages')
                .select('id, content, sender_id, media_type, media_url, message_type')
                .in('id', replyIds);

            const replyUserIds = [...new Set((replyMsgs || []).map(m => m.sender_id))];
            const { data: replyUsers } = await supabase
                .from('users').select('id, username').in('id', replyUserIds);
            const replyUserMap = {};
            (replyUsers || []).forEach(u => { replyUserMap[u.id] = u; });

            const replyMap = {};
            (replyMsgs || []).forEach(m => {
                replyMap[m.id] = { ...m, sender_username: replyUserMap[m.sender_id]?.username || 'User' };
            });

            enriched = enriched.map(msg => ({
                ...msg,
                reply_to: msg.reply_to_id ? (replyMap[msg.reply_to_id] || null) : null
            }));
        }

        // 4. Attach reactions
        if (enriched.length > 0) {
            const msgIds = enriched.map(m => m.id);
            const { data: reactions } = await supabase
                .from('executive_message_reactions')
                .select('message_id, user_id, emoji')
                .in('message_id', msgIds);

            const rxMap = {};
            (reactions || []).forEach(r => {
                if (!rxMap[r.message_id]) rxMap[r.message_id] = [];
                rxMap[r.message_id].push(r);
            });

            enriched = enriched.map(msg => ({ ...msg, reactions: rxMap[msg.id] || [] }));
        }

        // 5. Attach read receipts counts
        if (enriched.length > 0) {
            const msgIds = enriched.map(m => m.id);
            const { data: reads } = await supabase
                .from('executive_message_reads')
                .select('message_id, user_id')
                .in('message_id', msgIds);

            const readMap = {};
            (reads || []).forEach(r => {
                if (!readMap[r.message_id]) readMap[r.message_id] = [];
                readMap[r.message_id].push(r.user_id);
            });

            enriched = enriched.map(msg => ({
                ...msg,
                read_by: readMap[msg.id] || []
            }));
        }

        // 6. Attach poll data for poll messages
        const pollMsgIds = enriched.filter(m => m.message_type === 'poll').map(m => m.id);
        if (pollMsgIds.length > 0) {
            const { data: polls } = await supabase
                .from('executive_polls')
                .select('*, executive_poll_votes(*)')
                .in('message_id', pollMsgIds);

            const pollMap = {};
            (polls || []).forEach(p => { pollMap[p.message_id] = p; });

            enriched = enriched.map(msg => ({
                ...msg,
                poll: msg.message_type === 'poll' ? (pollMap[msg.id] || null) : undefined
            }));
        }

        res.json({ success: true, messages: enriched });

    } catch (err) {
        console.error('❌ Executive GET messages error:', err);
        res.status(500).json({ error: 'Failed to load messages', details: err.message });
    }
});


// POST /api/executive/messages — send a new message (text / media / voice / poll)
app.post('/api/executive/messages', authenticateToken, (req, res, next) => {
    if (req.headers['content-type']?.includes('multipart/form-data')) {
        upload.single('media')(req, res, next);
    } else {
        next();
    }
}, async (req, res) => {
    try {
        if (!req.user.community_joined || !req.user.college) {
            return res.status(400).json({ error: 'Join a college community first' });
        }

        const { content, reply_to_id, poll_question, poll_options } = req.body;
        const media = req.file;

        if (!content && !media && !poll_question) {
            return res.status(400).json({ error: 'Message content, media, or poll required' });
        }

        let mediaUrl = null, mediaType = null, msgType = 'text';

        if (media) {
            const safeName = media.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
            const isVoice = req.body.is_voice === 'true';
            const folder = isVoice ? 'exec-voice' : 'exec-media';
            const fileName = `${folder}/${Date.now()}_${safeName}`;

            const { error: uploadError } = await supabase.storage
                .from('chat-media')
                .upload(fileName, media.buffer, { contentType: media.mimetype, upsert: false });

            if (uploadError) {
                return res.status(500).json({ error: 'Media upload failed: ' + uploadError.message });
            }

            const { data: { publicUrl } } = supabase.storage.from('chat-media').getPublicUrl(fileName);
            mediaUrl = publicUrl;

            if (isVoice) {
                mediaType = 'audio'; msgType = 'voice';
            } else if (media.mimetype.startsWith('video/')) {
                mediaType = 'video'; msgType = 'video';
            } else if (media.mimetype.startsWith('audio/')) {
                mediaType = 'audio'; msgType = 'audio';
            } else if (media.mimetype === 'application/pdf') {
                mediaType = 'pdf'; msgType = 'document';
            } else if (media.mimetype.startsWith('application/') || media.mimetype.startsWith('text/')) {
                mediaType = 'document'; msgType = 'document';
            } else {
                mediaType = 'image'; msgType = 'image';
            }
        }

        if (poll_question) msgType = 'poll';

        const { data: inserted, error: insertError } = await supabase
            .from('executive_messages')
            .insert([{
                sender_id: req.user.id,
                college_name: req.user.college,
                content: content?.trim() || '',
                message_type: msgType,
                media_url: mediaUrl,
                media_type: mediaType,
                media_name: media ? media.originalname : null,
                media_size: media ? media.size : null,
                reply_to_id: (reply_to_id && reply_to_id !== 'null' && reply_to_id !== 'undefined') ? reply_to_id : null
            }])
            .select('*')
            .single();

        if (insertError) throw insertError;

        // Create poll if poll_question present
        let pollData = null;
        if (poll_question && inserted) {
            let options = [];
            try { options = JSON.parse(poll_options || '[]'); } catch { }
            const { data: poll } = await supabase
                .from('executive_polls')
                .insert([{ message_id: inserted.id, question: poll_question, options }])
                .select('*').single();
            pollData = poll ? { ...poll, executive_poll_votes: [] } : null;
        }

        // Fetch sender info
        const { data: sender } = await supabase
            .from('users').select('id, username, profile_pic').eq('id', req.user.id).single();

        // Fetch reply_to if needed
        let replyToData = null;
        if (inserted.reply_to_id) {
            const { data: rMsg } = await supabase
                .from('executive_messages').select('id, content, sender_id, media_type, media_url, message_type')
                .eq('id', inserted.reply_to_id).single();
            if (rMsg) {
                const { data: rUser } = await supabase.from('users').select('username').eq('id', rMsg.sender_id).single();
                replyToData = { ...rMsg, sender_username: rUser?.username || 'User' };
            }
        }

        const finalMsg = {
            ...inserted,
            users: sender || { id: req.user.id, username: req.user.username, profile_pic: null },
            reactions: [],
            read_by: [],
            reply_to: replyToData,
            poll: pollData
        };

        // Broadcast to college executive room
        const senderSocketId = userSockets.get(req.user.id);
        const room = `exec_${req.user.college}`;
        if (senderSocketId) {
            io.to(room).except(senderSocketId).emit('exec_new_message', finalMsg);
        } else {
            io.to(room).emit('exec_new_message', finalMsg);
        }

        res.json({ success: true, message: finalMsg });

    } catch (err) {
        console.error('❌ Executive POST message error:', err);
        res.status(500).json({ error: 'Failed to send message', details: err.message });
    }
});


// PATCH /api/executive/messages/:id — edit a message
app.patch('/api/executive/messages/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

        const { data: msg } = await supabase.from('executive_messages')
            .select('sender_id, college_name').eq('id', id).single();

        if (!msg || msg.sender_id !== req.user.id) {
            return res.status(403).json({ error: 'Not authorized to edit this message' });
        }

        const { data: updated, error } = await supabase.from('executive_messages')
            .update({ content: content.trim(), is_edited: true, edited_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', id).select('*').single();

        if (error) throw error;

        io.to(`exec_${msg.college_name}`).emit('exec_message_edited', { id, content: content.trim(), edited_at: updated.edited_at });
        res.json({ success: true, message: updated });

    } catch (err) {
        console.error('❌ Executive PATCH message error:', err);
        res.status(500).json({ error: 'Failed to edit message' });
    }
});


// DELETE /api/executive/messages/:id — soft-delete a message
app.delete('/api/executive/messages/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const { data: msg } = await supabase.from('executive_messages')
            .select('sender_id, college_name').eq('id', id).single();

        if (!msg || msg.sender_id !== req.user.id) {
            return res.status(403).json({ error: 'Not authorized to delete this message' });
        }

        await supabase.from('executive_messages')
            .update({ is_deleted: true, deleted_at: new Date().toISOString() })
            .eq('id', id);

        io.to(`exec_${msg.college_name}`).emit('exec_message_deleted', { id });
        res.json({ success: true });

    } catch (err) {
        console.error('❌ Executive DELETE message error:', err);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});


// POST /api/executive/reactions — toggle a reaction emoji on a message
app.post('/api/executive/reactions', authenticateToken, async (req, res) => {
    try {
        const { message_id, emoji } = req.body;
        if (!message_id || !emoji) return res.status(400).json({ error: 'message_id and emoji required' });

        // Fetch the message for its college
        const { data: msg } = await supabase.from('executive_messages')
            .select('college_name').eq('id', message_id).single();
        if (!msg) return res.status(404).json({ error: 'Message not found' });

        // Check if reaction already exists (toggle)
        const { data: existing } = await supabase.from('executive_message_reactions')
            .select('id').eq('message_id', message_id).eq('user_id', req.user.id).eq('emoji', emoji).single();

        let action;
        if (existing) {
            await supabase.from('executive_message_reactions').delete().eq('id', existing.id);
            action = 'removed';
        } else {
            await supabase.from('executive_message_reactions')
                .insert([{ message_id, user_id: req.user.id, emoji }]);
            action = 'added';
        }

        // Fetch updated reactions for this message
        const { data: allReactions } = await supabase.from('executive_message_reactions')
            .select('message_id, user_id, emoji').eq('message_id', message_id);

        const update = { message_id, reactions: allReactions || [], action, userId: req.user.id, emoji, collegeName: msg.college_name };
        io.to(`exec_${msg.college_name}`).emit('exec_reaction_update', update);

        res.json({ success: true, reactions: allReactions || [], action });

    } catch (err) {
        console.error('❌ Executive reaction error:', err);
        res.status(500).json({ error: 'Failed to update reaction' });
    }
});


// POST /api/executive/read — mark messages as read (batch)
app.post('/api/executive/read', authenticateToken, async (req, res) => {
    try {
        const { message_ids } = req.body;
        if (!message_ids?.length) return res.json({ success: true });

        const rows = message_ids.map(mid => ({ message_id: mid, user_id: req.user.id }));

        await supabase.from('executive_message_reads')
            .upsert(rows, { onConflict: 'message_id,user_id', ignoreDuplicates: true });

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Executive read error:', err);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});


// GET /api/executive/reads/:messageId — get list of users who read a message (for popup)
app.get('/api/executive/reads/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;

        const { data: reads, error } = await supabase
            .from('executive_message_reads')
            .select('user_id, read_at')
            .eq('message_id', messageId)
            .order('read_at', { ascending: true });

        if (error) throw error;

        // Fetch user info for each reader
        const userIds = (reads || []).map(r => r.user_id);
        let readers = [];
        if (userIds.length > 0) {
            const { data: users } = await supabase
                .from('users').select('id, username, profile_pic').in('id', userIds);
            const userMap = {};
            (users || []).forEach(u => { userMap[u.id] = u; });
            readers = (reads || []).map(r => ({
                ...userMap[r.user_id],
                read_at: r.read_at
            })).filter(u => u.id);
        }

        res.json({ success: true, readers });
    } catch (err) {
        console.error('❌ Executive reads error:', err);
        res.status(500).json({ error: 'Failed to load readers' });
    }
});


// POST /api/executive/polls/:pollId/vote — cast or change a vote
app.post('/api/executive/polls/:pollId/vote', authenticateToken, async (req, res) => {
    try {
        const { pollId } = req.params;
        const { option_id } = req.body;
        if (!option_id) return res.status(400).json({ error: 'option_id required' });

        // Check poll exists and get college
        const { data: poll } = await supabase.from('executive_polls')
            .select('*, executive_messages(college_name)').eq('id', pollId).single();
        if (!poll || poll.is_closed) {
            return res.status(404).json({ error: poll?.is_closed ? 'Poll is closed' : 'Poll not found' });
        }

        const collegeName = poll.executive_messages?.college_name;

        // Upsert vote (allows changing vote)
        await supabase.from('executive_poll_votes')
            .upsert([{ poll_id: pollId, user_id: req.user.id, option_id }],
                { onConflict: 'poll_id,user_id' });

        // Fetch updated votes
        const { data: votes } = await supabase.from('executive_poll_votes')
            .select('*').eq('poll_id', pollId);

        const update = { pollId, messageId: poll.message_id, votes: votes || [], userId: req.user.id, collegeName };
        if (collegeName) io.to(`exec_${collegeName}`).emit('exec_poll_voted', update);

        res.json({ success: true, votes: votes || [] });

    } catch (err) {
        console.error('❌ Executive poll vote error:', err);
        res.status(500).json({ error: 'Failed to vote' });
    }
});


// AUTO-DELETE: Chats older than 5 days  (day 1 is deleted ON day 6)
// Schedule: runs every hour
// =====================================================================
async function cleanupOldMessages() {
    try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 5);          // 5 full days retention

        const { error } = await supabase
            .from('community_messages')
            .delete()
            .lt('created_at', cutoff.toISOString());

        if (error) throw error;
        console.log('🗑️  Chat cleanup: messages older than 5 days removed');
    } catch (err) {
        console.error('❌ Chat cleanup error:', err.message);
    }
}

// =====================================================================
// AUTO-DELETE: Posts older than 100 days  (deleted ON the 100th day)
// Schedule: runs every 6 hours (separate from chat cleanup)
// =====================================================================
async function cleanupOldPosts() {
    try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 100);        // 100 full days retention

        const { error } = await supabase
            .from('posts')
            .delete()
            .lt('created_at', cutoff.toISOString());

        if (error) throw error;
        console.log('🗑️  Post cleanup: posts older than 100 days removed');
    } catch (err) {
        console.error('❌ Post cleanup error:', err.message);
    }
}

// Chat cleanup — every 1 hour
setInterval(cleanupOldMessages, 60 * 60 * 1000);
cleanupOldMessages();                              // also run immediately on boot

// =====================================================================
// AUTO-DELETE: Executive chat older than 5 days (day 1 deleted on day 6)
// =====================================================================
async function cleanupOldExecutiveMessages() {
    try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 5);

        const { error } = await supabase
            .from('executive_messages')
            .delete()
            .lt('created_at', cutoff.toISOString());

        if (error) throw error;
        console.log('🗑️  Executive chat cleanup: messages older than 5 days removed');
    } catch (err) {
        console.error('❌ Executive chat cleanup error:', err.message);
    }
}

// Run every hour alongside community_messages cleanup
setInterval(cleanupOldExecutiveMessages, 60 * 60 * 1000);
cleanupOldExecutiveMessages();  // run immediately on boot

// Post cleanup — every 6 hours (intentionally offset from chat cleanup)
setInterval(cleanupOldPosts, 6 * 60 * 60 * 1000);
setTimeout(() => cleanupOldPosts(), 5 * 60 * 1000); // first run 5 min after boot

// RealVibes cleanup — every 6 hours (delete expired vibes based on plan expiry)
async function cleanupExpiredRealVibes() {
    try {
        const { error } = await supabase.from('real_vibes').delete().lt('expires_at', new Date().toISOString());
        if (error) throw error;
        console.log('🗑️  RealVibes cleanup: expired vibes removed');
    } catch (err) {
        console.error('❌ RealVibes cleanup error:', err.message);
    }
}
setInterval(cleanupExpiredRealVibes, 6 * 60 * 60 * 1000);
setTimeout(() => cleanupExpiredRealVibes(), 10 * 60 * 1000);

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
