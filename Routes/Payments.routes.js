import express from "express";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import {
  createPayment,
  deletePayment,
  editPayment,
  getPayments,
} from "../Controllers/payments.controller.js";
import verifySite from "../Middlewares/verifySite.middleware.js";
import { downloadGeneralExpenses } from "../Controllers/materialwiseReport.controller.js";

const router = express.Router();

router.get("/getPayments", verifyToken,verifySite,getPayments);
router.post("/createPayment", verifyToken, verifySite,createPayment);
router.put("editPayment/:id", verifyToken, verifySite,editPayment);
router.delete("/deletePayment/:id",verifyToken,verifySite,deletePayment);
router.get("/downloadGeneralExpenses", verifyToken, downloadGeneralExpenses);
export default router;
