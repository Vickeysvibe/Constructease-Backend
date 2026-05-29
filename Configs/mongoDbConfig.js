import mongoose from "mongoose";

const connectDB = async () => {
  try {
    console.log("MongoDB URI:", process.env.MONGODB_URL);
    await mongoose.connect(process.env.MONGODB_URL);
    const connection = mongoose.connection;
    console.log("connected");
    /* connection.on("connected", () => {
      console.log("Connected to DB");
    }); */

    connection.on("error", (error) => {
      console.log("Something is wrong in MongoDB", error);
    });
  } catch (error) {
    console.log("Something is wrong", error);
  }
};

export default connectDB;