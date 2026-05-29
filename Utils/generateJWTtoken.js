import jwt from "jsonwebtoken";
import Supervisor from "../Models/Supervisors.model.js"

const generateJwt = async (user, role) => {
  try {
    let scope = "local"; // Default scope is local

    if (role === "Supervisor") {
      // Fetch the supervisor from DB and check their role
      const supervisor = await Supervisor.findById(user._id);
      if (supervisor && supervisor.role === "global") {
        scope = "global";
      }
    }

    const payload = {
      engineerId: role === "Engineer" ? user._id : user.engineerId,
      supervisorId: role === "Supervisor" ? user._id : null,
      role: role, // Store role from DB
      scope: scope, // Store scope (global/local)
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "12h" });
    return token;
  } catch (error) {
    console.error("Error generating JWT:", error.message);
    throw error;
  }
};

export default generateJwt;
