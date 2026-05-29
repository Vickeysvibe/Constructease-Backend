import express from "express";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import { getClientsWithPayments, getLabourAttendanceSummary, getMaterialCounts, getPaymentsDetails } from "../Controllers/dashboard.controller.js";

const router = express.Router();

router.get('/clientdetail',getClientsWithPayments);
router.get('/labour',getLabourAttendanceSummary);
router.get('/payement',getPaymentsDetails);
router.get('/material',getMaterialCounts)


export default router;
