import express from "express";
import { downloadExcelReport } from "../Controllers/download.controller.js";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import verifySite from "../Middlewares/verifySite.middleware.js";

const router = express.Router();

router.post("/file", verifyToken,verifySite,downloadExcelReport);

export default router;