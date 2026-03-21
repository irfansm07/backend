require('dotenv').config();
const mongoose = require('mongoose');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  // Directly query the collection
  const products = await mongoose.connection.collection('clientproducts').find().toArray();
  console.log("CLIENT PRODUCTS IN DB:", JSON.stringify(products, null, 2));
  
  process.exit(0);
}

test().catch(console.error);
