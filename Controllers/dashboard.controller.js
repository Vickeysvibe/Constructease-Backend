import Clients from "../Models/Client.model.js";
import Payments from "../Models/Payments.model.js";
import Labour from "../Models/Labors.model.js";
import LabourAttendance from "../Models/LabourAttendance.model.js";
import MaterialInwards from "../Models/MaterialInwads.model.js";
import Material from "../Models/Materials.model.js"; 
import mongoose from "mongoose";


export const getClientsWithPayments = async (req, res) => {
    try {
        const { siteId } = req.query;

        if (!siteId) {
            return res.status(400).json({ message: "siteId is required" });
        }

        const clients = await Clients.find({ siteId });

        if (!clients.length) {
            return res.status(404).json({ message: "No clients found for this siteId" });
        }

        const clientPaymentData = [];

        for (const client of clients) {
            const payments = await Payments.find({ name: client.name });

            let totalAmount = 0;
            let monthlyPayments = {
                Jan: 0, Feb: 0, Mar: 0, Apr: 0, May: 0, Jun: 0,
                Jul: 0, Aug: 0, Sep: 0, Oct: 0, Nov: 0, Dec: 0
            };

            payments.forEach(payment => {
                totalAmount += payment.paymentReceived; 

                const month = new Date(payment.date).toLocaleString("en-US", { month: "short" });

                if (monthlyPayments[month] !== undefined) {
                    monthlyPayments[month] += payment.paymentReceived;
                }
            });

            clientPaymentData.push({
                id: client._id,
                name: client.name,
                phone: client.phoneNo,
                pan: client.panGstNo,
                address: client.address,
                totalAmount,
                monthlyPayments
            });
        }

        res.status(200).json(clientPaymentData);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server Error" });
    }
};



export const getLabourAttendanceSummary = async (req, res) => {
    try {
        const { siteId } = req.query; // Get siteId from request

        if (!siteId) {
            return res.status(400).json({ message: "siteId is required" });
        }

        // Fetch all attendance records for the given site
        const attendanceRecords = await LabourAttendance.find({ siteId });

        let workers = {}; // To store total present days per worker
        let workermonth = {}; // To store total present days per month

        for (const record of attendanceRecords) {
            const month = new Date(record.date).toLocaleString("en-US", { month: "short" });

            if (!workermonth[month]) workermonth[month] = 0; // Initialize month count

            for (const att of record.attendance) {
                if (att.status === "present") {
                    // Count worker's total present days
                    workers[att.labourId] = (workers[att.labourId] || 0) + 1;

                    // Count monthly total present days
                    workermonth[month] += 1;
                }
            }
        }

        // Fetch worker names
        const labourIds = Object.keys(workers);
        const labourDetails = await Labour.find({ _id: { $in: labourIds } });

        // Map ObjectIds to Names
        let workersWithNames = {};
        for (const labour of labourDetails) {
            workersWithNames[labour.name] = workers[labour._id] || 0;
        }

        res.json({ workers: workersWithNames, workermonth });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};




export const getPaymentsDetails = async (req, res) => {
    try {
        const { siteId } = req.query; 

        if (!siteId) {
            return res.status(400).json({ message: "siteId is required" });
        }

        const payments = await Payments.find({ siteId });
        const paymentsLength=payments.length;

        let vendorPayments = {};
        let labourPayments = {};
        let clientPayments = {};
        let otherPayments = {};

        for (const payment of payments) {
            const month = new Date(payment.date).toLocaleString("en-US", { month: "short" });

            if (payment.type === "vendor") {
                vendorPayments[month] = (vendorPayments[month] || 0) + (payment.amount || 0);
            } else if (payment.type === "labour") {
                labourPayments[month] = (labourPayments[month] || 0) + (payment.amount || 0);
            } else if (payment.type === "client") {
                clientPayments[month] = (clientPayments[month] || 0) + (payment.paymentReceived || 0);
            } else {
                otherPayments[month] = (otherPayments[month] || 0) + (payment.amount || 0);
            }
        }
        
        res.json({
            paymentsLength, 
            vendorPayments,
            labourPayments,
            clientPayments,
            otherPayments
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};



export const getMaterialCounts = async (req, res) => {
    try {
        const { siteId } = req.query;
        console.log('working');

        if (!siteId) {
            return res.status(400).json({ message: "siteId is required" });
        }

        const materials = await Material.find({ siteId }).populate("productId", "name");
        console.log(materials);

        let materialCounts = {};

        for (const material of materials) {
            if (!material.productId) {
                console.warn(`Skipping material with ID: ${material._id} due to missing productId`);
                continue;
            }

            const month = new Date(material.createdAt).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
            const materialName = material.productId.name;

            if (!materialCounts[materialName]) {
                materialCounts[materialName] = {};
            }

            materialCounts[materialName][month] =
                (materialCounts[materialName][month] || 0) + material.availableQty;
        }

        res.json(materialCounts);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};
