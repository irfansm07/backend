require('dotenv').config();
const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  content: { type: String, required: true },
}, { strict: false });

const Post = mongoose.models.Post || mongoose.model('Post', PostSchema);

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const irfanPosts = await Post.find({ userId: '5448b626-e1b1-4f62-b121-dc41f1435754' }).lean();
  console.log(`Found ${irfanPosts.length} posts by irfansm (5448b626-e1b1-4f62-b121-dc41f1435754).`);
  irfanPosts.forEach(p => console.log(`- Post: ${p._id}, content: ${p.content}`));

  await mongoose.disconnect();
}

check().catch(console.error);
