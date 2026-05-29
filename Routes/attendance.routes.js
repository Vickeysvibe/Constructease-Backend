import express from "express";
import {
  attendance,
  deleteTodayAttendance,
  getLabours,
  getSupervisors,
  todayAttendance,
  updateShift,
} from "../Controllers/labourAttendance.controller.js";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import { paymentReport } from "../Controllers/paymentReport.controller.js";
import verifySite from "../Middlewares/verifySite.middleware.js";
import onlyForEngineers from "../Middlewares/onlyForEngineers.middleware.js";

const router = express.Router();

router.get("/labours", verifyToken,verifySite, getLabours);
router.get("/supervisors", verifyToken,verifySite,onlyForEngineers, getSupervisors);
router.post("/labouratt", verifyToken,verifySite, attendance);
router.put("/updateshift", verifyToken,verifySite, updateShift);
router.get("/todayAttendance",verifyToken,verifySite,todayAttendance);
router.delete("/deleteTodayAttendance",verifyToken,verifySite,deleteTodayAttendance);

export default router;
