import express from "express";
import EngineersModel from "../Models/Engineers.model.js";

const router = express.Router();

router.post("/createEngineer", async (req, res) => {
  try {
    const {
      name,
      companyName,
      companyLogo,
      companyDesc,
      email,
      phoneNo,
      address,
      password,
    } = req.body;
    if (
      !name ||
      !companyName ||
      !companyLogo ||
      !companyDesc ||
      !email ||
      !phoneNo ||
      !address ||
      !password
    ) {
      return res.status(400).json({
        message: "Please provide all the required fields",
      });
    }
    const engineer = await EngineersModel.create({
      name,
      companyName,
      companyLogo,
      companyDesc,
      email,
      phoneNo,
      address,
      password,
    });
    await engineer.save();
    res.status(200).json({
      message: "Engineer created successfully",
      engineer,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      message: "Internal server error",
      error,
    });
  }
});

router.get("create");

export default router;
