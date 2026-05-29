import Site from "../Models/Sites.model.js";
import dotenv from "dotenv";

dotenv.config();

const verifySite = async (req, res, next) => {
  try {
    const { supervisorId, engineerId, role, scope } = req.user;
    const { siteId } = req.query;
    if (!siteId) {
      return res.status(400).json({ error: "Site ID is required" });
    }
    if (siteId == "outer") return next();

    const site = await Site.findById(siteId);
    if (!site) {
      return res.status(404).json({ error: "Site not found" });
    }

    const isEngineer = site.engineerId.equals(engineerId);
    const isSupervisor = site.supervisorsId.some((supervisor) =>
      supervisor.equals(supervisorId)
    );

    if (isEngineer) {
      return next();
    }

    if (scope === "local") {
      if (isEngineer && isSupervisor) {
        return next();
      } else {
        return res.status(403).json({
          error:
            "Forbidden: Local users must be explicitly assigned as both engineer and supervisor",
        });
      }
    }

    if (scope === "global") {
      if (isEngineer) {
        return next();
      }
    }

    return res.status(403).json({ error: "Forbidden: Invalid access" });
  } catch (error) {
    console.error("Verify Site Error:", error.message);
    res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
};

export default verifySite;
