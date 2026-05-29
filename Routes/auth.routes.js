import express from "express";
import {login}  from "../Controllers/auth.controller.js";
import { checkin, checkout } from "../Controllers/checkin.controller.js";
import { verifyToken } from "../Middlewares/auth.middleware.js";

const router = express.Router();

router.post("/login", login);
router.post("/checkin",verifyToken,checkin);
router.post("/checkout",verifyToken,checkout);

export default router;
