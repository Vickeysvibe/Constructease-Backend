import express from "express";
import { createVendor, updateVendor, getAllVendors, getVendorById, uploadExcel, deleteVendor, downloadVendor, deleteMultipleVendors } from "../Controllers/vendor.controller.js";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import verifySite from "../Middlewares/verifySite.middleware.js";

const router = express.Router();

router.post("/createvendor",verifyToken, createVendor);
router.put("/update-vendor/:vendorId",verifyToken, updateVendor);
router.get("/getAllvendor", getAllVendors);
router.get("/getvendorById/:vendorId",verifyToken, getVendorById);
router.post("/upload-vendor",verifyToken, uploadExcel);
router.delete("/deletevendors/:vendorId",verifyToken, deleteVendor);
router.post("/downloadvendor",verifyToken,downloadVendor)
router.delete("/deleteseclected",verifyToken,verifySite,deleteMultipleVendors)


export default router;
