import express from "express";
import { createSite, editSite, getAllsite } from "../Controllers/sites.controller.js";
import { verifyToken } from "../Middlewares/auth.middleware.js";

const router = express.Router();

router.post("/create", verifyToken, createSite);
router.put("/:siteId/edit", verifyToken, editSite);
router.get("/getallsites",verifyToken,getAllsite)
// router.delete("/:siteId", editSite); delete has more logic than expected

export default router;
