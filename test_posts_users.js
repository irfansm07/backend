require('dotenv').config();
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Define Post schema
const PostSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { strict: false });

const Post = mongoose.models.Post || mongoose.model('Post', PostSchema);

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const posts = await Post.find().sort({ createdAt: -1 }).limit(10).lean();
  console.log(`Found ${posts.length} posts.`);

  if (posts.length > 0) {
    const userIds = [...new Set(posts.map(p => p.userId))];
    console.log('Unique userIds from posts in Mongo:', userIds);

    const { data: users, error } = await supabase.from('users').select('id, username, email').in('id', userIds);
    if (error) {
      console.error('Supabase query error:', error);
    } else {
      console.log('Corresponding Supabase users found:', users);
      const userMap = {};
      users.forEach(u => { userMap[u.id] = u; });

      posts.forEach(p => {
        console.log(`Post ID: ${p._id}, Mongo userId: ${p.userId}, Resolved User:`, userMap[p.userId] || 'NOT FOUND');
      });
    }
  }

  await mongoose.disconnect();
}

check().catch(console.error);
