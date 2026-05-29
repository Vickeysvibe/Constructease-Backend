import express from "express";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import {
  createMaterialInward,
  editMaterial,
  getAllMaterialInwards,
  getMaterialInwardById,
  getMaterials,
} from "../Controllers/materials.controller.js";

const router = express.Router();

router.get("/getMIBySite/:siteId", verifyToken, getAllMaterialInwards);
router.get("/getMI/:MIid", verifyToken, getMaterialInwardById);
router.get("/getMaterials/:siteId", verifyToken, getMaterials);
router.put("/editUse/:matId", verifyToken, editMaterial);

router.post("/createMI", verifyToken, createMaterialInward);
export default router;
