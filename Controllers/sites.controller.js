import SitesModel from "../Models/Sites.model.js";
import Supervisors from "../Models/Supervisors.model.js";


export const createSite = async (req, res) => {
  try {
    const { engineerId } = req.user;
    const { siteName, siteAddress } = req.body;
    console.log(req.body)
    if (!siteName || !siteAddress)
      return res.status(400).json({
        message: "Please provide all the required fields",
      });
    const site = await SitesModel.create({
      siteName,
      siteAddress,
      engineerId,
    });
    await site.save();
    res.status(200).json({
      message: "Site created successfully",
      site,
    });
  } catch (error) {
    console.log(error)
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

//edit site
export const editSite = async (req, res) => {
  try {
    const { siteId } = req.params;
    const { siteName, siteAddress } = req.body;
    if (!siteName || !siteAddress)
      return res.status(400).json({
        message: "Please provide all the required fields",
      });
    const site = await SitesModel.findOneAndUpdate(
      { _id: siteId },
      {
        siteName,
        siteAddress,
      }
    );
    res.status(200).json({
      message: "Site created successfully",
      site,
    });
  } catch (error) {
    res.status(500).json({
      message: "Internal server error",
      error,
    });
  }
};

export const getAllsite = async (req, res) => {
  try {
    const { role } = req.user; 
    const userId = req.user.supervisorId || req.user.engineerId;

    let sites;
    console.log(role)
    console.log(req.user)

    if (role === "Engineer") {
      sites = await SitesModel.find({ engineerId: userId });
      console.log(sites)
    } else if (role === "Supervisor") {
      const supervisor = await Supervisors.findById(userId);

      if (!supervisor) {
        return res.status(404).json({ message: "Supervisor not found" });
      }

      const { role: supervisorRole } = supervisor;

      if (supervisorRole === "local") {
        sites = await SitesModel.find({ supervisorsId: userId });
      } else if (supervisorRole === "global") {
        sites = await SitesModel.find({ engineerId: supervisor.engineerId });
      }
    } else {
      return res.status(403).json({ message: "Access denied" });
    }

    res.status(200).json({
      message: "Sites fetched successfully",
      sites,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

