import LabourAttendanceModel from "../Models/LabourAttendance.model.js";
import XLSX from "xlsx";
import express from "express";

const app = express();
app.use(express.json());

export const laborReport = async (req, res) => {
  try {
    const { siteId, startDate, endDate, laborCategory, subCategory } = req.body;

    if (!siteId || !startDate || !endDate) {
      return res
        .status(400)
        .json({ message: "siteId, startDate, and endDate are required" });
    }

    // Convert dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999); // Include the entire day

    // Query attendance data
    const attendanceRecords = await LabourAttendanceModel.find({
      siteId: siteId,
      date: { $gte: start, $lte: end },
    }).populate("attendance.labourId");

    if (!attendanceRecords.length) {
      return res.status(404).json({
        message: "No attendance records found for the given criteria.",
      });
    }

    // Debug: Log the populated attendance records
    console.log(
      "Populated Attendance Records:",
      JSON.stringify(attendanceRecords, null, 2)
    );

    // Filter and process data
    const laborData = {};
    let grandTotal = 0;
    const costPerUnit = {}; // To store cost per unit for each subcategory

    attendanceRecords.forEach((record) => {
      record.attendance.forEach((entry) => {
        const { labourId, shift, status } = entry;

        // Debug: Log the labourId and status
        console.log("Labour ID:", labourId);
        console.log("Status:", status);

        // Ensure labourId is populated
        if (!labourId || typeof labourId !== "object") {
          console.error("Labour ID is not populated:", labourId);
          return;
        }

        // Apply category and subcategory filters
        if (
          laborCategory &&
          laborCategory !== "ALL" &&
          labourId.category !== laborCategory
        ) {
          console.log("Skipping due to category filter");
          return;
        }
        if (
          subCategory &&
          subCategory !== "ALL" &&
          labourId.subCategory !== subCategory
        ) {
          console.log("Skipping due to subcategory filter");
          return;
        }

        // Initialize labour data if not already present
        if (!laborData[labourId._id]) {
          laborData[labourId._id] = {
            name: labourId.name,
            phoneNo: labourId.phoneNo,
            category: labourId.category,
            subCategory: labourId.subCategory,
            wagesPerShift: labourId.wagesPerShift,
            daysPresent: 0,
            totalShifts: 0,
            totalWages: 0,
          };
        }

        // Update labour data if status is "present"
        if (status === "present") {
          laborData[labourId._id].daysPresent++;
          laborData[labourId._id].totalShifts += shift;
          laborData[labourId._id].totalWages += shift * labourId.wagesPerShift;
          grandTotal += shift * labourId.wagesPerShift;

          // Calculate cost per unit for each subcategory
          if (!costPerUnit[labourId.subCategory]) {
            costPerUnit[labourId.subCategory] = 0;
          }
          costPerUnit[labourId.subCategory] += shift * labourId.wagesPerShift;
        }
      });
    });

    // Debug: Log the processed labourData
    console.log("Processed Labour Data:", laborData);

    // Convert data to Excel
    const rows = Object.values(laborData).map((data) => ({
      Name: data.name,
      Phone: data.phoneNo,
      Category: data.category,
      SubCategory: data.subCategory,
      "Wages/Shift": data.wagesPerShift,
      "Days Present": data.daysPresent,
      "Total Shifts": data.totalShifts,
      "Total Wages": data.totalWages,
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Labor Report");

    // Generate Excel file as base64
    const excelBuffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });
    const base64Excel = Buffer.from(excelBuffer).toString("base64");

    // Prepare report data
    const reportData = Object.values(laborData);

    // Send JSON response
    res.json({
      success: true,
      data: reportData,
      file: base64Excel,
      totalWages: grandTotal,
      costPerUnit: costPerUnit,
    });
  } catch (error) {
    console.error("Error generating labor report:", error);
    res.status(500).json({ message: "Failed to generate report" });
  }
};

export const laborReport_summary = async (req, res) => {
  try {
    const { siteId, startDate, endDate, laborCategory, subCategory } = req.body;

    if (!siteId || !startDate || !endDate) {
      return res
        .status(400)
        .json({ message: "siteId, startDate, and endDate are required" });
    }

    // Convert dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999); // Include the entire day

    // Query attendance data
    const attendanceRecords = await LabourAttendanceModel.find({
      siteId: siteId,
      date: { $gte: start, $lte: end },
    }).populate("attendance.labourId");

    if (!attendanceRecords.length) {
      return res.status(404).json({
        message: "No attendance records found for the given criteria.",
      });
    }

    // Initialize data structures
    const dateWiseData = {}; // To store data grouped by date and subcategory
    const subCategories = new Set(); // To store unique subcategories
    const wagesPerSubCategory = {}; // To store wages per subcategory

    attendanceRecords.forEach((record) => {
      const dateKey = record.date.toISOString().split("T")[0]; // Format date as YYYY-MM-DD

      if (!dateWiseData[dateKey]) {
        dateWiseData[dateKey] = {};
      }

      record.attendance.forEach((entry) => {
        const { labourId, shift, status } = entry;

        // Ensure labourId is populated
        if (!labourId || typeof labourId !== "object") {
          console.error("Labour ID is not populated:", labourId);
          return;
        }

        // Apply category and subcategory filters
        if (
          laborCategory &&
          laborCategory !== "ALL" &&
          labourId.category !== laborCategory
        ) {
          return;
        }
        if (
          subCategory &&
          subCategory !== "ALL" &&
          labourId.subCategory !== subCategory
        ) {
          return;
        }

        // Initialize subcategory data if not already present
        if (!dateWiseData[dateKey][labourId.subCategory]) {
          dateWiseData[dateKey][labourId.subCategory] = 0;
        }

        // Update subcategory data if status is "present"
        if (status === "present") {
          dateWiseData[dateKey][labourId.subCategory] += shift;

          // Track unique subcategories
          subCategories.add(labourId.subCategory);

          // Calculate wages per subcategory
          if (!wagesPerSubCategory[labourId.subCategory]) {
            wagesPerSubCategory[labourId.subCategory] = 0;
          }
          wagesPerSubCategory[labourId.subCategory] +=
            shift * labourId.wagesPerShift;
        }
      });
    });

    // Convert subCategories set to an array
    const subCategoryList = Array.from(subCategories);

    // Prepare the final report data
    const reportRows = [];
    let grandTotalShifts = Array(subCategoryList.length).fill(0);
    let grandTotalWages = 0;

    // Add rows for each date
    Object.keys(dateWiseData)
      .sort()
      .forEach((date) => {
        const row = { Date: date };
        subCategoryList.forEach((subCat, index) => {
          row[subCat] = dateWiseData[date][subCat] || 0;
          grandTotalShifts[index] += row[subCat];
        });
        reportRows.push(row);
      });

    // Add TOTAL row
    const totalRow = { Date: "TOTAL" };
    subCategoryList.forEach((subCat, index) => {
      totalRow[subCat] = grandTotalShifts[index];
    });
    reportRows.push(totalRow);

    // Add WAGES row
    const wagesRow = { Date: "Wages" };
    subCategoryList.forEach((subCat) => {
      wagesRow[subCat] = wagesPerSubCategory[subCat] || 0;
      grandTotalWages += wagesRow[subCat];
    });
    reportRows.push(wagesRow);

    // Add GRAND TOTAL row
    reportRows.push({
      Date: "Grand Total",
      [subCategoryList[0]]: grandTotalWages,
    });

    // Convert data to Excel
    const worksheet = XLSX.utils.json_to_sheet(reportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Labor Report");

    // Generate Excel file as base64
    const excelBuffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });
    const base64Excel = Buffer.from(excelBuffer).toString("base64");

    // Send JSON response
    res.json({
      success: true,
      data: reportRows,
      file: base64Excel,
      totalWages: grandTotalWages,
    });
  } catch (error) {
    console.error("Error generating labor report:", error);
    res.status(500).json({ message: "Failed to generate report" });
  }
};

