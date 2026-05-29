import express from "express";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import EngineersModel from "../Models/Engineers.model.js";
import SitesModel from "../Models/Sites.model.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { siteId } = req.query;
    const eng = await SitesModel.findById(siteId).populate("engineerId");
    const data = {
      companyName: eng.engineerId.companyName,
      companyLogo: eng.engineerId.companyLogo,
      companyDesc: eng.engineerId.companyDesc,
      email: eng.engineerId.email,
    };
    res.status(200).json(data);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
