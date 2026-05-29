import express from "express";
import {
  createSupervisor,
  updateSupervisor,
  getSupervisorsBySite,
  getSupervisorById,
  uploadExcel,
  deleteSupervisor,
  getGlobalSupervisors,
  createGloablSupervisor,
  downloadSupervisors,
  deleteMultipleSupervisors,
} from "../Controllers/supervisor.controller.js";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import onlyForEngineers from "../Middlewares/onlyForEngineers.middleware.js";


const router = express.Router();

router.post("/create", verifyToken, createSupervisor);

router.post("/create-global", verifyToken, createGloablSupervisor);

router.put(
  "/update/:supervisorId",
  verifyToken,
  onlyForEngineers,
  updateSupervisor
);

router.get("/getsuppervisors", verifyToken, getSupervisorsBySite);
router.get("/getGlobalSupervisors", verifyToken, getGlobalSupervisors);

router.get(
  "/getbyid/:supervisorId",
  verifyToken,
  onlyForEngineers,
  getSupervisorById
);

router.post("/upload", verifyToken, onlyForEngineers, uploadExcel);

router.delete(
  "/deletesupervisor/:supervisorId",
  verifyToken,
  onlyForEngineers,
  deleteSupervisor
);
router.post('/downloadsupervisors',verifyToken,onlyForEngineers,downloadSupervisors);
router.delete("/delete-selectedsupervisor",verifyToken,onlyForEngineers,deleteMultipleSupervisors);

export default router;
