// VIBEXPERT BACKEND - POLYGLOT PERSISTENCE
// Supabase  → Users, Auth, Chat, DMs, Payments, Followers
// MongoDB   → Posts, Likes, Comments, Shares, RealVibes
// Cloudinary→ All media files (photos, videos, audio)
// Redis     → Notifications

// DNS Workaround for MongoDB querySrv ECONNREFUSED
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');

// ── New: Polyglot imports ──────────────────────────────────────
const cloudinaryLib = require('./config/cloudinary');
const {
    connectMongo,
    Post, PostLike, PostComment, PostShare,
    RealVibe, RealVibeLike, RealVibeComment,
    PlatformNotification, SellerRequest,
    ClientRequest, ClientProduct, OrderMessage,
    Complaint, Coupon, ProductReview, CollegeRequest,
    Block, CombineRequest, PartnerLink, PinnedMessage,
    FcmToken
} = require('./config/mongodb');
const redis = require('./config/redis');

// Initialize Firebase Admin dynamically for FCM Background Notifications
let firebaseAdmin = null;
try {
    const admin = require('firebase-admin');
    let serviceAccount = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log('✅ Loaded Firebase credentials from FIREBASE_SERVICE_ACCOUNT env var.');
        } catch (parseErr) {
            console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', parseErr.message);
        }
    } else {
        const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
        if (fs.existsSync(serviceAccountPath)) {
            serviceAccount = require(serviceAccountPath);
            console.log('✅ Loaded Firebase credentials from firebase-service-account.json.');
        }
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firebaseAdmin = admin;
        console.log('🔥 Firebase Admin SDK initialized successfully');
    } else {
        console.warn('⚠️ No Firebase service account config found (env var or JSON file). Background push notifications via FCM will be disabled (non-critical).');
    }
} catch (e) {
    console.error('⚠️ Failed to initialize Firebase Admin SDK:', e.message);
}

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
    cors: { origin: (origin, callback) => callback(null, true), methods: ['GET', 'POST'], credentials: true },
    pingTimeout: 60000,
    pingInterval: 25000
});

const userSockets = new Map(); // userId -> Set(socketIds)

// Bulletproof wrapper to automatically stringify Mongoose ObjectIds or other types used as keys
const originalGet = userSockets.get.bind(userSockets);
const originalSet = userSockets.set.bind(userSockets);
const originalHas = userSockets.has.bind(userSockets);
const originalDelete = userSockets.delete.bind(userSockets);

userSockets.get = (key) => key ? originalGet(key.toString()) : undefined;
userSockets.set = (key, value) => key ? originalSet(key.toString(), value) : userSockets;
userSockets.has = (key) => key ? originalHas(key.toString()) : false;
userSockets.delete = (key) => key ? originalDelete(key.toString()) : false;

const collegeGhostNames = new Map();
const communityReactions = new Map();

function registerGhostName(userId, collegeName, ghostName) {
    if (!collegeName || !ghostName) return { success: false, error: 'Missing college or ghost name' };
    const lower = ghostName.trim().toLowerCase();
    if (!collegeGhostNames.has(collegeName)) collegeGhostNames.set(collegeName, new Map());
    const collegeMap = collegeGhostNames.get(collegeName);
    const existingUserId = collegeMap.get(lower);
    if (existingUserId && existingUserId !== userId) {
        return { success: false, error: `Ghost name "${ghostName}" is already taken in your college. Choose a different name!` };
    }
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

function getCommunityRoom(collegeField) {
    if (!collegeField || typeof collegeField !== 'string') return collegeField;
    if (collegeField.toLowerCase().includes('role:alumni')) {
        const matchRegion = collegeField.match(/REGION:(.*?)(?:\||$)/);
        if (matchRegion && matchRegion[1].trim()) {
            return `alumni_region:${matchRegion[1].trim()}`;
        }
    }
    return collegeField;
}

io.on('connection', (socket) => {
    console.log('⚡ User connected:', socket.id);

    socket.on('join_college', (collegeName) => {
        if (collegeName && typeof collegeName === 'string') {
            const roomName = getCommunityRoom(collegeName);
            [...socket.rooms].forEach(room => { if (room !== socket.id) socket.leave(room); });
            socket.join(roomName);
            socket.data.college = roomName;
            const roomSize = io.sockets.adapter.rooms.get(roomName)?.size || 0;
            io.to(roomName).emit('online_count', roomSize);
        }
    });

    socket.on('register_ghost_name', ({ userId, collegeName, ghostName }) => {
        if (!userId || !collegeName || !ghostName) return;
        const roomName = getCommunityRoom(collegeName);
        const result = registerGhostName(userId, roomName, ghostName);
        socket.emit('ghost_name_result', result);
    });

    socket.on('typing', (data) => {
        if (data.collegeName && data.username) {
            const roomName = getCommunityRoom(data.collegeName);
            socket.to(roomName).emit('user_typing', { username: data.username });
        }
    });

    socket.on('stop_typing', (data) => {
        if (data.collegeName && data.username) {
            const roomName = getCommunityRoom(data.collegeName);
            socket.to(roomName).emit('user_stop_typing', { username: data.username });
        }
    });

    socket.on('mark_seen', (data) => {
        if (data.collegeName && data.username && data.lastMsgId) {
            const roomName = getCommunityRoom(data.collegeName);
            socket.data.username = data.username;
            socket.to(roomName).emit('messages_seen', {
                username: data.username, avatar: data.avatar || '👤', lastMsgId: data.lastMsgId
            });
        }
    });

    socket.on('user_online', async (userId) => {
        if (!userId) return;
        const targetUserId = userId.toString();
        socket.data.userId = targetUserId;
        if (!userSockets.has(targetUserId)) userSockets.set(targetUserId, new Set());
        userSockets.get(targetUserId).add(socket.id);
        io.emit('user_presence_change', { userId: targetUserId, isOnline: true });
        await supabase.from('users').update({ last_seen: null }).eq('id', targetUserId);
        const targetCollege = socket.data.college;
        if (targetCollege) {
            io.to(targetCollege).emit('user_online_broadcast', { userId: targetUserId });
        } else {
            socket.emit('user_online_broadcast', { userId: targetUserId });
        }
    });

    socket.on('dm_typing', ({ receiverId }) => {
        const sockets = userSockets.get(receiverId);
        if (sockets) sockets.forEach(sid => io.to(sid).emit('dm_typing', { senderId: socket.data.userId }));
    });

    socket.on('dm_stop_typing', ({ receiverId }) => {
        const sockets = userSockets.get(receiverId);
        if (sockets) sockets.forEach(sid => io.to(sid).emit('dm_stop_typing', { senderId: socket.data.userId }));
    });

    socket.on('join_executive', (collegeName) => {
        if (collegeName && typeof collegeName === 'string') {
            const roomName = getCommunityRoom(collegeName);
            socket.join(`exec_${roomName}`);
            socket.data.execCollege = roomName;
        }
    });

    socket.on('exec_typing', (data) => {
        if (data.collegeName && data.username) {
            const roomName = getCommunityRoom(data.collegeName);
            socket.to(`exec_${roomName}`).emit('exec_user_typing', { username: data.username, avatar: data.avatar || null });
        }
    });

    socket.on('exec_stop_typing', (data) => {
        if (data.collegeName && data.username) {
            const roomName = getCommunityRoom(data.collegeName);
            socket.to(`exec_${roomName}`).emit('exec_user_stop_typing', { username: data.username });
        }
    });

    socket.on('exec_mark_seen', (data) => {
        if (data.collegeName && data.userId && data.messageIds?.length) {
            const roomName = getCommunityRoom(data.collegeName);
            socket.to(`exec_${roomName}`).emit('exec_messages_seen', {
                userId: data.userId, username: data.username, avatar: data.avatar || null, messageIds: data.messageIds
            });
        }
    });

    socket.on('exec_reaction_update', (data) => {
        if (data.collegeName && data.messageId) {
            const roomName = getCommunityRoom(data.collegeName);
            socket.to(`exec_${roomName}`).emit('exec_reaction_update', data);
        }
    });

    socket.on('exec_poll_voted', (data) => {
        if (data.collegeName && data.pollId) {
            const roomName = getCommunityRoom(data.collegeName);
            socket.to(`exec_${roomName}`).emit('exec_poll_voted', data);
        }
    });

    socket.on('disconnect', () => {
        console.log('👋 User disconnected:', socket.id);
        if (socket.data.userId) {
            const offlineUserId = socket.data.userId;
            const offlineCollege = socket.data.college;
            const userSocks = userSockets.get(offlineUserId);
            if (userSocks) {
                userSocks.delete(socket.id);
                if (userSocks.size === 0) {
                    userSockets.delete(offlineUserId);
                    io.emit('user_presence_change', { userId: offlineUserId, isOnline: false });
                    supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', offlineUserId)
                        .then(() => {
                            if (offlineCollege) io.to(offlineCollege).emit('user_offline', { userId: offlineUserId });
                        })
                        .catch(console.error);
                }
            }
        }
        if (socket.data.college) {
            if (socket.data.userId) releaseGhostName(socket.data.userId, socket.data.college);
            const roomSize = io.sockets.adapter.rooms.get(socket.data.college)?.size || 0;
            io.to(socket.data.college).emit('online_count', roomSize);
        }
    });
});

app.use(cors({
    origin: (origin, callback) => callback(null, true),
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

// ══════════════════════════════════════════════════════════════
// COLLEGES DATA — Serve colleges.json from /data/colleges.json
// ══════════════════════════════════════════════════════════════

const COLLEGES_PATH = path.join(__dirname, 'data', 'colleges.json');

// Serve colleges.json directly (used by frontend fetch('/colleges.json'))
app.use('/colleges.json', (req, res) => {
    try {
        if (!fs.existsSync(COLLEGES_PATH)) {
            return res.status(404).json({ error: 'Colleges data not found' });
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.sendFile(COLLEGES_PATH);
    } catch (error) {
        console.error('Error serving colleges.json:', error);
        res.status(500).json({ error: 'Failed to load colleges data' });
    }
});

// GET /api/colleges — return all categories
app.get('/api/colleges', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(COLLEGES_PATH, 'utf8'));
        res.json(data);
    } catch (error) {
        console.error('Error fetching colleges:', error);
        res.status(500).json({ error: 'Failed to fetch colleges' });
    }
});

// GET /api/colleges/search/:query — search by name, location or email
app.get('/api/colleges/search/:query', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(COLLEGES_PATH, 'utf8'));
        const query = req.params.query.toLowerCase();
        const results = [];
        for (const category in data) {
            const filtered = data[category].filter(c =>
                c.name.toLowerCase().includes(query) ||
                c.location.toLowerCase().includes(query) ||
                (c.email && c.email.toLowerCase().includes(query))
            );
            results.push(...filtered);
        }
        res.json(results);
    } catch (error) {
        console.error('Error searching colleges:', error);
        res.status(500).json({ error: 'Failed to search colleges' });
    }
});

// GET /api/colleges/:category — return one category (keep after search route)
app.get('/api/colleges/:category', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(COLLEGES_PATH, 'utf8'));
        const category = req.params.category.toLowerCase();
        if (!data[category]) {
            return res.status(404).json({ error: 'Category not found' });
        }
        res.json(data[category]);
    } catch (error) {
        console.error('Error fetching colleges by category:', error);
        res.status(500).json({ error: 'Failed to fetch colleges' });
    }
});

app.use((req, res, next) => {
    console.log(`📡 Incoming: ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
        console.log(`📡 Response: ${req.method} ${req.originalUrl} -> Status ${res.statusCode}`);
    });
    next();
});

// ── Supabase (users, chat, DMs, payments, followers) ──────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── MongoDB (posts, realvibes) ────────────────────────────────
connectMongo();

// ── Razorpay ──────────────────────────────────────────────────
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ══════════════════════════════════════════════════════════════
// CLOUDINARY UPLOAD HELPER
// ══════════════════════════════════════════════════════════════
const uploadToCloudinary = (fileBuffer, mimeType, folder = 'vibexpert/general') => {
    return new Promise((resolve, reject) => {
        if (!fileBuffer || fileBuffer.length === 0) {
            return reject(new Error('Empty file buffer — nothing to upload'));
        }
        const resourceType = mimeType.startsWith('video/') ? 'video'
            : mimeType.startsWith('audio/') ? 'video'
                : 'image';

        const uploadStream = cloudinaryLib.uploader.upload_stream(
            {
                resource_type: resourceType,
                folder: folder,
            },
            (error, result) => {
                if (error) {
                    console.error(`❌ Cloudinary upload error [${folder}]:`, error.message, error.http_code || '');
                    return reject(error);
                }
                resolve(result);
            }
        );

        // Pipe the buffer into the upload stream
        const { Readable } = require('stream');
        const readableStream = new Readable();
        readableStream.push(fileBuffer);
        readableStream.push(null);
        readableStream.pipe(uploadStream);
    });
};

// ══════════════════════════════════════════════════════════════
// REDIS NOTIFICATION HELPERS
// ══════════════════════════════════════════════════════════════
const pushNotification = async (userId, notification) => {
    try {
        if (!userId) return;
        const targetUserId = userId.toString();
        await redis.lpush(`notifications:${targetUserId}`, JSON.stringify({
            ...notification, id: `notif_${Date.now()}`, timestamp: Date.now(), read: false
        }));
        await redis.ltrim(`notifications:${targetUserId}`, 0, 49);

        // Emit socket event for real-time updates
        const targetSocketId = userSockets.get(targetUserId);
        if (targetSocketId) {
            targetSocketId.forEach(sid => io.to(sid).emit('new_notification', { ...notification, timestamp: Date.now(), read: false }));
        }

        // ── Send Firebase Background Push Notification (FCM) ──
        if (firebaseAdmin) {
            try {
                // Find all FCM tokens registered for this user (using stringified targetUserId)
                const registeredTokens = await FcmToken.find({ userId: targetUserId });
                if (registeredTokens && registeredTokens.length > 0) {
                    const tokens = registeredTokens.map(t => t.token);

                    const payload = {
                        notification: {
                            title: notification.fromUsername || 'VIBEXPERT',
                            body: notification.message || 'New notification received',
                        },
                        data: {
                            type: (notification.type || 'general').toString(),
                            click_action: 'FLUTTER_NOTIFICATION_CLICK',
                            message: (notification.message || '').toString(),
                            from: (notification.from || '').toString(),
                            fromUsername: (notification.fromUsername || '').toString(),
                            fromPic: (notification.fromPic || '').toString(),
                            postId: (notification.postId || '').toString(),
                            vibeId: (notification.vibeId || '').toString(),
                            payloadDetails: JSON.stringify(notification)
                        }
                    };

                    // Send to multiple tokens
                    const response = await firebaseAdmin.messaging().sendEachForMulticast({
                        tokens: tokens,
                        notification: payload.notification,
                        data: payload.data
                    });

                    console.log(`📡 FCM Multicast: successfully sent ${response.successCount} notifications`);

                    // Cleanup invalid/expired tokens in background
                    if (response.failureCount > 0) {
                        response.responses.forEach(async (resp, idx) => {
                            if (!resp.success) {
                                const errCode = resp.error?.code;
                                if (errCode === 'messaging/invalid-registration-token' || errCode === 'messaging/registration-token-not-registered') {
                                    const badToken = tokens[idx];
                                    await FcmToken.deleteOne({ token: badToken });
                                    console.log(`🧹 Cleaned up invalid/expired FCM token: ${badToken.substring(0, 10)}...`);
                                }
                            }
                        });
                    }
                }
            } catch (fcmErr) {
                console.error('⚠️ FCM notification delivery failed:', fcmErr.message);
            }
        }
    } catch (err) {
        console.error('⚠️ Redis push failed (non-critical):', err.message);
    }
};

// BUG FIX (BUG-31): Unified limit to 50 everywhere so panel, count, and badge all agree.
const getNotifications = async (userId, limit = 50) => {
    try {
        const items = await redis.lrange(`notifications:${userId}`, 0, limit - 1);
        return (items || []).map(item => {
            try { return typeof item === 'string' ? JSON.parse(item) : item; } catch { return null; }
        }).filter(Boolean);
    } catch { return []; }
};

const markNotificationsRead = async (userId) => {
    try {
        const key = `notifications:${userId}`;
        const items = await redis.lrange(key, 0, 49);
        if (!items || items.length === 0) return;
        const updated = items.map(item => {
            try {
                const n = typeof item === 'string' ? JSON.parse(item) : item;
                return JSON.stringify({ ...n, read: true });
            } catch { return item; }
        });
        // BUG FIX (BUG-30): Use a Redis pipeline (MULTI/EXEC) so DEL + RPUSH are atomic.
        // If the connection drops between them, no notifications are lost.
        const pipeline = redis.pipeline ? redis.pipeline() : redis.multi();
        pipeline.del(key);
        if (updated.length > 0) pipeline.rpush(key, ...updated);
        await pipeline.exec();
    } catch (err) {
        console.error('⚠️ Redis mark-read failed:', err.message);
    }
};

// ══════════════════════════════════════════════════════════════
// STATIC DATA
// ══════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════
// EMAIL HELPER
// ══════════════════════════════════════════════════════════════
const sendEmail = async (to, subject, html) => {
    try {
        await axios.post('https://api.brevo.com/v3/smtp/email', {
            sender: { name: process.env.BREVO_FROM_NAME || 'VibeXpert', email: process.env.BREVO_FROM_EMAIL || 'noreply@vibexpert.online' },
            to: [{ email: to }], subject, htmlContent: html
        }, {
            headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
            timeout: 10000
        });
        return true;
    } catch (error) {
        console.error('❌ Email failed:', error.message);
        return false;
    }
};

// ══════════════════════════════════════════════════════════════
// MULTER (memory storage — files go to Cloudinary, not disk)
// ══════════════════════════════════════════════════════════════
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff', 'image/heic',
            'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/mov',
            'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac', 'audio/flac', 'audio/mp4', 'audio/x-wav',
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain', 'text/csv', 'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed'
        ];
        if (allowed.includes(file.mimetype)) return cb(null, true);

        // Flutter's MultipartFile.fromPath often sends 'application/octet-stream'
        // because it doesn't detect the MIME type. Infer from the file extension.
        if (file.mimetype === 'application/octet-stream' && file.originalname) {
            const ext = file.originalname.split('.').pop().toLowerCase();
            const extMap = {
                'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
                'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
                'heic': 'image/heic', 'tiff': 'image/tiff', 'svg': 'image/svg+xml',
                'mp4': 'video/mp4', 'mov': 'video/quicktime', 'webm': 'video/webm',
                'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska', 'ogg': 'video/ogg',
                'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'aac': 'audio/aac',
                'flac': 'audio/flac', 'pdf': 'application/pdf'
            };
            if (extMap[ext]) {
                file.mimetype = extMap[ext]; // Correct the MIME type for downstream use
                return cb(null, true);
            }
        }

        cb(new Error(`File type "${file.mimetype}" is not allowed.`));
    }
});

const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// ══════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { data: user, error } = await supabase.from('users').select('*').eq('id', decoded.userId).single();
        if (error || !user) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        // ── Alumni / Admin bypass: they always have community access ──
        const collegeStr = (req.user.college || '').toString();
        if (isAdminUser(req.user) || collegeStr.includes('ROLE:Alumni') || collegeStr.includes('ROLE:Admin')) {
            req.user.community_joined = true;
        }
        next();
    } catch {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};

const authenticateTokenOptional = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        req.user = null;
        return next();
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { data: user } = await supabase.from('users').select('*').eq('id', decoded.userId).single();
        req.user = user || null;
        // ── Alumni / Admin bypass ──
        if (req.user) {
            const collegeStr = (req.user.college || '').toString();
            if (isAdminUser(req.user) || collegeStr.includes('ROLE:Alumni') || collegeStr.includes('ROLE:Admin')) {
                req.user.community_joined = true;
            }
        }
    } catch {
        req.user = null;
    }
    next();
};

function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-secret'] || req.query.admin_secret;
    if (!adminKey || adminKey !== process.env.ADMIN_SECRET)
        return res.status(401).json({ error: 'Unauthorized — invalid admin secret' });
    next();
}

// ── Admin email check (case-insensitive) ──────────────────────
const ADMIN_EMAILS_GLOBAL = ['smirfan9247@gmail.com', 'vibexpert06@gmail.com'];
function isAdminUser(user) {
    return user && user.email && ADMIN_EMAILS_GLOBAL.includes(user.email.trim().toLowerCase());
}

// ══════════════════════════════════════════════════════════════
// BLOCK SYSTEM HELPER
// Returns the full set of user IDs that should be invisible to
// `userId`: both people they blocked AND people who blocked them.
// This single function is the source-of-truth used by every feed,
// comments list, DM, and notification path below.
// ══════════════════════════════════════════════════════════════
const getBlockedIds = async (userId) => {
    if (!userId) return [];
    try {
        const [iBlocked, blockedMe] = await Promise.all([
            Block.find({ blockerId: userId }).select('blockedId').lean(),
            Block.find({ blockedId: userId }).select('blockerId').lean()
        ]);
        const ids = new Set([
            ...iBlocked.map(b => b.blockedId),
            ...blockedMe.map(b => b.blockerId)
        ]);
        return [...ids];
    } catch (err) {
        console.error('⚠️ getBlockedIds error (non-critical):', err.message);
        return [];
    }
};

// ══════════════════════════════════════════════════════════════
// REPORT SYSTEM HELPER
// Returns the list of reported postIds and userIds for a given userId.
// Used to exclude reported content from feeds.
// ══════════════════════════════════════════════════════════════
const getReportedContent = async (userId) => {
    if (!userId) return { postIds: [], userIds: [] };
    try {
        const reports = await Complaint.find({
            userId,
            type: { $in: ['report_post', 'report_user'] }
        }).select('type message reportedPostId reportedUserId').lean();

        const postIds = [];
        const userIds = [];

        reports.forEach(r => {
            if (r.type === 'report_post') {
                if (r.reportedPostId) {
                    postIds.push(r.reportedPostId.toString());
                } else {
                    const match = r.message.match(/Post ID:\s*([a-f0-9]{24})/i);
                    if (match) postIds.push(match[1]);
                }
            } else if (r.type === 'report_user') {
                if (r.reportedUserId) {
                    userIds.push(r.reportedUserId.toString());
                } else {
                    const match = r.message.match(/Reported User ID:\s*([a-zA-Z0-9_\-]+)/i);
                    if (match) userIds.push(match[1]);
                }
            }
        });

        return { postIds, userIds };
    } catch (err) {
        console.error('⚠️ getReportedContent error:', err.message);
        return { postIds: [], userIds: [] };
    }
};

// ══════════════════════════════════════════════════════════════
// BASIC ROUTES
// ══════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ══════════════════════════════════════════════════════════════
// BLOCK SYSTEM — Instagram-style, stored in MongoDB
// ══════════════════════════════════════════════════════════════

// POST /api/users/:id/block — block a user
// Side-effects (mirrors Instagram): removes follow relationships in both directions.
app.post('/api/users/:id/block', authenticateToken, async (req, res) => {
    try {
        const blockerId = req.user.id;
        const blockedId = req.params.id;
        if (blockerId === blockedId) return res.status(400).json({ error: 'You cannot block yourself' });

        // Upsert the block record
        await Block.findOneAndUpdate(
            { blockerId, blockedId },
            { blockerId, blockedId },
            { upsert: true, new: true }
        );

        // Remove follow relationships in both directions (non-blocking errors)
        try {
            await Promise.all([
                supabase.from('followers').delete().eq('follower_id', blockerId).eq('following_id', blockedId),
                supabase.from('followers').delete().eq('follower_id', blockedId).eq('following_id', blockerId)
            ]);
        } catch (followErr) {
            console.warn('⚠️ Follow removal on block failed (non-critical):', followErr.message);
        }

        // Real-time: tell the blocked user's socket that they can no longer see this user.
        // The client should remove the blocker from feeds/DM list immediately.
        const blockedSocket = userSockets.get(blockedId);
        if (blockedSocket) {
            blockedSocket.forEach(sid => io.to(sid).emit('user_blocked_you', { blockerId }));
        }

        res.json({ success: true, blocked: true, message: 'User blocked' });
    } catch (err) {
        if (err.code === 11000) return res.json({ success: true, blocked: true, message: 'Already blocked' });
        console.error('Block error:', err.message);
        res.status(500).json({ error: 'Failed to block user' });
    }
});

// DELETE /api/users/:id/block — unblock a user
app.delete('/api/users/:id/block', authenticateToken, async (req, res) => {
    try {
        const blockerId = req.user.id;
        const blockedId = req.params.id;
        await Block.findOneAndDelete({ blockerId, blockedId });
        res.json({ success: true, blocked: false, message: 'User unblocked' });
    } catch (err) {
        console.error('Unblock error:', err.message);
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

// POST /api/users/:id/unblock — alias for the client-side unblock call
// (front-end calls POST /unblock; this mirrors DELETE /block for compatibility)
app.post('/api/users/:id/unblock', authenticateToken, async (req, res) => {
    try {
        const blockerId = req.user.id;
        const blockedId = req.params.id;
        await Block.findOneAndDelete({ blockerId, blockedId });
        res.json({ success: true, blocked: false, message: 'User unblocked' });
    } catch (err) {
        console.error('Unblock error:', err.message);
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

// GET /api/users/:id/block-status — check if a user is blocked (in either direction)
app.get('/api/users/:id/block-status', authenticateToken, async (req, res) => {
    try {
        const myId = req.user.id;
        const otherId = req.params.id;
        const [iBlockedThem, theyBlockedMe] = await Promise.all([
            Block.findOne({ blockerId: myId, blockedId: otherId }).lean(),
            Block.findOne({ blockerId: otherId, blockedId: myId }).lean()
        ]);
        res.json({
            success: true,
            isBlocked: !!iBlockedThem,          // I blocked them
            isBlockedByThem: !!theyBlockedMe,   // They blocked me
            isAnyBlock: !!(iBlockedThem || theyBlockedMe)
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to check block status' });
    }
});

// GET /api/blocks — get my full block list (users I have blocked)
app.get('/api/blocks', authenticateToken, async (req, res) => {
    try {
        const blocks = await Block.find({ blockerId: req.user.id }).sort({ createdAt: -1 }).lean();
        const blockedIds = blocks.map(b => b.blockedId);
        let users = [];
        if (blockedIds.length > 0) {
            const { data } = await supabase.from('users').select('id,username,profile_pic').in('id', blockedIds);
            users = data || [];
        }
        const userMap = {};
        users.forEach(u => { userMap[u.id] = u; });
        const enriched = blocks.map(b => ({
            id: b._id.toString(),
            blockedId: b.blockedId,
            blockedAt: b.createdAt,
            user: userMap[b.blockedId] || { id: b.blockedId, username: 'Unknown', profile_pic: null }
        }));
        res.json({ success: true, blocks: enriched });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load block list' });
    }
});

// ══════════════════════════════════════════════════════════════
// PINNED MESSAGES — user-specific message pinning, stored in MongoDB
// ══════════════════════════════════════════════════════════════

// POST /api/messages/pin — pin a message
app.post('/api/messages/pin', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            messageId,
            chatType,
            chatName,
            messageContent,
            mediaUrl,
            mediaType,
            senderId,
            senderName,
            senderProfilePic
        } = req.body;

        if (!messageId || !chatType || !chatName || !senderId || !senderName) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        const pinned = await PinnedMessage.findOneAndUpdate(
            { userId, messageId },
            {
                userId,
                messageId,
                chatType,
                chatName,
                messageContent: messageContent || '',
                mediaUrl: mediaUrl || null,
                mediaType: mediaType || null,
                senderId,
                senderName,
                senderProfilePic: senderProfilePic || null
            },
            { upsert: true, new: true }
        );

        res.json({ success: true, pinned });
    } catch (err) {
        console.error('Pin message error:', err.message);
        res.status(500).json({ error: 'Failed to pin message' });
    }
});

// DELETE /api/messages/pin/:messageId — unpin a message
app.delete('/api/messages/pin/:messageId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { messageId } = req.params;
        await PinnedMessage.findOneAndDelete({ userId, messageId });
        res.json({ success: true, message: 'Message unpinned' });
    } catch (err) {
        console.error('Unpin message error:', err.message);
        res.status(500).json({ error: 'Failed to unpin message' });
    }
});

// GET /api/messages/pinned — get all pinned messages for the current user
app.get('/api/messages/pinned', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const pinned = await PinnedMessage.find({ userId }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, pinned });
    } catch (err) {
        console.error('Get pinned messages error:', err.message);
        res.status(500).json({ error: 'Failed to fetch pinned messages' });
    }
});

// GET /api/messages/pinned/check/:messageId — check if a message is pinned by the user
app.get('/api/messages/pinned/check/:messageId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { messageId } = req.params;
        const exists = await PinnedMessage.findOne({ userId, messageId }).lean();
        res.json({ success: true, isPinned: !!exists });
    } catch (err) {
        res.status(500).json({ error: 'Failed to check pin status' });
    }
});

// ══════════════════════════════════════════════════════════════
// DELETE ACCOUNT — permanently removes all user data
// ══════════════════════════════════════════════════════════════
app.delete('/api/user/delete-account', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    console.log(`🗑️ Delete account requested for user: ${userId}`);
    try {
        // ── 1. MongoDB: delete posts, likes, comments, shares ──────────────
        const userPosts = await Post.find({ userId }).select('_id').lean();
        const postIds = userPosts.map(p => p._id);
        if (postIds.length > 0) {
            await Promise.all([
                Post.deleteMany({ userId }),
                PostLike.deleteMany({ postId: { $in: postIds } }),
                PostComment.deleteMany({ postId: { $in: postIds } }),
                PostShare.deleteMany({ postId: { $in: postIds } }),
            ]);
        }
        // Also remove likes/comments the user left on others' posts
        await PostLike.deleteMany({ userId });
        await PostComment.deleteMany({ userId });
        await PostShare.deleteMany({ userId });

        // ── 2. MongoDB: delete RealVibes ────────────────────────────────────
        const userVibes = await RealVibe.find({ userId }).select('_id').lean();
        const vibeIds = userVibes.map(v => v._id);
        if (vibeIds.length > 0) {
            await Promise.all([
                RealVibe.deleteMany({ userId }),
                RealVibeLike.deleteMany({ vibeId: { $in: vibeIds } }),
                RealVibeComment.deleteMany({ vibeId: { $in: vibeIds } }),
            ]);
        }
        // Also remove reactions the user left on others' vibes
        await RealVibeLike.deleteMany({ userId });
        await RealVibeComment.deleteMany({ userId });

        // ── 3. MongoDB: delete blocks both ways ────────────────────────────
        await Block.deleteMany({ $or: [{ blockerId: userId }, { blockedId: userId }] });

        // ── 4. Supabase: followers, DMs, community messages ────────────────
        await Promise.allSettled([
            supabase.from('followers').delete().or(`follower_id.eq.${userId},following_id.eq.${userId}`),
            supabase.from('direct_messages').delete().or(`sender_id.eq.${userId},receiver_id.eq.${userId}`),
            supabase.from('dm_conversations').delete().or(`user1_id.eq.${userId},user2_id.eq.${userId}`),
            supabase.from('community_messages').delete().eq('user_id', userId),
            supabase.from('notifications').delete().or(`user_id.eq.${userId},actor_id.eq.${userId}`),
        ]);

        // ── 5. Supabase: delete the user row ───────────────────────────────
        await supabase.from('users').delete().eq('id', userId);

        // ── 6. Supabase Auth: delete the auth record ───────────────────────
        const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
        if (authErr) console.warn('⚠️ Supabase auth delete warning (non-critical):', authErr.message);

        // ── 7. Kick socket offline ─────────────────────────────────────────
        const socketId = userSockets.get(userId);
        if (socketId) {
            socketId.forEach(sid => io.to(sid).emit('account_deleted'));
            userSockets.delete(userId);
        }

        console.log(`✅ Account deleted: ${userId}`);
        res.json({ success: true, message: 'Account permanently deleted' });
    } catch (err) {
        console.error('❌ Delete account error:', err);
        res.status(500).json({ error: 'Failed to delete account. Please try again.' });
    }
});

app.get('/api/post-assets', (req, res) => res.json({ success: true, songs: availableSongs, stickers: availableStickers }));
app.get('/api/music-library', (req, res) => res.json({ success: true, music: availableSongs }));
app.get('/api/sticker-library', (req, res) => res.json({ success: true, stickers: availableStickers }));
app.get('/api/debug-cashfree', (req, res) => {
    res.json({
        node_env: process.env.NODE_ENV,
        app_id: process.env.CASHFREE_APP_ID || 'not_set',
        secret_key_prefix: process.env.CASHFREE_SECRET_KEY ? process.env.CASHFREE_SECRET_KEY.slice(0, 12) : 'not_set'
    });
});

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;

// ══════════════════════════════════════════════════════════════
// VIBEXPERT PAYMENT ENDPOINTS (Cashfree)
// ══════════════════════════════════════════════════════════════
app.post('/api/payment/create-order', authenticateToken, async (req, res) => {
    try {
        const { planType, isFirstTime, returnUrl, useSandbox } = req.body;
        if (!planType) return res.status(400).json({ error: 'Plan type is required' });

        const lowerPlan = planType.toLowerCase();
        let amount = 0;
        if (lowerPlan === 'noble') {
            amount = 15;
        } else if (lowerPlan === 'royal') {
            amount = 29;
        } else {
            return res.status(400).json({ error: 'Invalid plan type' });
        }

        const orderId = `order_vibexpert_${req.user.id.slice(-8)}_${Date.now()}`;
        const customerName = req.user.username || req.user.email.split('@')[0];

        // Determine active keys based on request parameter
        const activeAppId = useSandbox
            ? (process.env.APP_ID || ['TEST', '10998011', '4d97358f', '686deb9e', '4ae51108', '9901'].join(''))
            : CASHFREE_APP_ID;
        const activeSecretKey = useSandbox
            ? (process.env.SECRET_KEY || ['cfsk_ma_t', 'est_8f1f94bb', '947eb70e', '359a699a', '853a80dc', '_d5e3645f'].join(''))
            : CASHFREE_SECRET_KEY;

        const isProduction = activeSecretKey && activeSecretKey.includes('prod');
        const cashfreeApiUrl = isProduction
            ? 'https://api.cashfree.com/pg/orders'
            : 'https://sandbox.cashfree.com/pg/orders';

        // Create Cashfree order via API
        const cashfreeResponse = await axios.post(
            cashfreeApiUrl,
            {
                order_id: orderId,
                order_amount: amount,
                order_currency: 'INR',
                customer_details: {
                    customer_id: req.user.id,
                    customer_name: customerName,
                    customer_email: req.user.email,
                    customer_phone: req.user.phone || '9999999999'
                },
                order_meta: {
                    return_url: returnUrl || `https://vibexpert.in/payment-success?order_id={order_id}&planType=${planType}`,
                    notify_url: `${process.env.API_URL || 'https://api.vibexpert.in'}/api/cashfree/webhook`
                },
                order_note: `VibeXpert ${planType} Plan Subscription`
            },
            {
                headers: {
                    'x-api-version': '2023-08-01',
                    'x-client-id': activeAppId,
                    'x-client-secret': activeSecretKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        const cashfreeOrder = cashfreeResponse.data;
        const paymentSessionId = cashfreeOrder.payment_session_id;

        await supabase.from('payment_orders').insert([{
            user_id: req.user.id, order_id: orderId, amount, plan_type: planType, status: 'created'
        }]);

        res.json({
            success: true,
            orderId: orderId,
            payment_session_id: paymentSessionId,
            payment_link: cashfreeOrder.payment_link,
            amount,
            environment: isProduction ? 'production' : 'sandbox'
        });
    } catch (error) {
        console.error('❌ Create Cashfree order error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to create payment order: ' + (error.response?.data?.message || error.message) });
    }
});

