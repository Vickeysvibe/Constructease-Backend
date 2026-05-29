import express from "express";
import {
  createProduct,
  updateProduct,
  getAllProducts,
  getProductById,
  uploadExcel,
  deleteProduct,
  downloadProduct,
  deleteMultipleProducts,
  getProductNamesBySiteId,
} from "../Controllers/product.controller.js";
import { verifyToken } from "../Middlewares/auth.middleware.js";
import verifySite from "../Middlewares/verifySite.middleware.js";



const router = express.Router();

router.post("/create", verifyToken, createProduct); //tested
router.put("/update/:productId", verifyToken, updateProduct); //tested
router.get("/getAll", verifyToken, getAllProducts);
router.get("/getById/:productId", verifyToken, getProductById);
router.post("/upload", verifyToken, uploadExcel);
router.delete("/deleteproduct/:productId", verifyToken, deleteProduct);
router.post('/downloadproduct',verifyToken,verifySite,downloadProduct);
router.delete('/delete-selectedproducts',verifyToken,verifySite,deleteMultipleProducts);
router.get('/productlist',verifyToken,getProductNamesBySiteId)


export default router;
