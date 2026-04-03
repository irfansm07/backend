const mongoose = require('mongoose');
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
const OrderMessage = mongoose.model('OrderMessage2', orderMessageSchema);

const doc = new OrderMessage({
    orderId: '123',
    senderId: '456',
    senderRole: 'client',
    message: 'test message',
    mediaUrl: null,
    mediaType: null,
    mediaName: null,
});
const err = doc.validateSync();
console.log('Validation Error:', err ? err.message : 'NONE');