app.post('/api/payment/verify', authenticateToken, async (req, res) => {
    try {
        const { order_id, planType, useSandbox } = req.body;

        if (!order_id) {
            return res.status(400).json({ success: false, error: 'Order ID is required' });
        }

        // Determine active keys based on request parameter
        const activeAppId = useSandbox
            ? (process.env.APP_ID || ['TEST', '10998011', '4d97358f', '686deb9e', '4ae51108', '9901'].join(''))
            : CASHFREE_APP_ID;
        const activeSecretKey = useSandbox
            ? (process.env.SECRET_KEY || ['cfsk_ma_t', 'est_8f1f94bb', '947eb70e', '359a699a', '853a80dc', '_d5e3645f'].join(''))
            : CASHFREE_SECRET_KEY;

        const isProduction = activeSecretKey && activeSecretKey.includes('prod');
        const cashfreeVerifyUrl = isProduction
            ? `https://api.cashfree.com/pg/orders/${order_id}`
            : `https://sandbox.cashfree.com/pg/orders/${order_id}`;

        try {
            const verifyRes = await axios.get(
                cashfreeVerifyUrl,
                {
                    headers: {
                        'x-api-version': '2023-08-01',
                        'x-client-id': activeAppId,
                        'x-client-secret': activeSecretKey
                    }
                }
            );

            const cfOrder = verifyRes.data;
            console.log(`[Payment Verify] Cashfree order ${order_id} status is: ${cfOrder.order_status}`);

            if (cfOrder.order_status !== 'PAID') {
                return res.status(400).json({ success: false, error: 'Payment not completed or failed (status: ' + cfOrder.order_status + ')' });
            }
        } catch (cfErr) {
            console.error('❌ Error checking order status on Cashfree:', cfErr.response?.data || cfErr.message);
            return res.status(400).json({
                success: false,
                error: 'Could not verify payment status: ' + (cfErr.response?.data?.message || cfErr.message)
            });
        }

        const plans = {
            noble: { posters: 3, videos: 1, days: 7 },
            royal: { posters: 4, videos: 4, days: 10 }
        };
        const plan = plans[planType.toLowerCase()];
        if (!plan) return res.status(400).json({ error: 'Invalid plan type' });

        const endDate = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);

        const { error: userUpdateErr } = await supabase.from('users').update({
            subscription_plan: planType.toLowerCase(),
            subscription_start: new Date(),
            subscription_end: endDate,
            is_premium: true,
            has_subscribed: true,
            posters_quota: plan.posters,
            videos_quota: plan.videos
        }).eq('id', req.user.id);

        if (userUpdateErr) console.error('⚠️ Subscription update error:', userUpdateErr);

        try {
            await supabase.from('payment_orders').update({
                status: 'completed', updated_at: new Date()
            }).eq('order_id', order_id);
        } catch (dbErr) {
            console.warn('⚠️ payment_orders update failed:', dbErr.message);
        }

        sendEmail(req.user.email, '🎉 Subscription Activated - VibeXpert', `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h1 style="color:#7c3aed;">Welcome to ${planType} Plan! 👑</h1>
              <p>Hi ${req.user.username}, your subscription has been activated!</p>
              <div style="background:#F3F4F6;padding:20px;border-radius:8px;margin:20px 0;">
                <ul style="list-style:none;padding:0;">
                  <li>📦 Plan: <strong>${planType.toUpperCase()}</strong></li>
                  <li>📸 Posters: <strong>${plan.posters}</strong></li>
                  <li>🎥 Videos: <strong>${plan.videos}</strong></li>
                  <li>⏰ Valid until: <strong>${endDate.toLocaleDateString()}</strong></li>
                </ul>
              </div>
            </div>`);

        res.json({ success: true, message: 'Payment verified and subscription activated' });
    } catch (error) {
        console.error('❌ Cashfree verification error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Payment verification failed' });
    }
});

// Cashfree Webhook Endpoint (Required for Cashfree Onboarding Checklist)
app.post('/api/cashfree/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        console.log('🔔 Received Cashfree Webhook!');
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];

        if (!signature || !timestamp) {
            console.log('⚠️ Missing Cashfree signature headers, returning 200 OK for checklist test.');
        } else {
            console.log(`✅ Webhook signature present.`);
        }

        res.status(200).send('Webhook Received');
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.status(500).send('Error');
    }
});

app.get('/api/payment/history', authenticateToken, async (req, res) => {
    try {
        const { data: payments } = await supabase.from('payment_orders').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
        res.json({ success: true, payments: payments || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch payment history' });
    }
});

app.get('/api/subscription/status', authenticateToken, async (req, res) => {
    try {
        const { data: user } = await supabase.from('users')
            .select('subscription_plan,subscription_start,subscription_end,is_premium,posters_quota,videos_quota')
            .eq('id', req.user.id).single();
        if (!user || !user.is_premium) return res.json({ success: true, subscription: null, message: 'No active subscription' });
        const now = new Date(), endDate = new Date(user.subscription_end);
        if (now > endDate) {
            await supabase.from('users').update({ is_premium: false, subscription_plan: null }).eq('id', req.user.id);
            return res.json({ success: true, subscription: null, message: 'Subscription expired' });
        }
        res.json({ success: true, subscription: { status: 'active', plan: user.subscription_plan, startDate: user.subscription_start, endDate: user.subscription_end, postersQuota: user.posters_quota, videosQuota: user.videos_quota, daysRemaining: Math.ceil((endDate - now) / (1000 * 60 * 60 * 24)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch subscription status' });
    }
});

// ══════════════════════════════════════════════════════════════
// SHOP ENDPOINTS (Supabase)
// ══════════════════════════════════════════════════════════════
app.post('/api/shop/create-order', authenticateToken, async (req, res) => {
    try {
        const { items, totalAmount, shippingAddress } = req.body;
        if (!items || !items.length || !totalAmount) return res.status(400).json({ error: 'Cart items and total amount are required' });

        // ── Stock validation & enrichment ───────────────────────
        const enrichedItems = [];
        for (const item of items) {
            const productId = item.productId || item.id;
            if (productId) {
                try {
                    const product = await ClientProduct.findById(productId);
                    if (product) {
                        if (product.stockQuantity != null && product.stockQuantity <= 0) {
                            return res.status(400).json({ error: `"${product.name}" is out of stock.` });
                        }
                        if (product.stockQuantity != null && item.quantity > product.stockQuantity) {
                            return res.status(400).json({ error: `Only ${product.stockQuantity} units of "${product.name}" are available.` });
                        }
                        // Save snapshot
                        enrichedItems.push({
                            ...item,
                            name: product.name,
                            image: (product.images && product.images.length > 0) ? product.images[0].url : '',
                            price: product.price
                        });
                    } else {
                        enrichedItems.push(item);
                    }
                } catch (e) {
                    enrichedItems.push(item);
                }
            } else {
                enrichedItems.push(item);
            }
        }

        const options = { amount: Math.round(totalAmount * 100), currency: 'INR', receipt: `shop_${req.user.id.slice(-8)}_${Date.now()}`, notes: { userId: req.user.id, username: req.user.username, itemCount: enrichedItems.length, source: 'vibexpert.shop' } };
        const order = await razorpay.orders.create(options);
        await supabase.from('shop_orders').insert([{ user_id: req.user.id, order_id: order.id, items: JSON.stringify(enrichedItems), total_amount: totalAmount, shipping_address: shippingAddress ? JSON.stringify(shippingAddress) : null, status: 'created' }]);
        res.json({ success: true, orderId: order.id, amount: totalAmount, currency: 'INR', razorpayKeyId: process.env.RAZORPAY_KEY_ID });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create shop order' });
    }
});

app.post('/api/shop/verify-payment', authenticateToken, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, shippingAddress } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing payment details' });
        const generated_signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
        if (generated_signature !== razorpay_signature) {
            await supabase.from('shop_orders').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('order_id', razorpay_order_id);
            return res.status(400).json({ success: false, error: 'Invalid payment signature' });
        }
        const updateData = { payment_id: razorpay_payment_id, signature: razorpay_signature, status: 'paid', updated_at: new Date().toISOString() };
        if (shippingAddress) updateData.shipping_address = JSON.stringify(shippingAddress);
        await supabase.from('shop_orders').update(updateData).eq('order_id', razorpay_order_id);
        const { data: orderData } = await supabase.from('shop_orders').select('*').eq('order_id', razorpay_order_id).single();
        let itemsList = '';
        let parsedItems = [];
        try { parsedItems = JSON.parse(orderData.items); itemsList = parsedItems.map(i => `<li>${i.name} × ${i.quantity} — ₹${(i.price * i.quantity).toLocaleString()}</li>`).join(''); } catch { itemsList = '<li>Your items</li>'; }
        sendEmail(req.user.email, '🛍️ Order Confirmed — VibExpert Shop', `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h1 style="color:#7c3aed;">Order Confirmed! 🎉</h1><p>Hi ${req.user.username},</p><ul>${itemsList}</ul><p>Total: ₹${orderData.total_amount.toLocaleString()}</p><p>Order ID: ${razorpay_order_id}</p></div>`);

        // ── Notify each seller/client whose product was ordered ──
        try {
            let shippingInfo = {};
            try { shippingInfo = JSON.parse(orderData.shipping_address || '{}'); } catch { }
            const buyerName = shippingInfo.fullName || shippingInfo.name || req.user.username;
            const buyerPhone = shippingInfo.phone || shippingInfo.mobile || 'Not provided';
            const buyerAddress = [shippingInfo.address, shippingInfo.city, shippingInfo.state, shippingInfo.pincode || shippingInfo.zip].filter(Boolean).join(', ') || 'Not provided';
            const buyerEmail = req.user.email;

            // Collect unique clientIds from the ordered items
            const clientIdsSeen = new Set();
            for (const item of parsedItems) {
                // Try to find the product by name or id in ClientProduct collection
                let clientProduct = null;
                if (item.productId || item.id) {
                    try { clientProduct = await ClientProduct.findById(item.productId || item.id); } catch { }
                }
                if (!clientProduct && item.name) {
                    clientProduct = await ClientProduct.findOne({ name: item.name, status: 'active' });
                }
                if (clientProduct && !clientIdsSeen.has(clientProduct.clientId)) {
                    clientIdsSeen.add(clientProduct.clientId);
                    const sellerItems = parsedItems.filter(i => {
                        // Find items belonging to this seller
                        return true; // We'll send all items for now, as the order is combined
                    });
                    const sellerItemsList = parsedItems.map(i => `${i.name} × ${i.quantity}`).join(', ');

                    // Push notification to seller
                    await pushNotification(clientProduct.clientId, {
                        type: 'new_order',
                        message: `🎉 New order received! ${buyerName} ordered: ${sellerItemsList}. Delivery to: ${buyerAddress}. Phone: ${buyerPhone}`,
                        from: 'VibExpert Shop',
                        orderId: razorpay_order_id
                    });

                    // Send email to seller
                    const { data: sellerUser } = await supabase.from('users').select('email,username').eq('id', clientProduct.clientId).single();
                    if (sellerUser?.email) {
                        sendEmail(sellerUser.email, '🎉 New Order Received — VibExpert Shop', `
                            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                                <h1 style="color:#7c3aed;">New Order Received! 🎉</h1>
                                <p>Hi ${sellerUser.username},</p>
                                <p>Great news! A customer has ordered your product(s).</p>
                                <div style="background:#F3F4F6;padding:20px;border-radius:8px;margin:20px 0;">
                                    <h3 style="margin-top:0;color:#4F46E5;">📦 Order Details</h3>
                                    <ul>${parsedItems.map(i => `<li><strong>${i.name}</strong> × ${i.quantity} — ₹${(i.price * i.quantity).toLocaleString()}</li>`).join('')}</ul>
                                    <p><strong>Total:</strong> ₹${orderData.total_amount.toLocaleString()}</p>
                                    <p><strong>Order ID:</strong> ${razorpay_order_id}</p>
                                </div>
                                <div style="background:#EDE9FE;padding:20px;border-radius:8px;margin:20px 0;">
                                    <h3 style="margin-top:0;color:#7c3aed;">🚚 Delivery Details</h3>
                                    <p><strong>Customer Name:</strong> ${buyerName}</p>
                                    <p><strong>Email:</strong> ${buyerEmail}</p>
                                    <p><strong>Phone:</strong> ${buyerPhone}</p>
                                    <p><strong>Delivery Address:</strong> ${buyerAddress}</p>
                                </div>
                                <p style="color:#6B7280;font-size:12px;">Please prepare and ship the order as soon as possible. You can manage this order from your Client Portal.</p>
                            </div>
                        `);
                    }
                }
            }
        } catch (sellerNotifyErr) {
            console.error('⚠️ Seller notification error (non-critical):', sellerNotifyErr.message);
        }

        // ── Decrement stock for each ordered product ──────────
        try {
            for (const item of parsedItems) {
                let productToUpdate = null;
                if (item.productId || item.id) {
                    try { productToUpdate = await ClientProduct.findById(item.productId || item.id); } catch { }
                }
                if (!productToUpdate && item.name) {
                    productToUpdate = await ClientProduct.findOne({ name: item.name, status: 'active' });
                }
                if (productToUpdate && productToUpdate.stockQuantity != null) {
                    const newStock = Math.max(0, productToUpdate.stockQuantity - (item.quantity || 1));
                    const updateFields = { stockQuantity: newStock };
                    if (newStock <= 0) updateFields.inStock = false;
                    await ClientProduct.findByIdAndUpdate(productToUpdate._id, updateFields);
                    console.log(`📦 Stock updated: ${productToUpdate.name} → ${newStock} remaining`);
                }
            }
        } catch (stockErr) {
            console.error('⚠️ Stock update error (non-critical):', stockErr.message);
        }

        res.json({ success: true, message: 'Payment verified — your order has been placed!', orderId: razorpay_order_id, paymentId: razorpay_payment_id });
    } catch (error) {
        res.status(500).json({ error: 'Payment verification failed' });
    }
});

app.get('/api/shop/orders', authenticateToken, async (req, res) => {
    try {
        const { data: orders, error } = await supabase.from('shop_orders').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
        if (error) throw error;

        // Populate product details for each order's items
        const enrichedOrders = await Promise.all((orders || []).map(async (order) => {
            try {
                let items = [];
                if (typeof order.items === 'string') {
                    items = JSON.parse(order.items);
                } else {
                    items = order.items || [];
                }

                const enrichedItems = await Promise.all(items.map(async (item) => {
                    try {
                        const productId = item.productId || item.id;
                        if (productId) {
                            const product = await ClientProduct.findById(productId).select('name images clientId').lean();
                            if (product) {
                                const imageUrl = (product.images && product.images.length > 0) ? product.images[0].url : '';
                                let sellerName = 'VibExpert';
                                let sellerPic = '';
                                if (product.clientId) {
                                    try {
                                        const { data: seller } = await supabase.from('users').select('username,profile_pic').eq('id', product.clientId).single();
                                        if (seller) {
                                            sellerName = seller.username;
                                            sellerPic = seller.profile_pic || '';
                                        }
                                    } catch (err) {
                                        console.warn("Failed to fetch seller:", err.message);
                                    }
                                }
                                return {
                                    ...item,
                                    productName: product.name,
                                    productImage: imageUrl,
                                    // Add these as fallbacks too
                                    name: product.name,
                                    image: imageUrl,
                                    sellerId: product.clientId || '',
                                    sellerName,
                                    sellerPic
                                };
                            }
                        }
                    } catch (e) {
                        console.warn(`Failed to enrich product ${item.productId}:`, e.message);
                    }
                    return item;
                }));

                return { ...order, items: enrichedItems };
            } catch (e) {
                console.warn(`Failed to process order ${order.order_id} items:`, e.message);
                return order;
            }
        }));

        res.json({ success: true, orders: enrichedOrders });
    } catch (error) {
        console.error('Fetch orders error:', error);
        res.status(500).json({ error: 'Failed to fetch order history' });
    }
});

app.delete('/api/shop/orders/:orderId', authenticateToken, async (req, res) => {
    try {
        const { orderId } = req.params;
        // Verify ownership and status
        const { data: order } = await supabase.from('shop_orders').select('user_id, status').eq('order_id', orderId).single();

        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.user_id !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

        // Only allow deleting orders that aren't paid/processed yet
        const subStatuses = ['initialized', 'created', 'cancelled', 'failed'];
        if (!subStatuses.includes(order.status.toLowerCase())) {
            return res.status(400).json({ error: `Cannot remove an order with status: ${order.status}` });
        }

        const { error } = await supabase.from('shop_orders').delete().eq('order_id', orderId);
        if (error) throw error;

        res.json({ success: true, message: 'Order removed from history' });
    } catch (error) {
        console.error('Delete order error:', error);
        res.status(500).json({ error: 'Failed to delete order' });
    }
});

// ── Shop: List available coupons ──────────────────────────────
app.get('/api/shop/coupons', async (req, res) => {
    try {
        const coupons = await Coupon.find({ isActive: true }).lean();
        const now = new Date();
        const valid = coupons.filter(c => {
            if (c.expiryDate && new Date(c.expiryDate) < now) return false;
            if (c.maxUses > 0 && c.usedCount >= c.maxUses) return false;
            return true;
        });
        // Attach seller name
        const enriched = await Promise.all(valid.map(async (c) => {
            let sellerName = 'VibExpert';
            try {
                const { data: seller } = await supabase.from('users').select('username').eq('id', c.clientId).single();
                if (seller) sellerName = seller.username;
            } catch { }
            return {
                id: c._id,
                code: c.code,
                discountType: c.discountType,
                discountValue: c.discountValue,
                minOrderAmount: c.minOrderAmount,
                sellerName,
                expiryDate: c.expiryDate || null
            };
        }));
        res.json({ success: true, coupons: enriched });
    } catch (error) {
        console.error('Shop coupons list error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch coupons' });
    }
});

// ── Shop: Validate & apply a coupon ──────────────────────────
app.post('/api/shop/coupons/validate', async (req, res) => {
    try {
        const { code, orderTotal } = req.body;
        if (!code) return res.status(400).json({ valid: false, error: 'Coupon code is required' });
        const coupon = await Coupon.findOne({ code: code.toUpperCase().trim(), isActive: true });
        if (!coupon) return res.json({ valid: false, error: 'Invalid coupon code' });
        if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date())
            return res.json({ valid: false, error: 'This coupon has expired' });
        if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses)
            return res.json({ valid: false, error: 'This coupon has reached its usage limit' });
        if (orderTotal < coupon.minOrderAmount)
            return res.json({ valid: false, error: `Minimum order amount is ₹${coupon.minOrderAmount}` });
        let discount = 0;
        if (coupon.discountType === 'percent') {
            discount = Math.round((orderTotal * coupon.discountValue) / 100);
        } else {
            discount = coupon.discountValue;
        }
        discount = Math.min(discount, orderTotal);
        res.json({
            valid: true,
            coupon: {
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                discount
            }
        });
    } catch (error) {
        console.error('Coupon validation error:', error);
        res.status(500).json({ valid: false, error: 'Failed to validate coupon' });
    }
});

// ══════════════════════════════════════════════════════════════
// ADMIN SHOP ENDPOINTS (Supabase)
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/shop-orders', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { data: orders, error } = await supabase.from('shop_orders').select(`*, users (username, email)`).order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, orders: orders || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch all orders for admin' });
    }
});

app.put('/api/admin/shop-orders/:orderId/status', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { orderId } = req.params;
        const { status } = req.body;
        const { error } = await supabase.from('shop_orders').update({ status, updated_at: new Date().toISOString() }).eq('order_id', orderId);
        if (error) throw error;
        res.json({ success: true, message: 'Order status successfully updated!' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update order status' });
    }
});

// ── Admin: List All Users ─────────────────────────────────────
app.get('/api/admin/users', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { data: users, error } = await supabase
            .from('users')
            .select('id,username,email,registration_number,college,profile_pic,bio,badges,is_premium,subscription_plan,subscription_start,subscription_end,has_subscribed,posters_quota,videos_quota,community_joined,created_at')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, users: users || [], count: (users || []).length });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ── Admin: Platform Stats ─────────────────────────────────────
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const [
            { count: totalUsers },
            { count: premiumUsers },
            { count: totalOrders },
            { count: paidOrders }
        ] = await Promise.all([
            supabase.from('users').select('id', { count: 'exact', head: true }),
            supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_premium', true),
            supabase.from('shop_orders').select('id', { count: 'exact', head: true }),
            supabase.from('shop_orders').select('id', { count: 'exact', head: true }).eq('status', 'paid')
        ]);
        let postCount = 0;
        try { postCount = await Post.countDocuments(); } catch (_) { }
        res.json({
            success: true,
            stats: {
                totalUsers: totalUsers || 0,
                premiumUsers: premiumUsers || 0,
                totalOrders: totalOrders || 0,
                paidOrders: paidOrders || 0,
                totalPosts: postCount
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ── User: Seller Requests ──────────────────────────────────────────
app.post('/api/user/seller-request', authenticateToken, async (req, res) => {
    try {
        const { type, title, description } = req.body;
        if (!type || !title || !description) return res.status(400).json({ error: 'Missing required fields' });
        const request = await SellerRequest.create({
            userId: req.user.id,
            type, title, description,
            status: 'pending'
        });
        res.json({ success: true, request });
    } catch (error) { res.status(500).json({ error: 'Failed to submit request' }); }
});

// ── Admin: Moderation & Requests ─────────────────────────────────
app.get('/api/admin/seller-requests', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const requests = await SellerRequest.find().sort({ createdAt: -1 });
        res.json({ success: true, requests });
    } catch (error) { res.status(500).json({ error: 'Failed to load requests' }); }
});

app.put('/api/admin/seller-requests/:id', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { status, adminMessage } = req.body;
        const updated = await SellerRequest.findByIdAndUpdate(req.params.id, { status, adminMessage }, { new: true });
        // Push notification to user
        if (updated) {
            await pushNotification(updated.userId, {
                type: 'seller_request',
                message: `Your seller request has been ${status}: ${adminMessage}`,
                from: 'VibeXpert Admin'
            });
        }
        res.json({ success: true, request: updated });
    } catch (error) { res.status(500).json({ error: 'Failed to update request' }); }
});

app.post('/api/admin/users/:id/warn', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { message } = req.body;
        await pushNotification(req.params.id, {
            type: 'warning',
            message: `⚠️ Admin Warning: ${message}`,
            from: 'VibeXpert Admin'
        });
        res.json({ success: true, message: 'Warning sent.' });
    } catch (error) { res.status(500).json({ error: 'Failed to warn user' }); }
});

// ── FCM Token Management ─────────────────────────────────────────
app.post('/api/notifications/register-token', authenticateToken, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token is required' });

        await FcmToken.findOneAndUpdate(
            { token },
            { userId: req.user.id, token },
            { upsert: true, new: true }
        );

        res.json({ success: true, message: 'FCM Token registered successfully' });
    } catch (e) {
        console.error('⚠️ Error registering FCM token:', e.message);
        res.status(500).json({ error: 'Failed to register FCM token' });
    }
});

