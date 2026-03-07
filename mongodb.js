// ================================================================
// VibeXpert — MongoDB Schemas
// File: config/mongodb.js
// Contains: Posts, Likes, Comments, Shares, RealVibes
// ================================================================

const mongoose = require('mongoose');

const connectMongo = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, { dbName: 'vibexpert' });
        console.log('✅ MongoDB connected');
    } catch (err) {
        console.error('❌ MongoDB connection error:', err.message);
    }
};

// SCHEMA 1: Post
const postSchema = new mongoose.Schema({
    userId:    { type: String, required: true },
    content:   { type: String, default: '' },
    media:     { type: Array,  default: [] },       // [{ url, type, public_id }]
    postedTo:  { type: String, default: 'profile', enum: ['profile', 'community'] },
    college:   { type: String, default: null },
    music:     { type: Object, default: null },
    stickers:  { type: Array,  default: [] },
    createdAt: { type: Date,   default: Date.now },
    updatedAt: { type: Date,   default: Date.now }
});
postSchema.index({ createdAt: -1 });
postSchema.index({ userId: 1, createdAt: -1 });
postSchema.index({ postedTo: 1, college: 1, createdAt: -1 });

// SCHEMA 2: Post Like
const postLikeSchema = new mongoose.Schema({
    postId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId:    { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
postLikeSchema.index({ postId: 1, userId: 1 }, { unique: true });

// SCHEMA 3: Post Comment
const postCommentSchema = new mongoose.Schema({
    postId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId:    { type: String, required: true },
    content:   { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
postCommentSchema.index({ postId: 1, createdAt: -1 });

// SCHEMA 4: Post Share
const postShareSchema = new mongoose.Schema({
    postId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId:    { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
postShareSchema.index({ postId: 1 });

// SCHEMA 5: RealVibe
const realVibeSchema = new mongoose.Schema({
    userId:          { type: String, required: true },
    caption:         { type: String, default: '' },
    mediaUrl:        { type: String, required: true },
    mediaType:       { type: String, enum: ['image', 'video'], required: true },
    mediaPublicId:   { type: String },
    planType:        { type: String, enum: ['noble', 'royal'], required: true },
    visibility:      { type: String, default: 'public' },
    status:          { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
    rejectionReason: { type: String, default: null },
    reviewedAt:      { type: Date,   default: null },
    reviewedByAdmin: { type: String, default: null },
    expiresAt:       { type: Date,   required: true },
    createdAt:       { type: Date,   default: Date.now }
});
realVibeSchema.index({ status: 1, expiresAt: -1 });
realVibeSchema.index({ userId: 1, createdAt: -1 });
realVibeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // auto-deletes when expired!

// SCHEMA 6: RealVibe Like
const realVibeLikeSchema = new mongoose.Schema({
    vibeId:    { type: mongoose.Schema.Types.ObjectId, ref: 'RealVibe', required: true },
    userId:    { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
realVibeLikeSchema.index({ vibeId: 1, userId: 1 }, { unique: true });

// SCHEMA 7: RealVibe Comment
const realVibeCommentSchema = new mongoose.Schema({
    vibeId:    { type: mongoose.Schema.Types.ObjectId, ref: 'RealVibe', required: true },
    userId:    { type: String, required: true },
    content:   { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
realVibeCommentSchema.index({ vibeId: 1, createdAt: 1 });

const Post            = mongoose.model('Post',            postSchema);
const PostLike        = mongoose.model('PostLike',        postLikeSchema);
const PostComment     = mongoose.model('PostComment',     postCommentSchema);
const PostShare       = mongoose.model('PostShare',       postShareSchema);
const RealVibe        = mongoose.model('RealVibe',        realVibeSchema);
const RealVibeLike    = mongoose.model('RealVibeLike',    realVibeLikeSchema);
const RealVibeComment = mongoose.model('RealVibeComment', realVibeCommentSchema);

module.exports = {
    connectMongo,
    Post, PostLike, PostComment, PostShare,
    RealVibe, RealVibeLike, RealVibeComment
};