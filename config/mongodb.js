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

// Seller Requests
const sellerRequestSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    type: { type: String, enum: ['new_seller', 'new_product'], required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'hold'], default: 'pending', index: true },
    adminMessage: { type: String, default: null }
}, { timestamps: true });

// Platform Notifications (Global/Targeted)
const platformNotificationSchema = new mongoose.Schema({
    title: { type: String, required: true },
    message: { type: String, required: true },
    target: { type: String, enum: ['all', 'sellers', 'specific'], default: 'all' },
    targetUserId: { type: String, default: null }, // if target is specific
    createdBy: { type: String, required: true }
}, { timestamps: true });

// Banned Users
const bannedUserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    reason: { type: String, required: true },
    bannedBy: { type: String, required: true },
    bannedAt: { type: Date, default: Date.now }
});

// Client Registration Requests
const clientRequestSchema = new mongoose.Schema({
    userId: { type: String, default: null },
    email: { type: String, required: true },
    businessName: { type: String, required: true },
    businessType: { type: String, required: true },
    phone: { type: String, default: '' },
    description: { type: String, required: true },
    gstNumber: { type: String, default: '' },
    address: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'hold'], default: 'pending', index: true },
    adminMessage: { type: String, default: null },
    setupToken: { type: String, default: null },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null }
}, { timestamps: true });

clientRequestSchema.index({ userId: 1, status: 1 });

// Client Products (products added by clients/sellers)
const clientProductSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    price: { type: Number, required: true },
    originalPrice: { type: Number, required: true },
    category: { type: String, required: true },
    images: [{ url: String, public_id: String }],
    colors: [String],
    sizes: [String],
    badge: { type: String, enum: ['sale', 'new', 'trending', null], default: 'new' },
    inStock: { type: Boolean, default: true },
    stockQuantity: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive', 'pending_review'], default: 'active', index: true },
    rating: { type: Number, default: 0 },
    reviews: { type: Number, default: 0 }
}, { timestamps: true });

clientProductSchema.index({ clientId: 1, status: 1 });
clientProductSchema.index({ category: 1 });

// Order Messages (admin-user communication about orders)
const orderMessageSchema = new mongoose.Schema({
    orderId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    senderRole: { type: String, enum: ['admin', 'user', 'client'], required: true },
    message: { type: String, required: true },
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video', 'audio', 'pdf', 'document', null], default: null },
    mediaName: { type: String, default: null },
    read: { type: Boolean, default: false }
}, { timestamps: true });

orderMessageSchema.index({ orderId: 1, createdAt: 1 });

// Complaints / Support Tickets
const complaintSchema = new mongoose.Schema({
    userId: { type: String, default: null, index: true },
    email: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: ['bug', 'support', 'feedback', 'other'], default: 'support' },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    source: { type: String, enum: ['online', 'shop', 'client_portal', 'app'], required: true },
    status: { type: String, enum: ['open', 'resolved', 'closed'], default: 'open', index: true },
    adminResponse: { type: String, default: null },
    resolvedAt: { type: Date, default: null }
}, { timestamps: true });

// Password Reset Codes
const passwordResetCodeSchema = new mongoose.Schema({
    email: { type: String, required: true, index: true },
    code: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 900 } // Auto expires in 15 mins (900 secs)
});

// ── Models ────────────────────────────────────────────────────
const Post            = mongoose.models.Post            || mongoose.model('Post',            postSchema);
const PostLike        = mongoose.models.PostLike        || mongoose.model('PostLike',        postLikeSchema);
const PostComment     = mongoose.models.PostComment     || mongoose.model('PostComment',     postCommentSchema);
const PostShare       = mongoose.models.PostShare       || mongoose.model('PostShare',       postShareSchema);
const RealVibe        = mongoose.models.RealVibe        || mongoose.model('RealVibe',        realVibeSchema);
const RealVibeLike    = mongoose.models.RealVibeLike    || mongoose.model('RealVibeLike',    realVibeLikeSchema);
const RealVibeComment = mongoose.models.RealVibeComment || mongoose.model('RealVibeComment', realVibeCommentSchema);
const SellerRequest   = mongoose.models.SellerRequest   || mongoose.model('SellerRequest',   sellerRequestSchema);
const PlatformNotification = mongoose.models.PlatformNotification || mongoose.model('PlatformNotification', platformNotificationSchema);
const BannedUser      = mongoose.models.BannedUser      || mongoose.model('BannedUser',      bannedUserSchema);
const ClientRequest   = mongoose.models.ClientRequest   || mongoose.model('ClientRequest',   clientRequestSchema);
const ClientProduct   = mongoose.models.ClientProduct   || mongoose.model('ClientProduct',   clientProductSchema);
const OrderMessage    = mongoose.models.OrderMessage    || mongoose.model('OrderMessage',    orderMessageSchema);
const Complaint       = mongoose.models.Complaint       || mongoose.model('Complaint',       complaintSchema);
const PasswordResetCode = mongoose.models.PasswordResetCode || mongoose.model('PasswordResetCode', passwordResetCodeSchema);

module.exports = {
    connectMongo,
    Post,
    PostLike,
    PostComment,
    PostShare,
    RealVibe,
    RealVibeLike,
    RealVibeComment,
    SellerRequest,
    PlatformNotification,
    BannedUser,
    ClientRequest,
    ClientProduct,
    OrderMessage,
    Complaint,
    PasswordResetCode
};