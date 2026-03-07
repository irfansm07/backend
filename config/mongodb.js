// config/mongodb.js
// Requires env var: MONGODB_URI

const mongoose = require('mongoose');

// ── Connection ────────────────────────────────────────────────
const connectMongo = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
        console.log('✅ MongoDB connected');
    } catch (err) {
        console.error('❌ MongoDB connection failed:', err.message);
        // Retry after 5 seconds instead of crashing the whole server
        setTimeout(connectMongo, 5000);
    }
};

mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  MongoDB disconnected — retrying...');
    setTimeout(connectMongo, 5000);
});

// ── Schemas ───────────────────────────────────────────────────

// Posts
const postSchema = new mongoose.Schema({
    userId:   { type: String, required: true, index: true },
    content:  { type: String, default: '' },
    media:    [{
        url:       String,
        public_id: String,
        type:      { type: String, enum: ['image', 'video', 'audio'] }
    }],
    postedTo: { type: String, enum: ['profile', 'community'], default: 'profile' },
    college:  { type: String, default: null },
    music:    { type: mongoose.Schema.Types.Mixed, default: null },
    stickers: { type: [mongoose.Schema.Types.Mixed], default: [] },
    updatedAt: { type: Date }
}, { timestamps: true });

postSchema.index({ postedTo: 1, college: 1, createdAt: -1 });
postSchema.index({ userId: 1, createdAt: -1 });

// Post Likes
const postLikeSchema = new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    userId: { type: String, required: true }
}, { timestamps: true });

postLikeSchema.index({ postId: 1, userId: 1 }, { unique: true });

// Post Comments
const postCommentSchema = new mongoose.Schema({
    postId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    userId:  { type: String, required: true },
    content: { type: String, required: true }
}, { timestamps: true });

// Post Shares
const postShareSchema = new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    userId: { type: String, required: true }
}, { timestamps: true });

// RealVibes
const realVibeSchema = new mongoose.Schema({
    userId:         { type: String, required: true, index: true },
    caption:        { type: String, default: '' },
    mediaUrl:       { type: String, required: true },
    mediaPublicId:  { type: String },
    mediaType:      { type: String, enum: ['image', 'video'], required: true },
    planType:       { type: String, enum: ['noble', 'royal'], required: true },
    visibility:     { type: String, enum: ['public', 'college'], default: 'public' },
    status:         { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    rejectionReason:{ type: String, default: null },
    reviewedAt:     { type: Date, default: null },
    reviewedByAdmin:{ type: String, default: null },
    expiresAt:      { type: Date, required: true, index: true }
}, { timestamps: true });

// TTL index: MongoDB auto-deletes expired RealVibes
realVibeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// RealVibe Likes
const realVibeLikeSchema = new mongoose.Schema({
    vibeId: { type: mongoose.Schema.Types.ObjectId, ref: 'RealVibe', required: true, index: true },
    userId: { type: String, required: true }
}, { timestamps: true });

realVibeLikeSchema.index({ vibeId: 1, userId: 1 }, { unique: true });

// RealVibe Comments
const realVibeCommentSchema = new mongoose.Schema({
    vibeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'RealVibe', required: true, index: true },
    userId:  { type: String, required: true },
    content: { type: String, required: true }
}, { timestamps: true });

// ── Models ────────────────────────────────────────────────────
const Post            = mongoose.models.Post            || mongoose.model('Post',            postSchema);
const PostLike        = mongoose.models.PostLike        || mongoose.model('PostLike',        postLikeSchema);
const PostComment     = mongoose.models.PostComment     || mongoose.model('PostComment',     postCommentSchema);
const PostShare       = mongoose.models.PostShare       || mongoose.model('PostShare',       postShareSchema);
const RealVibe        = mongoose.models.RealVibe        || mongoose.model('RealVibe',        realVibeSchema);
const RealVibeLike    = mongoose.models.RealVibeLike    || mongoose.model('RealVibeLike',    realVibeLikeSchema);
const RealVibeComment = mongoose.models.RealVibeComment || mongoose.model('RealVibeComment', realVibeCommentSchema);

module.exports = {
    connectMongo,
    Post,
    PostLike,
    PostComment,
    PostShare,
    RealVibe,
    RealVibeLike,
    RealVibeComment
};