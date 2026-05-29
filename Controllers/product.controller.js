import Products from "../Models/Products.model.js";
import PurchaseOrders from "../Models/PurchaseOrders.model.js";
import XLSX from "xlsx";
import mongoose from "mongoose";


export const createProduct = async (req, res) => {
  try {
    const { name, description, category, unit } = req.body;
    const { siteId } = req.query;
    console.log(req.body);
    console.log(req.query);

    if (!name || !description || !category || !unit || !siteId) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingProduct = await Products.findOne({ name, siteId });

    if (existingProduct) {
      return res.status(400).json({
        message: "Product with this name already exists in this site",
      });
    }

    const newProduct = new Products({
      name,
      description,
      category,
      unit,
      siteId,
    });
    await newProduct.save();

    return res.status(201).json({
      message: "Product created successfully",
      product: newProduct,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

export const updateProduct = async (req, res) => {
  try {
    const { productId } = req.params;
    const updatedData = req.body;
    const { siteId } = req.query;
    updatedData.siteId = siteId;
    const updatedProduct = await Products.findByIdAndUpdate(
      productId,
      updatedData,
      { new: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.status(200).json({
      message: "Product updated successfully",
      product: updatedProduct,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
      redirectUrl: "http://.....",
    });
  }
};

export const getAllProducts = async (req, res) => {
  try {
    const { siteId } = req.query;
    let products;

    if (siteId) {
      products = await Products.find({ siteId }).populate("siteId", "siteName");
    } else {
      products = await Products.find().populate("siteId", "name");
    }

    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({
      message: error.message,
      redirectUrl: "http://.....",
    });
  }
};

export const getProductById = async (req, res) => {
  try {
    const { productId } = req.params;
    const product = await Products.findById(productId).populate(
      "siteId",
      "name"
    );

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({
      message: error.message,
      redirectUrl: "http://.....",
    });
  }
};

export const uploadExcel = async (req, res) => {
  try {
    const { siteId } = req.query;

    if (!siteId) {
      return res
        .status(400)
        .json({ error: "Site ID is required in the query" });
    }
    if (!req.files || !req.files.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const file = req.files.file;
    const workbook = XLSX.read(file.data, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(sheet);

    const products = [];

    jsonData.forEach((row) => {
      const { name, description, category, unit } = row;
      if (name && description && category && unit) {
        products.push({ name, description, category, unit, siteId });
      }
    });

    if (products.length === 0) {
      return res.status(400).json({ error: "No valid data found in the file" });
    }

    await Products.insertMany(products);
    res
      .status(200)
      .json({ message: "Products uploaded successfully", products });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      message: error.message,
      redirectUrl: "http://.....",
    });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const { productId } = req.params;
    const { siteId } = req.query;
    const existingPurchaseOrder = await PurchaseOrders.findOne({
      siteId: siteId,
      "order.productId": productId,
    });

    if (existingPurchaseOrder) {
      return res.status(400).json({
        error:
          "Cannot delete product because it is associated with a purchase order.",
      });
    }

    const deletedProduct = await Products.findByIdAndDelete(productId);

    if (!deletedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.status(200).json({
      message: "Product deleted successfully",
      product: deletedProduct,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: error.message, redirectUrl: "http://....." });
  }
};

export const downloadProduct = async (req, res) => {
  try {
    const { productsIds } = req.body;
    const { siteId } = req.query;

    if (!siteId) {
      return res
        .status(400)
        .json({ error: "Site ID is required in the query" });
    }

    if (
      !productsIds ||
      !Array.isArray(productsIds) ||
      productsIds.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "Products IDs are required in the request body" });
    }

    const product = await Products.find({ _id: { $in: productsIds }, siteId });

    if (product.length === 0) {
      return res
        .status(404)
        .json({ error: "No products found for the provided IDs and site ID" });
    }

    const jsonData = product.map(({ name, description, category, unit }) => ({
      name,
      description,
      category,
      unit,
    }));

    const worksheet = XLSX.utils.json_to_sheet(jsonData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Products");

    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="products.xlsx"'
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.send(buffer);
  } catch (error) {
    res.status(500).json({
      message: error.message,
      redirectUrl: "http://.....",
    });
  }
};

export const deleteMultipleProducts = async (req, res) => {
  try {
    const { productIds } = req.body;
    const { siteId } = req.query;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: "Invalid productIds list" });
    }

    const productsInPurchaseOrders = await PurchaseOrders.distinct(
      "order.productId",
      {
        siteId: siteId,
        "order.productId": { $in: productIds },
      }
    );

    const productsToDelete = productIds.filter(
      (id) => !productsInPurchaseOrders.includes(id)
    );

    if (productsToDelete.length === 0) {
      return res.status(400).json({
        error:
          "All selected products are associated with a purchase order and cannot be deleted.",
      });
    }

    const deletedProducts = await Products.deleteMany({
      _id: { $in: productsToDelete },
      siteId,
    });

    res.status(200).json({
      message: "Products deleted successfully.",
      deletedCount: deletedProducts.deletedCount,
      skippedProducts: productsInPurchaseOrders,
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: error.message, redirectUrl: "http://....." });
  }
};


export const getProductNamesBySiteId = async (req, res) => {
    try {
        const { siteId } = req.query;

        // Validate siteId
        if (!siteId || !mongoose.Types.ObjectId.isValid(siteId)) {
            return res.status(400).json({ success: false, message: "Invalid or missing siteId." });
        }

        // Fetch product names for the given siteId
        const products = await Products.find({ siteId }, { name: 1, _id: 0 }); // Only fetch the 'name' field

        if (products.length === 0) {
            return res.status(404).json({ success: false, message: "No products found for the given siteId." });
        }

        // Extract product names from the result
        const productNames = products.map(product => product.name);

        // Return the product names
        res.status(200).json({ success: true, data: productNames });
    } catch (error) {
        console.error("Error fetching product names:", error);
        res.status(500).json({ success: false, message: "An error occurred while fetching product names.", error });
    }
};