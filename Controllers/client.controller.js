import Clients from "../Models/Client.model.js";
import XLSX from "xlsx";


export const createClient = async (req, res) => {
    try {
        const { name, phoneNo, address, panGstNo } = req.body;
        const { siteId } = req.query; 
        console.log(siteId)
        if (!siteId) {
            return res.status(400).json({ error: "Site ID is required in the query" });
        }

        const newClient = new Clients({ name, phoneNo, address, panGstNo, siteId });
        await newClient.save();

        res.status(201).json
        ({ message: "Client created successfully", client: newClient });
    } catch (error) {
        console.log(error)
        res.status(500).json({
            message: error.message,
            redirectUrl: 'http://.....',
        });
    }
};


export const updateClient = async (req, res) => {
    try {
        const { clientId } = req.params;
        const updatedData = req.body;

        const updatedClient = await Clients.findByIdAndUpdate(clientId, updatedData, { new: true });

        if (!updatedClient) {
            return res.status(404).json({ error: "Client not found" });
        }

        res.status(200).json({ message: "Client updated successfully", client: updatedClient });
    } catch (error) {
        res.status(500).json({
            message: error.message,
            redirectUrl: 'http://.....',
        });
    }
};


export const getAllClients = async (req, res) => {
    try {
        const { siteId } = req.query; 

        if (!siteId) {
            return res.status(400).json({ error: "Site ID is required in the query" });
        }

        
        const clients = await Clients.find({ siteId }).populate("siteId", "name");

        if (clients.length === 0) {
            return res.status(404).json({ error: "No clients found for the specified site ID" });
        }

        res.status(200).json(clients);
    } catch (error) {
        console.log(error)
        res.status(500).json({
            message: error.message,
            redirectUrl: 'http://.....',
        });
    }
};



export const getClientById = async (req, res) => {
    try {
        const { clientId } = req.params;
        const client = await Clients.findById(clientId).populate("siteId", "name");

        if (!client) {
            return res.status(404).json({ error: "Client not found" });
        }

        res.status(200).json(client);
    } catch (error) {
        res.status(500).json({
            message: error.message,
            redirectUrl: 'http://.....',
        });
    }
};

export const upload = async (req, res) => {
    try {
        const { siteId } = req.query; 

        if (!siteId) {
            return res.status(400).json({ error: "Site ID is required in the query" });
        }

        if (!req.files || !req.files.file) {
            return res.status(400).json({ message: "No file uploaded" });
        }

        const file = req.files.file;
        const workbook = XLSX.read(file.data, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(sheet);

        const clients = [];

        jsonData.forEach((row) => {
            const { name, phoneNo, address, panGstNo } = row;
            if (name && phoneNo && address && panGstNo) {
                clients.push({ name, phoneNo, address, panGstNo, siteId });
            }
        });

        if (clients.length === 0) {
            return res.status(400).json({ error: "No valid data found in the file" });
        }

        await Clients.insertMany(clients);

        res.status(200).json({ message: "Clients uploaded successfully", clients });
    } catch (error) {
        res.status(500).json({
            message: error.message,
            redirectUrl: 'http://.....',
        });
    }
};

export const deleteClient = async (req, res) => {
    try {
        const { clientId } = req.params;

        const deletedClient = await Clients.findByIdAndDelete(clientId);

        if (!deletedClient) {
            return res.status(404).json({ error: "Client not found" });
        }

        res.status(200).json({ message: "Client deleted successfully", client: deletedClient });
    } catch (error) {
        console.log(error)
        res.status(500).json({
            message: error.message,
            redirectUrl: 'http://.....', 
        });
    }
};


export const downloadClients = async (req, res) => {
    try {
        const { clientIds } = req.body;
        const { siteId } = req.query;

        if (!siteId) {
            return res.status(400).json({ error: "Site ID is required in the query" });
        }

        if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
            return res.status(400).json({ error: "Client IDs are required in the request body" });
        }

        const clients = await Clients.find({ _id: { $in: clientIds }, siteId });

        if (clients.length === 0) {
            return res.status(404).json({ error: "No clients found for the provided IDs and site ID" });
        }

        const jsonData = clients.map(({ name, phoneNo, address, panGstNo, siteId }) => ({
            name,
            phoneNo,
            address,
            panGstNo,
            siteId
        }));

        const worksheet = XLSX.utils.json_to_sheet(jsonData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Clients");

        const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

        res.setHeader("Content-Disposition", 'attachment; filename="clients.xlsx"');
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        
        res.send(buffer);
    } catch (error) {
        res.status(500).json({
            message: error.message,
            redirectUrl: 'http://.....',
        });
    }
};
