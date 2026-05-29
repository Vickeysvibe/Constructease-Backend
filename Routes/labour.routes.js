import express from "express";
import {
  createLabour,
  updateLabour,
  getAllLabours,
  getLabourById,
  uploadExcel,
  deleteLabour,
  downloadLabour,
  deleteMultipleLabours,
} from "../Controllers/labour.controller.js";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import verifySite from "../Middlewares/verifySite.middleware.js";

const router = express.Router();

router.post("/create", verifyToken, verifySite, createLabour);
router.put("/update-labour/:labourId", verifyToken, verifySite, updateLabour);
router.get("/getAll", verifyToken, verifySite, getAllLabours);
router.get("/getById/:labourId", verifyToken, verifySite, getLabourById);
router.post("/upload", verifyToken, verifySite, uploadExcel);
router.delete("/delete/:labourId", verifyToken, verifySite, deleteLabour);
router.post('/downloadlabour',verifyToken,verifySite,downloadLabour);
router.delete('/deletemultiplelabour',verifyToken,verifySite,deleteMultipleLabours)


export default router;