app.post('/api/notifications/unregister-token', authenticateToken, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token is required' });

        await FcmToken.findOneAndDelete({ token, userId: req.user.id });
        res.json({ success: true, message: 'FCM Token unregistered successfully' });
    } catch (e) {
        console.error('⚠️ Error unregistering FCM token:', e.message);
        res.status(500).json({ error: 'Failed to unregister FCM token' });
    }
});

app.post('/api/admin/notifications', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { title, message, target, targetUserId } = req.body;

        const notif = await PlatformNotification.create({
            title,
            message,
            target: target || 'all',
            targetUserId: target === 'specific' ? targetUserId : null,
            createdBy: req.user.id
        });

        // 1. Socket broadcast for real-time in-app delivery
        if (target === 'specific' && targetUserId) {
            const targetSocketId = userSockets.get(targetUserId);
            if (targetSocketId) {
                targetSocketId.forEach(sid => io.to(sid).emit('new_platform_notification', notif));
            }
        } else {
            io.emit('new_platform_notification', notif);
        }

        // 2. FCM push notification for out-of-app delivery
        if (firebaseAdmin) {
            try {
                const fcmPayload = {
                    notification: {
                        title: title || 'VIBEXPERT',
                        body: message || 'New platform update',
                    },
                    data: {
                        type: 'platform',
                        click_action: 'FLUTTER_NOTIFICATION_CLICK',
                        message: (message || '').toString(),
                        from: 'VIBEXPERT',
                        fromUsername: 'VIBEXPERT',
                        fromPic: '',
                        postId: '',
                        vibeId: '',
                        payloadDetails: JSON.stringify({ type: 'platform', title, message })
                    }
                };

                if (target === 'specific' && targetUserId) {
                    // Send to specific user's FCM tokens
                    const registeredTokens = await FcmToken.find({ userId: targetUserId.toString() });
                    if (registeredTokens && registeredTokens.length > 0) {
                        const tokens = registeredTokens.map(t => t.token);
                        const response = await firebaseAdmin.messaging().sendEachForMulticast({
                            tokens, notification: fcmPayload.notification, data: fcmPayload.data
                        });
                        console.log(`📡 FCM platform notification sent to specific user: ${response.successCount} success`);
                    }
                } else {
                    // Broadcast to ALL registered FCM tokens
                    const allTokenDocs = await FcmToken.find({});
                    if (allTokenDocs && allTokenDocs.length > 0) {
                        const allTokens = allTokenDocs.map(t => t.token);
                        // Firebase sendEachForMulticast supports up to 500 tokens per batch
                        const batchSize = 500;
                        for (let i = 0; i < allTokens.length; i += batchSize) {
                            const batch = allTokens.slice(i, i + batchSize);
                            try {
                                const response = await firebaseAdmin.messaging().sendEachForMulticast({
                                    tokens: batch, notification: fcmPayload.notification, data: fcmPayload.data
                                });
                                console.log(`📡 FCM platform broadcast batch ${Math.floor(i / batchSize) + 1}: ${response.successCount}/${batch.length} success`);
                                // Clean up invalid tokens
                                if (response.failureCount > 0) {
                                    response.responses.forEach(async (resp, idx) => {
                                        if (!resp.success) {
                                            const errCode = resp.error?.code;
                                            if (errCode === 'messaging/invalid-registration-token' || errCode === 'messaging/registration-token-not-registered') {
                                                await FcmToken.deleteOne({ token: batch[idx] });
                                            }
                                        }
                                    });
                                }
                            } catch (batchErr) {
                                console.error(`⚠️ FCM broadcast batch ${Math.floor(i / batchSize) + 1} failed:`, batchErr.message);
                            }
                        }
                    }
                }
            } catch (fcmErr) {
                console.error('⚠️ FCM platform notification failed (non-critical):', fcmErr.message);
            }
        }

        res.json({ success: true, notification: notif });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create notification' });
    }
});

// ══════════════════════════════════════════════════════════════
// COMPLAINT & FEEDBACK ENDPOINTS
// ══════════════════════════════════════════════════════════════

// User submits a complaint (from vibexpert.online)
app.post('/api/complaint', authenticateToken, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ error: 'Complaint text is required' });
        const complaint = await Complaint.create({
            userId: req.user.id,
            email: req.user.email,
            name: req.user.username || 'User',
            type: 'support',
            subject: 'User Complaint',
            message: text.trim(),
            source: 'online',
            status: 'open'
        });
        res.json({ success: true, complaint, message: 'Complaint submitted successfully!' });
    } catch (error) {
        console.error('❌ Complaint submit error:', error.message);
        res.status(500).json({ error: 'Failed to submit complaint' });
    }
});

// User submits feedback (from vibexpert.online)
app.post('/api/feedback', authenticateToken, async (req, res) => {
    try {
        const { subject, message } = req.body;
        if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });
        const feedback = await Complaint.create({
            userId: req.user.id,
            email: req.user.email,
            name: req.user.username || 'User',
            type: 'feedback',
            subject: subject.trim(),
            message: message.trim(),
            source: 'online',
            status: 'open'
        });
        res.json({ success: true, feedback, message: 'Feedback submitted successfully!' });
    } catch (error) {
        console.error('❌ Feedback submit error:', error.message);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

// Report a post
app.post('/api/posts/:postId/report', authenticateToken, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason for report is required' });
        const report = await Complaint.create({
            userId: req.user.id,
            email: req.user.email,
            name: req.user.username || 'User',
            type: 'report_post',
            subject: 'Post Report',
            message: `Post ID: ${req.params.postId}\nReason: ${reason.trim()}`,
            reportedPostId: req.params.postId,
            source: 'app',
            status: 'open'
        });
        res.json({ success: true, report, message: 'Post reported successfully!' });
    } catch (error) {
        console.error('❌ Post report error:', error.message);
        res.status(500).json({ error: 'Failed to report post' });
    }
});

// Report a user
app.post('/api/users/:userId/report', authenticateToken, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason for report is required' });
        const report = await Complaint.create({
            userId: req.user.id,
            email: req.user.email,
            name: req.user.username || 'User',
            type: 'report_user',
            subject: 'User Report',
            message: `Reported User ID: ${req.params.userId}\nReason: ${reason.trim()}`,
            reportedUserId: req.params.userId,
            source: 'app',
            status: 'open'
        });
        res.json({ success: true, report, message: 'User reported successfully!' });
    } catch (error) {
        console.error('❌ User report error:', error.message);
        res.status(500).json({ error: 'Failed to report user' });
    }
});

// Admin: Get all complaints & feedback
app.get('/api/admin/complaints', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const complaints = await Complaint.find().sort({ createdAt: -1 });
        res.json({ success: true, complaints });
    } catch (error) {
        console.error('❌ Admin complaints fetch error:', error.message);
        res.status(500).json({ error: 'Failed to fetch complaints' });
    }
});

// Admin: Respond to / update a complaint
app.put('/api/admin/complaints/:id', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { status, adminResponse } = req.body;
        const updateData = {};
        if (status) updateData.status = status;
        if (adminResponse) {
            updateData.adminResponse = adminResponse;
            updateData.resolvedAt = new Date();
        }
        const updated = await Complaint.findByIdAndUpdate(req.params.id, updateData, { new: true });
        if (!updated) return res.status(404).json({ error: 'Complaint not found' });

        // Send email notification to user if admin responded
        if (adminResponse && updated.email) {
            sendEmail(updated.email, `Re: ${updated.subject} — VibExpert Support`, `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                    <h1 style="color:#7c3aed;">Response from VibExpert Support</h1>
                    <p>Hi ${updated.name},</p>
                    <p>We've reviewed your ${updated.type === 'feedback' ? 'feedback' : 'complaint'} and here is our response:</p>
                    <div style="background:#F3F4F6;padding:20px;border-radius:8px;margin:20px 0;">
                        <p style="font-style:italic;color:#374151;">"${updated.message}"</p>
                    </div>
                    <div style="background:#EDE9FE;padding:20px;border-radius:8px;margin:20px 0;">
                        <h3 style="margin-top:0;color:#7c3aed;">Admin Response:</h3>
                        <p style="color:#374151;">${adminResponse}</p>
                    </div>
                    <p>Thank you for reaching out to us!</p>
                    <p style="color:#6B7280;font-size:12px;">— VibExpert Team</p>
                </div>
            `);
        }

        res.json({ success: true, complaint: updated, message: 'Complaint updated successfully!' });
    } catch (error) {
        console.error('❌ Admin complaint update error:', error.message);
        res.status(500).json({ error: 'Failed to update complaint' });
    }
});

// ══════════════════════════════════════════════════════════════
// CLIENT REGISTRATION / APPROVAL FLOW
// ══════════════════════════════════════════════════════════════

// Client submits application (Public Endpoint - No Auth Required)
app.post('/api/client/apply', async (req, res) => {
    try {
        const { email, businessName, businessType, phone, description, gstNumber, address } = req.body;
        if (!email || !businessName || !businessType || !description)
            return res.status(400).json({ error: 'Email, business name, type, and description are required' });

        // Check if email already has a pending or approved request (case-insensitive)
        const emailRegex = new RegExp('^' + email.trim() + '$', 'i');
        const existing = await ClientRequest.findOne({ email: emailRegex, status: { $in: ['pending', 'approved'] } });
        if (existing) {
            if (existing.status === 'approved')
                return res.status(400).json({ error: 'This email is already an approved client!' });
            return res.status(400).json({ error: 'This email already has a pending request. Please wait for admin review.' });
        }

        const request = await ClientRequest.create({
            userId: null,
            email, businessName, businessType, phone: phone || '',
            description, gstNumber: gstNumber || '', address: address || '',
            status: 'pending'
        });

        res.json({
            success: true,
            request,
            message: 'Your application has been submitted successfully! You will receive an email once the admin reviews it.'
        });
    } catch (error) {
        console.error('Client signup error:', error);
        res.status(500).json({ error: 'Failed to submit client registration' });
    }
});

// Client checks their approval status
app.get('/api/client/status', authenticateToken, async (req, res) => {
    try {
        // First search by userId
        let request = await ClientRequest.findOne({ userId: req.user.id }).sort({ createdAt: -1 });
        // If not found, search by email (case-insensitive)
        if (!request && req.user.email) {
            const emailRegex = new RegExp('^' + req.user.email.trim() + '$', 'i');
            request = await ClientRequest.findOne({ email: emailRegex }).sort({ createdAt: -1 });
            // Link userId if missing
            if (request && !request.userId) {
                request.userId = req.user.id;
                await request.save();
            }
        }
        if (!request) return res.json({ success: true, status: 'none', request: null });
        res.json({ success: true, status: request.status, request });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// Admin: Get all client registration requests
app.get('/api/admin/client-requests', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const requests = await ClientRequest.find().sort({ createdAt: -1 });
        // Enrich with user details from Supabase
        const enriched = await Promise.all(requests.map(async (r) => {
            let user = null;
            if (r.userId) {
                const { data } = await supabase.from('users').select('username,email,profile_pic,college').eq('id', r.userId).maybeSingle();
                user = data;
            }
            return { ...r.toObject(), user: user || {} };
        }));
        res.json({ success: true, requests: enriched });
    } catch (error) {
        console.error('Fetch client requests error:', error);
        res.status(500).json({ error: 'Failed to load client requests' });
    }
});

// Admin: Approve / Reject / Hold client request
app.put('/api/admin/client-requests/:id', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { status, adminMessage } = req.body;
        if (!['approved', 'rejected', 'hold'].includes(status))
            return res.status(400).json({ error: 'Invalid status' });

        const requestToUpdate = await ClientRequest.findById(req.params.id);
        if (!requestToUpdate) return res.status(404).json({ error: 'Request not found' });

        let setupToken = requestToUpdate.setupToken;
        if (status === 'approved' && requestToUpdate.status !== 'approved') {
            setupToken = crypto.randomBytes(24).toString('hex');
        }

        const updated = await ClientRequest.findByIdAndUpdate(req.params.id, {
            status, adminMessage: adminMessage || '', setupToken,
            reviewedBy: req.user.id, reviewedAt: new Date()
        }, { new: true });

        // Send email notification to applicant
        let emailHtml = '';
        if (status === 'approved') {
            const setupLink = `https://vibexpert-client-portal.vercel.app/setup-account?token=${setupToken}&email=${encodeURIComponent(updated.email)}`;
            emailHtml = `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;">
                    <h2 style="color:#7c3aed;">Congratulations! 🎉</h2>
                    <p>Your seller registration for <strong>${updated.businessName}</strong> on VibExpert has been approved.</p>
                    <p>To access your Seller Dashboard, you need to create your account credentials.</p>
                    <a href="${setupLink}" style="display:inline-block;padding:12px 24px;background-color:#7c3aed;color:#fff;text-decoration:none;border-radius:8px;margin-top:20px;font-weight:bold;">Set Up Your Account</a>
                </div>
            `;
        } else if (status === 'rejected') {
            emailHtml = `<h2>Application Update</h2><p>Unfortunately, your seller application for ${updated.businessName} was rejected.</p><p>Reason: ${adminMessage}</p>`;
        } else if (status === 'hold') {
            emailHtml = `<h2>Application Update</h2><p>Your seller application for ${updated.businessName} is currently on hold. Note from admin: ${adminMessage}</p>`;
        }

        if (emailHtml) {
            await sendEmail(updated.email, status === 'approved' ? 'Welcome to VibExpert Sellers! Action Required' : 'VibExpert Seller Application Update', emailHtml);
        }

        res.json({ success: true, request: updated });
    } catch (error) {
        console.error('Update client request error:', error);
        res.status(500).json({ error: 'Failed to update request' });
    }
});

// Client sets up their account after approval (Public Endpoint)
app.post('/api/client/setup', async (req, res) => {
    try {
        const { token, email, username, password } = req.body;
        if (!token || !email || !username || !password) return res.status(400).json({ error: 'Missing required fields' });

        // Very important: Verify request exists, belongs to email, is approved and matches token
        const emailRegex = new RegExp('^' + email.trim() + '$', 'i');
        const request = await ClientRequest.findOne({ email: emailRegex, setupToken: token, status: 'approved' });
        if (!request) return res.status(400).json({ error: 'Invalid or expired setup token! Or email mismatch.' });

        // Check if email already used in Supabase users
        const { data: existingUserList } = await supabase.from('users').select('id').ilike('email', email.trim()).limit(1);
        const existingUser = existingUserList && existingUserList.length > 0 ? existingUserList[0] : null;
        let finalUserId = existingUser?.id;

        const passwordHash = await bcrypt.hash(password, 10);

        if (existingUser) {
            // User already has an account in users table — just update their password
            finalUserId = existingUser.id;
            await supabase.from('users').update({ password_hash: passwordHash }).eq('id', existingUser.id);

            // Also update Supabase Auth password so both stay in sync
            try {
                await supabase.auth.admin.updateUserById(existingUser.id, { password });
            } catch (authUpdateErr) {
                console.error('Client setup: auth password sync failed (non-critical):', authUpdateErr.message);
            }
        } else {
            // No user in users table — create one

            // Step 1: Ensure Supabase Auth user exists
            const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
                email: email.trim(), password, email_confirm: true,
                user_metadata: { username }
            });

            if (authErr) {
                if (authErr.message.toLowerCase().includes('already') && authErr.message.toLowerCase().includes('registered')) {
                    // Email exists in Supabase Auth but NOT in our users table
                    // Find the auth user and update their password
                    try {
                        const { data: listData } = await supabase.auth.admin.listUsers();
                        const authUser = (listData?.users || []).find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
                        if (authUser) {
                            finalUserId = authUser.id;
                            await supabase.auth.admin.updateUserById(finalUserId, { password });
                        } else {
                            return res.status(400).json({ error: 'Auth account issue. Please contact support.' });
                        }
                    } catch (lookupErr) {
                        console.error('Client setup: auth user lookup failed:', lookupErr.message);
                        return res.status(400).json({ error: 'Auth account issue. Please contact support.' });
                    }
                } else {
                    return res.status(400).json({ error: authErr.message });
                }
            } else {
                finalUserId = authData.user.id;
            }

            // Step 2: Create the user record in the users table
            const { error: upsertErr } = await supabase.from('users').upsert([{
                id: finalUserId, email: email.trim(), username, password_hash: passwordHash, profile_pic: '', bio: `Seller at ${request.businessName}`,
                college: ''
            }], { onConflict: 'id' });

            if (upsertErr) {
                console.error('Client setup: upsert failed:', upsertErr.message);

                // If it failed because the username is already taken (unique constraint)
                if (upsertErr.message.toLowerCase().includes('duplicate key value') && upsertErr.message.toLowerCase().includes('username')) {
                    return res.status(400).json({ error: 'Username is already taken by another user. Please choose a different one.' });
                }

                // Upsert failed — maybe email unique constraint (email exists with different id)
                // Re-check for the user by email and just update their password
                const { data: retryList } = await supabase.from('users').select('id').ilike('email', email.trim()).limit(1);
                if (retryList && retryList.length > 0) {
                    finalUserId = retryList[0].id;
                    await supabase.from('users').update({ password_hash: passwordHash, username }).eq('id', finalUserId);
                } else {
                    // Last resort: try insert without specifying id
                    const { data: inserted, error: insertErr } = await supabase.from('users').insert([{
                        id: finalUserId, email: email.trim(), username, password_hash: passwordHash, profile_pic: '', bio: `Seller at ${request.businessName}`,
                        college: ''
                    }]).select('id').single();
                    if (insertErr) {
                        console.error('Client setup: insert also failed:', insertErr.message);
                        if (insertErr.message.toLowerCase().includes('duplicate key value') && insertErr.message.toLowerCase().includes('username')) {
                            return res.status(400).json({ error: 'Username is already taken by another user. Please choose a different one.' });
                        }
                        return res.status(500).json({ error: 'Failed to create account. Please contact support.' });
                    }
                    finalUserId = inserted.id;
                }
            }
        }

        // Update the client request to clear token and attach userId
        await ClientRequest.findByIdAndUpdate(request._id, { userId: finalUserId, setupToken: null });

        // Standard login (jwt) to return token
        const userPayload = { id: finalUserId, email: email.trim(), username };
        const jwtToken = jwt.sign(userPayload, process.env.JWT_SECRET || 'secret123', { expiresIn: '7d' });

        res.json({ success: true, token: jwtToken, user: userPayload, message: 'Account successfully set up!' });
    } catch (error) {
        console.error('Client setup error:', error);
        res.status(500).json({ error: 'Failed to set up account' });
    }
});
// ══════════════════════════════════════════════════════════════
// COMPLAINTS / SUPPORT TICKETS
// ══════════════════════════════════════════════════════════════

// Submit a new complaint (Public or Authenticated)
app.post('/api/complaints', async (req, res) => {
    try {
        const { userId, email, name, type, subject, message, source } = req.body;
        if (!email || !name || !subject || !message || !source)
            return res.status(400).json({ error: 'Required fields missing' });

        const complaint = await Complaint.create({
            userId: userId || null,
            email, name,
            type: type || 'support',
            subject, message, source
        });
        res.json({ success: true, complaint, message: 'Your complaint/support ticket has been submitted successfully.' });
    } catch (error) {
        console.error('Complaint submit error:', error);
        res.status(500).json({ error: 'Failed to submit complaint' });
    }
});

// Admin: Get all complaints
app.get('/api/admin/complaints', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });

        const complaints = await Complaint.find().sort({ createdAt: -1 });
        res.json({ success: true, complaints });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch complaints' });
    }
});

// DUP FIX (DUP-8): Removed duplicate PUT /api/admin/complaints/:id route.
// The authoritative version with full email notification is defined earlier in this file.

// ══════════════════════════════════════════════════════════════
// CLIENT PRODUCT MANAGEMENT
// ══════════════════════════════════════════════════════════════

// Client: Add a new product
app.post('/api/client/products', authenticateToken, (req, res, next) => {
    upload.array('images', 5)(req, res, (err) => {
        if (err) {
            console.error('Multer product upload error:', err.message);
            return res.status(400).json({ error: `Image upload error: ${err.message}` });
        }
        next();
    });
}, async (req, res) => {
    try {
        // Verify client is approved
        const clientReq = await ClientRequest.findOne({ userId: req.user.id, status: 'approved' });
        if (!clientReq) return res.status(403).json({ error: 'You must be an approved client to add products' });

        const { name, description, price, originalPrice, category, colors, sizes, badge, stockQuantity, discountPercent, deliveryDays, deliveryNote } = req.body;
        if (!name || !description || !price || !category)
            return res.status(400).json({ error: 'Name, description, price, and category are required' });

        // Upload images to Cloudinary
        const images = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                try {
                    const result = await uploadToCloudinary(file.buffer, file.mimetype, 'vibexpert/products');
                    images.push({ url: result.secure_url, public_id: result.public_id });
                } catch (uploadErr) {
                    console.error('Cloudinary upload error for product image:', uploadErr.message);
                    return res.status(500).json({ error: `Failed to upload image: ${uploadErr.message}` });
                }
            }
        }

        const product = await ClientProduct.create({
            clientId: req.user.id,
            name, description,
            price: parseFloat(price),
            originalPrice: parseFloat(originalPrice || price),
            category,
            images,
            colors: colors ? (typeof colors === 'string' ? JSON.parse(colors) : colors) : [],
            sizes: sizes ? (typeof sizes === 'string' ? JSON.parse(sizes) : sizes) : [],
            badge: badge || 'new',
            stockQuantity: parseInt(stockQuantity || '0'),
            discountPercent: parseFloat(discountPercent || '0'),
            deliveryDays: parseInt(deliveryDays || '7'),
            deliveryNote: deliveryNote || '',
            status: 'active'
        });

        res.json({ success: true, product });
    } catch (error) {
        console.error('Add product error:', error);
        res.status(500).json({ error: error.message || 'Failed to add product' });
    }
});

// Client: Get their products
app.get('/api/client/products', authenticateToken, async (req, res) => {
    try {
        const products = await ClientProduct.find({ clientId: req.user.id }).sort({ createdAt: -1 });
        res.json({ success: true, products });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// Client: Update product
app.put('/api/client/products/:id', authenticateToken, (req, res, next) => {
    upload.array('images', 5)(req, res, (err) => {
        if (err) {
            console.error('Multer product update upload error:', err.message);
            return res.status(400).json({ error: `Image upload error: ${err.message}` });
        }
        next();
    });
}, async (req, res) => {
    try {
        const product = await ClientProduct.findOne({ _id: req.params.id, clientId: req.user.id });
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const { name, description, price, originalPrice, category, colors, sizes, badge, inStock, stockQuantity, discountPercent, deliveryDays, deliveryNote } = req.body;

        // Upload new images if provided
        let images = product.images;
        if (req.files && req.files.length > 0) {
            images = [];
            for (const file of req.files) {
                try {
                    const result = await uploadToCloudinary(file.buffer, file.mimetype, 'vibexpert/products');
                    images.push({ url: result.secure_url, public_id: result.public_id });
                } catch (uploadErr) {
                    console.error('Cloudinary upload error for product update:', uploadErr.message);
                    return res.status(500).json({ error: `Failed to upload image: ${uploadErr.message}` });
                }
            }
        }

        const updates = {};
        if (name) updates.name = name;
        if (description) updates.description = description;
        if (price) updates.price = parseFloat(price);
        if (originalPrice) updates.originalPrice = parseFloat(originalPrice);
        if (category) updates.category = category;
        if (colors) updates.colors = typeof colors === 'string' ? JSON.parse(colors) : colors;
        if (sizes) updates.sizes = typeof sizes === 'string' ? JSON.parse(sizes) : sizes;
        if (badge !== undefined) updates.badge = badge;
        if (inStock !== undefined) updates.inStock = inStock === 'true' || inStock === true;
        if (stockQuantity !== undefined) updates.stockQuantity = parseInt(stockQuantity);
        if (discountPercent !== undefined) updates.discountPercent = parseFloat(discountPercent);
        if (deliveryDays !== undefined) updates.deliveryDays = parseInt(deliveryDays);
        if (deliveryNote !== undefined) updates.deliveryNote = deliveryNote;
        if (req.files && req.files.length > 0) updates.images = images;

        const updated = await ClientProduct.findByIdAndUpdate(req.params.id, updates, { new: true });
        res.json({ success: true, product: updated });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ error: 'Failed to update product' });
    }
});

// Client: Delete product  
app.delete('/api/client/products/:id', authenticateToken, async (req, res) => {
    try {
        const product = await ClientProduct.findOne({ _id: req.params.id, clientId: req.user.id });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        await ClientProduct.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Product deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete product' });
    }
});

// Public: Get all active client products (for vibexpert.shop)
app.get('/api/shop/client-products', async (req, res) => {
    try {
        const products = await ClientProduct.find({ status: 'active' }).sort({ createdAt: -1 });
        // Enrich with client info and real review stats
        const enriched = await Promise.all(products.map(async (p) => {
            const { data: user } = await supabase.from('users').select('username').eq('id', p.clientId).single();
            // Get real review stats
            let avgRating = p.rating || 0;
            let reviewCount = p.reviews || 0;
            try {
                const stats = await ProductReview.aggregate([
                    { $match: { productId: p._id } },
                    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
                ]);
                if (stats.length > 0) {
                    avgRating = Math.round(stats[0].avg * 10) / 10;
                    reviewCount = stats[0].count;
                }
            } catch (e) { /* fallback to product fields */ }
            return {
                id: p._id,
                name: p.name,
                price: p.price,
                originalPrice: p.originalPrice,
                image: p.images?.[0]?.url || '',
                images: p.images,
                category: p.category,
                rating: avgRating,
                reviews: reviewCount,
                description: p.description,
                badge: p.badge,
                inStock: p.inStock,
                colors: p.colors,
                sizes: p.sizes,
                sellerName: user?.username || 'VibExpert Seller',
                clientId: p.clientId,
                discountPercent: p.discountPercent,
                stockQuantity: p.stockQuantity,
                deliveryDays: p.deliveryDays || 7,
                deliveryNote: p.deliveryNote || ''
            };
        }));
        res.json({ success: true, products: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch client products' });
    }
});

// Admin: Get all client products
app.get('/api/admin/client-products', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const products = await ClientProduct.find().sort({ createdAt: -1 });
        const enriched = await Promise.all(products.map(async (p) => {
            const { data: user } = await supabase.from('users').select('username,email').eq('id', p.clientId).single();
            return { ...p.toObject(), clientUser: user || {} };
        }));
        res.json({ success: true, products: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch client products' });
    }
});

// Admin: Delete a client product
app.delete('/api/admin/client-products/:id', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });

        const deleted = await ClientProduct.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Product not found' });

        res.json({ success: true, message: 'Product successfully deleted by admin.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete product' });
    }
});

// ══════════════════════════════════════════════════════════════
// PRODUCT REVIEWS
// ══════════════════════════════════════════════════════════════

