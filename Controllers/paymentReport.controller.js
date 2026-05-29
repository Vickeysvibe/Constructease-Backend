import Payments from "../Models/Payments.model.js";
import XLSX from "xlsx";

export const paymentReport = async (req, res) => {
  try {
    const  {type } = req.body;
    const { siteId } = req.query;

    if (!type || !["vendor", "client", "labor", "others"].includes(type)) {
      return res.status(400).json({ message: "Invalid type provided" });
    }
    if (!siteId) {
      return res.status(400).json({ message: "Site ID is required" });
    }

    let projection = [];
    let headers = [];

    if (type === "vendor") {
      projection = [
        "date",
        "description",
        "quantity",
        "unit",
        "costPerUnit",
        "amount",
      ];
      headers = [
        "Date",
        "Description",
        "Quantity",
        "Unit",
        "Cost per Unit",
        "Amount",
      ];
    } else if (type === "client") {
      projection = ["date", "paymentReceived", "paymentAs", "paymentBy"];
      headers = ["Date", "Payment Received", "Payment As", "Payment By"];
    } else {
      // For labor and others
      projection = ["date", "description", "amount"];
      headers = ["Date", "Description", "Amount"];
    }

    // Fetching payments from the database
    const payments = await Payments.find({ type, siteId })
      .select(projection.join(" "))
      .lean();

    if (!payments.length) {
      return res
        .status(404)
        .json({ message: "No payments found for the given criteria" });
    }

    // Format data for XLSX
    const formattedData = payments.map((payment) => {
      return {
        ...payment,
        date: new Date(payment.date).toLocaleDateString(), // Format the date
      };
    });

    // Adding headers and data for the worksheet
    const worksheetData = [
      headers,
      ...formattedData.map((row) => projection.map((key) => row[key])),
    ];

    // Create a new workbook and worksheet
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Payments");

    // Write the file to buffer
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    // Send the file as a response
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=payments_${type}_${siteId}.xlsx`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(buffer);
  } catch (error) {
    console.error("Error generating Excel:", error);
    res.status(500).json({ message: "Internal server error", error });
  }
};
