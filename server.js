// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import connectDB from "./Configs/mongoDbConfig.js";
import { routing } from "./routes.js"; // Import the routing function
import fileUpload from "express-fileupload";
import loggerMiddleware from "./Middlewares/logger.middleware.js"



dotenv.config();

const app = express();

app.use(loggerMiddleware);


// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
    fileUpload({
      useTempFiles: false,
      tempFileDir: "/tmp/",
    })
  );
  

// Connect to DB
connectDB();

// Simple API status route
app.get("/", (req, res) => res.send("API is running perfectly!"));
// Use the routing function to register routes
routing(app); // Now this registers all routes

// Listen on a port

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));