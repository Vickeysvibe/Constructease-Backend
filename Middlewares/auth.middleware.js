import EngineersModel from "../Models/Engineers.model.js";
import SupervisorsModel from "../Models/Supervisors.model.js";
import jwt from "jsonwebtoken";
export const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ message: "No token provided", redirect: true });
    }

    const token = authHeader.split(" ")[1];

    // Check if token exists after splitting
    if (!token) {
      return res
        .status(401)
        .json({ message: "Malformed token", redirect: true });
    }
    // Verify the token using the secret key
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Find the user using the decoded userId from the token payload
    const user =
      decoded.role === "Engineer"
        ? await EngineersModel.findById(decoded.engineerId)
        : await SupervisorsModel.findById(decoded.supervisorId);
    // If no user found, return a 404 error
    if (!user) {
      return res
        .status(404)
        .json({ message: "User not found", redirect: true });
    }

    // Attach the user to the request object for further use
    req.user = decoded;

    // Proceed to the next middleware or route handler
    next();
  } catch (error) {
    console.error(error);

    // Check for specific JWT errors
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token", redirect: true });
    } else if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired", redirect: true });
    }

    // Return a generic internal server error for other errors
    res.status(500).json({ message: "Internal server error" });
  }
};
