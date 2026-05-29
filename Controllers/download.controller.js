import express from "express";
import mongoose from "mongoose";
import XLSX from "xlsx";
import Labor from "../Models/Labors.model.js";
import Product from "../Models/Products.model.js";
import Supervisor from "../Models/Supervisors.model.js";
import Vendor from "../Models/Vendors.model.js";

export const downloadExcelReport = async (req, res) => {
  try {
    const { ids } = req.body; 
    const { siteId } = req.query;

    if (!ids || ids.length === 0) {
      return res.status(400).json({ message: "At least one ID is required" });
    }

    if (!siteId) {
      return res.status(400).json({ message: "siteId is required" });
    }


    let siteQuery = siteId;  
    if (mongoose.Types.ObjectId.isValid(siteId)) {``
      siteQuery = new mongoose.Types.ObjectId(siteId);
    }

    let finalData = [];

    const laborRecords = await Labor.find({ _id: { $in: ids }, siteId: siteQuery });
    if (laborRecords.length > 0) {
      finalData = finalData.concat(
        laborRecords.map((labor) => ({
          Type: "Labor",
          Name: labor.name,
          PhoneNo: labor.phoneNo,
          Category: labor.category,
          SubCategory: labor.subCategory,
          WagesPerShift: labor.wagesPerShift,
        }))
      );
    }

    const productRecords = await Product.find({ _id: { $in: ids }, siteId: siteQuery });
    if (productRecords.length > 0) {
      finalData = finalData.concat(
        productRecords.map((product) => ({
          Type: "Product",
          Name: product.name,
          Description: product.description,
          Category: product.category,
          Unit: product.unit,
        }))
      );
    }

    const supervisorRecords = await Supervisor.find({ _id: { $in: ids } });
    if (supervisorRecords.length > 0) {
      finalData = finalData.concat(
        supervisorRecords.map((supervisor) => ({
          Type: "Supervisor",
          Name: supervisor.name,
          Email: supervisor.email,
          Address: supervisor.address,
          PhoneNo: supervisor.phoneNo,
          Role: supervisor.role,
        }))
      );
    }

    const vendorRecords = await Vendor.find({ _id: { $in: ids }, siteId: siteQuery });
    if (vendorRecords.length > 0) {
      finalData = finalData.concat(
        vendorRecords.map((vendor) => ({
          Type: "Vendor",
          Name: vendor.name,
          OwnerName: vendor.ownerName,
          Address: vendor.address,
          GSTIN: vendor.gstin,
          PhoneNo: vendor.phoneNo,
        }))
      );
    }

    if (finalData.length === 0) {
      return res.status(404).json({ message: "No matching records found for the given siteId" });
    }

    const worksheet = XLSX.utils.json_to_sheet(finalData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Report");

    const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Disposition", "attachment; filename=DataReport.xlsx");
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(excelBuffer);
  } catch (error) {
    console.error("Error generating Excel report:", error);
    res.status(500).json({ message: "Failed to generate report" });
  }
};
