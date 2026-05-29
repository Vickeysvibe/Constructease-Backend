import MaterialsModel from "../Models/Materials.model.js";
import ProductsModel from "../Models/Products.model.js";
import PurchaseOrdersModel from "../Models/PurchaseOrders.model.js";
import PurchaseReturnsModel from "../Models/PurchaseReturns.model.js";
import SitesModel from "../Models/Sites.model.js";
import VendorsModel from "../Models/Vendors.model.js";
import fs from "fs";
// import puppeteer from "puppeteer";
import Handlebars from "handlebars";
import MaterialInwards from "../Models/MaterialInwads.model.js";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";
import pdf from "html-pdf";
import { model } from "mongoose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Format the date

const generateHTML = (templatePath, data) => {
  const absolutePath = path.resolve(__dirname, templatePath);
  console.log("Resolved template path:", absolutePath); // Debugging

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Template file not found: ${absolutePath}`);
  }
  // Register Handlebars helpers here
  Handlebars.registerHelper("formatDate", function (date) {
    if (!date) return "";

    // Convert date to Date object if it's a string
    const parsedDate = new Date(date);
    if (isNaN(parsedDate)) return "Invalid Date";

    // Format date to DD/MM/YYYY
    return parsedDate.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  });

  Handlebars.registerHelper("multiply", function (a, b) {
    if (typeof a === "number" && typeof b === "number") {
      return (a * b).toFixed(2); // Multiplying numbers and fixing to 2 decimal places
    }
    return "Invalid";
  });
  const templateSource = fs.readFileSync(absolutePath, "utf8");
  const template = Handlebars.compile(templateSource);
  return template(data);
};

const generatePDFBuffer = async (html) => {
  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint:
        "wss://chrome.browserless.io?token=Rk2roxKXuhbJgb130e3a8de6bd4a4e8a1414288206", // Replace with your actual API key
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });

    await browser.close();
    return pdfBuffer;
  } catch (error) {
    console.error("Error generating PDF:", error);
    throw new Error("PDF generation failed");
  }
};

// get all purchase orders for the site
export const getAllPos = async (req, res) => {
  try {
    const { siteId, mi, pr } = req.query;
    console.log(siteId, mi, pr);

    if (!siteId) {
      return res.status(400).json({ message: "Site ID is required" });
    }

    const pos = await PurchaseOrdersModel.find({ siteId })
      .populate("vendorId", "name")
      .lean();

    let data = [];

    if (mi) {
      const MIS = await MaterialInwards.find({ siteId }).select("POid");
      const miPOids = new Set(MIS.map((m) => m.POid.toString()));

      data = pos
        .filter((po) => !miPOids.has(po._id.toString()))
        .map((po) => ({
          POid: po._id,
          vendorName: po?.vendorId?.name || "unknown",
          date: po.date,
          transport: po.transport,
          orderCount: po.order.length,
        }));

      return res.status(200).json(data);
    } else if (pr) {
      const MS = await MaterialsModel.find({ siteId }).select("POid");
      const prPOids = new Set(MS.map((m) => m?.POid?.toString()));
      data = pos
        .filter((po) => prPOids.has(po?._id?.toString()))
        .map((po) => ({
          POid: po._id,
          vendorName: po?.vendorId?.name || "unknown",
          date: po.date,
          transport: po.transport,
          orderCount: po.order.length,
        }));
      return res.status(200).json(data);
    }

    data = pos.map((po) => ({
      POid: po._id,
      vendorName: po?.vendorId?.name || "unknown",
      date: po.date,
      transport: po.transport,
      orderCount: po.order.length,
    }));

    res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching purchase orders:", error);
    res
      .status(500)
      .json({ message: "Something went wrong", error: error.message });
  }
};

// get all purchase returns for the site
export const getAllPrs = async (req, res) => {
  try {
    const { siteId } = req.query;
    const prs = await PurchaseReturnsModel.find({ siteId })
      .populate({
        path: "POid",
        populate: {
          path: "vendorId",
          select: "name",
        },
      })
      .lean();
    console.log("new",prs);
    let data = [];
    prs.map((po) => {
      const d = {
        id: po._id,
        vendorName: po?.POid.vendorId?.name || "unknown",
        date: po?.POid.date,
        transport: po.POid.transport,
        orderCount: po.order.length,
      };
      data.push(d);
    });
    res.status(200).json(data);
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ message: "Something went wrong", error: error.message });
  }
};

//get particular Purchase order
export const getPo = async (req, res) => {
  try {
    const { poid } = req.params;
    const pos = await PurchaseOrdersModel.findById(poid)
      .populate("vendorId siteId")
      .populate("order.productId");

    if (!pos.siteId)
      return res.status(404).json({ message: "No purchase orders found" });
    res.status(200).json(pos);
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ message: "Something went wrong", error: error.message });
  }
};

//get particular Purchase order for pr
export const getPoForPr = async (req, res) => {
  try {
    const { poid } = req.params;

    // Fetch the purchase order with vendor and site details
    const pos = await PurchaseOrdersModel.findById(poid)
      .populate("vendorId siteId")
      .lean();

    if (!pos) {
      return res.status(404).json({ message: "Purchase order not found" });
    }

    if (!pos.siteId) {
      return res
        .status(404)
        .json({ message: "No site associated with this purchase order" });
    }

    // Extract product IDs from the order
    const productIds = pos.order.map((item) => item.productId);

    // Fetch all related materials in one query (optimized)
    const materials = await MaterialsModel.find({
      productId: { $in: productIds },
      siteId: pos.siteId,
      POid: poid,
    })
      .populate("productId")
      .lean();

    res.status(200).json({ pos, materials });
  } catch (error) {
    console.error("Error fetching purchase order:", error);
    res
      .status(500)
      .json({ message: "Something went wrong", error: error.message });
  }
};

//get particular Purchase return
export const getPr = async (req, res) => {
  try {
    const { prid } = req.params;
    const prs = await PurchaseReturnsModel.findById(prid)
      .populate({
        path: "POid",
        populate: {
          path: "vendorId",
        },
      })
      .populate({
        path: "order.materialId",
        populate: "productId",
      });
    if (!prs.siteId)
      return res.status(404).json({ message: "No purchase returns found" });
    res.status(200).json(prs);
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ message: "Something went wrong", error: error.message });
  }
};

//suggestions for creation
export const helper = async (req, res) => {
  try {
    const { siteId } = req.query;
    const vendors = await VendorsModel.find({ siteId });
    const products = await ProductsModel.find({ siteId });
    if (!vendors || !products)
      return res.status(404).json({ message: "No vendors or products found" });
    res.status(200).json({ vendors: vendors, products: products });
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ message: "Something went wrong", error: error.message });
  }
};

//create purchase order
export const CreatePo = async (req, res) => {
  try {
    const { siteId } = req.query;
    const { vendorId, date, transport, order, template } = req.body;

    // Validate required fields
    if (order.length === 0 || !vendorId || !date ) {
      return res
        .status(400)
        .json({ message: "Please fill all the required fields" });
    }

    // Create the purchase order
    const po = await PurchaseOrdersModel.create({
      siteId,
      vendorId,
      date,
      transport,
      order,
    });
    await po.save();

    // Fetch the purchase order with populated fields
    const PurOrder = await PurchaseOrdersModel.findById(po._id)
      .populate("vendorId") // Populate vendor details
      .populate({
        path: "siteId", // Populate site details
        populate: [
          { path: "engineerId", model: "Engineers" }, // Populate engineer within site
        ],
      })
      .populate({
        path: "order.productId", // Populate products in the order
        populate: { path: "siteId", model: "Sites" }, // Nested population: Product -> Site
      })
      .lean();

    // Generate HTML using the selected template
    const html = generateHTML(
      `../PoTemplates/template${template}.html`, // Relative path to the template
      PurOrder
    );

    // Generate PDF buffer
    const pdfBuffer = await generatePDFBuffer(html);

    // Set response headers to send PDF
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=purchase_order.pdf"
    );

    // Send PDF buffer as response
    res.end(pdfBuffer);
  } catch (error) {
    console.error("Error in CreatePo controller:", error);
    res.status(500).json({
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const downloadPO = async (req, res) => {
  try {
    const { poId } = req.params;
    const { template } = req.query;
    // Fetch the purchase order with populated fields
    const PurOrder = await PurchaseOrdersModel.findById(poId)
      .populate("vendorId") // Populate vendor details
      .populate({
        path: "siteId", // Populate site details
        populate: [
          { path: "engineerId", model: "Engineers" }, // Populate engineer within site
        ],
      })
      .populate({
        path: "order.productId", // Populate products in the order
        populate: { path: "siteId", model: "Sites" }, // Nested population: Product -> Site
      })
      .lean();
    // Generate HTML using the selected template
    const html = generateHTML(
      `../PoTemplates/template${template}.html`, // Relative path to the template
      PurOrder
    );

    // Generate PDF buffer
    const pdfBuffer = await generatePDFBuffer(html);

    // Set response headers to send PDF
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=purchase_order.pdf"
    );

    // Send PDF buffer as response
    res.end(pdfBuffer);
  } catch (error) {
    console.error("Error in downloading po controller:", error);
    res.status(500).json({
      message: "Something went wrong",
      error: error.message,
    });
  }
};

//create purchase order
export const CreatePr = async (req, res) => {
  try {
    const { edit } = req.query;
    const { siteId } = req.query;
    const { vendorId, grandTotal, order, POid, template: tempp } = req.body;

    // Validate required fields
    if (!order?.length || !vendorId || !grandTotal) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (edit) {
      // Updating an existing purchase return
      const updatedPR = await PurchaseReturnsModel.findByIdAndUpdate(
        POid,
        { grandTotal, order },
        { new: true }
      );

      if (!updatedPR) {
        return res.status(404).json({ message: "Purchase return not found" });
      }

      return res
        .status(200)
        .json({ message: "Purchase return updated", data: updatedPR });
    } else {
      // Creating a new purchase return
      const matIds = await Promise.all(
        order.map(async (product) => {
          const updatedMaterial = await MaterialsModel.findByIdAndUpdate(
            product.MatId,
            { availableQty: product.availableQty },
            { new: true }
          );

          if (!updatedMaterial) {
            throw new Error(`Material with ID ${product.MatId} not found`);
          }

          return {
            materialId: updatedMaterial._id,
            returnQty: product.returnQty,
            tax: product.tax,
            subTotal: product.subTotal,
          };
        })
      );

      const pr = await PurchaseReturnsModel.create({
        POid,
        siteId,
        vendorId,
        grandTotal,
        order: matIds,
      });

      const PurOrder = await PurchaseReturnsModel.findById(pr._id)
        .populate({
          path: "POid",
          populate: {
            path: "vendorId siteId",
          },
        })
        .populate({
          path: "order.materialId",
          populate: "productId",
        })
        .populate({
          path: "siteId",
          select: "engineerId",
          populate: { path: "engineerId" },
        })
        .lean();

      // Main Execution
      const html = generateHTML(`../PoTemplates/return${tempp}.html`, PurOrder);
      console.log(html);
      const pdfBuffer = await generatePDFBuffer(html);
      console.log("pdfBuffer", pdfBuffer.length);
      // Set response headers
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=purchase_order.pdf"
      );

      // Send PDF Buffer as response
      res.end(pdfBuffer);
    }
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ message: "Something went wrong", error: error.message });
  }
};
