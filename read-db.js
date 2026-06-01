require('dotenv').config();
const mongoose = require('mongoose');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');
  const OrderMessage = mongoose.models.OrderMessage || mongoose.model('OrderMessage', new mongoose.Schema({
    orderId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    senderRole: { type: String, enum: ['admin', 'user', 'client'], required: true },
    message: { type: String, required: true },
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video', 'audio', 'pdf', 'document', null], default: null },
    mediaName: { type: String, default: null },
    read: { type: Boolean, default: false }
  }, { timestamps: true }));

  const messages = await OrderMessage.find({ orderId: 'order_5X8xu8T3A9vnap' }).lean();
  console.log('Found messages:', messages.length);
  console.log(messages);

  mongoose.disconnect();
}
test().catch(console.error);
