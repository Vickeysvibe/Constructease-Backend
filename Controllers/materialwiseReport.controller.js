import MaterialInward from '../Models/MaterialInwads.model.js';
import Vendors from "../Models/Vendors.model.js"
import PurchaseOrdersModel from "../Models/PurchaseOrders.model.js";
import XLSX from 'xlsx';
import mongoose from 'mongoose';
import Payment from "../Models/Payments.model.js"
import SitesModel from '../Models/Sites.model.js';


const { ObjectId } = mongoose.Types;

export const overallMaterialReport = async (req, res) => {
    try {
        const { siteId } = req.query;
        const { startDate, endDate } = req.body;


        const materials = await MaterialInward.find({
            siteId,
            createdAt: {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            },
        })
            .populate({
                path: 'POid',
                populate: { path: 'vendorId', model: 'Vendors' },
            })
            .populate('order.productId');

        const reportData = [];


        materials.forEach((material) => {
            material.order.forEach((orderItem) => {
                reportData.push({
                    'Vendor Name': material.POid.vendorId.name,
                    'Product Name': orderItem.productId.name,
                    'Supplied Quantity': orderItem.suppliedQty,
                    'Unit Price': orderItem.unitPrice,
                    'Total Price': orderItem.suppliedQty * orderItem.unitPrice,
                    'Date': material.createdAt.toISOString().split('T')[0],
                });
            });
        });

        if (reportData.length === 0) {
            return res.status(404).json({ success: false, message: 'No data found for the selected site and date range.' });
        }


        const worksheet = XLSX.utils.json_to_sheet(reportData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Vendor Purchase Report');


        const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Vendor_Purchase_Report.xlsx');

        res.send(excelBuffer);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
export const materialSummary = async (req, res) => {
    try {
        const { siteId } = req.query;
        const { startDate, endDate, productName } = req.body;




        const matchConditions = {
            siteId: new mongoose.Types.ObjectId(siteId),
            createdAt: {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            }
        };


        const pipeline = [
            {
                $match: matchConditions
            },
            {
                $lookup: {
                    from: "materials",
                    localField: "materials",
                    foreignField: "_id",
                    as: "materialDetails",
                },
            },
            {
                $lookup: {
                    from: "purchaseorders",
                    localField: "POid",
                    foreignField: "_id",
                    as: "PO",
                },
            },
            { $unwind: { path: "$PO", preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: "vendors",
                    localField: "PO.vendorId",
                    foreignField: "_id",
                    as: "PO.vendor",
                },
            },
            { $unwind: { path: "$PO.vendor", preserveNullAndEmptyArrays: true } },
            {
                $addFields: {
                    "PO.order": { $ifNull: ["$PO.order", []] },
                },
            },
            { $unwind: { path: "$PO.order", preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: "products",
                    localField: "PO.order.productId",
                    foreignField: "_id",
                    as: "PO.order.productDetails",
                },
            },
            { $unwind: { path: "$PO.order.productDetails", preserveNullAndEmptyArrays: true } }
        ];


        if (productName && productName !== "ALL") {
            pipeline.push({
                $match: {
                    "PO.order.productDetails.name": productName
                }
            });
        }

        const materials = await MaterialInward.aggregate(pipeline);



        if (materials.length === 0) {
            return res.status(404).json({
                success: false,
                message: productName === "ALL"
                    ? "No data found for the selected date range."
                    : "No data found for the selected product and date range."
            });
        }


        const reportData = materials.map((material) => {
            const orderItem = material.PO.order;


            if (!material.PO || !material.PO.vendor || !orderItem || !orderItem.productDetails) {
                console.warn("Invalid or missing data in material:", material);
                return null;
            }

            const materialDetail = material.materialDetails.find(
                (mat) => mat.productId.toString() === orderItem.productDetails._id.toString()
            );

            if (!materialDetail) {
                console.warn("No matching material details found for product:", orderItem.productDetails.name);
                return null;
            }


            const suppliedQty = materialDetail.suppliedQty || 0;
            const unitPrice = materialDetail.unitPrice || 0;
            const gst = (suppliedQty * unitPrice) * (materialDetail.tax / 100);
            const totalAmount = (suppliedQty * unitPrice) + gst;

            return {
                "Date": material.createdAt.toISOString().split("T")[0],
                "Vendor Name": material.PO.vendor.name,
                "Product Name": orderItem.productDetails.name,
                "Quantity": suppliedQty,
                "Tax": gst,
                "Total": totalAmount,
            };
        }).filter(Boolean);


        if (reportData.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No reportable data found."
            });
        }


        const worksheet = XLSX.utils.json_to_sheet(reportData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Product Purchase Report");

        const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });


        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=Product_Purchase_Report_${productName === "ALL" ? "ALL" : productName}_${siteId}.xlsx`);


        res.json({
            success: true,
            data: reportData,
            file: excelBuffer.toString('base64'),
        });
    } catch (error) {
        console.error("Error generating report:", error);
        res.status(500).json({
            success: false,
            message: "An error occurred while generating the report.",
            error
        });
    }
};


export const SingleVendorReport = async (req, res) => {
    try {
        const { siteId } = req.query;
        const { vendor, startDate, endDate } = req.body;




        const openingBalanceMaterials = await MaterialInward.aggregate([
            {
                $match: {
                    siteId: new mongoose.Types.ObjectId(siteId),
                    createdAt: { $lt: new Date(startDate) },
                },
            },
            {
                $lookup: {
                    from: "materials",
                    localField: "materials",
                    foreignField: "_id",
                    as: "materialDetails",
                },
            },
            { $unwind: "$materialDetails" },
            {
                $group: {
                    _id: null,
                    totalAmount: { $sum: { $multiply: ["$materialDetails.suppliedQty", "$materialDetails.unitPrice"] } },
                },
            },
        ]);

        const openingBalancePayments = await Payment.aggregate([
            {
                $match: {
                    siteId: new mongoose.Types.ObjectId(siteId),
                    date: { $lt: new Date(startDate) },
                    type: "vendor",
                },
            },
            {
                $group: {
                    _id: null,
                    totalAmountPaid: { $sum: "$amount" },
                },
            },
        ]);

        const openingBalanceTotalAmount = openingBalanceMaterials.length > 0 ? openingBalanceMaterials[0].totalAmount : 0;
        const openingBalanceAmountPaid = openingBalancePayments.length > 0 ? openingBalancePayments[0].totalAmountPaid : 0;

        const reportData = [
            {
                "Date": new Date(startDate).toISOString().split("T")[0],
                "Vendor": "",
                "Product Name": "",
                "Description": "Opening Balance",
                "Quantity": "",
                "Unit": "",
                "Price/Unit": "",
                "Amount": "",
                "GST": "",
                "Total Amount": openingBalanceTotalAmount,
                "Amount Paid": openingBalanceAmountPaid,
            },
        ];

        if (vendor === 'ALL') {

            const materials = await MaterialInward.aggregate([
                {
                    $match: {
                        siteId: new mongoose.Types.ObjectId(siteId),
                        createdAt: {
                            $gte: new Date(startDate),
                            $lte: new Date(endDate),
                        },
                    },
                },
                {
                    $lookup: {
                        from: "materials",
                        localField: "materials",
                        foreignField: "_id",
                        as: "materialDetails",
                    },
                },
                {
                    $lookup: {
                        from: "purchaseorders",
                        localField: "POid",
                        foreignField: "_id",
                        as: "PO",
                    },
                },
                { $unwind: { path: "$PO", preserveNullAndEmptyArrays: true } },
                {
                    $lookup: {
                        from: "vendors",
                        localField: "PO.vendorId",
                        foreignField: "_id",
                        as: "PO.vendor",
                    },
                },
                { $unwind: { path: "$PO.vendor", preserveNullAndEmptyArrays: true } },
                {
                    $addFields: {
                        "PO.order": { $ifNull: ["$PO.order", []] },
                    },
                },
                { $unwind: { path: "$PO.order", preserveNullAndEmptyArrays: true } },
                {
                    $lookup: {
                        from: "products",
                        localField: "PO.order.productId",
                        foreignField: "_id",
                        as: "PO.order.productDetails",
                    },
                },
                { $unwind: { path: "$PO.order.productDetails", preserveNullAndEmptyArrays: true } },
            ]);

            if (materials.length === 0) {
                return res.status(404).json({ success: false, message: "No data found for the selected site and date range." });
            }


            const payments = await Payment.find({
                siteId: new mongoose.Types.ObjectId(siteId),
                createdAt: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                },
                type: "vendor",
            });


            materials.forEach((material) => {
                if (!material.PO || !material.PO.order) {
                    console.warn("Invalid or missing order in POid:", material.POid);
                    return;
                }
                const orders = Array.isArray(material.PO.order) ? material.PO.order : [material.PO.order];

                orders.forEach((orderItem) => {
                    if (!orderItem.productDetails || !orderItem.productDetails.name) {
                        console.warn("Invalid product reference in order:", orderItem);
                        return;
                    }

                    const materialDetail = material.materialDetails.find(
                        (mat) => mat.productId.toString() === orderItem.productDetails._id.toString()
                    );

                    if (!materialDetail) {
                        console.warn("No matching material details found for product:", orderItem.productDetails.name);
                        return;
                    }
                    const suppliedQty = materialDetail.suppliedQty || 0;
                    const unitPrice = materialDetail.unitPrice || 0;
                    const gst = (suppliedQty * unitPrice) * (materialDetail.tax / 100);
                    const totalAmount = (suppliedQty * unitPrice) + gst;


                    reportData.push({
                        "Date": material.createdAt.toISOString().split("T")[0],
                        "Vendor": material.PO.vendor?.name || "Unknown Vendor",
                        "Product Name": orderItem.productDetails.name,
                        "Description": materialDetail.description || "",
                        "Quantity": suppliedQty,
                        "Unit": materialDetail.unit || "",
                        "Price/Unit": unitPrice,
                        "Amount": suppliedQty * unitPrice,
                        "GST": gst,
                        "Total Amount": totalAmount,
                        "Amount Paid": 0,
                    });
                });
            });


            payments.forEach((payment) => {
                reportData.push({
                    "Date": payment.createdAt.toISOString().split("T")[0],
                    "Vendor": payment.name || "Unknown Vendor",
                    "Product Name": "",
                    "Description": payment.description,
                    "Quantity": "",
                    "Unit": "",
                    "Price/Unit": "",
                    "Amount": "",
                    "GST": "",
                    "Total Amount": "",
                    "Amount Paid": payment.amount,
                });
            });



            if (reportData.length === 0) {
                return res.status(404).json({ success: false, message: "No reportable data found." });
            }


            const totalAmount = reportData.reduce((sum, row) => sum + (row["Total Amount"] || 0), 0);
            const totalAmountPaid = reportData.reduce((sum, row) => sum + (row["Amount Paid"] || 0), 0);
            const balance = totalAmount - totalAmountPaid;


            reportData.push({
                "Date": "",
                "Vendor": "",
                "Product Name": "Total",
                "Description": "",
                "Quantity": "",
                "Unit": "",
                "Price/Unit": "",
                "Amount": "",
                "GST": "",
                "Total Amount": totalAmount,
                "Amount Paid": totalAmountPaid,
            });

            reportData.push({
                "Date": "",
                "Vendor": "",
                "Product Name": "Balance",
                "Description": "",
                "Quantity": "",
                "Unit": "",
                "Price/Unit": "",
                "Amount": "",
                "GST": "",
                "Total Amount": "",
                "Amount Paid": balance,
            });


            const worksheet = XLSX.utils.json_to_sheet(reportData);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Vendor Purchase Report");

            const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });


            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename=Vendor_Purchase_Report_${siteId}.xlsx`);


            res.json({
                success: true,
                data: reportData,
                file: excelBuffer.toString('base64'),
            });
        } else {

            const vendorDoc = await Vendors.findOne({ name: vendor });
            if (!vendorDoc) {
                return res.status(404).json({ success: false, message: "Vendor not found." });
            }
            const vendorId = vendorDoc._id;

            const materials = await MaterialInward.aggregate([
                {
                    $match: {
                        siteId: new mongoose.Types.ObjectId(siteId),
                        createdAt: {
                            $gte: new Date(startDate),
                            $lte: new Date(endDate),
                        },
                    },
                },
                {
                    $lookup: {
                        from: "materials",
                        localField: "materials",
                        foreignField: "_id",
                        as: "materialDetails",
                    },
                },
                {
                    $lookup: {
                        from: "purchaseorders",
                        localField: "POid",
                        foreignField: "_id",
                        as: "PO",
                    },
                },
                { $unwind: { path: "$PO", preserveNullAndEmptyArrays: true } },
                {
                    $match: {
                        "PO.vendorId": vendorId
                    }
                },
                {
                    $lookup: {
                        from: "vendors",
                        localField: "PO.vendorId",
                        foreignField: "_id",
                        as: "PO.vendor",
                    },
                },
                { $unwind: { path: "$PO.vendor", preserveNullAndEmptyArrays: true } },
                {
                    $addFields: {
                        "PO.order": { $ifNull: ["$PO.order", []] },
                    },
                },
                { $unwind: { path: "$PO.order", preserveNullAndEmptyArrays: true } },
                {
                    $lookup: {
                        from: "products",
                        localField: "PO.order.productId",
                        foreignField: "_id",
                        as: "PO.order.productDetails",
                    },
                },
                { $unwind: { path: "$PO.order.productDetails", preserveNullAndEmptyArrays: true } },
            ]);

            if (materials.length === 0) {
                return res.status(404).json({ success: false, message: "No data found for this vendor within the specified date range." });
            }


            const payments = await Payment.find({
                siteId: new mongoose.Types.ObjectId(siteId),
                date: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                },
                type: "vendor",
                name: vendor,
            });


            materials.forEach((material) => {
                if (!material.PO || !material.PO.order) {
                    console.warn("Invalid or missing order in POid:", material.POid);
                    return;
                }
                const orders = Array.isArray(material.PO.order) ? material.PO.order : [material.PO.order];

                orders.forEach((orderItem) => {
                    if (!orderItem.productDetails || !orderItem.productDetails.name) {
                        console.warn("Invalid product reference in order:", orderItem);
                        return;
                    }

                    const materialDetail = material.materialDetails.find(
                        (mat) => mat.productId.toString() === orderItem.productDetails._id.toString()
                    );

                    if (!materialDetail) {
                        console.warn("No matching material details found for product:", orderItem.productDetails.name);
                        return;
                    }


                    const suppliedQty = materialDetail.suppliedQty || 0;
                    const unitPrice = materialDetail.unitPrice || 0;
                    const gst = (suppliedQty * unitPrice) * (materialDetail.tax / 100);
                    const totalAmount = (suppliedQty * unitPrice) + gst;


                    reportData.push({
                        "Date": material.createdAt.toISOString().split("T")[0],
                        "Vendor": vendor,
                        "Product Name": orderItem.productDetails.name,
                        "Description": orderItem.productDetails.description || "",
                        "Quantity": suppliedQty,
                        "Unit": orderItem.productDetails.unit || "",
                        "Price/Unit": unitPrice,
                        "Amount": suppliedQty * unitPrice,
                        "GST": gst,
                        "Total Amount": totalAmount,
                        "Amount Paid": 0,
                    });
                });
            });


            payments.forEach((payment) => {
                reportData.push({
                    "Date": payment.createdAt.toISOString().split("T")[0],
                    "Vendor": vendor,
                    "Product Name": "",
                    "Description": payment.description,
                    "Quantity": "",
                    "Unit": "",
                    "Price/Unit": "",
                    "Amount": "",
                    "GST": "",
                    "Total Amount": "",
                    "Amount Paid": payment.amount,
                });
            });



            if (reportData.length === 0) {
                return res.status(404).json({ success: false, message: "No reportable data found." });
            }


            const totalAmount = reportData.reduce((sum, row) => sum + (row["Total Amount"] || 0), 0);
            const totalAmountPaid = reportData.reduce((sum, row) => sum + (row["Amount Paid"] || 0), 0);
            const balance = totalAmount - totalAmountPaid;


            reportData.push({
                "Date": "",
                "Vendor": "",
                "Product Name": "Total",
                "Description": "",
                "Quantity": "",
                "Unit": "",
                "Price/Unit": "",
                "Amount": "",
                "GST": "",
                "Total Amount": totalAmount,
                "Amount Paid": totalAmountPaid,
            });

            reportData.push({
                "Date": "",
                "Vendor": "",
                "Product Name": "Balance",
                "Description": "",
                "Quantity": "",
                "Unit": "",
                "Price/Unit": "",
                "Amount": "",
                "GST": "",
                "Total Amount": "",
                "Amount Paid": balance,
            });

            const worksheet = XLSX.utils.json_to_sheet(reportData);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Vendor Report");

            const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });


            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename=Vendor_Report_${vendor}.xlsx`);


            res.json({
                success: true,
                data: reportData,
                file: excelBuffer.toString('base64'),
            });
        }
    } catch (error) {
        console.error("Error generating report:", error);
        res.status(500).json({ success: false, message: "An error occurred while generating the report.", error });
    }
};


export const ComprehensiveReport = async (req, res) => {
    try {
        const { engineerId } = req.user;

        const sites = await SitesModel.find({ engineerId });

        const siteReports = [];
        let totalIncoming = 0;
        let totalSiteOutgoing = 0;
        let totalSiteProfit = 0;

        for (const site of sites) {
            const incomingResult = await Payment.aggregate([
                {
                    $match: {
                        siteId: site._id,
                        type: "client",
                    },
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: "$paymentReceived" },
                        count: { $sum: 1 },
                    },
                },
            ]);
            const incoming = incomingResult[0]?.total || 0;

            const outgoingResult = await Payment.aggregate([
                {
                    $match: {
                        siteId: site._id,
                        type: { $in: ["vendor", "labour", "others"] },
                    },
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: "$amount" },
                        count: { $sum: 1 },
                    },
                },
            ]);
            const outgoing = outgoingResult[0]?.total || 0;
            const profit = incoming - outgoing;

            siteReports.push({
                siteId: site._id,
                siteName: site.siteName,
                incoming,
                outgoing,
                profit,
                transactionCount:
                    (incomingResult[0]?.count || 0) + (outgoingResult[0]?.count || 0),
            });

            totalIncoming += incoming;
            totalSiteOutgoing += outgoing;
            totalSiteProfit += profit;
        }

        const generalExpensesResult = await Payment.aggregate([
  {
    $match: {
      engineerId: new mongoose.Types.ObjectId(engineerId),
      type: "others",
      siteId: { $exists: false }, 
    },
  },
  {
    $group: {
      _id: null,
      total: { $sum: "$amount" },
      count: { $sum: 1 },
    },
  },
]);

        console.log(generalExpensesResult)

        const generalExpenses = generalExpensesResult[0]?.total || 0;
        const overallProfit = totalSiteProfit - generalExpenses;
        const totalOutgoing = totalSiteOutgoing + generalExpenses;

        
        const excelRows = [
            ["S.no", "Site Name", "Income", "Expense", "Profit/Loss"],

            ...siteReports.map((report, index) => [
                index + 1,
                report.siteName,
                report.incoming,
                report.outgoing,
                report.profit,
            ]),
            [],
            ["", "General Expenses", "", generalExpenses, ""],
            ["", "Total", totalIncoming, totalOutgoing, overallProfit],
        ];

        const worksheet = XLSX.utils.aoa_to_sheet(excelRows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Comprehensive Report");

        
        const excelBuffer = XLSX.write(workbook, {
            type: "buffer",
            bookType: "xlsx",
        });

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=Comprehensive_report_full.xlsx`
        );

        res.send(excelBuffer);
    } catch (error) {
        console.error("Error generating Comprehensive report:", error);
        res.status(500).json({
            message: "Failed to generate Comprehensive report",
            error: error.message,
        });
    }
};




export const downloadGeneralExpenses = async (req, res) => {
  try {
    const { engineerId } = req.user;

    const expenses = await Payment.find({
      engineerId: new mongoose.Types.ObjectId(engineerId),
      type: "others",
      siteId: { $exists: false },
    });

    if (!expenses.length) {
      return res.status(404).json({ message: "No general expenses found." });
    }

    let totalAmount = 0;

    const excelRows = [
      ["S.no", "Date", "Description", "Amount"],
      ...expenses.map((expense, index) => {
        const formattedDate = new Date(expense.date).toLocaleDateString("en-GB"); 
        totalAmount += expense.amount;
        return [
          index + 1,
          formattedDate,
          expense.description || "-",
          expense.amount,
        ];
      }),
      [],
      ["", "Total", "", totalAmount],
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(excelRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "General Expenses");

    const excelBuffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=general_expenses.xlsx`
    );

    res.send(excelBuffer);
  } catch (error) {
    console.error("Error downloading general expenses:", error);
    res.status(500).json({
      message: "Failed to download general expenses",
      error: error.message,
    });
  }
};