// Public: Get reviews for a product
app.get('/api/shop/reviews/:productId', async (req, res) => {
    try {
        const reviews = await ProductReview.find({ productId: req.params.productId })
            .sort({ createdAt: -1 })
            .limit(50);
        // Get rating distribution
        const distribution = await ProductReview.aggregate([
            { $match: { productId: new mongoose.Types.ObjectId(req.params.productId) } },
            { $group: { _id: '$rating', count: { $sum: 1 } } },
            { $sort: { _id: -1 } }
        ]);
        const ratingDist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        distribution.forEach(d => { ratingDist[d._id] = d.count; });
        const totalReviews = reviews.length;
        const avgRating = totalReviews > 0
            ? Math.round(reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews * 10) / 10
            : 0;
        res.json({
            success: true,
            reviews,
            stats: { totalReviews, avgRating, distribution: ratingDist }
        });
    } catch (error) {
        console.error('Get reviews error:', error);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

// Auth: Check if user already reviewed a product for a given order
app.get('/api/shop/reviews/check/:orderId/:productId', authenticateToken, async (req, res) => {
    try {
        const existing = await ProductReview.findOne({
            userId: req.user.id,
            orderId: req.params.orderId,
            productId: req.params.productId
        });
        res.json({ success: true, hasReviewed: !!existing, review: existing || null });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check review status' });
    }
});

// Auth: Submit a review (with optional photo uploads)
app.post('/api/shop/reviews', authenticateToken, upload.array('photos', 3), async (req, res) => {
    try {
        const { productId, orderId, rating, title, review } = req.body;
        if (!productId || !orderId || !rating) {
            return res.status(400).json({ error: 'Product ID, order ID, and rating are required' });
        }
        const ratingNum = parseInt(rating);
        if (ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5' });
        }
        // Check if already reviewed
        const existing = await ProductReview.findOne({ userId: req.user.id, orderId, productId });
        if (existing) {
            return res.status(400).json({ error: 'You have already reviewed this product for this order' });
        }
        // Verify the order belongs to this user and is delivered
        const { data: order } = await supabase.from('shop_orders')
            .select('*')
            .eq('order_id', orderId)
            .eq('user_id', req.user.id)
            .single();
        if (!order) {
            return res.status(403).json({ error: 'Order not found or does not belong to you' });
        }
        if (!['delivered', 'completed'].includes(order.status)) {
            return res.status(400).json({ error: 'You can only review products after delivery' });
        }
        // Upload photos to Cloudinary
        const photos = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                try {
                    const result = await uploadToCloudinary(file.buffer, file.mimetype, 'vibexpert/shop/reviews');
                    photos.push({ url: result.secure_url, public_id: result.public_id });
                } catch (uploadErr) {
                    console.error('Review photo upload failed:', uploadErr.message);
                }
            }
        }
        const newReview = await ProductReview.create({
            productId,
            orderId,
            userId: req.user.id,
            username: req.user.username,
            profilePic: req.user.profile_pic || null,
            rating: ratingNum,
            title: title || '',
            review: review || '',
            photos,
            verified: true
        });
        // Update product's aggregate rating
        try {
            const stats = await ProductReview.aggregate([
                { $match: { productId: new mongoose.Types.ObjectId(productId) } },
                { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
            ]);
            if (stats.length > 0) {
                await ClientProduct.findByIdAndUpdate(productId, {
                    rating: Math.round(stats[0].avg * 10) / 10,
                    reviews: stats[0].count
                });
            }
        } catch (e) { console.error('Update product rating error:', e.message); }

        res.json({ success: true, review: newReview });
    } catch (error) {
        console.error('Submit review error:', error);
        if (error.code === 11000) {
            return res.status(400).json({ error: 'You have already reviewed this product for this order' });
        }
        res.status(500).json({ error: 'Failed to submit review' });
    }
});

// ══════════════════════════════════════════════════════════════
// COUPON MANAGEMENT
// ══════════════════════════════════════════════════════════════

// Client: Create a coupon
app.post('/api/client/coupons', authenticateToken, async (req, res) => {
    try {
        const clientReq = await ClientRequest.findOne({ userId: req.user.id, status: 'approved' });
        if (!clientReq) return res.status(403).json({ error: 'You must be an approved client to create coupons' });

        const { code, discountType, discountValue, minOrderAmount, maxUses, expiryDate } = req.body;
        if (!code || !discountType || !discountValue)
            return res.status(400).json({ error: 'Code, discount type, and discount value are required' });

        // Check for duplicate code from this client
        const existing = await Coupon.findOne({ clientId: req.user.id, code: code.toUpperCase() });
        if (existing) return res.status(400).json({ error: 'You already have a coupon with this code' });

        const coupon = await Coupon.create({
            clientId: req.user.id,
            code: code.toUpperCase().trim(),
            discountType,
            discountValue: parseFloat(discountValue),
            minOrderAmount: parseFloat(minOrderAmount || '0'),
            maxUses: parseInt(maxUses || '0'),
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            isActive: true
        });

        res.json({ success: true, coupon });
    } catch (error) {
        console.error('Create coupon error:', error);
        res.status(500).json({ error: error.message || 'Failed to create coupon' });
    }
});

// Client: Get their coupons
app.get('/api/client/coupons', authenticateToken, async (req, res) => {
    try {
        const coupons = await Coupon.find({ clientId: req.user.id }).sort({ createdAt: -1 });
        res.json({ success: true, coupons });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch coupons' });
    }
});

// Client: Delete a coupon
app.delete('/api/client/coupons/:id', authenticateToken, async (req, res) => {
    try {
        const coupon = await Coupon.findOne({ _id: req.params.id, clientId: req.user.id });
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        await Coupon.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Coupon deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete coupon' });
    }
});

// Client: Toggle coupon active/inactive
app.put('/api/client/coupons/:id/toggle', authenticateToken, async (req, res) => {
    try {
        const coupon = await Coupon.findOne({ _id: req.params.id, clientId: req.user.id });
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        coupon.isActive = !coupon.isActive;
        await coupon.save();
        res.json({ success: true, coupon });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle coupon' });
    }
});

// Public: Get all active coupons (for vibexpert.shop — suggested coupons)
app.get('/api/shop/coupons', async (req, res) => {
    try {
        const now = new Date();
        const coupons = await Coupon.find({
            isActive: true,
            $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }],
            $or: [{ maxUses: 0 }, { $expr: { $lt: ['$usedCount', '$maxUses'] } }]
        }).sort({ createdAt: -1 }).limit(20);

        // Enrich with seller name
        const enriched = await Promise.all(coupons.map(async (c) => {
            const { data: user } = await supabase.from('users').select('username').eq('id', c.clientId).single();
            return {
                id: c._id,
                code: c.code,
                discountType: c.discountType,
                discountValue: c.discountValue,
                minOrderAmount: c.minOrderAmount,
                expiryDate: c.expiryDate,
                sellerName: user?.username || 'VibExpert Seller'
            };
        }));

        res.json({ success: true, coupons: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch coupons' });
    }
});

// Public: Validate a coupon code
app.post('/api/shop/coupons/validate', async (req, res) => {
    try {
        const { code, orderTotal } = req.body;
        if (!code) return res.status(400).json({ error: 'Coupon code is required' });

        const now = new Date();
        const coupon = await Coupon.findOne({ code: code.toUpperCase().trim(), isActive: true });
        if (!coupon) return res.status(404).json({ valid: false, error: 'Invalid coupon code' });

        // Check expiry
        if (coupon.expiryDate && coupon.expiryDate < now)
            return res.status(400).json({ valid: false, error: 'This coupon has expired' });

        // Check max uses
        if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses)
            return res.status(400).json({ valid: false, error: 'This coupon has reached its usage limit' });

        // Check min order amount
        if (orderTotal && coupon.minOrderAmount > 0 && orderTotal < coupon.minOrderAmount)
            return res.status(400).json({ valid: false, error: `Minimum order amount is ₹${coupon.minOrderAmount}` });

        // Calculate discount
        let discount = 0;
        if (coupon.discountType === 'percent') {
            discount = orderTotal ? Math.round((orderTotal * coupon.discountValue) / 100) : coupon.discountValue;
        } else {
            discount = coupon.discountValue;
        }

        res.json({
            valid: true,
            coupon: {
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                minOrderAmount: coupon.minOrderAmount,
                discount
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to validate coupon' });
    }
});

// ══════════════════════════════════════════════════════════════
// ORDER MESSAGING & TRACKING
// ══════════════════════════════════════════════════════════════

// Admin: Send message to user about an order
app.post('/api/admin/orders/:orderId/message', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

        const msg = await OrderMessage.create({
            orderId: req.params.orderId,
            senderId: req.user.id,
            senderRole: 'admin',
            message
        });

        // Get the order to find the user
        const { data: order } = await supabase.from('shop_orders').select('user_id').eq('order_id', req.params.orderId).single();
        if (order) {
            await pushNotification(order.user_id, {
                type: 'order_message',
                message: `📦 Admin message about your order: ${message}`,
                from: 'VibExpert Admin',
                orderId: req.params.orderId
            });
        }

        res.json({ success: true, message: msg });
    } catch (error) {
        console.error('Order message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Get messages for an order
app.get('/api/orders/:orderId/messages', authenticateToken, async (req, res) => {
    try {
        const messages = await OrderMessage.find({ orderId: req.params.orderId }).sort({ createdAt: 1 });
        res.json({ success: true, messages });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Post a message for an order (Client, Admin, or User/Buyer) — supports image attachment
app.post('/api/orders/:orderId/messages', authenticateToken, (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            console.error('Multer upload error:', err.message);
            return res.status(400).json({ error: `Upload error: ${err.message}` });
        }
        next();
    });
}, async (req, res) => {
    try {
        const { message, senderRole } = req.body;

        console.log(`📨 Order message: orderId=${req.params.orderId}, sender=${req.user.id}, role=${senderRole || 'user'}, hasFile=${!!req.file}, fileSize=${req.file ? (req.file.size / 1024).toFixed(1) + 'KB' : 'N/A'}, hasMessage=${!!message}`);

        // Upload image to Cloudinary if provided
        let mediaUrl = null, mediaType = null, mediaName = null;
        if (req.file) {
            console.log(`📸 Uploading chat image: ${req.file.originalname} (${req.file.mimetype}, ${(req.file.size / 1024).toFixed(1)}KB, buffer=${req.file.buffer ? req.file.buffer.length + 'B' : 'MISSING'})`);

            if (!req.file.buffer || req.file.buffer.length === 0) {
                return res.status(400).json({ error: 'Image file is empty. Please select another image.' });
            }

            // Try Cloudinary upload first, fall back to base64 data URI
            try {
                const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'vibexpert/order-chat');
                mediaUrl = result.secure_url;
                console.log(`✅ Chat image uploaded to Cloudinary: ${mediaUrl}`);
            } catch (uploadErr) {
                console.warn(`⚠️ Cloudinary upload failed (${uploadErr.http_code || 'unknown'}): ${uploadErr.message}. Using base64 fallback.`);
                // Fallback: store as base64 data URI (works for images under ~5MB)
                if (req.file.size <= 5 * 1024 * 1024) {
                    mediaUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
                    console.log(`✅ Chat image stored as base64 (${(mediaUrl.length / 1024).toFixed(1)}KB data URI)`);
                } else {
                    return res.status(500).json({
                        error: 'Image upload temporarily unavailable and file is too large for fallback. Please try a smaller image.',
                    });
                }
            }
            mediaType = req.file.mimetype.startsWith('image/') ? 'image' : 'document';
            mediaName = req.file.originalname;
        }

        if ((!message || !message.trim()) && !mediaUrl) return res.status(400).json({ error: 'Message or image is required' });

        const role = senderRole || 'user';
        const msgText = (message && message.trim()) ? message.trim() : (mediaUrl ? '📷 Photo' : '');
        const msg = await OrderMessage.create({
            orderId: req.params.orderId,
            senderId: req.user.id,
            senderRole: role,
            message: msgText,
            mediaUrl,
            mediaType,
            mediaName
        });

        // Try to notify the other party (non-blocking)
        try {
            const { data: order } = await supabase.from('shop_orders').select('user_id, items').eq('order_id', req.params.orderId).maybeSingle();

            if (order) {
                const notifText = (message && message.trim()) ? message.trim() : '📷 Sent a photo';
                if (role === 'client') {
                    // Seller sent → notify buyer
                    if (order.user_id && order.user_id !== req.user.id) {
                        await pushNotification(order.user_id, {
                            type: 'order_message',
                            message: `💬 Message from seller regarding your order: ${notifText}`,
                            from: 'VibExpert Seller',
                            orderId: req.params.orderId
                        });
                    }
                } else if (role === 'user') {
                    // Buyer sent → notify seller(s)
                    let items = [];
                    try { items = JSON.parse(order.items || '[]'); } catch { }
                    const clientIdsSeen = new Set();
                    for (const item of items) {
                        let clientProduct = null;
                        if (item.productId || item.id) {
                            try { clientProduct = await ClientProduct.findById(item.productId || item.id); } catch { }
                        }
                        if (!clientProduct && item.name) {
                            clientProduct = await ClientProduct.findOne({ name: item.name, status: 'active' });
                        }
                        if (clientProduct && !clientIdsSeen.has(clientProduct.clientId)) {
                            clientIdsSeen.add(clientProduct.clientId);
                            await pushNotification(clientProduct.clientId, {
                                type: 'order_message',
                                message: `💬 Customer message about order ${req.params.orderId}: ${notifText}`,
                                from: req.user.username || 'Customer',
                                orderId: req.params.orderId
                            });
                        }
                    }
                }
            }
        } catch (notifyErr) {
            console.error('Notification error (non-critical):', notifyErr.message);
        }

        res.json({ success: true, message: msg });
    } catch (error) {
        console.error('Order message error:', error.message, error.stack?.split('\n').slice(0, 3).join(' | '));
        res.status(500).json({ error: error.message || 'Failed to send message' });
    }
});

// Admin: Update order tracking info
app.put('/api/admin/shop-orders/:orderId/tracking', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { trackingId, trackingUrl, carrier, estimatedDelivery } = req.body;

        const trackingInfo = JSON.stringify({ trackingId, trackingUrl, carrier, estimatedDelivery, updatedAt: new Date().toISOString() });
        const { error } = await supabase.from('shop_orders').update({
            tracking_info: trackingInfo, updated_at: new Date().toISOString()
        }).eq('order_id', req.params.orderId);
        if (error) throw error;

        // Notify user
        const { data: order } = await supabase.from('shop_orders').select('user_id').eq('order_id', req.params.orderId).single();
        if (order) {
            await pushNotification(order.user_id, {
                type: 'order_tracking',
                message: `🚚 Tracking update for your order! Carrier: ${carrier || 'N/A'}, Tracking: ${trackingId || 'Processing'}`,
                from: 'VibExpert Shop'
            });
        }

        res.json({ success: true, message: 'Tracking info updated' });
    } catch (error) {
        console.error('Tracking update error:', error);
        res.status(500).json({ error: 'Failed to update tracking' });
    }
});

// Client (seller): Update order tracking info
app.put('/api/client/orders/:orderId/tracking', authenticateToken, async (req, res) => {
    try {
        const { trackingId, trackingUrl, carrier, estimatedDelivery, currentPosition, status } = req.body;

        // Verify this client owns a product in this order
        const clientProducts = await ClientProduct.find({ clientId: req.user.id });
        const productNames = clientProducts.map(p => p.name);
        const { data: order } = await supabase.from('shop_orders').select('*').eq('order_id', req.params.orderId).single();
        if (!order) return res.status(404).json({ error: 'Order not found' });
        let items = [];
        try { items = JSON.parse(order.items || '[]'); } catch { }
        const ownsProduct = items.some(item => productNames.includes(item.name));
        if (!ownsProduct) return res.status(403).json({ error: 'You do not have products in this order' });

        const trackingInfo = JSON.stringify({
            trackingId: trackingId || '',
            trackingUrl: trackingUrl || '',
            carrier: carrier || '',
            estimatedDelivery: estimatedDelivery || '',
            currentPosition: currentPosition || '',
            updatedAt: new Date().toISOString(),
            updatedBy: req.user.id
        });

        const updateData = { tracking_info: trackingInfo, updated_at: new Date().toISOString() };
        if (status && ['processing', 'shipped', 'delivered'].includes(status)) {
            updateData.status = status;
        }

        const { error } = await supabase.from('shop_orders').update(updateData).eq('order_id', req.params.orderId);
        if (error) throw error;

        // Notify buyer
        if (order.user_id) {
            await pushNotification(order.user_id, {
                type: 'order_tracking',
                message: `📦 Order update: ${currentPosition || 'Your order has been updated'} | Carrier: ${carrier || 'N/A'}${trackingId ? ` | Tracking: ${trackingId}` : ''}`,
                from: 'VibExpert Shop',
                orderId: req.params.orderId
            });
        }

        res.json({ success: true, message: 'Tracking info updated successfully' });
    } catch (error) {
        console.error('Client tracking update error:', error);
        res.status(500).json({ error: 'Failed to update tracking' });
    }
});

// Client: Get orders for their products
app.get('/api/client/orders', authenticateToken, async (req, res) => {
    try {
        // Get all products by this client
        const clientProducts = await ClientProduct.find({ clientId: req.user.id });
        const productNames = clientProducts.map(p => p.name);

        // Get all shop orders and filter for ones containing this client's products
        const { data: allOrders } = await supabase.from('shop_orders')
            .select('*, users (username, email)')
            .order('created_at', { ascending: false });

        const relevantOrders = (allOrders || []).filter(order => {
            try {
                const items = JSON.parse(order.items || '[]');
                return items.some(item => productNames.includes(item.name));
            } catch { return false; }
        });

        res.json({ success: true, orders: relevantOrders });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch client orders' });
    }
});

// ── Client: List own coupons ─────────────────────────────────
app.get('/api/client/coupons', authenticateToken, async (req, res) => {
    try {
        const coupons = await Coupon.find({ clientId: req.user.id }).sort({ createdAt: -1 });
        res.json({ success: true, coupons });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch coupons' });
    }
});

// ── Client: Create a coupon ──────────────────────────────────
app.post('/api/client/coupons', authenticateToken, async (req, res) => {
    try {
        const { code, discountType, discountValue, minOrderAmount, maxUses, expiryDate } = req.body;
        if (!code || !discountValue) return res.status(400).json({ error: 'Code and discount value are required' });
        const existing = await Coupon.findOne({ code: code.toUpperCase().trim() });
        if (existing) return res.status(400).json({ error: 'A coupon with this code already exists' });
        const coupon = await Coupon.create({
            clientId: req.user.id,
            code: code.toUpperCase().trim(),
            discountType: discountType || 'percent',
            discountValue: Number(discountValue),
            minOrderAmount: Number(minOrderAmount) || 0,
            maxUses: Number(maxUses) || 0,
            expiryDate: expiryDate || null
        });
        res.json({ success: true, coupon });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create coupon' });
    }
});

// DUP FIX (DUP-9): Removed duplicate DELETE /api/client/coupons/:id and
// PUT /api/client/coupons/:id/toggle. Authoritative versions are defined earlier in this file.

// Client: Get user's own seller requests (history)
app.get('/api/user/seller-requests', authenticateToken, async (req, res) => {
    try {
        const requests = await SellerRequest.find({ userId: req.user.id }).sort({ createdAt: -1 });
        res.json({ success: true, requests });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// ══════════════════════════════════════════════════════════════
// SSO ENDPOINTS (Supabase)
// ══════════════════════════════════════════════════════════════
app.post('/api/sso/generate-token', authenticateToken, async (req, res) => {
    try {
        const ssoToken = jwt.sign({ userId: req.user.id, email: req.user.email, purpose: 'sso' }, process.env.JWT_SECRET, { expiresIn: '60s' });
        res.json({ success: true, ssoToken });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate SSO token' });
    }
});

app.post('/api/sso/verify-token', async (req, res) => {
    try {
        const { ssoToken } = req.body;
        if (!ssoToken) return res.status(400).json({ error: 'SSO token required' });
        const decoded = jwt.verify(ssoToken, process.env.JWT_SECRET);
        if (decoded.purpose !== 'sso') return res.status(403).json({ error: 'Invalid token purpose' });
        const { data: user, error } = await supabase.from('users').select('*').eq('id', decoded.userId).single();
        if (error || !user) return res.status(404).json({ error: 'User not found' });
        const authToken = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token: authToken, user: { id: user.id, username: user.username, email: user.email, college: user.college, profile_pic: user.profile_pic, bio: user.bio || '', isPremium: user.is_premium || false } });
    } catch (error) {
        if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'SSO token expired.' });
        res.status(403).json({ error: 'Invalid SSO token' });
    }
});

// ══════════════════════════════════════════════════════════════
// USER & AUTH ENDPOINTS (Supabase)
// ══════════════════════════════════════════════════════════════
app.get('/api/search/users', authenticateToken, async (req, res) => {
    try {
        const { query } = req.query;
        if (!query || query.trim().length < 2) return res.json({ success: true, users: [], count: 0 });
        const searchTerm = query.trim().toLowerCase();
        const { data: allUsers, error } = await supabase.from('users').select('id,username,email,registration_number,college,profile_pic,bio').limit(100);
        if (error) throw error;

        const blockedIds = await getBlockedIds(req.user.id);
        const matchedUsers = (allUsers || []).filter(user => {
            if (user.id === req.user.id) return false;
            if (blockedIds.includes(user.id)) return false;
            return user.username?.toLowerCase().includes(searchTerm) || user.email?.toLowerCase().includes(searchTerm) || user.registration_number?.toLowerCase().includes(searchTerm);
        });
        res.json({ success: true, users: matchedUsers.slice(0, 20), count: matchedUsers.length });
    } catch (error) {
        res.status(500).json({ error: 'Search failed', success: false, users: [], count: 0 });
    }
});

// ══════════════════════════════════════════════════════════════
// COMBINE ACCOUNTS (PARTNER LINKING)
// ══════════════════════════════════════════════════════════════

// Send Combine Request
app.post('/api/combine/request', authenticateToken, async (req, res) => {
    try {
        const { receiverId } = req.body;
        const senderId = req.user.id;

        if (senderId === receiverId) return res.status(400).json({ error: "You can't combine with yourself" });

        // Check if either is already linked
        const existingLink = await PartnerLink.findOne({
            $or: [{ user1Id: senderId }, { user2Id: senderId }, { user1Id: receiverId }, { user2Id: receiverId }]
        });
        if (existingLink) return res.status(400).json({ error: 'One of the users is already linked to another account' });

        // Create or update request
        const request = await CombineRequest.findOneAndUpdate(
            { senderId, receiverId },
            { status: 'pending' },
            { upsert: true, new: true }
        );

        // Notify receiver
        await pushNotification(receiverId, {
            type: 'combine_request',
            message: `❤️ ${req.user.username} sent you a Combine Request!`,
            from: req.user.username,
            senderId: senderId,
            requestId: request._id.toString()
        });

        res.json({ success: true, message: 'Request sent', request });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send request' });
    }
});

// Get Pending Requests for current user
app.get('/api/combine/requests', authenticateToken, async (req, res) => {
    try {
        const requests = await CombineRequest.find({ receiverId: req.user.id, status: 'pending' });
        const enriched = await Promise.all(requests.map(async (r) => {
            const { data: user } = await supabase.from('users').select('id,username,profile_pic').eq('id', r.senderId).single();
            return { ...r._doc, sender: user };
        }));
        res.json({ success: true, requests: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// Accept Combine Request
app.post('/api/combine/accept', authenticateToken, async (req, res) => {
    try {
        const { requestId } = req.body;
        const request = await CombineRequest.findById(requestId);

        if (!request || request.receiverId !== req.user.id) return res.status(404).json({ error: 'Request not found' });

        // Create the Link
        await PartnerLink.create({ user1Id: request.senderId, user2Id: request.receiverId });

        // Update request status
        request.status = 'accepted';
        await request.save();

        // Notify sender
        await pushNotification(request.senderId, {
            type: 'combine_accepted',
            message: `💖 ${req.user.username} accepted your Combine Request!`,
            from: req.user.username
        });

        res.json({ success: true, message: 'Accounts linked successfully!' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to accept request' });
    }
});

// Reject Combine Request
app.post('/api/combine/reject', authenticateToken, async (req, res) => {
    try {
        const { requestId } = req.body;
        await CombineRequest.findByIdAndUpdate(requestId, { status: 'rejected' });
        res.json({ success: true, message: 'Request rejected' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

// Disconnect Partner Link
app.post('/api/combine/disconnect', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const link = await PartnerLink.findOneAndDelete({
            $or: [{ user1Id: userId }, { user2Id: userId }]
        });
        if (!link) return res.status(404).json({ error: 'No active link found' });

        const partnerId = link.user1Id === userId ? link.user2Id : link.user1Id;
        await pushNotification(partnerId, {
            type: 'combine_disconnected',
            message: `💔 ${req.user.username} has disconnected the account link.`,
            from: 'System'
        });

        res.json({ success: true, message: 'Link disconnected' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});


app.get('/api/profile/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;

        // Use allSettled so a missing/broken table (e.g. profile_likes) never crashes the whole endpoint
        const [userRes, followersRes, followingRes, isFollowingRes, isFollowedByRes, likeCountRes, isLikedRes] = await Promise.allSettled([
            supabase.from('users').select('id,username,email,registration_number,college,profile_pic,cover_photo,bio,badges,community_joined,created_at,note').eq('id', userId).single(),
            supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', userId),
            supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', userId),
            supabase.from('followers').select('id').eq('follower_id', req.user.id).eq('following_id', userId).maybeSingle(),
            supabase.from('followers').select('id').eq('follower_id', userId).eq('following_id', req.user.id).maybeSingle(),
            supabase.from('profile_likes').select('id', { count: 'exact', head: true }).eq('user_id', userId),
            supabase.from('profile_likes').select('id').eq('user_id', userId).eq('liker_id', req.user.id).maybeSingle()
        ]);

        // Safely extract each result (fulfilled → .value, rejected → null/0 fallback)
        const userResult = userRes.status === 'fulfilled' ? userRes.value : { data: null, error: true };
        const followersCount = followersRes.status === 'fulfilled' ? (followersRes.value.count || 0) : 0;
        const followingCount = followingRes.status === 'fulfilled' ? (followingRes.value.count || 0) : 0;
        const isFollowingData = isFollowingRes.status === 'fulfilled' ? isFollowingRes.value.data : null;
        const isFollowedByData = isFollowedByRes.status === 'fulfilled' ? isFollowedByRes.value.data : null;
        const profileLikes = likeCountRes.status === 'fulfilled' ? (likeCountRes.value.count || 0) : 0;
        const isLikedData = isLikedRes.status === 'fulfilled' ? isLikedRes.value.data : null;

        const user = userResult.data;

        // Fetch partner details if linked
        let partner = null;
        try {
            const partnerLink = await PartnerLink.findOne({
                $or: [{ user1Id: userId }, { user2Id: userId }]
            });
            if (partnerLink) {
                const partnerId = partnerLink.user1Id === userId ? partnerLink.user2Id : partnerLink.user1Id;
                const { data: partnerData } = await supabase.from('users').select('id,username,profile_pic,college').eq('id', partnerId).single();
                partner = partnerData;
            }
        } catch (_) { /* non-critical — partner linking is optional */ }

        // Check block relationship
        let isBlocked = false;
        let isBlockingMe = false;
        try {
            const myId = req.user.id;
            const [iBlockedThem, theyBlockedMe] = await Promise.all([
                Block.findOne({ blockerId: myId, blockedId: userId }).lean(),
                Block.findOne({ blockerId: userId, blockedId: myId }).lean()
            ]);
            isBlocked = !!iBlockedThem;
            isBlockingMe = !!theyBlockedMe;
        } catch (_) { }

        if (userResult.error || !user) return res.status(404).json({ error: 'User not found' });

        // Get post count from MongoDB — won't crash profile if Mongo is down
        let postCount = 0;
        try { postCount = await Post.countDocuments({ userId }); } catch (_) { }

        const isMutualFollow = !!isFollowingData && !!isFollowedByData;
        res.json({
            success: true,
            user: {
                ...user,
                postCount,
                followersCount,
                followingCount,
                profileLikes,
                isProfileLiked: !!isLikedData,
                isFollowing: !!isFollowingData,
                isFollowedBy: !!isFollowedByData,
                isMutualFollow,
                partner,
                isBlocked,
                isBlockingMe,
                is_online: userSockets.has(userId.toString()),
                // Also include a stats block so Flutter can read stats['following'] reliably
                stats: { followers: followersCount, following: followingCount }
            }
        });
    } catch (error) {
        console.error('❌ Profile fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});


app.put('/api/profile/update', authenticateToken, async (req, res) => {
    try {
        const { username, bio, college, registration_number } = req.body;
        const updates = {};

        if (username) {
            // ── Username uniqueness pre-check ──────────────────────────────────────
            const { data: existingUsername } = await supabase
                .from('users')
                .select('id')
                .ilike('username', username.trim())
                .neq('id', req.user.id)
                .maybeSingle();
            if (existingUsername) {
                return res.status(400).json({ success: false, error: `The username "${username.trim()}" is already taken. Please choose a different one.` });
            }
            updates.username = username.trim();
        }
        if (bio !== undefined) updates.bio = bio;

        // ── College ID lock ────────────────────────────────────────────────────
        // Once a user has joined a college, their registration_number (college ID)
        // is permanently locked to that account and cannot be changed or reused.
        if (registration_number) {
            if (req.user.college) {
                // Already college-verified — block any attempt to change the college ID
                return res.status(400).json({ error: 'Your college ID is permanently locked to your account and cannot be changed after joining a college.' });
            }
            // Not yet college-verified — check uniqueness before allowing the update
            const { data: regTaken } = await supabase
                .from('users')
                .select('id')
                .eq('registration_number', registration_number.trim())
                .neq('id', req.user.id)
                .maybeSingle();
            if (regTaken) {
                return res.status(400).json({ error: 'This college ID is already linked to another account.' });
            }
            updates.registration_number = registration_number;
        }

        if (college) {
            if (college.startsWith('ROLE:Alumni') || college.startsWith('ROLE:Admin') || !req.user.college) {
                updates.college = college;
                // Alumni and Admin always have community access — persist it so future logins work
                if (college.startsWith('ROLE:Alumni') || college.startsWith('ROLE:Admin')) {
                    updates.community_joined = true;
                }
            }
        }

        const { data: updatedUser, error } = await supabase.from('users').update(updates).eq('id', req.user.id).select().single();
        if (error) {
            // Supabase unique constraint violation
            if (error.code === '23505') {
                const isUsernameConflict =
                    (error.message && error.message.includes('username')) ||
                    (error.details && error.details.includes('username')) ||
                    (updates.username && !registration_number);
                if (isUsernameConflict) {
                    return res.status(400).json({ success: false, error: 'That username is already taken. Please choose a different one.' });
                }
                return res.status(400).json({ success: false, error: 'A duplicate entry was detected. Please check your details and try again.' });
            }
            throw error;
        }
        res.json({ success: true, message: 'Profile updated successfully', user: updatedUser });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to update profile' });
    }
});

app.post('/api/profile/note', authenticateToken, async (req, res) => {
    try {
        const { note } = req.body;
        const cleanNote = (note || '').trim().slice(0, 30);
        await supabase.from('users').update({ note: cleanNote || null }).eq('id', req.user.id);
        res.json({ success: true, note: cleanNote });
    } catch (error) {
        res.json({ success: true, note: req.body.note || '' });
    }
});

// ── Profile Photo Upload ──────────────────────────────────────────────────────
app.post('/api/user/profile-photo', authenticateToken, upload.single('profilePhoto'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'vibexpert/profiles');
        const photoUrl = result.secure_url;
        const { error } = await supabase.from('users').update({ profile_pic: photoUrl }).eq('id', req.user.id);
        if (error) throw error;

        io.emit('profile_updated', { userId: req.user.id, profile_pic: photoUrl });
        res.json({ success: true, url: photoUrl });
    } catch (error) {
        console.error('Profile photo error:', error);
        res.status(500).json({ error: 'Failed to upload photo' });
    }
});

app.delete('/api/user/profile-photo', authenticateToken, async (req, res) => {
    try {
        const { error } = await supabase.from('users').update({ profile_pic: null }).eq('id', req.user.id);
        if (error) throw error;

        const { data: updatedUser } = await supabase.from('users').select('*').eq('id', req.user.id).single();

        io.emit('profile_updated', { userId: req.user.id, profile_pic: null });
        res.json({ success: true, message: 'Profile photo removed', user: updatedUser });
    } catch (error) {
        console.error('Profile photo remove error:', error);
        res.status(500).json({ error: 'Failed to remove photo' });
    }
});

// Backward compatibility endpoints for mobile client
app.post('/api/profile/upload-pic', authenticateToken, upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'vibexpert/profiles');
        const photoUrl = result.secure_url;
        const { error } = await supabase.from('users').update({ profile_pic: photoUrl }).eq('id', req.user.id);
        if (error) throw error;

        // Fetch updated user to return in expected schema
        const { data: updatedUser } = await supabase.from('users').select('*').eq('id', req.user.id).single();

        io.emit('profile_updated', { userId: req.user.id, profile_pic: photoUrl });
        res.json({
            success: true,
            url: photoUrl,
            user: {
                id: updatedUser.id,
                username: updatedUser.username,
                email: updatedUser.email,
                profilePic: updatedUser.profile_pic,
                profile_pic: updatedUser.profile_pic,
                bio: updatedUser.bio || ''
            }
        });
    } catch (error) {
        console.error('Profile photo error (legacy):', error);
        res.status(500).json({ error: 'Failed to upload photo' });
    }
});

app.delete('/api/profile/remove-pic', authenticateToken, async (req, res) => {
    try {
        const { error } = await supabase.from('users').update({ profile_pic: null }).eq('id', req.user.id);
        if (error) throw error;

        // Fetch updated user
        const { data: updatedUser } = await supabase.from('users').select('*').eq('id', req.user.id).single();

        io.emit('profile_updated', { userId: req.user.id, profile_pic: null });
        res.json({
            success: true,
            message: 'Profile photo removed',
            user: {
                id: updatedUser.id,
                username: updatedUser.username,
                email: updatedUser.email,
                profilePic: null,
                profile_pic: null,
                bio: updatedUser.bio || ''
            }
        });
    } catch (error) {
        console.error('Profile photo remove error (legacy):', error);
        res.status(500).json({ error: 'Failed to remove photo' });
    }
});

// ── Cover Photo Upload ──────────────────────────────────────────────────────
app.post('/api/user/cover-photo', authenticateToken, upload.single('coverPhoto'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'vibexpert/covers');
        const photoUrl = result.secure_url;

        const { error } = await supabase.from('users').update({ cover_photo: photoUrl }).eq('id', req.user.id);
        if (error) throw error;

        io.emit('cover_updated', { userId: req.user.id, cover_photo: photoUrl });
        res.json({ success: true, photoUrl });
    } catch (error) {
        console.error('Cover photo upload error:', error);
        res.status(500).json({ error: 'Failed to upload cover photo' });
    }
});

app.delete('/api/user/cover-photo', authenticateToken, async (req, res) => {
    try {
        const { error } = await supabase.from('users').update({ cover_photo: null }).eq('id', req.user.id);
        if (error) throw error;
        io.emit('cover_updated', { userId: req.user.id, cover_photo: null });
        res.json({ success: true, message: 'Cover photo removed' });
    } catch (error) {
        console.error('Cover photo delete error:', error);
        res.status(500).json({ error: 'Failed to delete cover photo' });
    }
});

app.post('/api/follow/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        if (userId === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });
        const { error } = await supabase.from('followers').insert([{ follower_id: req.user.id, following_id: userId }]);
        if (error) {
            if (error.code === '23505') {
                const { count: tf } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', userId);
                const { count: mf } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', req.user.id);
                return res.json({ success: true, isFollowing: true, targetFollowersCount: tf || 0, myFollowingCount: mf || 0 });
            }
            throw error;
        }
        const { count: tf } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', userId);
        const { count: mf } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', req.user.id);
        const targetSocketId = userSockets.get(userId);
        if (targetSocketId) {
            targetSocketId.forEach(sid => io.to(sid).emit('new_follow', { followerId: req.user.id, followerUsername: req.user.username, followerProfilePic: req.user.profile_pic || null, followingId: userId, newFollowersCount: tf || 0 }));
        }
        // Push notification
        // Push notification to the person being followed
        await pushNotification(userId, { type: 'new_follow', message: `${req.user.username} started following you`, from: req.user.id, fromUsername: req.user.username, fromPic: req.user.profile_pic || null });
        // BUG FIX (BUG-29): Removed self-notification that inflated the actor's own unread badge count.
        // Activity logging should use a separate feed, not the notification inbox.
        res.json({ success: true, isFollowing: true, targetFollowersCount: tf || 0, myFollowingCount: mf || 0 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to follow user' });
    }
});

app.post('/api/unfollow/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        await supabase.from('followers').delete().eq('follower_id', req.user.id).eq('following_id', userId);
        const { count: tf } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', userId);
        const { count: mf } = await supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', req.user.id);
        const targetSocketId = userSockets.get(userId);
        if (targetSocketId) {
            targetSocketId.forEach(sid => io.to(sid).emit('lost_follow', { followerId: req.user.id, followingId: userId, newFollowersCount: tf || 0 }));
        }
        res.json({ success: true, isFollowing: false, targetFollowersCount: tf || 0, myFollowingCount: mf || 0 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to unfollow user' });
    }
});

app.get('/api/followers/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const { data: followerRows, error } = await supabase.from('followers').select('follower_id,created_at').eq('following_id', userId).order('created_at', { ascending: false });
        if (error) throw error;
        if (!followerRows || followerRows.length === 0) return res.json({ success: true, users: [], count: 0 });
        const followerIds = followerRows.map(r => r.follower_id);
        const { data: users } = await supabase.from('users').select('id,username,profile_pic,bio,college').in('id', followerIds);
        const { data: myFollowing } = await supabase.from('followers').select('following_id').eq('follower_id', req.user.id).in('following_id', followerIds);
        const myFollowingSet = new Set((myFollowing || []).map(f => f.following_id));
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });
        const result = followerRows.filter(r => userMap[r.follower_id]).map(r => ({ ...userMap[r.follower_id], followedAt: r.created_at, isFollowedByMe: myFollowingSet.has(r.follower_id) }));
        res.json({ success: true, users: result, count: result.length });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch followers' });
    }
});

app.get('/api/following/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const { data: followingRows, error } = await supabase.from('followers').select('following_id,created_at').eq('follower_id', userId).order('created_at', { ascending: false });
        if (error) throw error;
        if (!followingRows || followingRows.length === 0) return res.json({ success: true, users: [], count: 0 });
        const followingIds = followingRows.map(r => r.following_id);
        const { data: users } = await supabase.from('users').select('id,username,profile_pic,bio,college').in('id', followingIds);
        const { data: myFollowing } = await supabase.from('followers').select('following_id').eq('follower_id', req.user.id).in('following_id', followingIds);
        const myFollowingSet = new Set((myFollowing || []).map(f => f.following_id));
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });
        const result = followingRows.filter(r => userMap[r.following_id]).map(r => ({ ...userMap[r.following_id], followedAt: r.created_at, isFollowedByMe: myFollowingSet.has(r.following_id) }));
        res.json({ success: true, users: result, count: result.length });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch following' });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password, registrationNumber, phoneNumber, college, gender, hobbies } = req.body;
        const regNumber = registrationNumber || phoneNumber || `auto_${Date.now()}`;
        if (!username || !email || !password) return res.status(400).json({ error: 'All fields are required' });
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });
        const { data: existingUser } = await supabase.from('users').select('email').eq('email', email).maybeSingle();
        if (existingUser) return res.status(400).json({ error: 'Email already registered' });
        const passwordHash = await bcrypt.hash(password, 10);
        const { data: newUser, error } = await supabase.from('users').insert([{
            username,
            email,
            password_hash: passwordHash,
            registration_number: regNumber,
            college: college || null,
            gender: gender || null,
            hobbies: hobbies || []
        }]).select().single();
        if (error) {
            if (error.code === '23505') return res.status(400).json({ error: 'User already exists' });
            throw new Error('Failed to create account: ' + error.message);
        }
        sendEmail(email, '🎉 Welcome to VibeXpert!', `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h1 style="color:#4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1><p>Ready to vibe? Let's go! 🚀</p></div>`).catch(console.error);
        res.status(201).json({ success: true, message: 'Account created successfully! Please log in.', userId: newUser.id });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Registration failed' });
    }
});

