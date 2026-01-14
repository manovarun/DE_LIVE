const mongoose = require('mongoose');
const colors = require('colors');

mongoose.set('strictQuery', false);

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 100000,
      socketTimeoutMS: 450000,
      connectTimeoutMS: 300000,
    });
    console.log(
      `MongoDB Connected: ${conn.connection.host}:${conn.connection.port}/${conn.connection.name}`
        .cyan.underline
    );
  } catch (error) {
    console.log(`Error: ${error.message}`.red.underline.bold);
    throw error;
  }
};

module.exports = connectDB;
