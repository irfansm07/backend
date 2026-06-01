require('dotenv').config();
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PostSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  content: { type: String, required: true },
}, { strict: false });

const Post = mongoose.models.Post || mongoose.model('Post', PostSchema);

async function inspect() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const allPosts = await Post.find().lean();
  console.log(`Total posts in MongoDB: ${allPosts.length}`);

  const uniqueUserIds = [...new Set(allPosts.map(p => p.userId))];
  console.log(`Unique userIds: ${uniqueUserIds.length}`, uniqueUserIds);

  const { data: users, error } = await supabase.from('users').select('id, username');
  if (error) {
    console.error('Supabase error:', error);
  } else {
    console.log(`Users in Supabase: ${users.length}`);
    users.forEach(u => console.log(`- ${u.username} (${u.id})`));

    const activeUserIds = new Set(users.map(u => u.id));
    const orphanedPosts = allPosts.filter(p => !activeUserIds.has(p.userId));
    console.log(`Orphaned posts: ${orphanedPosts.length}`);
  }

  await mongoose.disconnect();
}

inspect().catch(console.error);
