import Labours from "../Models/Labors.model.js";
import XLSX from "xlsx";

export const createLabour = async (req, res) => {
    try {
        const { name, phoneNo, category, subCategory, wagesPerShift } = req.body;
        const { siteId } = req.query;
        const newLabour = new Labours({ name, phoneNo, category, subCategory, wagesPerShift, siteId });
        await newLabour.save();
        res.status(201).json({ message: "Labour created successfully", labour: newLabour });
    } catch (error) {
        res.status(500).json({ message: error.message, redirectUrl: 'http://.....' });
    }
};

export const updateLabour = async (req, res) => {
    try {
        const { labourId } = req.params;
        const updatedData = req.body;
        const { siteId } = req.query;
        updatedData.siteId = siteId;
        const updatedLabour = await Labours.findByIdAndUpdate(labourId, updatedData, { new: true });
        if (!updatedLabour) {
            return res.status(404).json({ error: "Labour not found" });
        }
        res.status(200).json({ message: "Labour updated successfully", labour: updatedLabour });
    } catch (error) {
        res.status(500).json({ message: error.message, redirectUrl: 'http://.....' });
    }
};


export const getAllLabours = async (req, res) => {
    try {
        const { siteId } = req.query;
        let labours;
        const query = { isDel: false };
        if (siteId) {
            query.siteId = siteId;
        }
        labours = await Labours.find(query).populate("siteId", "name");

        res.status(200).json(labours);
    } catch (error) {
        res.status(500).json({ message: error.message, redirectUrl: 'http://.....' });
    }
};

export const getLabourById = async (req, res) => {
    try {
        const { labourId } = req.params;
        const labour = await Labours.findById(labourId).populate("siteId", "name");
        if (!labour) {
            return res.status(404).json({ error: "Labour not found" });
        }
        res.status(200).json(labour);
    } catch (error) {
        res.status(500).json({ message: error.message, redirectUrl: 'http://.....' });
    }
};

export const uploadExcel = async (req, res) => {
    try {
        const { siteId } = req.query;
        if (!req.files || !req.files.file) {
            return res.status(400).json({ message: "No file uploaded" });
        }
        const file = req.files.file;
        const workbook = XLSX.read(file.data, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(sheet);
        const labours = [];
        jsonData.forEach((row) => {
            const { name, phoneNo, category, subCategory, wagesPerShift } = row;
            if (name && phoneNo && category && subCategory && wagesPerShift) {
                labours.push({ name, phoneNo, category, subCategory, wagesPerShift, siteId });
            }
        });
        if (labours.length === 0) {
            return res.status(400).json({ error: "No valid data found in the file" });
        }
        await Labours.insertMany(labours);
        res.status(200).json({ message: "Labours uploaded successfully", labours });
    } catch (error) {
        res.status(500).json({ message: error.message, redirectUrl: 'http://.....' });
    }
};


export const deleteLabour = async (req, res) => {
    try {
        const { labourId } = req.params;

        const updatedLabour = await Labours.findByIdAndUpdate(
            labourId,
            { isDel: true },  
            { new: true }      
        );

        if (!updatedLabour) {
            return res.status(404).json({ error: "Labour not found" });
        }

        res.status(200).json({ message: "Labour marked as deleted successfully", labour: updatedLabour });
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: error.message, redirectUrl: 'http://.....' });
    }
};


export const downloadLabour = async (req, res) => {
    try {
        const { labourIds } = req.body;
        const { siteId } = req.query;

        if (!siteId) {
            return res.status(400).json({ error: "Site ID is required in the query" });
        }

        if (!labourIds || !Array.isArray(labourIds) || labourIds.length === 0) {
            return res.status(400).json({ error: "Labour IDs are required in the request body" });
        }

        const labour = await Labours.find({ _id: { $in: labourIds }, siteId });

        if (labour.length === 0) {
            return res.status(404).json({ error: "No labour found for the provided IDs and site ID" });
        }

        const jsonData = labour.map(({ name, phoneNo, category, subCategory, wagesPerShift }) => ({
            name,
            phoneNo,
            category, 
            subCategory, 
            wagesPerShift
        }));

        const worksheet = XLSX.utils.json_to_sheet(jsonData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Labours");

        const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

        res.setHeader("Content-Disposition", 'attachment; filename="labour.xlsx"');
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        
        res.send(buffer);
    } catch (error) {
        res.status(500).json({
            message: error.message,
            redirectUrl: 'http://.....',
        });
    }
};

export const deleteMultipleLabours = async (req, res) => {
    try {
        const { labourIds } = req.body; 
        const { siteId } = req.query;   

        if (!labourIds || !Array.isArray(labourIds) || labourIds.length === 0) {
            return res.status(400).json({ error: "Invalid labourIds list" });
        }

        const updatedLabours = await Labours.updateMany(
            { _id: { $in: labourIds }, siteId }, 
            { $set: { isDel: true } }          
        );

        if (updatedLabours.modifiedCount === 0) {
            return res.status(404).json({ error: "No labours found or already deleted" });
        }

        res.status(200).json({ message: "Labours marked as deleted successfully", count: updatedLabours.modifiedCount });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message, redirectUrl: 'http://.....' });
    }
};