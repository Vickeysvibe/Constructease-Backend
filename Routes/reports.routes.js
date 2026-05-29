import express from "express";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import { laborReport, laborReport_summary } from "../Controllers/reports.controller.js";
import { paymentReport } from "../Controllers/paymentReport.controller.js";
import { ComprehensiveReport, materialSummary, overallMaterialReport, SingleVendorReport } from '../Controllers/materialwiseReport.controller.js';
import {getSubCategoryCounts} from '../Controllers/labourAttendance.controller.js'



const router = express.Router();

router.post("/labourReport", verifyToken, laborReport);
router.post("/paymentreport",verifyToken,paymentReport);
router.post('/laborReportsummary',verifyToken,laborReport_summary);
router.post('/vendor-report', verifyToken,SingleVendorReport);
router.post('/overall-material',verifyToken, overallMaterialReport);
router.get("/labourlist",verifyToken,getSubCategoryCounts);
router.post("/materialsummary",verifyToken,materialSummary);
router.post("/comprehensive",verifyToken,ComprehensiveReport);

export default router;