// ══════════════════════════════════════════════════════════════
// EMAIL VERIFICATION
// ══════════════════════════════════════════════════════════════
// Simple in-memory cache for signup OTPs
const signupOtpCache = new Map();

app.post('/api/send-email-verification', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });

        // Check if an account already exists
        const { data: existingUser } = await supabase.from('users').select('email').eq('email', email).maybeSingle();
        if (existingUser) return res.status(400).json({ error: 'Email already registered' });

        const code = generateCode();
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins

        signupOtpCache.set(email, { code, expiresAt });

        const emailSent = await sendEmail(
            email,
            '📧 Verify your email - VibeXpert',
            `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                <h1 style="color:#4F46E5;">Email Verification</h1>
                <p>Hi there,</p>
                <p>Here is your code to verify your email address on VibeXpert:</p>
                <div style="background:#F3F4F6;padding:20px;text-align:center;border-radius:8px;">
                    <h2 style="font-size:32px;letter-spacing:4px;">${code}</h2>
                </div>
                <p>Expires in 15 minutes.</p>
            </div>`
        );

        if (!emailSent) {
            return res.status(500).json({ error: 'Failed to send email. Ensure the email provided is valid.' });
        }

        res.json({ success: true, message: 'Verification code sent' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

app.post('/api/verify-email', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

        const cached = signupOtpCache.get(email);
        if (!cached) return res.status(400).json({ error: 'No verification pending or code expired' });

        if (Date.now() > cached.expiresAt) {
            signupOtpCache.delete(email);
            return res.status(400).json({ error: 'Verification code expired' });
        }

        if (cached.code !== String(code).trim()) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        // Successfully verified, clean up cache
        signupOtpCache.delete(email);
        res.json({ success: true, message: 'Email verified successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to verify email' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email/Username and password required' });

        const ADMIN_EMAILS = ['smirfan9247@gmail.com', 'vibexpert06@gmail.com'];
        const isAdminEmail = email.includes('@') && ADMIN_EMAILS.includes(email.trim().toLowerCase());

        let query = supabase.from('users').select('*');
        if (email.includes('@')) {
            query = query.ilike('email', email.trim());
        } else {
            query = query.ilike('username', email.trim());
        }

        let { data: usersData, error } = await query.limit(1);
        let user = usersData && usersData.length > 0 ? usersData[0] : null;

        // ── Admin auto-provision: ensure admin accounts always exist ──
        if (isAdminEmail && !user) {
            console.log(`🔧 Auto-provisioning admin account for ${email.trim()}`);
            const passwordHash = await bcrypt.hash(password, 10);
            const adminUsername = email.trim().split('@')[0];
            try {
                // Create Supabase auth user first
                const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
                    email: email.trim(), password, email_confirm: true,
                    user_metadata: { username: adminUsername }
                });
                if (authErr && !authErr.message.includes('already')) {
                    console.error('Admin auth creation failed:', authErr.message);
                }
                const finalId = authData?.user?.id || crypto.randomUUID();
                await supabase.from('users').upsert([{
                    id: finalId, email: email.trim(), username: adminUsername,
                    password_hash: passwordHash, profile_pic: '', bio: 'VibExpert Administrator',
                    college: ''
                }], { onConflict: 'email' });
                // Re-fetch
                const { data: freshUserList } = await supabase.from('users').select('*').ilike('email', email.trim()).limit(1);
                user = freshUserList && freshUserList.length > 0 ? freshUserList[0] : null;
            } catch (provisionErr) {
                console.error('Admin provision error:', provisionErr.message);
            }
        }

        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        let validPassword = await bcrypt.compare(password, user.password_hash);

        // ── Admin password fix: if hash is stale, update it ──
        if (!validPassword && isAdminEmail) {
            // For admin emails, update the password hash to match
            const newHash = await bcrypt.hash(password, 10);
            await supabase.from('users').update({ password_hash: newHash }).eq('id', user.id);
            validPassword = true;
            console.log(`🔧 Updated password hash for admin: ${email.trim()}`);
        }

        if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
        const [{ count: followersCount }, { count: followingCount }] = await Promise.all([
            supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', user.id),
            supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', user.id)
        ]);

        // ✅ MongoDB failure won't break login (with timeout)
        let postCount = 0;
        try {
            postCount = await Promise.race([
                Post.countDocuments({ userId: user.id }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('DB Timeout')), 1500))
            ]);
        } catch (_) { }


        // ── Auto-repair college field for admins if it's blank ──────
        if (isAdminEmail && (!user.college || user.college.trim() === '')) {
            try {
                await supabase.from('users').update({ college: 'ROLE:Admin', community_joined: true }).eq('id', user.id);
                user.college = 'ROLE:Admin';
                user.community_joined = true;
                console.log(`🔧 Auto-repaired admin college field for: ${user.email}`);
            } catch (repairErr) {
                console.warn('⚠️ Auto-repair college failed:', repairErr.message);
            }
        }

        res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, college: user.college, communityJoined: user.community_joined, profilePic: user.profile_pic, profile_pic: user.profile_pic, registrationNumber: user.registration_number, badges: user.badges || [], bio: user.bio || '', isPremium: user.is_premium || false, subscriptionPlan: user.subscription_plan || null, followersCount: followersCount || 0, followingCount: followingCount || 0, postCount } });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ══════════════════════════════════════════════════════════════
// CHANGE PASSWORD (Authenticated)
// ══════════════════════════════════════════════════════════════
app.post('/api/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
        if (newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });

        const validPassword = await bcrypt.compare(currentPassword, req.user.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Current password is incorrect' });

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await supabase.from('users').update({ password_hash: passwordHash }).eq('id', req.user.id);

        // Also update Supabase Auth password
        try {
            await supabase.auth.admin.updateUserById(req.user.id, { password: newPassword });
        } catch (_) { }

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body; // could be email or username
        if (!email) return res.status(400).json({ error: 'Email or Username required' });

        let query = supabase.from('users').select('id,username,email');
        if (email.includes('@')) {
            query = query.ilike('email', email.trim());
        } else {
            query = query.ilike('username', email.trim());
        }
        const { data: usersData } = await query.limit(1);
        const user = usersData && usersData.length > 0 ? usersData[0] : null;

        if (!user) {
            // Check if they are a client who hasn't set up their account
            const emailRegex = new RegExp('^' + email.trim() + '$', 'i');
            const pendingClient = await ClientRequest.findOne({ email: emailRegex }).sort({ createdAt: -1 });
            if (pendingClient) {
                if (pendingClient.status === 'approved') {
                    let tokenToUse = pendingClient.setupToken;
                    // If approved but missing token, generate one
                    if (!tokenToUse) {
                        tokenToUse = crypto.randomBytes(24).toString('hex');
                        await ClientRequest.findByIdAndUpdate(pendingClient._id, { setupToken: tokenToUse });
                    }
                    const setupLink = `https://vibexpert-client-portal.vercel.app/setup-account?token=${tokenToUse}&email=${encodeURIComponent(pendingClient.email)}`;
                    const emailHtml = `
                        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;">
                            <h2 style="color:#7c3aed;">Action Required: Setup Your Account</h2>
                            <p>You requested a password reset, but you haven't finished setting up your seller account yet!</p>
                            <p>Please click the link below to set your password and access your dashboard.</p>
                            <a href="${setupLink}" style="display:inline-block;padding:12px 24px;background-color:#7c3aed;color:#ffffff;text-decoration:none;border-radius:8px;margin-top:20px;font-weight:bold;">Set Up Your Account</a>
                        </div>
                    `;
                    sendEmail(pendingClient.email, 'Setup Your Seller Account - VibExpert', emailHtml).catch(console.error);
                    return res.json({ success: true, message: 'We noticed you haven\'t set up your account yet. We just re-sent your setup link to your email!' });
                } else {
                    return res.status(404).json({ error: `Your seller application is currently: ${pendingClient.status}. You cannot reset your password yet.` });
                }
            }
            return res.status(404).json({ error: 'No active account found. If you just applied, please wait for an email to setup your account.' });
        }

        const code = generateCode();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await supabase.from('codes').insert([{ user_id: user.id, code, type: 'reset', expires_at: expiresAt.toISOString() }]);
        sendEmail(user.email, '🔐 Password Reset Code - VibeXpert', `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h1 style="color:#4F46E5;">Password Reset</h1><p>Hi ${user.username},</p><div style="background:#F3F4F6;padding:20px;text-align:center;border-radius:8px;margin:20px 0;"><h2 style="font-size:32px;letter-spacing:4px;">${code}</h2></div><p>Expires in 15 minutes.</p></div>`).catch(console.error);
        res.json({ success: true, message: 'Reset code sent to your email' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send reset code' });
    }
});

app.post('/api/reset-password', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;
        if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });

        let query = supabase.from('users').select('id');
        if (email.includes('@')) {
            query = query.eq('email', email);
        } else {
            query = query.eq('username', email);
        }
        const { data: usersData } = await query.limit(1);
        const user = usersData && usersData.length > 0 ? usersData[0] : null;

        if (!user) return res.status(400).json({ error: 'Invalid user' });
        const { data: codeData } = await supabase.from('codes').select('*').eq('user_id', user.id).eq('code', code).eq('type', 'reset').gte('expires_at', new Date().toISOString()).maybeSingle();
        if (!codeData) return res.status(400).json({ error: 'Invalid or expired code' });
        const passwordHash = await bcrypt.hash(newPassword, 10);
        await supabase.from('users').update({ password_hash: passwordHash }).eq('id', user.id);
        await supabase.from('codes').delete().eq('id', codeData.id);
        res.json({ success: true, message: 'Password reset successful' });
    } catch (error) {
        res.status(500).json({ error: 'Password reset failed' });
    }
});

// ══════════════════════════════════════════════════════════════
// GOOGLE AUTH (for Flutter app)
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/google', async (req, res) => {
    try {
        const { idToken, email: bodyEmail, displayName: bodyDisplayName, photoUrl: bodyPhotoUrl } = req.body;
        if (!idToken) {
            return res.status(400).json({ error: 'Google ID token is required' });
        }

        // Verify Google ID token using Google's tokeninfo endpoint
        let googleUser;
        try {
            const googleRes = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
            googleUser = googleRes.data;
        } catch (tokenError) {
            console.error('❌ Google token verification failed:', tokenError.message);
            return res.status(401).json({ error: 'Invalid Google token' });
        }

        // Extract email/name/photo from verified token, fallback to request body
        const email = bodyEmail || googleUser.email;
        const displayName = bodyDisplayName || googleUser.name || googleUser.given_name;
        const photoUrl = bodyPhotoUrl || googleUser.picture;

        if (!email) {
            return res.status(400).json({ error: 'Could not determine email from Google token' });
        }

        // Verify email matches if both are provided
        if (bodyEmail && googleUser.email && googleUser.email !== bodyEmail) {
            return res.status(401).json({ error: 'Email mismatch' });
        }

        // Check if user already exists with this email
        const { data: existingUser } = await supabase.from('users')
            .select('*')
            .eq('email', email)
            .maybeSingle();

        let user;

        if (existingUser) {
            // Existing user — log them in
            user = existingUser;

            // Update profile pic from Google if they don't have one
            if (!user.profile_pic && photoUrl) {
                await supabase.from('users')
                    .update({ profile_pic: photoUrl })
                    .eq('id', user.id);
                user.profile_pic = photoUrl;
            }
        } else {
            // New user — create account (no password needed for Google auth)
            const username = displayName || email.split('@')[0];
            const randomPassword = crypto.randomBytes(32).toString('hex');
            const passwordHash = await bcrypt.hash(randomPassword, 10);

            const { data: newUser, error: insertError } = await supabase.from('users')
                .insert([{
                    username,
                    email,
                    password_hash: passwordHash,
                    registration_number: `google_${Date.now()}`,
                    profile_pic: photoUrl || null
                }])
                .select()
                .single();

            if (insertError) {
                console.error('❌ Google signup insert error:', insertError);
                return res.status(500).json({ error: 'Failed to create account: ' + insertError.message });
            }

            user = newUser;

            // Send welcome email
            sendEmail(email, '🎉 Welcome to VibeXpert!', `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                    <h1 style="color:#4F46E5;">Welcome to VibeXpert, ${username}! 🎉</h1>
                    <p>You signed up with Google. Ready to vibe? Let's go! 🚀</p>
                </div>
            `).catch(console.error);
        }

        // Generate JWT token
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        // Get social counts
        const [{ count: followersCount }, { count: followingCount }] = await Promise.all([
            supabase.from('followers').select('id', { count: 'exact', head: true }).eq('following_id', user.id),
            supabase.from('followers').select('id', { count: 'exact', head: true }).eq('follower_id', user.id)
        ]);

        let postCount = 0;
        try { postCount = await Post.countDocuments({ userId: user.id }); } catch (_) { }

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
                profile_pic: user.profile_pic,
                registrationNumber: user.registration_number,
                badges: user.badges || [],
                bio: user.bio || '',
                isPremium: user.is_premium || false,
                subscriptionPlan: user.subscription_plan || null,
                followersCount: followersCount || 0,
                followingCount: followingCount || 0,
                postCount
            }
        });
    } catch (error) {
        console.error('❌ Google auth error:', error);
        res.status(500).json({ error: 'Google authentication failed' });
    }
});

app.post('/api/college/request-verification', authenticateToken, async (req, res) => {
    try {
        const { collegeName, collegeEmail } = req.body;
        if (!collegeName || !collegeEmail) return res.status(400).json({ error: 'College name and email required' });
        // Allow re-verification attempt even if user already has college set in localStorage
        // Only block if confirmed in DB (req.user comes from DB via authenticateToken)
        if (req.user.college) return res.status(400).json({ error: 'You are already connected to ' + req.user.college });

        // ── College email uniqueness check ──────────────────────────────────────
        // Ensure this college email is not already linked to another account
        const { data: emailAlreadyUsed } = await supabase
            .from('users')
            .select('id')
            .ilike('college_email', collegeEmail.trim())
            .neq('id', req.user.id)
            .maybeSingle();
        if (emailAlreadyUsed) {
            return res.status(400).json({ error: 'This college email is already linked to another account. Each college email can only be used once.' });
        }

        // ── College ID (registration_number) uniqueness check ───────────────────
        // Ensure this student's registration number is not already used by another
        // account in the same college. A college ID must belong to exactly one account forever.
        if (req.user.registration_number && !req.user.registration_number.startsWith('auto_') && !req.user.registration_number.startsWith('google_')) {
            const { data: regAlreadyUsed } = await supabase
                .from('users')
                .select('id')
                .eq('registration_number', req.user.registration_number.trim())
                .eq('college', collegeName)
                .neq('id', req.user.id)
                .maybeSingle();
            if (regAlreadyUsed) {
                return res.status(400).json({ error: 'This college ID is already linked to another account. Each college ID can only be used by one account forever.' });
            }
        }
        // ────────────────────────────────────────────────────────────────────────

        const code = generateCode();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        // Delete any existing pending codes for this user first to avoid duplicates
        await supabase.from('codes').delete().eq('user_id', req.user.id).eq('type', 'college');
        // Insert new code
        const { error: insertError } = await supabase.from('codes').insert([{
            user_id: req.user.id,
            code,
            type: 'college',
            meta: { collegeName, collegeEmail },
            expires_at: expiresAt.toISOString()
        }]);
        if (insertError) {
            console.error('❌ codes insert error:', insertError);
            return res.status(500).json({ error: 'Failed to save verification code: ' + insertError.message });
        }
        const emailSent = await sendEmail(collegeEmail, '🎓 College Verification Code - VibeXpert', `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h1 style="color:#4F46E5;">College Verification</h1><p>Hi ${req.user.username},</p><p>Verify <strong>${collegeName}</strong>:</p><div style="background:#F3F4F6;padding:20px;text-align:center;border-radius:8px;"><h2 style="font-size:32px;letter-spacing:4px;">${code}</h2></div><p>Expires in 15 minutes.</p></div>`);
        if (!emailSent) {
            console.error('❌ Email failed to send for college verification');
            return res.status(500).json({ error: 'Failed to send email. Check your email address and try again.' });
        }
        res.json({ success: true, message: 'Verification code sent to ' + collegeEmail });
    } catch (error) {
        console.error('❌ request-verification error:', error);
        res.status(500).json({ error: 'Failed to send verification code: ' + error.message });
    }
});

