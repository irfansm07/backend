require('dotenv').config();
const { connectMongo, ClientProduct } = require('./config/mongodb');

connectMongo().then(async () => {
    try {
        const res = await ClientProduct.deleteMany({});
        console.log(`Deleted ${res.deletedCount} mock products`);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
});
