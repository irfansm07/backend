require('dotenv').config();
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Define Schemas
const PostSchema = new mongoose.Schema({ userId: String }, { strict: false });
const PostLikeSchema = new mongoose.Schema({ postId: mongoose.Schema.Types.ObjectId, userId: String }, { strict: false });
const PostCommentSchema = new mongoose.Schema({ postId: mongoose.Schema.Types.ObjectId, userId: String }, { strict: false });
const PostShareSchema = new mongoose.Schema({ postId: mongoose.Schema.Types.ObjectId, userId: String }, { strict: false });

const RealVibeSchema = new mongoose.Schema({ userId: String }, { strict: false });
const RealVibeLikeSchema = new mongoose.Schema({ vibeId: mongoose.Schema.Types.ObjectId, userId: String }, { strict: false });
const RealVibeCommentSchema = new mongoose.Schema({ vibeId: mongoose.Schema.Types.ObjectId, userId: String }, { strict: false });

const Post = mongoose.models.Post || mongoose.model('Post', PostSchema);
const PostLike = mongoose.models.PostLike || mongoose.model('PostLike', PostLikeSchema);
const PostComment = mongoose.models.PostComment || mongoose.model('PostComment', PostCommentSchema);
const PostShare = mongoose.models.PostShare || mongoose.model('PostShare', PostShareSchema);

const RealVibe = mongoose.models.RealVibe || mongoose.model('RealVibe', RealVibeSchema);
const RealVibeLike = mongoose.models.RealVibeLike || mongoose.model('RealVibeLike', RealVibeLikeSchema);
const RealVibeComment = mongoose.models.RealVibeComment || mongoose.model('RealVibeComment', RealVibeCommentSchema);

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('CONNECTED TO MONGO');

  // 1. Fetch active Supabase users
  const { data: users, error } = await supabase.from('users').select('id, username');
  if (error) throw error;
  console.log(`Active Supabase users found: ${users.length}`);
  users.forEach(u => console.log(`  - ${u.username} (${u.id})`));
  const activeUserIds = new Set(users.map(u => u.id));

  // 2. Cleanup Posts
  const allPosts = await Post.find().lean();
  const postsToDelete = allPosts.filter(p => !activeUserIds.has(p.userId));
  console.log(`\nPOSTS: Total=${allPosts.length}, Orphaned=${postsToDelete.length}`);
  if (postsToDelete.length > 0) {
    const postDelResult = await Post.deleteMany({ _id: { $in: postsToDelete.map(p => p._id) } });
    console.log(`  Deleted ${postDelResult.deletedCount} orphaned posts.`);
  }

  // Fetch remaining active posts for cascading deletion
  const remainingPosts = await Post.find().lean();
  const activePostIds = new Set(remainingPosts.map(p => p._id.toString()));

  // 3. Cleanup PostLikes
  const allLikes = await PostLike.find().lean();
  const likesToDelete = allLikes.filter(l => !activeUserIds.has(l.userId) || !activePostIds.has(l.postId?.toString()));
  console.log(`POST LIKES: Total=${allLikes.length}, Orphaned=${likesToDelete.length}`);
  if (likesToDelete.length > 0) {
    const delResult = await PostLike.deleteMany({ _id: { $in: likesToDelete.map(l => l._id) } });
    console.log(`  Deleted ${delResult.deletedCount} orphaned post likes.`);
  }

  // 4. Cleanup PostComments
  const allComments = await PostComment.find().lean();
  const commentsToDelete = allComments.filter(c => !activeUserIds.has(c.userId) || !activePostIds.has(c.postId?.toString()));
  console.log(`POST COMMENTS: Total=${allComments.length}, Orphaned=${commentsToDelete.length}`);
  if (commentsToDelete.length > 0) {
    const delResult = await PostComment.deleteMany({ _id: { $in: commentsToDelete.map(c => c._id) } });
    console.log(`  Deleted ${delResult.deletedCount} orphaned post comments.`);
  }

  // 5. Cleanup PostShares
  const allShares = await PostShare.find().lean();
  const sharesToDelete = allShares.filter(s => !activeUserIds.has(s.userId) || !activePostIds.has(s.postId?.toString()));
  console.log(`POST SHARES: Total=${allShares.length}, Orphaned=${sharesToDelete.length}`);
  if (sharesToDelete.length > 0) {
    const delResult = await PostShare.deleteMany({ _id: { $in: sharesToDelete.map(s => s._id) } });
    console.log(`  Deleted ${delResult.deletedCount} orphaned post shares.`);
  }

  // 6. Cleanup RealVibes
  const allVibes = await RealVibe.find().lean();
  const vibesToDelete = allVibes.filter(v => !activeUserIds.has(v.userId));
  console.log(`\nREAL VIBES: Total=${allVibes.length}, Orphaned=${vibesToDelete.length}`);
  if (vibesToDelete.length > 0) {
    const delResult = await RealVibe.deleteMany({ _id: { $in: vibesToDelete.map(v => v._id) } });
    console.log(`  Deleted ${delResult.deletedCount} orphaned real vibes.`);
  }

  const remainingVibes = await RealVibe.find().lean();
  const activeVibeIds = new Set(remainingVibes.map(v => v._id.toString()));

  // 7. Cleanup RealVibeLikes
  const allVibeLikes = await RealVibeLike.find().lean();
  const vibeLikesToDelete = allVibeLikes.filter(vl => !activeUserIds.has(vl.userId) || !activeVibeIds.has(vl.vibeId?.toString()));
  console.log(`REAL VIBE LIKES: Total=${allVibeLikes.length}, Orphaned=${vibeLikesToDelete.length}`);
  if (vibeLikesToDelete.length > 0) {
    const delResult = await RealVibeLike.deleteMany({ _id: { $in: vibeLikesToDelete.map(vl => vl._id) } });
    console.log(`  Deleted ${delResult.deletedCount} orphaned real vibe likes.`);
  }

  // 8. Cleanup RealVibeComments
  const allVibeComments = await RealVibeComment.find().lean();
  const vibeCommentsToDelete = allVibeComments.filter(vc => !activeUserIds.has(vc.userId) || !activeVibeIds.has(vc.vibeId?.toString()));
  console.log(`REAL VIBE COMMENTS: Total=${allVibeComments.length}, Orphaned=${vibeCommentsToDelete.length}`);
  if (vibeCommentsToDelete.length > 0) {
    const delResult = await RealVibeComment.deleteMany({ _id: { $in: vibeCommentsToDelete.map(vc => vc._id) } });
    console.log(`  Deleted ${delResult.deletedCount} orphaned real vibe comments.`);
  }

  console.log('\nCLEANUP COMPLETED SUCCESSFULLY!');
  await mongoose.disconnect();
}

run().catch(console.error);