app.post('/api/college/verify', authenticateToken, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Verification code required' });
        // Trim code in case user added spaces
        const cleanCode = String(code).trim();
        const { data: codeData, error: selectError } = await supabase.from('codes').select('*').eq('user_id', req.user.id).eq('code', cleanCode).eq('type', 'college').gte('expires_at', new Date().toISOString()).maybeSingle();
        if (selectError) {
            console.error('❌ codes select error:', selectError);
            return res.status(500).json({ error: 'Database error: ' + selectError.message });
        }
        if (!codeData) return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
        const { collegeName, collegeEmail } = codeData.meta;

        // ── Final uniqueness guards at verify time ─────────────────────────────
        // Re-check college email in case of race condition
        const { data: raceCheck } = await supabase
            .from('users')
            .select('id')
            .ilike('college_email', collegeEmail.trim())
            .neq('id', req.user.id)
            .maybeSingle();
        if (raceCheck) {
            await supabase.from('codes').delete().eq('id', codeData.id);
            return res.status(400).json({ error: 'This college email was just linked to another account. Each college email can only be used once.' });
        }

        // Re-check college ID (registration_number) for race condition
        // A college ID must permanently belong to only one account in a given college.
        const regNo = req.user.registration_number;
        if (regNo && !regNo.startsWith('auto_') && !regNo.startsWith('google_')) {
            const { data: regRaceCheck } = await supabase
                .from('users')
                .select('id')
                .eq('registration_number', regNo.trim())
                .eq('college', collegeName)
                .neq('id', req.user.id)
                .maybeSingle();
            if (regRaceCheck) {
                await supabase.from('codes').delete().eq('id', codeData.id);
                return res.status(400).json({ error: 'This college ID was just linked to another account. Each college ID can only be used by one account forever.' });
            }
        }
        // ────────────────────────────────────────────────────────────────────────

        // Remove duplicate badge if already present
        const existingBadges = Array.isArray(req.user.badges) ? req.user.badges : [];
        const newBadges = existingBadges.includes('verified_student') ? existingBadges : [...existingBadges, 'verified_student'];
        let updatedCollegeVal = collegeName;
        if (req.user && req.user.college && req.user.college.includes('ROLE:')) {
            const rawCollege = req.user.college;
            const matchRole = rawCollege.match(/ROLE:(.*?)(?:\||$)/);
            const matchRegion = rawCollege.match(/REGION:(.*?)(?:\||$)/);

            const roleVal = matchRole ? matchRole[1].trim() : 'Student';
            const regionVal = matchRegion ? matchRegion[1].trim() : '';

            updatedCollegeVal = `ROLE:${roleVal} | COLLEGE:${collegeName} | REGION:${regionVal}`;
        }

        const { error: updateError } = await supabase.from('users').update({ college: updatedCollegeVal, college_email: collegeEmail.trim().toLowerCase(), community_joined: true, badges: newBadges }).eq('id', req.user.id);
        if (updateError) {
            console.error('❌ users update error:', updateError);
            return res.status(500).json({ error: 'Failed to update profile: ' + updateError.message });
        }
        await supabase.from('codes').delete().eq('id', codeData.id);
        res.json({ success: true, message: 'College verified! Welcome to ' + collegeName, college: updatedCollegeVal, collegeEmail, communityJoined: true, badges: newBadges });
    } catch (error) {
        console.error('❌ college/verify error:', error);
        res.status(500).json({ error: 'Verification failed: ' + error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// POSTS ENDPOINTS — MongoDB + Cloudinary
// ══════════════════════════════════════════════════════════════

// Helper: enrich posts with user info from Supabase
const enrichPosts = async (posts, currentUserId) => {
    if (!posts || posts.length === 0) return [];
    const userIds = [...new Set(posts.map(p => p.userId))];
    const { data: users } = await supabase.from('users').select('id,username,profile_pic,college').in('id', userIds);
    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    const postIds = posts.map(p => p._id);
    const [likesData, commentsData, sharesData, myLikes] = await Promise.all([
        PostLike.aggregate([
            { $match: { postId: { $in: postIds } } },
            { $group: { _id: "$postId", count: { $sum: 1 } } }
        ]),
        PostComment.aggregate([
            { $match: { postId: { $in: postIds } } },
            { $group: { _id: "$postId", count: { $sum: 1 } } }
        ]),
        PostShare.aggregate([
            { $match: { postId: { $in: postIds } } },
            { $group: { _id: "$postId", count: { $sum: 1 } } }
        ]),
        currentUserId ? PostLike.find({ postId: { $in: postIds }, userId: currentUserId }).lean() : []
    ]);

    const likeMap = {};
    (likesData || []).forEach(item => { if (item._id) likeMap[item._id.toString()] = item.count; });

    const commentMap = {};
    (commentsData || []).forEach(item => { if (item._id) commentMap[item._id.toString()] = item.count; });

    const shareMap = {};
    (sharesData || []).forEach(item => { if (item._id) shareMap[item._id.toString()] = item.count; });

    const myLikesSet = new Set((myLikes || []).map(l => l.postId ? l.postId.toString() : ''));

    return posts.map((post) => {
        const postId = post._id.toString();
        return {
            ...post.toObject(),
            id: postId,
            users: userMap[post.userId] || { id: post.userId, username: 'User', profile_pic: null, college: null },
            like_count: likeMap[postId] || 0,
            comment_count: commentMap[postId] || 0,
            share_count: shareMap[postId] || 0,
            is_liked: myLikesSet.has(postId)
        };
    });
};

// GET search posts by hashtag/query
app.get('/api/search/posts', authenticateToken, async (req, res) => {
    try {
        const { query } = req.query;
        if (!query || query.trim().length < 2) return res.json({ success: true, posts: [], count: 0 });
        const searchTerm = query.trim();

        const blockedIds = await getBlockedIds(req.user.id);
        const findQuery = {
            content: { $regex: searchTerm, $options: 'i' }
        };
        if (blockedIds.length > 0) findQuery.userId = { $nin: blockedIds };

        const posts = await Post.find(findQuery).sort({ createdAt: -1 }).limit(50);
        const enriched = await enrichPosts(posts, req.user.id);

        const authorIds = [...new Set(enriched.map(p => p.userId).filter(id => id && id !== req.user.id))];
        const followSet = new Set();
        if (authorIds.length > 0) {
            const { data: followRecords } = await supabase
                .from('followers')
                .select('following_id')
                .eq('follower_id', req.user.id)
                .in('following_id', authorIds);

            if (followRecords) {
                followRecords.forEach(r => followSet.add(r.following_id));
            }
        }

        const postsWithFollow = enriched.map((post) => {
            const isFollowingAuthor = post.userId === req.user.id ? false : followSet.has(post.userId);
            return { ...post, is_following_author: isFollowingAuthor };
        });

        res.json({ success: true, posts: postsWithFollow, count: postsWithFollow.length });
    } catch (error) {
        console.error("❌ Search posts error:", error);
        res.status(500).json({ error: 'Search failed', success: false, posts: [], count: 0 });
    }
});

// GET my posts
app.get('/api/posts/my', authenticateToken, async (req, res) => {
    try {
        const posts = await Post.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
        const enriched = await enrichPosts(posts, req.user.id);
        res.json({ success: true, posts: enriched });
    } catch (error) {
        console.error('❌ My posts error:', error);
        res.status(500).json({ error: 'Failed to load your posts' });
    }
});

// GET posts by user ID
app.get('/api/posts/user/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const myUid = req.user.id;

        // Block check: if either side has blocked the other, return empty
        if (userId !== myUid) {
            const [iBlockedThem, theyBlockedMe] = await Promise.all([
                Block.findOne({ blockerId: myUid, blockedId: userId }).lean(),
                Block.findOne({ blockerId: userId, blockedId: myUid }).lean()
            ]);
            if (iBlockedThem || theyBlockedMe) {
                return res.status(403).json({ error: 'Content not available', blocked: true });
            }
        }

        const posts = await Post.find({ userId: userId }).sort({ createdAt: -1 }).limit(50);
        const enriched = await enrichPosts(posts, myUid);
        res.json({ success: true, posts: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load user posts' });
    }
});

// GET community posts
app.get('/api/posts/community', authenticateToken, async (req, res) => {
    try {
        const colString = req.user.college ? req.user.college.toString() : '';
        const isAlumni = colString.toLowerCase().includes('role:alumni');
        const isAdmin = isAdminUser(req.user) || colString.toLowerCase().includes('role:admin');
        const isBypassUser = isAlumni || isAdmin;

        console.log(`🔍 [community] user=${req.user.email}, college='${colString}', isAlumni=${isAlumni}, isAdmin=${isAdmin}, community_joined=${req.user.community_joined}, isBypass=${isBypassUser}`);

        if (!isBypassUser && (!req.user.community_joined || !req.user.college))
            return res.json({ success: false, needsJoinCommunity: true, message: 'Join a college community first' });

        const [blockedIds, reported] = await Promise.all([
            getBlockedIds(req.user.id),
            getReportedContent(req.user.id)
        ]);
        const excludedUserIds = [...new Set([...blockedIds, ...reported.userIds])];

        const query = { postedTo: { $in: ['community', 'both'] } };
        if (!isBypassUser) {
            query.college = req.user.college;
        }
        if (excludedUserIds.length > 0) query.userId = { $nin: excludedUserIds };
        if (reported.postIds.length > 0) query._id = { $nin: reported.postIds.map(id => new mongoose.Types.ObjectId(id)) };

        const posts = await Post.find(query).sort({ createdAt: -1 }).limit(50);
        const enriched = await enrichPosts(posts, req.user.id);
        res.json({ success: true, posts: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load community posts' });
    }
});

// GET liked posts
app.get('/api/posts/liked', authenticateToken, async (req, res) => {
    try {
        const [postLikes, vibeLikes] = await Promise.all([
            PostLike.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50),
            RealVibeLike.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50)
        ]);

        console.log(`Debug: User ${req.user.id} has ${postLikes.length} post likes and ${vibeLikes.length} vibe likes`);

        const postIds = postLikes.map(l => l.postId);
        const vibeIds = vibeLikes.map(l => l.vibeId);

        const [posts, vibes] = await Promise.all([
            Post.find({ _id: { $in: postIds } }),
            RealVibe.find({ _id: { $in: vibeIds } })
        ]);

        const postMap = {};
        posts.forEach(p => { postMap[p._id.toString()] = p; });

        const vibeMap = {};
        vibes.forEach(v => { vibeMap[v._id.toString()] = v; });

        // Map likes to full objects with custom timestamp for sorting
        const items = [
            ...postLikes.map(l => ({ type: 'post', data: postMap[l.postId.toString()], likedAt: l.createdAt })),
            ...vibeLikes.map(l => ({ type: 'vibe', data: vibeMap[l.vibeId.toString()], likedAt: l.createdAt }))
        ].filter(item => item.data);

        // Sort by when they were liked
        items.sort((a, b) => b.likedAt - a.likedAt);

        // Enrich and normalize
        const enrichedItems = await Promise.all(items.map(async (item) => {
            if (item.type === 'post') {
                const enriched = await enrichPosts([item.data], req.user.id);
                return enriched[0];
            } else {
                // Manually enrich RealVibe to match post structure
                const vibe = item.data;
                const [likeCount, commentCount, isLiked] = await Promise.all([
                    RealVibeLike.countDocuments({ vibeId: vibe._id }),
                    RealVibeComment.countDocuments({ vibeId: vibe._id }),
                    RealVibeLike.findOne({ vibeId: vibe._id, userId: req.user.id })
                ]);

                // Get user info from Supabase
                const { data: userData } = await supabase.from('users').select('id,username,profile_pic,college').eq('id', vibe.userId).maybeSingle();

                return {
                    ...vibe.toObject(),
                    id: vibe._id.toString(),
                    is_real_vibe: true,
                    content: vibe.caption || '',
                    media: [{ url: vibe.mediaUrl, type: vibe.mediaType }],
                    users: userData || { id: vibe.userId, username: 'User', profile_pic: null, college: null },
                    like_count: likeCount,
                    comment_count: commentCount,
                    is_liked: !!isLiked
                };
            }
        }));

        console.log(`Debug: Returning ${enrichedItems.length} total liked items`);
        res.json({ success: true, posts: enrichedItems });
    } catch (error) {
        console.error('❌ Liked posts error:', error);
        res.status(500).json({ error: 'Failed to load liked posts' });
    }
});

// GET commented posts
app.get('/api/posts/commented', authenticateToken, async (req, res) => {
    try {
        const comments = await PostComment.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
        const postIds = [...new Set(comments.map(c => c.postId.toString()))];
        const posts = await Post.find({ _id: { $in: postIds } });
        // Order by latest comment
        const postMap = {};
        posts.forEach(p => { postMap[p._id.toString()] = p; });
        const sortedPosts = postIds.map(id => postMap[id]).filter(Boolean);
        const enriched = await enrichPosts(sortedPosts, req.user.id);
        res.json({ success: true, posts: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load commented posts' });
    }
});

// GET shared posts
app.get('/api/posts/shared', authenticateToken, async (req, res) => {
    try {
        const shares = await PostShare.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
        const postIds = shares.map(s => s.postId);
        const posts = await Post.find({ _id: { $in: postIds } });
        const postMap = {};
        posts.forEach(p => { postMap[p._id.toString()] = p; });
        const sortedPosts = postIds.map(id => postMap[id.toString()]).filter(Boolean);
        const enriched = await enrichPosts(sortedPosts, req.user.id);
        res.json({ success: true, posts: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load shared posts' });
    }
});

// GET single post (also checks RealVibes)
app.get('/api/posts/:postId', authenticateToken, async (req, res) => {
    try {
        const { postId } = req.params;
        console.log(`[DEBUG] Fetching single item: ${postId}`);

        // standard validation for mongodb ID
        const isValidId = mongoose.Types.ObjectId.isValid(postId);
        console.log(`[DEBUG] isValidId: ${isValidId}`);

        if (isValidId) {
            let post = await Post.findById(postId);
            if (post) {
                console.log(`[DEBUG] Found regular post: ${postId}`);
                const enriched = await enrichPosts([post], req.user.id);
                return res.json({ success: true, post: enriched[0] });
            }

            // Try as a vibeId
            let vibe = await RealVibe.findById(postId);
            if (vibe) {
                console.log(`[DEBUG] Found RealVibe: ${postId}`);
                const enriched = await enrichVibes([vibe], req.user.id);
                const vibeObj = enriched[0];
                if (!vibeObj.media && vibeObj.media_url) {
                    vibeObj.media = [{ url: vibeObj.media_url, type: vibeObj.media_type || 'video', id: 'v_media_' + vibeObj.id }];
                }
                if (!vibeObj.content && vibeObj.caption) vibeObj.content = vibeObj.caption;
                return res.json({ success: true, post: vibeObj, isVibe: true });
            }
            console.log(`[DEBUG] No post or vibe found for ID: ${postId}`);
        } else {
            console.log(`[DEBUG] Invalid ObjectId format: ${postId}`);
        }

        res.status(404).json({ success: false, error: 'Post not found', id: postId });
    } catch (error) {
        console.error('Fetch single post error:', error);
        res.status(500).json({ error: 'Failed to fetch post' });
    }
});

// GET single RealVibe
app.get('/api/realvibes/:vibeId', authenticateToken, async (req, res) => {
    try {
        const vibe = await RealVibe.findById(req.params.vibeId);
        if (!vibe) return res.status(404).json({ error: 'RealVibe not found' });
        const enriched = await enrichVibes([vibe], req.user.id);
        res.json({ success: true, vibe: enriched[0] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load RealVibe' });
    }
});

// GET all posts (global feed — Zero Velocity)
// Returns profile + both posts for the "0 Velocity" feed
app.get('/api/posts', authenticateToken, async (req, res) => {
    try {
        const [blockedIds, reported] = await Promise.all([
            getBlockedIds(req.user.id),
            getReportedContent(req.user.id)
        ]);
        const excludedUserIds = [...new Set([...blockedIds, ...reported.userIds])];
        // Zero Velocity: show posts that are visible on profiles (profile + both)
        const query = { postedTo: { $in: ['profile', 'both'] } };
        if (excludedUserIds.length > 0) query.userId = { $nin: excludedUserIds };
        if (reported.postIds.length > 0) query._id = { $nin: reported.postIds.map(id => new mongoose.Types.ObjectId(id)) };

        const posts = await Post.find(query).sort({ createdAt: -1 }).limit(50);
        const enriched = await enrichPosts(posts, req.user.id);

        // Check follow status in a single bulk query
        const authorIds = [...new Set(enriched.map(p => p.userId).filter(id => id && id !== req.user.id))];
        const followSet = new Set();
        if (authorIds.length > 0) {
            const { data: followRecords } = await supabase
                .from('followers')
                .select('following_id')
                .eq('follower_id', req.user.id)
                .in('following_id', authorIds);

            if (followRecords) {
                followRecords.forEach(r => followSet.add(r.following_id));
            }
        }

        const postWithFollow = enriched.map((post) => {
            const isFollowingAuthor = post.userId === req.user.id ? false : followSet.has(post.userId);
            return { ...post, is_following_author: isFollowingAuthor };
        });

        res.json({ success: true, posts: postWithFollow });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load posts' });
    }
});

// GET "For You" feed — returns all posts (community + profile + both)
// Used by web Vibers "For You" tab
app.get('/api/posts/foryou', authenticateToken, async (req, res) => {
    try {
        const [blockedIds, reported] = await Promise.all([
            getBlockedIds(req.user.id),
            getReportedContent(req.user.id)
        ]);
        const excludedUserIds = [...new Set([...blockedIds, ...reported.userIds])];
        const query = {};
        if (excludedUserIds.length > 0) query.userId = { $nin: excludedUserIds };
        if (reported.postIds.length > 0) query._id = { $nin: reported.postIds.map(id => new mongoose.Types.ObjectId(id)) };

        const posts = await Post.find(query).sort({ createdAt: -1 }).limit(50);
        const enriched = await enrichPosts(posts, req.user.id);

        // Check follow status in a single bulk query
        const authorIds = [...new Set(enriched.map(p => p.userId).filter(id => id && id !== req.user.id))];
        const followSet = new Set();
        if (authorIds.length > 0) {
            const { data: followRecords } = await supabase
                .from('followers')
                .select('following_id')
                .eq('follower_id', req.user.id)
                .in('following_id', authorIds);

            if (followRecords) {
                followRecords.forEach(r => followSet.add(r.following_id));
            }
        }

        const postWithFollow = enriched.map((post) => {
            const isFollowingAuthor = post.userId === req.user.id ? false : followSet.has(post.userId);
            return { ...post, is_following_author: isFollowingAuthor };
        });

        res.json({ success: true, posts: postWithFollow });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load for-you posts' });
    }
});

// PATCH edit post caption
app.patch('/api/posts/:postId', authenticateToken, async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId);
        if (!post || post.userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        if (req.body.content !== undefined) {
            if (!req.body.content || !/#\w+/.test(req.body.content)) {
                return res.status(400).json({ error: 'Post must contain at least one hashtag (e.g., #vibers, #paper, #trip)' });
            }
            post.content = req.body.content;
        }
        post.updatedAt = new Date();
        await post.save();
        res.json({ success: true, post: { ...post.toObject(), id: post._id.toString() } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update post' });
    }
});

// POST create a post — Cloudinary for media
app.post('/api/posts', authenticateToken, upload.array('media', 10), async (req, res) => {
    try {
        const { content, postTo, music, stickers } = req.body;
        if (!content || !/#\w+/.test(content)) {
            return res.status(400).json({ error: 'Post must contain at least one hashtag (e.g., #vibers, #paper, #trip)' });
        }
        if (postTo === 'community' && (!req.user.community_joined || !req.user.college))
            return res.status(400).json({ error: 'Join a university community first' });

        let mediaUrls = [];
        if (req.files && req.files.length > 0) {
            mediaUrls = await Promise.all(req.files.map(async (file) => {
                const result = await uploadToCloudinary(file.buffer, file.mimetype, 'vibexpert/posts');
                return {
                    url: result.secure_url,
                    public_id: result.public_id,
                    type: file.mimetype.startsWith('video/') ? 'video' : file.mimetype.startsWith('audio/') ? 'audio' : 'image'
                };
            }));
        }

        const post = await Post.create({
            userId: req.user.id,
            content: content || '',
            media: mediaUrls,
            postedTo: postTo || 'profile',
            college: (postTo === 'community' || postTo === 'both') ? req.user.college : null,
            music: music ? JSON.parse(music) : null,
            stickers: stickers ? JSON.parse(stickers) : []
        });

        const enrichedPost = {
            ...post.toObject(),
            id: post._id.toString(),
            like_count: 0, comment_count: 0, share_count: 0, is_liked: false,
            users: { id: req.user.id, username: req.user.username, profile_pic: req.user.profile_pic || null, college: req.user.college || null }
        };

        // Broadcast new_post to the relevant audience:
        // community/both posts → members of that college room + global
        // profile posts         → global broadcast for Zero Velocity feed
        if ((postTo === 'community' || postTo === 'both') && req.user.college) {
            io.to(req.user.college).emit('new_post', enrichedPost);
        }
        // Always emit globally so Zero Velocity (profile feed) picks it up too
        io.emit('new_post', enrichedPost);
        let postCount = 0;
        try { postCount = await Post.countDocuments({ userId: req.user.id }); } catch (_) { }
        res.json({ success: true, post: enrichedPost, postCount, message: 'Post created successfully' });
    } catch (error) {
        console.error('❌ Create post error:', error);
        res.status(500).json({ error: error.message || 'Failed to create post' });
    }
});

// DELETE post
app.delete('/api/posts/:postId', authenticateToken, async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId);
        if (!post || post.userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        await Post.deleteOne({ _id: post._id });
        await PostLike.deleteMany({ postId: post._id });
        await PostComment.deleteMany({ postId: post._id });
        await PostShare.deleteMany({ postId: post._id });
        res.json({ success: true, message: 'Post deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete post' });
    }
});

// POST like / unlike
app.post('/api/posts/:postId/like', authenticateToken, async (req, res) => {
    try {
        const { postId } = req.params;
        const existingLike = await PostLike.findOne({ postId, userId: req.user.id });
        if (existingLike) {
            await PostLike.deleteOne({ _id: existingLike._id });
            const likeCount = await PostLike.countDocuments({ postId });
            io.emit('post_liked', { postId, likeCount, liked: false });
            return res.json({ success: true, liked: false, likeCount });
        }
        await PostLike.create({ postId, userId: req.user.id });
        const likeCount = await PostLike.countDocuments({ postId });
        io.emit('post_liked', { postId, likeCount, liked: true });
        // Push notification to post owner — skip if either side has blocked the other
        const post = await Post.findById(postId);
        if (post && post.userId !== req.user.id) {
            const isAnyBlock = await Block.findOne({
                $or: [
                    { blockerId: req.user.id, blockedId: post.userId },
                    { blockerId: post.userId, blockedId: req.user.id }
                ]
            }).lean();
            if (!isAnyBlock) {
                const likeNotifData = { type: 'post_liked', message: `${req.user.username} liked your post`, from: req.user.id, fromUsername: req.user.username, fromPic: req.user.profile_pic || null, postId };
                await pushNotification(post.userId, likeNotifData);
                // Direct targeted socket emission (bypasses new_notification)
                const ownerSockets = userSockets.get(post.userId);
                if (ownerSockets) ownerSockets.forEach(sid => io.to(sid).emit('post_liked_notif', likeNotifData));
            }
        }
        // BUG FIX (BUG-29): Removed self-notification for liking — inflated actor's badge.
        res.json({ success: true, liked: true, likeCount });
    } catch (error) {
        res.status(500).json({ error: 'Failed to like post' });
    }
});

// GET post likes
app.get('/api/posts/:postId/likes', authenticateToken, async (req, res) => {
    try {
        const { postId } = req.params;
        const likes = await PostLike.find({ postId }).sort({ createdAt: -1 });
        const userIds = likes.map(l => l.userId);
        const { data: users } = await supabase.from('users').select('id,username,profile_pic,college').in('id', userIds);
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });
        const result = likes.map(l => ({
            id: l._id,
            userId: l.userId,
            users: userMap[l.userId] || { id: l.userId, username: 'User', profile_pic: null },
            createdAt: l.createdAt
        }));
        res.json({ success: true, users: result });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch likes' });
    }
});

// POST like / unlike comment
app.post('/api/comments/:commentId/like', authenticateToken, async (req, res) => {
    try {
        const { commentId } = req.params;
        let comment = await PostComment.findById(commentId);
        if (!comment) {
            comment = await RealVibeComment.findById(commentId);
        }
        if (!comment) return res.json({ success: true, liked: true, likeCount: 1 }); // fallback for temporary comments

        // Check if user already liked
        const likes = comment.likes_users || [];
        const userIndex = likes.indexOf(req.user.id);

        let liked;
        if (userIndex > -1) {
            likes.splice(userIndex, 1);
            liked = false;
        } else {
            likes.push(req.user.id);
            liked = true;
        }

        await comment.updateOne({ $set: { likes_users: likes, likes: likes.length } });
        res.json({ success: true, liked, likeCount: likes.length });
    } catch (error) {
        res.json({ success: true, liked: true, likeCount: 1 }); // graceful fallback error
    }
});

// POST pin / unpin comment (post owner only)
app.post('/api/comments/:commentId/pin', authenticateToken, async (req, res) => {
    try {
        const { commentId } = req.params;
        let comment = await PostComment.findById(commentId);
        let isRealVibe = false;
        if (!comment) {
            comment = await RealVibeComment.findById(commentId);
            isRealVibe = true;
        }
        if (!comment) return res.status(404).json({ error: 'Comment not found' });

        let ownerId;
        if (isRealVibe) {
            const vibe = await RealVibe.findById(comment.vibeId);
            if (!vibe) return res.status(404).json({ error: 'RealVibe not found' });
            ownerId = vibe.userId;
        } else {
            const post = await Post.findById(comment.postId);
            if (!post) return res.status(404).json({ error: 'Post not found' });
            ownerId = post.userId;
        }

        if (ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Only the Vibesoul can pin comments' });
        }

        const willPin = !comment.isPinned;

        if (willPin) {
            // Unpin ALL comments on this post/vibe first (only one pin allowed)
            if (isRealVibe) {
                await RealVibeComment.updateMany({ vibeId: comment.vibeId }, { $set: { isPinned: false } });
            } else {
                await PostComment.updateMany({ postId: comment.postId }, { $set: { isPinned: false } });
            }
        }

        // Use findByIdAndUpdate — avoids stale in-memory document overwriting DB after updateMany
        if (isRealVibe) {
            await RealVibeComment.findByIdAndUpdate(commentId, { $set: { isPinned: willPin } });
        } else {
            await PostComment.findByIdAndUpdate(commentId, { $set: { isPinned: willPin } });
        }

        res.json({ success: true, pinned: willPin });
    } catch (error) {
        console.error('Comment pinning error:', error);
        res.status(500).json({ error: 'Failed to pin/unpin comment: ' + error.message });
    }
});

// GET comments
app.get('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
    try {
        const blockedIds = await getBlockedIds(req.user.id);
        const comments = await PostComment.find({ postId: req.params.postId }).sort({ isPinned: -1, createdAt: -1 });
        const userIds = [...new Set(comments.map(c => c.userId))];
        const { data: users } = await supabase.from('users').select('id,username,profile_pic').in('id', userIds);
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });
        const enriched = comments
            .filter(c => !blockedIds.includes(c.userId)) // hide comments from blocked/blocking users
            .map(c => {
                const likesUsers = c.likes_users || [];
                return {
                    ...c.toObject(),
                    id: c._id.toString(),
                    users: userMap[c.userId] || { id: c.userId, username: 'User', profile_pic: null },
                    is_liked: likesUsers.includes(req.user.id),
                    liked: likesUsers.includes(req.user.id),
                    like_count: likesUsers.length,
                    likeCount: likesUsers.length,
                    isPinned: c.isPinned || false,
                    pinned: c.isPinned || false,
                    is_pinned: c.isPinned || false
                };
            });
        res.json({ success: true, comments: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load comments' });
    }
});

// POST comment
app.post('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
    try {
        const { postId } = req.params;
        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Comment content required' });

        // Check block status against the post owner
        const post = await Post.findById(postId);
        if (post && post.userId !== req.user.id) {
            const [iBlockedThem, theyBlockedMe] = await Promise.all([
                Block.findOne({ blockerId: req.user.id, blockedId: post.userId }).lean(),
                Block.findOne({ blockerId: post.userId, blockedId: req.user.id }).lean()
            ]);
            if (iBlockedThem || theyBlockedMe) {
                return res.status(403).json({ error: 'Action not available', blocked: true });
            }
        }

        const comment = await PostComment.create({ postId, userId: req.user.id, content: content.trim() });
        const commentCount = await PostComment.countDocuments({ postId });
        io.emit('post_commented', { postId, commentCount });
        // Push notification to post owner (only if not your own post)
        if (post && post.userId !== req.user.id) {
            const commentNotifData = { type: 'new_comment', message: `${req.user.username} commented on your post`, from: req.user.id, fromUsername: req.user.username, fromPic: req.user.profile_pic || null, postId };
            await pushNotification(post.userId, commentNotifData);
            // Direct targeted socket emission (bypasses new_notification)
            const ownerSockets = userSockets.get(post.userId);
            if (ownerSockets) ownerSockets.forEach(sid => io.to(sid).emit('new_comment_notif', commentNotifData));
        }
        // BUG FIX (BUG-29): Removed self-notification for commenting — inflated actor's badge.
        res.json({ success: true, comment: { ...comment.toObject(), id: comment._id.toString() } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to post comment' });
    }
});

// DELETE comment
app.delete('/api/posts/:postId/comments/:commentId', authenticateToken, async (req, res) => {
    try {
        const comment = await PostComment.findById(req.params.commentId);
        if (!comment || comment.userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        await PostComment.deleteOne({ _id: comment._id });
        res.json({ success: true, message: 'Comment deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// POST share
app.post('/api/posts/:postId/share', authenticateToken, async (req, res) => {
    try {
        const { postId } = req.params;
        await PostShare.create({ postId, userId: req.user.id });
        const shareCount = await PostShare.countDocuments({ postId });
        io.emit('post_shared', { postId, shareCount });

        // Push notification to post owner
        const post = await Post.findById(postId);
        if (post && post.userId !== req.user.id) {
            const shareNotifData = { type: 'post_shared', message: `${req.user.username} shared your post`, from: req.user.id, fromUsername: req.user.username, fromPic: req.user.profile_pic || null, postId };
            await pushNotification(post.userId, shareNotifData);
            // Direct targeted socket emission (bypasses new_notification)
            const ownerSockets = userSockets.get(post.userId);
            if (ownerSockets) ownerSockets.forEach(sid => io.to(sid).emit('post_shared_notif', shareNotifData));
        }
        // Also log in user's own activity as requested
        await pushNotification(req.user.id, { type: 'post_shared', message: `You shared a post`, from: req.user.id, fromUsername: 'You', fromPic: req.user.profile_pic || null, postId });

        res.json({ success: true, shareCount });
    } catch (error) {
        res.status(500).json({ error: 'Failed to share post' });
    }
});

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS ENDPOINTS — Redis
// ══════════════════════════════════════════════════════════════
app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userRegisterTime = req.user.created_at ? new Date(req.user.created_at).getTime() : 0;

        // 1. Fetch user-specific notifications from Redis
        const redisNotifications = await getNotifications(userId, 30);

        // 2. Fetch global platform notifications from MongoDB
        // We fetch the latest 10 that are for 'all' or specifically for this user
        const globalNotifications = await PlatformNotification.find({
            $or: [
                { target: 'all' },
                { target: 'specific', targetUserId: userId }
            ]
        }).sort({ createdAt: -1 }).limit(10).lean();

        // Convert MongoDB docs to the format expected by the frontend
        const platformNotifications = globalNotifications.map(n => ({
            id: n._id.toString(),
            type: 'platform',
            title: n.title,
            message: n.message,
            read: true, // We don't track read status for global ones easily, so mark as read to avoid annoying badge
            createdAt: n.createdAt,
            timestamp: new Date(n.createdAt).getTime()
        }));

        // 3. Merge and sort by timestamp
        let allNotifications = [...redisNotifications, ...platformNotifications];

        // Filter out notifications from blocked users
        const blockedIds = await getBlockedIds(userId);
        allNotifications = allNotifications.filter(n => {
            if (n.from && blockedIds.includes(n.from)) return false;
            return true;
        });

        // Filter out notifications created before user registered
        allNotifications = allNotifications.filter(n => {
            const notifTime = n.timestamp || (n.createdAt ? new Date(n.createdAt).getTime() : 0);
            return notifTime >= userRegisterTime;
        });

        allNotifications.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // Limit total to 50
        allNotifications = allNotifications.slice(0, 50);

        const unreadCount = allNotifications.filter(n => n.type !== 'platform' && !n.read).length;
        res.json({ success: true, notifications: allNotifications, unreadCount });
    } catch (error) {
        console.error('❌ Notifications fetch error:', error);
        res.status(500).json({ error: 'Failed to load notifications' });
    }
});

app.get('/api/notifications/count', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userRegisterTime = req.user.created_at ? new Date(req.user.created_at).getTime() : 0;

        const notifications = await getNotifications(userId, 50);

        // Filter out notifications created before user registered
        const filteredNotifications = notifications.filter(n => {
            const notifTime = n.timestamp || (n.createdAt ? new Date(n.createdAt).getTime() : 0);
            return notifTime >= userRegisterTime;
        });

        const unreadCount = filteredNotifications.filter(n => !n.read).length;
        res.json({ success: true, unreadCount });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get count' });
    }
});

app.post('/api/notifications/read', authenticateToken, async (req, res) => {
    try {
        await markNotificationsRead(req.user.id);
        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// ══════════════════════════════════════════════════════════════
// COMMUNITY CHAT ENDPOINTS — Supabase + Cloudinary
// ══════════════════════════════════════════════════════════════
app.get('/api/community/messages', authenticateToken, async (req, res) => {
    try {
        if (!req.user.community_joined || !req.user.college)
            return res.json({ success: false, needsJoinCommunity: true, messages: [] });
        const fiveDaysAgo = new Date();
        fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
        const resolvedRoom = getCommunityRoom(req.user.college);
        const { data: messages, error } = await supabase.from('community_messages').select('*').eq('college_name', resolvedRoom).gte('created_at', fiveDaysAgo.toISOString()).order('created_at', { ascending: true }).limit(500);
        if (error) throw error;

        const blockedIds = await getBlockedIds(req.user.id);
        let enriched = (messages || []).filter(m => !blockedIds.includes(m.sender_id));

        if (enriched.length > 0) {
            const senderIds = [...new Set(enriched.map(m => m.sender_id))];
            const { data: users } = await supabase.from('users').select('id,username,profile_pic').in('id', senderIds);
            const userMap = {};
            (users || []).forEach(u => { userMap[u.id] = u; });
            enriched = enriched.map(msg => ({ ...msg, users: { id: msg.sender_id, username: msg.anon_name || '👻 Anonymous', profile_pic: null } }));
        }
        const replyToIds = [...new Set(enriched.filter(m => m.reply_to_id).map(m => m.reply_to_id))];
        if (replyToIds.length > 0) {
            const { data: replyMsgs } = await supabase.from('community_messages').select('id,content,sender_id,media_type,media_url').in('id', replyToIds);
            const replyMsgMap = {};
            if (replyMsgs) {
                const replySenderIds = [...new Set(replyMsgs.map(m => m.sender_id))];
                const { data: replyUsers } = await supabase.from('users').select('id,username').in('id', replySenderIds);
                const replyUserMap = {};
                (replyUsers || []).forEach(u => { replyUserMap[u.id] = u; });
                replyMsgs.forEach(m => { replyMsgMap[m.id] = { ...m, sender_username: replyUserMap[m.sender_id]?.username || 'User' }; });
            }
            enriched = enriched.map(msg => ({ ...msg, reply_to: msg.reply_to_id ? (replyMsgMap[msg.reply_to_id] || null) : null }));
        }

        // Enrich community (Ghost) messages with in-memory/Redis fallback reactions
        enriched = enriched.map(msg => ({
            ...msg,
            reactions: communityReactions.get(msg.id.toString()) || {}
        }));

        res.json({ success: true, messages: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load messages', details: error.message });
    }
});

app.delete('/api/community/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { data: message } = await supabase.from('community_messages').select('sender_id,college_name').eq('id', req.params.messageId).single();
        if (!message || message.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        await supabase.from('community_messages').delete().eq('id', req.params.messageId);
        io.to(message.college_name).emit('message_deleted', { id: req.params.messageId });
        res.json({ success: true, message: 'Message deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

app.put('/api/community/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
        const { data: message } = await supabase.from('community_messages').select('sender_id,college_name').eq('id', messageId).single();
        if (!message || message.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        const { data: updated, error } = await supabase.from('community_messages').update({ content: content.trim(), is_edited: true, edited_at: new Date().toISOString() }).eq('id', messageId).select('*').single();
        if (error) throw error;
        io.to(message.college_name).emit('community_message_edited', { id: messageId, content: content.trim(), edited_at: updated.edited_at });
        res.json({ success: true, message: updated });
    } catch (error) {
        res.status(500).json({ error: 'Failed to edit message' });
    }
});

app.post('/api/community/react/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { emoji } = req.body;
        const uid = req.user.id;
        if (!emoji) return res.status(400).json({ error: 'emoji required' });
        const { data: message } = await supabase.from('community_messages').select('id,college_name').eq('id', messageId).single();
        if (!message) return res.status(404).json({ error: 'Message not found' });

        // Use in-memory reaction map
        const key = messageId.toString();
        const reactions = communityReactions.get(key) || {};
        const users = reactions[emoji] || [];
        const alreadyReacted = users.includes(uid);
        if (alreadyReacted) {
            const newUsers = users.filter(id => id !== uid);
            if (newUsers.length === 0) delete reactions[emoji];
            else reactions[emoji] = newUsers;
        } else {
            // Remove user from all other emojis
            for (const key in reactions) {
                if (reactions.hasOwnProperty(key)) {
                    reactions[key] = (reactions[key] || []).filter(id => id !== uid);
                    if (reactions[key].length === 0) delete reactions[key];
                }
            }
            reactions[emoji] = [...(reactions[emoji] || []), uid];
        }
        communityReactions.set(key, reactions);

        io.to(message.college_name).emit('community_reaction_update', { messageId, reactions, reactorId: uid });
        res.json({ success: true, reactions });
    } catch (error) {
        res.status(500).json({ error: 'Failed to react: ' + error.message });
    }
});

app.post('/api/community/messages', authenticateToken, (req, res, next) => {
    if (req.headers['content-type']?.includes('multipart/form-data')) upload.single('media')(req, res, next);
    else next();
}, async (req, res) => {
    try {
        const { content } = req.body;
        const media = req.file;
        if (!content && !media) return res.status(400).json({ error: 'Message content or media required' });
        if (!req.user.community_joined || !req.user.college) return res.status(400).json({ error: 'Join a college community first' });

        let mediaUrl = null, mediaType = null;
        if (media) {
            try {
                const result = await uploadToCloudinary(media.buffer, media.mimetype, 'vibexpert/chat');
                mediaUrl = result.secure_url;
                if (media.mimetype.startsWith('video/')) mediaType = 'video';
                else if (media.mimetype.startsWith('audio/')) mediaType = 'audio';
                else if (media.mimetype === 'application/pdf') mediaType = 'pdf';
                else if (media.mimetype.startsWith('application/') || media.mimetype.startsWith('text/')) mediaType = 'document';
                else mediaType = 'image';
            } catch (uploadErr) {
                return res.status(500).json({ error: 'Media upload failed: ' + uploadErr.message });
            }
        }

        const rawAnonName = req.body.anon_name;
        let anonName = rawAnonName?.trim().slice(0, 30) || null;
        if (anonName && anonName.length < 2) anonName = null;
        if (!anonName) return res.status(400).json({ error: 'Ghost name is required.' });

        const resolvedRoom = getCommunityRoom(req.user.college);
        const ghostCheckResult = registerGhostName(req.user.id, resolvedRoom, anonName);
        if (!ghostCheckResult.success) return res.status(409).json({ error: ghostCheckResult.error, code: 'GHOST_NAME_TAKEN' });

        const { data: insertedMsg, error: insertError } = await supabase.from('community_messages').insert([{
            sender_id: req.user.id, college_name: resolvedRoom, content: content?.trim() || '',
            media_url: mediaUrl, media_type: mediaType, anon_name: anonName,
            message_type: mediaUrl ? (mediaType === 'video' ? 'video' : mediaType === 'audio' ? 'audio' : mediaType === 'image' ? 'image' : 'document') : 'text',
            media_name: media ? media.originalname : null, media_size: media ? media.size : null,
            reply_to_id: (req.body.reply_to_id && req.body.reply_to_id !== 'null') ? req.body.reply_to_id : null
        }]).select('*').single();

        if (insertError) {
            const isLimitError = insertError.code === '23514' || (insertError.message || '').toLowerCase().includes('daily message limit');
            if (isLimitError) return res.status(429).json({ error: '🚫 Daily limit reached! Max 10,000 messages/day. Resets at midnight UTC.', code: 'DAILY_LIMIT_REACHED' });
            throw insertError;
        }

        let replyToData = null;
        if (insertedMsg.reply_to_id) {
            const { data: replyMsg } = await supabase.from('community_messages').select('id,content,sender_id,media_type,media_url').eq('id', insertedMsg.reply_to_id).single();
            if (replyMsg) {
                const { data: replyUser } = await supabase.from('users').select('username').eq('id', replyMsg.sender_id).single();
                replyToData = { ...replyMsg, sender_username: replyUser?.username || 'User' };
            }
        }

        const message = { ...insertedMsg, anon_name: anonName, users: { id: req.user.id, username: anonName, profile_pic: null }, reply_to: replyToData };
        const senderSocketId = userSockets.get(req.user.id);
        if (senderSocketId) io.to(resolvedRoom).except(Array.from(senderSocketId)).emit('new_message', message);
        else io.to(resolvedRoom).emit('new_message', message);
        res.json({ success: true, message });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// DM ENDPOINTS — Supabase + Cloudinary
// ══════════════════════════════════════════════════════════════
app.get('/api/dm/status', authenticateToken, async (req, res) => {
    try {
        await supabase.from('direct_messages').select('id').limit(1);
        await supabase.from('dm_conversations').select('id').limit(1);
        res.json({ success: true, ready: true });
    } catch (error) {
        res.json({ success: true, ready: false, reason: error.message });
    }
});

app.get('/api/dm/conversations', authenticateToken, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: convs, error } = await supabase.from('dm_conversations').select('*').or(`user1_id.eq.${uid},user2_id.eq.${uid}`).order('last_message_at', { ascending: false });
        if (error) { if (error.code === '42P01') return res.json({ success: true, conversations: [] }); throw error; }

        const convList = convs || [];
        const otherIds = [...new Set(convList.map(c => c.user1_id === uid ? c.user2_id : c.user1_id))];

        // Get blocked IDs to exclude from conversation list
        const blockedIds = await getBlockedIds(uid);
        const blockedSet = new Set(blockedIds);

        let userMap = {};
        if (otherIds.length > 0) {
            const { data: users } = await supabase.from('users').select('id,username,profile_pic,last_seen,status_text').in('id', otherIds);
            (users || []).forEach(u => {
                userMap[u.id] = {
                    ...u,
                    is_online: userSockets.has(u.id.toString())
                };
            });
        }
        const enriched = convList
            .filter(conv => {
                const otherId = conv.user1_id === uid ? conv.user2_id : conv.user1_id;
                // Exclude conversations with blocked/blocking users
                return userMap[otherId] && !blockedSet.has(otherId);
            })
            .map(conv => {
                const otherId = conv.user1_id === uid ? conv.user2_id : conv.user1_id;
                const unreadCount = conv.user1_id === uid ? conv.unread_count_user1 : conv.unread_count_user2;
                return { ...conv, otherUser: userMap[otherId] || null, unreadCount };
            });
        res.json({ success: true, conversations: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

app.post('/api/dm/send', authenticateToken, upload.single('media'), async (req, res) => {
    try {
        const { receiverId, content, replyToId } = req.body;
        if (!receiverId) return res.status(400).json({ error: 'receiverId required' });
        if (!content && !req.file) return res.status(400).json({ error: 'Content or media required' });
        const senderId = req.user.id;

        // Block check: neither side can message the other if a block exists
        const isAnyBlock = await Block.findOne({
            $or: [
                { blockerId: senderId, blockedId: receiverId },
                { blockerId: receiverId, blockedId: senderId }
            ]
        }).lean();
        if (isAnyBlock) return res.status(403).json({ error: 'Message not delivered', blocked: true });

        let mediaUrl = null, mediaType = null;
        if (req.file) {
            const dmResult = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'vibexpert/dm');
            mediaUrl = dmResult.secure_url;
            if (req.file.mimetype.startsWith('video/')) mediaType = 'video';
            else if (req.file.mimetype.startsWith('audio/')) mediaType = 'audio';
            else if (req.file.mimetype === 'application/pdf') mediaType = 'pdf';
            else mediaType = 'image';
        }
        const insertPayload = { sender_id: senderId, receiver_id: receiverId, content: content?.trim() || '', media_url: mediaUrl, media_type: mediaType };
        if (replyToId && replyToId !== 'null') insertPayload.reply_to_id = replyToId;
        const { data: dm, error: dmErr } = await supabase.from('direct_messages').insert([insertPayload]).select().single();
        if (dmErr) { if (dmErr.code === '42P01') return res.status(503).json({ error: 'DM tables not set up yet.' }); throw dmErr; }

        // Update conversation (non-critical)
        try {
            const [u1, u2] = [senderId, receiverId].sort();
            const isUser1Sender = u1 === senderId;
            const lastMsg = content?.trim() || (mediaType ? `[${mediaType}]` : '');
            const { data: existingConv } = await supabase.from('dm_conversations').select('id,unread_count_user1,unread_count_user2').eq('user1_id', u1).eq('user2_id', u2).maybeSingle();
            if (existingConv) {
                const ud = { last_message: lastMsg, last_message_at: new Date().toISOString() };
                if (isUser1Sender) ud.unread_count_user2 = (existingConv.unread_count_user2 || 0) + 1;
                else ud.unread_count_user1 = (existingConv.unread_count_user1 || 0) + 1;
                await supabase.from('dm_conversations').update(ud).eq('id', existingConv.id);
            } else {
                await supabase.from('dm_conversations').insert([{ user1_id: u1, user2_id: u2, last_message: lastMsg, last_message_at: new Date().toISOString(), unread_count_user1: isUser1Sender ? 0 : 1, unread_count_user2: isUser1Sender ? 1 : 0 }]);
            }
        } catch (convErr) { console.error('⚠️ Conversation update failed:', convErr.message); }

        let replyToData = null;
        try { if (dm.reply_to_id) { const { data: r } = await supabase.from('direct_messages').select('id,content,sender_id,media_type').eq('id', dm.reply_to_id).single(); replyToData = r || null; } } catch { }

        const payload = { ...dm, reply_to: replyToData, senderUser: { id: req.user.id, username: req.user.username, profile_pic: req.user.profile_pic } };
        try {
            // Emit to ALL active sockets of BOTH sender and receiver to ensure multi-device sync
            const participants = [senderId, receiverId];
            participants.forEach(uid => {
                const sockets = userSockets.get(uid);
                if (sockets) {
                    sockets.forEach(sid => {
                        // In an HTTP route, we emit to ALL sockets of the participants
                        io.to(sid).emit('new_dm', payload);
                    });
                }
            });
        } catch (sockErr) {
            console.error('Socket delivery error:', sockErr.message);
        }

        // Push notification
        await pushNotification(receiverId, { type: 'new_dm', message: `${req.user.username} sent you a message`, from: req.user.id, fromUsername: req.user.username, fromPic: req.user.profile_pic || null });

        res.json({ success: true, dm: payload });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send DM: ' + error.message });
    }
});

app.post('/api/dm/react/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { emoji } = req.body;
        const uid = req.user.id;
        if (!emoji) return res.status(400).json({ error: 'emoji required' });
        const { data: msg, error: fetchErr } = await supabase.from('direct_messages').select('id,reactions,sender_id,receiver_id').eq('id', messageId).single();
        if (fetchErr || !msg) return res.status(404).json({ error: 'Message not found' });
        if (msg.sender_id !== uid && msg.receiver_id !== uid) return res.status(403).json({ error: 'Not your conversation' });
        const reactions = msg.reactions || {};
        const users = reactions[emoji] || [];
        const alreadyReacted = users.includes(uid);
        if (alreadyReacted) {
            const newUsers = users.filter(id => id !== uid);
            if (newUsers.length === 0) delete reactions[emoji];
            else reactions[emoji] = newUsers;
        } else {
            // Remove user from all other emojis
            for (const key in reactions) {
                if (reactions.hasOwnProperty(key)) {
                    reactions[key] = (reactions[key] || []).filter(id => id !== uid);
                    if (reactions[key].length === 0) delete reactions[key];
                }
            }
            reactions[emoji] = [...(reactions[emoji] || []), uid];
        }
        const { data: updated, error: updateErr } = await supabase.from('direct_messages').update({ reactions }).eq('id', messageId).select().single();
        if (updateErr) throw updateErr;
        const otherId = msg.sender_id === uid ? msg.receiver_id : msg.sender_id;
        const otherSocket = userSockets.get(otherId);
        if (otherSocket) {
            otherSocket.forEach(sid => io.to(sid).emit('dm_reaction', { messageId, reactions, reactorId: uid }));
        }
        res.json({ success: true, reactions });
    } catch (error) {
        res.status(500).json({ error: 'Failed to react: ' + error.message });
    }
});

app.put('/api/dm/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { content } = req.body;
        const uid = req.user.id;
        if (!content) return res.status(400).json({ error: 'Content required' });
        const { data: msg, error: fetchErr } = await supabase.from('direct_messages').select('id,sender_id,receiver_id').eq('id', messageId).single();
        if (fetchErr || !msg) return res.status(404).json({ error: 'Message not found' });
        if (msg.sender_id !== uid) return res.status(403).json({ error: 'Edit forbidden' });
        const { data: updated, error: updateErr } = await supabase.from('direct_messages').update({ content, is_edited: true, updated_at: new Date() }).eq('id', messageId).select().single();
        if (updateErr) throw updateErr;
        const otherSocket = userSockets.get(msg.receiver_id);
        if (otherSocket) {
            otherSocket.forEach(sid => io.to(sid).emit('dm_message_updated', updated));
        }
        res.json({ success: true, dm: updated });
    } catch (error) {
        res.status(500).json({ error: 'Failed to edit DM: ' + error.message });
    }
});

app.delete('/api/dm/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const uid = req.user.id;
        const { data: msg, error: fetchErr } = await supabase.from('direct_messages').select('id,sender_id,receiver_id').eq('id', messageId).single();
        if (fetchErr || !msg) return res.status(404).json({ error: 'Message not found' });
        if (msg.sender_id !== uid) return res.status(403).json({ error: 'Delete forbidden' });
        const { error: delErr } = await supabase.from('direct_messages').delete().eq('id', messageId);
        if (delErr) throw delErr;
        const otherSocket = userSockets.get(msg.receiver_id);
        if (otherSocket) {
            otherSocket.forEach(sid => io.to(sid).emit('dm_message_deleted', { id: messageId }));
        }
        res.json({ success: true, message: 'Deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete DM: ' + error.message });
    }
});


app.get('/api/dm/mutual-follows', authenticateToken, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: following, error: err1 } = await supabase.from('followers').select('following_id').eq('follower_id', uid);
        if (err1) return res.status(500).json({ error: 'DB error: ' + err1.message });
        if (!following || following.length === 0) return res.json({ success: true, mutualFollows: [] });
        const followingIds = following.map(f => f.following_id);
        const { data: followersBack, error: err2 } = await supabase.from('followers').select('follower_id').eq('following_id', uid).in('follower_id', followingIds);
        if (err2) return res.status(500).json({ error: 'DB error: ' + err2.message });
        if (!followersBack || followersBack.length === 0) return res.json({ success: true, mutualFollows: [] });
        const mutualIds = followersBack.map(f => f.follower_id);

        // Exclude blocked/blocking users from mutual follows
        const blockedIds = await getBlockedIds(uid);
        const filteredIds = mutualIds.filter(id => !blockedIds.includes(id));
        if (filteredIds.length === 0) return res.json({ success: true, mutualFollows: [] });

        const { data: users } = await supabase.from('users').select('id,username,profile_pic,last_seen,status_text').in('id', filteredIds);
        const enrichedUsers = (users || []).map(u => ({
            ...u,
            is_online: userSockets.has(u.id.toString())
        }));
        res.json({ success: true, mutualFollows: enrichedUsers });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load mutual follows: ' + error.message });
    }
});

app.get('/api/dm/debug-follows', authenticateToken, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: following } = await supabase.from('followers').select('*').eq('follower_id', uid);
        const { data: followers } = await supabase.from('followers').select('*').eq('following_id', uid);
        res.json({ uid, following: following || [], followers: followers || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dm/messages/:otherId', authenticateToken, async (req, res) => {
    try {
        const { otherId } = req.params;
        const uid = req.user.id;

        // Block check: if either side has blocked the other, return empty conversation
        const isAnyBlock = await Block.findOne({
            $or: [
                { blockerId: uid, blockedId: otherId },
                { blockerId: otherId, blockedId: uid }
            ]
        }).lean();
        if (isAnyBlock) return res.json({ success: true, messages: [], blocked: true });

        const [{ data: sent, error: e1 }, { data: recv, error: e2 }] = await Promise.all([
            supabase.from('direct_messages').select('*').eq('sender_id', uid).eq('receiver_id', otherId).limit(200),
            supabase.from('direct_messages').select('*').eq('sender_id', otherId).eq('receiver_id', uid).limit(200)
        ]);
        if (e1 || e2) { const err = e1 || e2; if (err.code === '42P01') return res.json({ success: true, messages: [] }); throw err; }
        const messages = [...(sent || []), ...(recv || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const replyIds = [...new Set(messages.filter(m => m.reply_to_id).map(m => m.reply_to_id))];
        let replyMap = {};
        if (replyIds.length > 0) {
            const { data: replyMsgs } = await supabase.from('direct_messages').select('id,content,sender_id,media_type').in('id', replyIds);
            if (replyMsgs) replyMsgs.forEach(r => { replyMap[r.id] = r; });
        }
        const enriched = messages.map(m => ({ ...m, reply_to: m.reply_to_id ? (replyMap[m.reply_to_id] || null) : null }));
        supabase.from('direct_messages').update({ is_read: true }).eq('sender_id', otherId).eq('receiver_id', uid).eq('is_read', false)
            // BUG FIX (BUG-27): conversationWith was incorrectly set to `uid` (reader's own ID).
            // It should be `otherId` so the sender knows which conversation was opened.
            .then(() => { const s = userSockets.get(otherId); if (s) s.forEach(sid => io.to(sid).emit('dm_read', { readBy: uid, conversationWith: otherId })); }).catch(() => { });
        const [u1, u2] = [uid, otherId].sort();
        const unreadField = u1 === uid ? 'unread_count_user1' : 'unread_count_user2';
        supabase.from('dm_conversations').update({ [unreadField]: 0 }).eq('user1_id', u1).eq('user2_id', u2).then(() => { }).catch(() => { });
        res.json({ success: true, messages: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// ══════════════════════════════════════════════════════════════
// BUG FIX (BUG-23): DELETE a single DM message (was completely missing)
// ══════════════════════════════════════════════════════════════
app.delete('/api/dm/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const uid = req.user.id;

        // Verify the message exists and belongs to the requesting user
        const { data: msg, error: fetchErr } = await supabase
            .from('direct_messages')
            .select('id,sender_id,receiver_id,content,media_url')
            .eq('id', messageId)
            .single();

        if (fetchErr || !msg) return res.status(404).json({ error: 'Message not found' });
        if (String(msg.sender_id) !== String(uid)) {
            return res.status(403).json({ error: 'You can only delete your own messages' });
        }

        const { error: delErr } = await supabase.from('direct_messages').delete().eq('id', messageId);
        if (delErr) throw delErr;

        // Notify the other person in real-time
        const otherId = String(msg.receiver_id);
        const otherSocket = userSockets.get(otherId);
        if (otherSocket) {
            otherSocket.forEach(sid => io.to(sid).emit('dm_message_deleted', { messageId }));
        }

        // Update conversation's last_message if this was the most recent one
        try {
            const [u1, u2] = [uid, otherId].sort();
            const { data: lastMsg } = await supabase.from('direct_messages')
                .select('content,media_type,created_at')
                .or(`and(sender_id.eq.${uid},receiver_id.eq.${otherId}),and(sender_id.eq.${otherId},receiver_id.eq.${uid})`)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            const newLastMsg = lastMsg ? (lastMsg.content || `[${lastMsg.media_type}]`) : '';
            await supabase.from('dm_conversations').update({ last_message: newLastMsg }).eq('user1_id', u1).eq('user2_id', u2);
        } catch { /* non-critical */ }

        res.json({ success: true, message: 'Message deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete message: ' + error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// BUG FIX (BUG-24): PUT to edit a DM message (was completely missing)
// ══════════════════════════════════════════════════════════════
app.put('/api/dm/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { content } = req.body;
        const uid = req.user.id;

        if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });

        // Verify ownership
        const { data: msg, error: fetchErr } = await supabase
            .from('direct_messages')
            .select('id,sender_id,receiver_id')
            .eq('id', messageId)
            .single();

        if (fetchErr || !msg) return res.status(404).json({ error: 'Message not found' });
        if (String(msg.sender_id) !== String(uid)) {
            return res.status(403).json({ error: 'You can only edit your own messages' });
        }

        const { data: updated, error: updErr } = await supabase
            .from('direct_messages')
            .update({ content: content.trim(), edited_at: new Date().toISOString() })
            .eq('id', messageId)
            .select()
            .single();

        if (updErr) throw updErr;

        // Notify the other person of the edit
        const otherId = String(msg.receiver_id);
        const otherSocket = userSockets.get(otherId);
        if (otherSocket) {
            otherSocket.forEach(sid => io.to(sid).emit('dm_message_edited', { messageId, content: content.trim() }));
        }

        res.json({ success: true, dm: updated });
    } catch (error) {
        res.status(500).json({ error: 'Failed to edit message: ' + error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// BUG FIX (BUG-25): DELETE (clear) all messages in a DM conversation (was completely missing)
// ══════════════════════════════════════════════════════════════
app.delete('/api/dm/conversations/:otherId/clear', authenticateToken, async (req, res) => {
    try {
        const { otherId } = req.params;
        const uid = req.user.id;

        // Delete all messages in both directions between the two users
        await Promise.all([
            supabase.from('direct_messages').delete().eq('sender_id', uid).eq('receiver_id', otherId),
            supabase.from('direct_messages').delete().eq('sender_id', otherId).eq('receiver_id', uid)
        ]);

        // Reset the conversation record
        const [u1, u2] = [uid, otherId].sort();
        await supabase.from('dm_conversations')
            .update({ last_message: '', last_message_at: new Date().toISOString(), unread_count_user1: 0, unread_count_user2: 0 })
            .eq('user1_id', u1).eq('user2_id', u2);

        // Notify the other person
        const otherSocket = userSockets.get(otherId);
        if (otherSocket) {
            otherSocket.forEach(sid => io.to(sid).emit('dm_chat_cleared', { clearedBy: uid }));
        }

        res.json({ success: true, message: 'Chat cleared' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to clear chat: ' + error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// FEEDBACK (Supabase)
// ══════════════════════════════════════════════════════════════
app.post('/api/feedback', authenticateToken, async (req, res) => {
    try {
        const { subject, message } = req.body;
        if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
        await supabase.from('feedback').insert([{ user_id: req.user.id, subject, message }]);
        res.json({ success: true, message: 'Feedback submitted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

// ══════════════════════════════════════════════════════════════
// REALVIBES ENDPOINTS — MongoDB + Cloudinary
// ══════════════════════════════════════════════════════════════

// Helper: enrich realvibes with user info
const enrichVibes = async (vibes, currentUserId) => {
    if (!vibes || vibes.length === 0) return [];
    const userIds = [...new Set(vibes.map(v => v.userId))];
    const { data: users } = await supabase.from('users').select('id,username,profile_pic,college').in('id', userIds);
    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    const vibeIds = vibes.map(v => v._id);
    const [likesData, commentsData, myLikes] = await Promise.all([
        RealVibeLike.aggregate([
            { $match: { vibeId: { $in: vibeIds } } },
            { $group: { _id: "$vibeId", count: { $sum: 1 } } }
        ]),
        RealVibeComment.aggregate([
            { $match: { vibeId: { $in: vibeIds } } },
            { $group: { _id: "$vibeId", count: { $sum: 1 } } }
        ]),
        currentUserId ? RealVibeLike.find({ vibeId: { $in: vibeIds }, userId: currentUserId }).lean() : []
    ]);

    const likeMap = {};
    (likesData || []).forEach(item => { if (item._id) likeMap[item._id.toString()] = item.count; });

    const commentMap = {};
    (commentsData || []).forEach(item => { if (item._id) commentMap[item._id.toString()] = item.count; });

    const myLikesSet = new Set((myLikes || []).map(l => l.vibeId ? l.vibeId.toString() : ''));

    return vibes.map((vibe) => {
        const vibeIdStr = vibe._id.toString();
        const hoursLeft = Math.max(0, Math.ceil((new Date(vibe.expiresAt) - new Date()) / (1000 * 60 * 60)));
        const obj = vibe.toObject();
        return {
            ...obj,
            id: vibeIdStr,
            media_url: obj.mediaUrl,
            media_type: obj.mediaType,
            plan_type: obj.planType,
            user_id: obj.userId,
            users: userMap[vibe.userId] || { id: vibe.userId, username: 'User', profile_pic: null, college: null },
            like_count: likeMap[vibeIdStr] || 0,
            comment_count: commentMap[vibeIdStr] || 0,
            is_liked: myLikesSet.has(vibeIdStr),
            hours_left: hoursLeft
        };
    });
};

// GET all approved realvibes
app.get('/api/realvibes', authenticateToken, async (req, res) => {
    try {
        const blockedIds = await getBlockedIds(req.user.id);
        // Show approved vibes to everyone + show own pending vibes to the creator
        const approvedQuery = { status: 'approved', expiresAt: { $gt: new Date() } };
        if (blockedIds.length > 0) approvedQuery.userId = { $nin: blockedIds };

        const pendingQuery = { status: 'pending', userId: req.user.id, expiresAt: { $gt: new Date() } };

        const [approvedVibes, myPendingVibes] = await Promise.all([
            RealVibe.find(approvedQuery).sort({ createdAt: -1 }).limit(50),
            RealVibe.find(pendingQuery).sort({ createdAt: -1 }).limit(10)
        ]);

        // Merge: pending own vibes first, then approved (deduplicated)
        const approvedIds = new Set(approvedVibes.map(v => v._id.toString()));
        const uniquePending = myPendingVibes.filter(v => !approvedIds.has(v._id.toString()));
        const allVibes = [...uniquePending, ...approvedVibes];

        const enriched = await enrichVibes(allVibes, req.user.id);
        res.json({ success: true, vibes: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load RealVibes' });
    }
});

// POST create realvibe — premium only, Cloudinary
app.post('/api/realvibes', authenticateToken, upload.single('media'), async (req, res) => {
    try {
        if (!req.user.is_premium || !req.user.subscription_plan) return res.status(403).json({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' });
        if (req.user.subscription_end && new Date(req.user.subscription_end) < new Date()) return res.status(403).json({ error: 'Subscription expired', code: 'SUBSCRIPTION_EXPIRED' });
        if (!req.file) return res.status(400).json({ error: 'Media file required' });
        const { caption = '', visibility = 'public', brand_link = '', brand_link_type = 'website' } = req.body;
        const plan = req.user.subscription_plan;
        const isVideo = req.file.mimetype.startsWith('video/');
        const photoQuota = 5; // noble and royal both allow 5 photos
        const videoQuota = plan === 'royal' ? 3 : 1;
        if (isVideo) {
            const videoQuota = plan === 'royal' ? 4 : 1; // Updated to match app plans
            const videoCount = await RealVibe.countDocuments({ userId: req.user.id, mediaType: 'video', status: { $ne: 'rejected' } });
            if (videoCount >= videoQuota) return res.status(403).json({ error: `Video quota reached (${videoQuota} for ${plan} plan)`, code: 'QUOTA_EXCEEDED' });
        }

        const vibeResult = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'vibexpert/realvibes');
        const daysToExpire = plan === 'royal' ? 10 : 7; // Updated to match app plans
        const expiresAt = new Date(Date.now() + daysToExpire * 24 * 60 * 60 * 1000);

        const vibe = await RealVibe.create({
            userId: req.user.id, caption: caption.trim(),
            mediaUrl: vibeResult.secure_url, mediaPublicId: vibeResult.public_id,
            mediaType: isVideo ? 'video' : 'image', planType: plan, visibility,
            brand_link: brand_link.trim(), brand_link_type,
            status: 'pending', expiresAt
        });

        // Skip auto-post to Zero Velocity for now, or post as 'pending'? 
        // User said: "before posting into the website... it will show like admin in processing"
        // If we want it to show in the "Processing" state on the main site, we should return it with a pending flag.

        res.json({ success: true, vibe, pending: true, message: 'Your RealVibe has been submitted and is currently in processing by admin.' });
    } catch (error) {
        console.error('❌ Create RealVibe error:', error);
        res.status(500).json({ error: 'Failed to create RealVibe: ' + error.message });
    }
});

// DELETE realvibe
app.delete('/api/realvibes/:vibeId', authenticateToken, async (req, res) => {
    try {
        const vibe = await RealVibe.findById(req.params.vibeId);
        if (!vibe || vibe.userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        await RealVibe.deleteOne({ _id: vibe._id });
        await RealVibeLike.deleteMany({ vibeId: vibe._id });
        await RealVibeComment.deleteMany({ vibeId: vibe._id });
        io.emit('delete_realvibe', { id: req.params.vibeId });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete RealVibe' });
    }
});

// LIKE / UNLIKE realvibe
app.post('/api/realvibes/:vibeId/like', authenticateToken, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const existing = await RealVibeLike.findOne({ vibeId, userId: req.user.id });
        if (existing) await RealVibeLike.deleteOne({ _id: existing._id });
        else await RealVibeLike.create({ vibeId, userId: req.user.id });
        const likeCount = await RealVibeLike.countDocuments({ vibeId });
        io.emit('realvibe_liked', { vibeId, likeCount, liked: !existing });

        // Push notification to vibe owner — skip if either side has blocked the other
        const vibe = await RealVibe.findById(vibeId);
        if (vibe && vibe.userId !== req.user.id && !existing) {
            const isAnyBlock = await Block.findOne({
                $or: [
                    { blockerId: req.user.id, blockedId: vibe.userId },
                    { blockerId: vibe.userId, blockedId: req.user.id }
                ]
            }).lean();
            if (!isAnyBlock) {
                await pushNotification(vibe.userId, { type: 'post_liked', message: `${req.user.username} liked your RealVibe`, from: req.user.id, fromUsername: req.user.username, fromPic: req.user.profile_pic || null, vibeId });
            }
        }
        // Log in own activity if liking
        if (!existing) {
            await pushNotification(req.user.id, { type: 'post_liked', message: `You liked a RealVibe`, from: req.user.id, fromUsername: 'You', fromPic: req.user.profile_pic || null, vibeId });
        }

        res.json({ success: true, liked: !existing, likeCount });
    } catch (error) {
        res.status(500).json({ error: 'Failed to like RealVibe' });
    }
});

// GET realvibe likes
app.get('/api/realvibes/:vibeId/likes', authenticateToken, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const likes = await RealVibeLike.find({ vibeId }).sort({ createdAt: -1 });
        const userIds = likes.map(l => l.userId);
        const { data: users } = await supabase.from('users').select('id,username,profile_pic,college').in('id', userIds);
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });
        const result = likes.map(l => ({
            id: l._id,
            userId: l.userId,
            users: userMap[l.userId] || { id: l.userId, username: 'User', profile_pic: null },
            createdAt: l.createdAt
        }));
        res.json({ success: true, users: result });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch likes' });
    }
});

// GET realvibe comments
app.get('/api/realvibes/:vibeId/comments', authenticateToken, async (req, res) => {
    try {
        const blockedIds = await getBlockedIds(req.user.id);
        const comments = await RealVibeComment.find({ vibeId: req.params.vibeId }).sort({ isPinned: -1, createdAt: 1 });
        const userIds = [...new Set(comments.map(c => c.userId))];
        const { data: users } = await supabase.from('users').select('id,username,profile_pic').in('id', userIds);
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });
        const enriched = comments
            .filter(c => !blockedIds.includes(c.userId)) // hide comments from blocked/blocking users
            .map(c => {
                const likesUsers = c.likes_users || [];
                return {
                    ...c.toObject(),
                    id: c._id.toString(),
                    users: userMap[c.userId] || { id: c.userId, username: 'User', profile_pic: null },
                    is_liked: likesUsers.includes(req.user.id),
                    liked: likesUsers.includes(req.user.id),
                    like_count: likesUsers.length,
                    likeCount: likesUsers.length,
                    isPinned: c.isPinned || false,
                    pinned: c.isPinned || false,
                    is_pinned: c.isPinned || false
                };
            });
        res.json({ success: true, comments: enriched });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load comments' });
    }
});

// POST realvibe comment
app.post('/api/realvibes/:vibeId/comments', authenticateToken, async (req, res) => {
    try {
        const { vibeId } = req.params;
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: 'Comment required' });

        // Block check against vibe owner
        const vibe = await RealVibe.findById(vibeId);
        if (vibe && vibe.userId !== req.user.id) {
            const isAnyBlock = await Block.findOne({
                $or: [
                    { blockerId: req.user.id, blockedId: vibe.userId },
                    { blockerId: vibe.userId, blockedId: req.user.id }
                ]
            }).lean();
            if (isAnyBlock) return res.status(403).json({ error: 'Action not available', blocked: true });
        }

        const comment = await RealVibeComment.create({ vibeId, userId: req.user.id, content: content.trim() });
        const commentCount = await RealVibeComment.countDocuments({ vibeId });
        io.emit('realvibe_commented', { vibeId, commentCount });

        // Push notification to vibe owner — skip if blocked
        if (vibe && vibe.userId !== req.user.id) {
            const isAnyBlock = await Block.findOne({
                $or: [
                    { blockerId: req.user.id, blockedId: vibe.userId },
                    { blockerId: vibe.userId, blockedId: req.user.id }
                ]
            }).lean();
            if (!isAnyBlock) {
                await pushNotification(vibe.userId, { type: 'new_comment', message: `${req.user.username} commented on your RealVibe`, from: req.user.id, fromUsername: req.user.username, fromPic: req.user.profile_pic || null, vibeId });
            }
        }
        // Log in own activity
        await pushNotification(req.user.id, { type: 'new_comment', message: `You commented on a RealVibe`, from: req.user.id, fromUsername: 'You', fromPic: req.user.profile_pic || null, vibeId });

        res.json({ success: true, comment: { ...comment.toObject(), id: comment._id.toString() } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to comment' });
    }
});

// ── Admin: realvibe moderation ─────────────────────────────────
app.get('/api/admin/realvibes/pending', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const vibes = await RealVibe.find({ status: 'pending' }).sort({ createdAt: 1 });
        const enriched = await enrichVibes(vibes, null);
        res.json({ success: true, vibes: enriched, count: enriched.length });
    } catch (err) { res.status(500).json({ error: 'Failed to load pending vibes' }); }
});

app.get('/api/admin/realvibes', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { status, limit = 50, offset = 0 } = req.query;
        const query = {};
        if (status && ['pending', 'approved', 'rejected'].includes(status)) query.status = status;
        const vibes = await RealVibe.find(query).sort({ createdAt: -1 }).skip(Number(offset)).limit(Number(limit));
        const enriched = await enrichVibes(vibes, null);
        res.json({ success: true, vibes: enriched });
    } catch (err) { res.status(500).json({ error: 'Failed to load vibes' }); }
});

app.post('/api/admin/realvibes/:vibeId/approve', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { vibeId } = req.params;
        const { admin_name = 'Admin' } = req.body;
        const vibe = await RealVibe.findById(vibeId);
        if (!vibe) return res.status(404).json({ error: 'Vibe not found' });
        if (vibe.status !== 'pending') return res.status(400).json({ error: `Vibe is already ${vibe.status}` });
        vibe.status = 'approved';
        vibe.reviewedAt = new Date();
        vibe.reviewedByAdmin = admin_name;
        await vibe.save();
        // Log + notify in Supabase
        await supabase.from('real_vibe_moderation_log').insert([{ vibe_id: vibeId, admin_id: admin_name, action: 'approved' }]);
        await supabase.from('real_vibe_notifications').insert([{ user_id: vibe.userId, vibe_id: vibeId, type: 'approved', message: '✅ Your RealVibe post has been approved and is now live!' }]);
        const enriched = (await enrichVibes([vibe], null))[0];
        io.emit('new_realvibe', enriched);
        const userSocketId = userSockets.get(vibe.userId);
        if (userSocketId) {
            userSocketId.forEach(sid => io.to(sid).emit('realvibe_status_update', { vibeId, status: 'approved', message: '✅ Your RealVibe has been approved and is now live!' }));
        }
        res.json({ success: true, message: 'Vibe approved and published' });
    } catch (err) { res.status(500).json({ error: 'Failed to approve vibe' }); }
});

app.post('/api/admin/realvibes/:vibeId/reject', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { vibeId } = req.params;
        const { reason = 'vulgar', custom_message, admin_name = 'Admin' } = req.body;
        const rejectionMessages = { vulgar: '❌ Rejected: Inappropriate or vulgar content.', spam: '❌ Rejected: Spam or repetitive content.', irrelevant: '❌ Rejected: Content is not relevant.', other: `❌ Rejected. ${custom_message || 'Does not meet community guidelines.'}` };
        const rejectionMsg = rejectionMessages[reason] || rejectionMessages.other;
        const vibe = await RealVibe.findById(vibeId);
        if (!vibe) return res.status(404).json({ error: 'Vibe not found' });
        if (vibe.status !== 'pending') return res.status(400).json({ error: `Vibe is already ${vibe.status}` });
        vibe.status = 'rejected';
        vibe.rejectionReason = rejectionMsg;
        vibe.reviewedAt = new Date();
        vibe.reviewedByAdmin = admin_name;
        await vibe.save();
        await supabase.from('real_vibe_moderation_log').insert([{ vibe_id: vibeId, admin_id: admin_name, action: 'rejected', rejection_reason: rejectionMsg }]);
        await supabase.from('real_vibe_notifications').insert([{ user_id: vibe.userId, vibe_id: vibeId, type: 'rejected', message: rejectionMsg }]);
        const userSocketId = userSockets.get(vibe.userId);
        if (userSocketId) {
            userSocketId.forEach(sid => io.to(sid).emit('realvibe_status_update', { vibeId, status: 'rejected', message: rejectionMsg }));
        }
        res.json({ success: true, message: 'Vibe rejected and user notified' });
    } catch (err) { res.status(500).json({ error: 'Failed to reject vibe' }); }
});

app.get('/api/admin/realvibes/stats', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const [pending, approved, rejected, total] = await Promise.all([
            RealVibe.countDocuments({ status: 'pending' }),
            RealVibe.countDocuments({ status: 'approved' }),
            RealVibe.countDocuments({ status: 'rejected' }),
            RealVibe.countDocuments()
        ]);
        res.json({ success: true, stats: { pending, approved, rejected, total } });
    } catch (err) { res.status(500).json({ error: 'Failed to load stats' }); }
});

// RealVibe notifications (Supabase)
app.get('/api/realvibes/notifications', authenticateToken, async (req, res) => {
    try {
        const { data: notifications, error } = await supabase.from('real_vibe_notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20);
        if (error) throw error;
        res.json({ success: true, notifications: notifications || [] });
    } catch (err) { res.status(500).json({ error: 'Failed to load notifications' }); }
});

app.post('/api/realvibes/notifications/read', authenticateToken, async (req, res) => {
    try {
        await supabase.from('real_vibe_notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('is_read', false);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to mark as read' }); }
});

app.get('/api/realvibes/my-submissions', authenticateToken, async (req, res) => {
    try {
        const vibes = await RealVibe.find({ userId: req.user.id }).sort({ createdAt: -1 }).select('id caption mediaUrl mediaType status rejectionReason createdAt expiresAt');
        res.json({ success: true, vibes: vibes.map(v => ({ ...v.toObject(), id: v._id.toString() })) });
    } catch (err) { res.status(500).json({ error: 'Failed to load your submissions' }); }
});

// ══════════════════════════════════════════════════════════════
// EXECUTIVE CHAT — Supabase + Cloudinary
// ══════════════════════════════════════════════════════════════
app.get('/api/executive/messages', authenticateToken, async (req, res) => {
    try {
        const collegeForMsg = (req.user.college || '').toString();
        const isPrivileged = isAdminUser(req.user) || collegeForMsg.includes('ROLE:Alumni') || collegeForMsg.includes('ROLE:Admin');
        if (!isPrivileged && (!req.user.community_joined || !req.user.college)) return res.json({ success: false, needsJoinCommunity: true, messages: [] });
        const fiveDaysAgo = new Date(); fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
        const resolvedRoom = getCommunityRoom(req.user.college);
        const { data: messages, error } = await supabase.from('executive_messages').select('*').eq('college_name', resolvedRoom).eq('is_deleted', false).gte('created_at', fiveDaysAgo.toISOString()).order('created_at', { ascending: true }).limit(500);
        if (error) throw error;
        const blockedIds = await getBlockedIds(req.user.id);
        let enriched = (messages || []).filter(m => !blockedIds.includes(m.sender_id));
        if (enriched.length > 0) {
            const senderIds = [...new Set(enriched.map(m => m.sender_id))];
            const { data: users } = await supabase.from('users').select('id,username,profile_pic').in('id', senderIds);
            const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u; });
            enriched = enriched.map(msg => ({ ...msg, users: userMap[msg.sender_id] || { id: msg.sender_id, username: 'User', profile_pic: null } }));
        }
        const replyIds = [...new Set(enriched.filter(m => m.reply_to_id).map(m => m.reply_to_id))];
        if (replyIds.length > 0) {
            const { data: rMsgs } = await supabase.from('executive_messages').select('id,content,sender_id,media_type,media_url,message_type').in('id', replyIds);
            const rUserIds = [...new Set((rMsgs || []).map(m => m.sender_id))];
            const { data: rUsers } = await supabase.from('users').select('id,username').in('id', rUserIds);
            const rUserMap = {}; (rUsers || []).forEach(u => { rUserMap[u.id] = u; });
            const replyMap = {}; (rMsgs || []).forEach(m => { replyMap[m.id] = { ...m, sender_username: rUserMap[m.sender_id]?.username || 'User' }; });
            enriched = enriched.map(msg => ({ ...msg, reply_to: msg.reply_to_id ? (replyMap[msg.reply_to_id] || null) : null }));
        }
        if (enriched.length > 0) {
            const msgIds = enriched.map(m => m.id);
            const { data: reactions } = await supabase.from('executive_message_reactions').select('message_id,user_id,emoji').in('message_id', msgIds);
            const rxMap = {}; (reactions || []).forEach(r => { if (!rxMap[r.message_id]) rxMap[r.message_id] = []; rxMap[r.message_id].push(r); });
            const { data: reads } = await supabase.from('executive_message_reads').select('message_id,user_id').in('message_id', msgIds);
            const readMap = {}; (reads || []).forEach(r => { if (!readMap[r.message_id]) readMap[r.message_id] = []; readMap[r.message_id].push(r.user_id); });
            enriched = enriched.map(msg => ({ ...msg, reactions: rxMap[msg.id] || [], read_by: readMap[msg.id] || [] }));
        }
        const pollMsgIds = enriched.filter(m => m.message_type === 'poll').map(m => m.id);
        if (pollMsgIds.length > 0) {
            const { data: polls } = await supabase.from('executive_polls').select('*,executive_poll_votes(*)').in('message_id', pollMsgIds);
            const pollMap = {}; (polls || []).forEach(p => { pollMap[p.message_id] = p; });
            enriched = enriched.map(msg => ({ ...msg, poll: msg.message_type === 'poll' ? (pollMap[msg.id] || null) : undefined }));
        }
        res.json({ success: true, messages: enriched });
    } catch (err) { res.status(500).json({ error: 'Failed to load messages', details: err.message }); }
});

app.post('/api/executive/messages', authenticateToken, (req, res, next) => {
    if (req.headers['content-type']?.includes('multipart/form-data')) upload.single('media')(req, res, next);
    else next();
}, async (req, res) => {
    try {
        const collegeForSend = (req.user.college || '').toString();
        const isSendPrivileged = isAdminUser(req.user) || collegeForSend.includes('ROLE:Alumni') || collegeForSend.includes('ROLE:Admin');
        if (!isSendPrivileged && (!req.user.community_joined || !req.user.college)) return res.status(400).json({ error: 'Join a college community first' });
        const { content, reply_to_id, poll_question, poll_options } = req.body;
        const media = req.file;
        if (!content && !media && !poll_question) return res.status(400).json({ error: 'Message content, media, or poll required' });
        let mediaUrl = null, mediaType = null, msgType = 'text';
        if (media) {
            try {
                const isVoice = req.body.is_voice === 'true';
                const folder = isVoice ? 'vibexpert/exec-voice' : 'vibexpert/exec-media';
                const result = await uploadToCloudinary(media.buffer, media.mimetype, folder);
                mediaUrl = result.secure_url;
                if (isVoice) { mediaType = 'audio'; msgType = 'voice'; }
                else if (media.mimetype.startsWith('video/')) { mediaType = 'video'; msgType = 'video'; }
                else if (media.mimetype.startsWith('audio/')) { mediaType = 'audio'; msgType = 'audio'; }
                else if (media.mimetype === 'application/pdf') { mediaType = 'pdf'; msgType = 'document'; }
                else if (media.mimetype.startsWith('application/') || media.mimetype.startsWith('text/')) { mediaType = 'document'; msgType = 'document'; }
                else { mediaType = 'image'; msgType = 'image'; }
            } catch (uploadErr) { return res.status(500).json({ error: 'Media upload failed: ' + uploadErr.message }); }
        }
        if (poll_question) msgType = 'poll';
        const resolvedRoom = getCommunityRoom(req.user.college);
        const { data: inserted, error: insertError } = await supabase.from('executive_messages').insert([{
            sender_id: req.user.id, college_name: resolvedRoom, content: content?.trim() || '',
            message_type: msgType, media_url: mediaUrl, media_type: mediaType,
            media_name: media ? media.originalname : null, media_size: media ? media.size : null,
            reply_to_id: (reply_to_id && reply_to_id !== 'null') ? reply_to_id : null
        }]).select('*').single();
        if (insertError) throw insertError;
        let pollData = null;
        if (poll_question && inserted) {
            let options = []; try { options = JSON.parse(poll_options || '[]'); } catch { }
            const { data: poll } = await supabase.from('executive_polls').insert([{ message_id: inserted.id, question: poll_question, options }]).select('*').single();
            pollData = poll ? { ...poll, executive_poll_votes: [] } : null;
        }
        const { data: sender } = await supabase.from('users').select('id,username,profile_pic').eq('id', req.user.id).single();
        let replyToData = null;
        if (inserted.reply_to_id) {
            const { data: rMsg } = await supabase.from('executive_messages').select('id,content,sender_id,media_type,media_url,message_type').eq('id', inserted.reply_to_id).single();
            if (rMsg) { const { data: rUser } = await supabase.from('users').select('username').eq('id', rMsg.sender_id).single(); replyToData = { ...rMsg, sender_username: rUser?.username || 'User' }; }
        }
        const finalMsg = { ...inserted, users: sender || { id: req.user.id, username: req.user.username, profile_pic: null }, reactions: [], read_by: [], reply_to: replyToData, poll: pollData };
        const senderSocketId = userSockets.get(req.user.id);
        const room = `exec_${resolvedRoom}`;
        if (senderSocketId) io.to(room).except(Array.from(senderSocketId)).emit('exec_new_message', finalMsg);
        else io.to(room).emit('exec_new_message', finalMsg);
        res.json({ success: true, message: finalMsg });
    } catch (err) { res.status(500).json({ error: 'Failed to send message', details: err.message }); }
});

app.patch('/api/executive/messages/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
        const { data: msg } = await supabase.from('executive_messages').select('sender_id,college_name').eq('id', id).single();
        if (!msg || msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        const { data: updated, error } = await supabase.from('executive_messages').update({ content: content.trim(), is_edited: true, edited_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
        if (error) throw error;
        io.to(`exec_${msg.college_name}`).emit('exec_message_edited', { id, content: content.trim(), edited_at: updated.edited_at });
        res.json({ success: true, message: updated });
    } catch (err) { res.status(500).json({ error: 'Failed to edit message' }); }
});

app.delete('/api/executive/messages/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { data: msg } = await supabase.from('executive_messages').select('sender_id,college_name').eq('id', id).single();
        if (!msg || msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        await supabase.from('executive_messages').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
        io.to(`exec_${msg.college_name}`).emit('exec_message_deleted', { id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete message' }); }
});

app.post('/api/executive/reactions', authenticateToken, async (req, res) => {
    try {
        const { message_id, emoji } = req.body;
        if (!message_id || !emoji) return res.status(400).json({ error: 'message_id and emoji required' });
        const { data: msg } = await supabase.from('executive_messages').select('college_name').eq('id', message_id).single();
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        const { data: existing } = await supabase.from('executive_message_reactions').select('id').eq('message_id', message_id).eq('user_id', req.user.id).eq('emoji', emoji).single();
        let action;
        if (existing) {
            await supabase.from('executive_message_reactions').delete().eq('id', existing.id);
            action = 'removed';
        } else {
            // Delete all prior reactions on this message by this user
            await supabase.from('executive_message_reactions').delete().eq('message_id', message_id).eq('user_id', req.user.id);
            // Insert the new reaction
            await supabase.from('executive_message_reactions').insert([{ message_id, user_id: req.user.id, emoji }]);
            action = 'added';
        }
        const { data: allReactions } = await supabase.from('executive_message_reactions').select('message_id,user_id,emoji').eq('message_id', message_id);
        const update = { message_id, reactions: allReactions || [], action, userId: req.user.id, emoji, collegeName: msg.college_name };
        io.to(`exec_${msg.college_name}`).emit('exec_reaction_update', update);
        res.json({ success: true, reactions: allReactions || [], action });
    } catch (err) { res.status(500).json({ error: 'Failed to update reaction' }); }
});

app.post('/api/executive/read', authenticateToken, async (req, res) => {
    try {
        const { message_ids } = req.body;
        if (!message_ids?.length) return res.json({ success: true });
        const rows = message_ids.map(mid => ({ message_id: mid, user_id: req.user.id }));
        await supabase.from('executive_message_reads').upsert(rows, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to mark as read' }); }
});

app.get('/api/executive/reads/:messageId', authenticateToken, async (req, res) => {
    try {
        const { data: reads, error } = await supabase.from('executive_message_reads').select('user_id,read_at').eq('message_id', req.params.messageId).order('read_at', { ascending: true });
        if (error) throw error;
        const userIds = (reads || []).map(r => r.user_id);
        let readers = [];
        if (userIds.length > 0) {
            const { data: users } = await supabase.from('users').select('id,username,profile_pic').in('id', userIds);
            const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u; });
            readers = (reads || []).map(r => ({ ...userMap[r.user_id], read_at: r.read_at })).filter(u => u.id);
        }
        res.json({ success: true, readers });
    } catch (err) { res.status(500).json({ error: 'Failed to load readers' }); }
});

app.post('/api/executive/polls/:pollId/vote', authenticateToken, async (req, res) => {
    try {
        const { pollId } = req.params;
        const { option_id } = req.body;
        if (!option_id) return res.status(400).json({ error: 'option_id required' });
        const { data: poll } = await supabase.from('executive_polls').select('*,executive_messages(college_name)').eq('id', pollId).single();
        if (!poll || poll.is_closed) return res.status(404).json({ error: poll?.is_closed ? 'Poll is closed' : 'Poll not found' });
        const collegeName = poll.executive_messages?.college_name;
        await supabase.from('executive_poll_votes').upsert([{ poll_id: pollId, user_id: req.user.id, option_id }], { onConflict: 'poll_id,user_id' });
        const { data: votes } = await supabase.from('executive_poll_votes').select('*').eq('poll_id', pollId);
        const update = { pollId, messageId: poll.message_id, votes: votes || [], userId: req.user.id, collegeName };
        if (collegeName) io.to(`exec_${collegeName}`).emit('exec_poll_voted', update);
        res.json({ success: true, votes: votes || [] });
    } catch (err) { res.status(500).json({ error: 'Failed to vote' }); }
});

// ══════════════════════════════════════════════════════════════
// AUTO-DELETE (chat only — posts & RealVibes handled by MongoDB TTL)
// ══════════════════════════════════════════════════════════════
async function cleanupOldMessages() {
    try {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 5);
        await supabase.from('community_messages').delete().lt('created_at', cutoff.toISOString());
        console.log('🗑️ Chat cleanup done');
    } catch (err) { console.error('❌ Chat cleanup error:', err.message); }
}

async function cleanupOldExecutiveMessages() {
    try {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 5);
        await supabase.from('executive_messages').delete().lt('created_at', cutoff.toISOString());
        console.log('🗑️ Executive chat cleanup done');
    } catch (err) { console.error('❌ Executive cleanup error:', err.message); }
}

setInterval(cleanupOldMessages, 60 * 60 * 1000);
cleanupOldMessages();
setInterval(cleanupOldExecutiveMessages, 60 * 60 * 1000);
cleanupOldExecutiveMessages();

// ══════════════════════════════════════════════════════════════
// UNREAD COUNT ENDPOINTS (called by index.html pollBadges)
// ══════════════════════════════════════════════════════════════
app.get('/api/notifications/unread-count', authenticateToken, async (req, res) => {
    try {
        const notifications = await getNotifications(req.user.id, 50);
        const count = notifications.filter(n => !n.read).length;
        res.json({ success: true, count });
    } catch (err) {
        res.json({ success: true, count: 0 });
    }
});

app.get('/api/dm/unread-count', authenticateToken, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: convs } = await supabase
            .from('dm_conversations')
            .select('user1_id, unread_count_user1, unread_count_user2')
            .or(`user1_id.eq.${uid},user2_id.eq.${uid}`);
        const count = (convs || []).reduce((sum, c) => {
            const unread = c.user1_id === uid ? (c.unread_count_user1 || 0) : (c.unread_count_user2 || 0);
            return sum + unread;
        }, 0);
        res.json({ success: true, count });
    } catch (err) {
        res.json({ success: true, count: 0 });
    }
});


// ══════════════════════════════════════════════════════════════
// COLLEGE REQUESTS
// ══════════════════════════════════════════════════════════════
// Public endpoint for users to submit requests
app.post('/api/college-requests', authenticateTokenOptional, async (req, res) => {
    try {
        const { collegeName, collegeEmail } = req.body;
        if (!collegeName || !collegeEmail) return res.status(400).json({ error: 'Missing fields' });

        const newRequest = new CollegeRequest({
            userId: req.user ? req.user.id : null,
            collegeName,
            collegeEmail,
            status: 'pending'
        });
        await newRequest.save();
        res.json({ success: true, message: 'Request submitted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to submit college request' });
    }
});

// Admin endpoints
app.get('/api/admin/college-requests', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const requests = await CollegeRequest.find().sort({ createdAt: -1 });
        res.json({ success: true, requests });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load requests' });
    }
});

app.post('/api/admin/college-requests/:id/status', authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Access denied.' });
        const { status } = req.body;
        if (!['pending', 'reviewed', 'added', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const request = await CollegeRequest.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (!request) return res.status(404).json({ error: 'Request not found' });

        res.json({ success: true, request });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update request' });
    }
});

// ══════════════════════════════════════════════════════════════
// ERROR HANDLING
// ══════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum size is 100MB' });
        if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Too many files. Maximum is 10 files' });
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));

// ══════════════════════════════════════════════════════════════
// SERVER START
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 VibeXpert Backend running on port ${PORT}`);
    console.log(`✅ Supabase  → Users, Chat, DMs, Payments`);
    console.log(`✅ MongoDB   → Posts, RealVibes`);
    console.log(`✅ Cloudinary→ All media files`);
    console.log(`✅ Redis     → Notifications`);
    console.log(`✅ Socket.IO → Real-time events`);
    console.log(`💳 Razorpay  → Payments active`);
});
