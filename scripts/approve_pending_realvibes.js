// One-time migration: approve all pending RealVibes
// Run: node scripts/approve_pending_realvibes.js
// Requires env var MONGODB_URI

const mongoose = require('mongoose');

const realVibeSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    caption: { type: String, default: '' },
    mediaUrl: { type: String, required: true },
    mediaPublicId: { type: String },
    mediaType: { type: String, enum: ['image', 'video'], required: true },
    planType: { type: String, enum: ['noble', 'royal'], required: true },
    visibility: { type: String, enum: ['public', 'college'], default: 'public' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    rejectionReason: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedByAdmin: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: true },
    brandLink: { type: String, default: null },
    brandLinkType: { type: String, default: 'website' }
}, { timestamps: true });

async function run() {
    await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
    });
    console.log('✅ Connected to MongoDB');

    const RealVibe = mongoose.model('RealVibe', realVibeSchema);
    const result = await RealVibe.updateMany(
        { status: 'pending', expiresAt: { $gt: new Date() } },
        { $set: { status: 'approved', reviewedAt: new Date(), reviewedByAdmin: 'migration' } }
    );

    console.log(`✅ Approved ${result.matchedCount} pending RealVibes (${result.modifiedCount} modified)`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});