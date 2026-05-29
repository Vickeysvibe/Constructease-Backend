import express from "express";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import {
  createColumns,
  createWorks,
  deleteColumn,
  deleteWork,
  editColumn,
  editWork,
  getAllWorks,
} from "../Controllers/works.controller.js";

const router = express.Router();

router.get("/getAllWorks", verifyToken, getAllWorks);
router.post("/create", verifyToken, createWorks);
router.post("/createColums", verifyToken, createColumns);
router.put("/editColumn", verifyToken, editColumn);
router.put("/edit/:workId", verifyToken, editWork);
router.delete("/delete/:workId", verifyToken, deleteWork);
router.delete("/deleteColumn", verifyToken, deleteColumn);

export default router;
