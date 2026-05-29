import Supervisors from "../Models/Supervisors.model.js";
import Sites from "../Models/Sites.model.js";
import XLSX from "xlsx";
import SitesModel from "../Models/Sites.model.js";
import e from "express";

export const createSupervisor = async (req, res) => {
  try {
    const { name, email, address, phoneNo, password, role } = req.body;
    const { engineerId } = req.user;
    const { siteId } = req.query;

    const supervisorExists = await Supervisors.findOne({ email });
    if (supervisorExists) {
      if (supervisorExists.role === "global")
        return res.status(208).json({
          message:
            "the supervisor is alredy a global supervisor so no need to add",
        });
      const site = await Sites.findById(siteId);
      console.log(site);
      site.supervisorsId.push(supervisorExists._id);
      await site.save();
      return res.status(201).json({ message: "Supervisor added" });
    }

    const newSupervisor = new Supervisors({
      name,
      email,
      address,
      phoneNo,
      password,
      role,
      engineerId,
    });
    await newSupervisor.save();

    if (siteId && role === "local") {
      const site = await Sites.findById(siteId);
      if (!site) {
        return res.status(404).json({ message: "Site not found" });
      }

      site.supervisorsId.push(newSupervisor._id);
      await site.save();
    }

    res.status(201).json({
      message: "Supervisor created successfully",
      supervisor: newSupervisor,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: error.message });
  }
};

export const updateSupervisor = async (req, res) => {
  try {
    const { supervisorId } = req.params;
    const updatedData = req.body;
    const { siteId } = req.query;

    const updatedSupervisor = await Supervisors.findByIdAndUpdate(
      supervisorId,
      updatedData,
      { new: true }
    );
    if (!updatedSupervisor) {
      return res.status(404).json({ message: "Supervisor not found" });
    }

    if (siteId) {
      const site = await Sites.findById(siteId);
      if (!site) {
        return res.status(404).json({ message: "Site not found" });
      }

      if (!site.supervisorsId.includes(updatedSupervisor._id)) {
        site.supervisorsId.push(updatedSupervisor._id);
        await site.save();
      }
    }

    res.status(200).json({
      message: "Supervisor updated successfully",
      supervisor: updatedSupervisor,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getSupervisorsBySite = async (req, res) => {
  try {
    const { siteId } = req.query;
    const { scope } = req.query;

    if (!siteId) {
      return res.status(400).json({ message: "Site ID is required" });
    }
    const matchCondition = { isDel: false }; // Common condition

    if (scope === "local") {
      matchCondition.role = "local";
    } else if (scope === "global") {
      matchCondition.role = "global";
    }

    const site = await Sites.findById(siteId).populate({
      path: "supervisorsId",
      match: matchCondition,
      match: matchCondition,
    });

    if (!site) {
      return res.status(404).json({ message: "Site not found" });
    }

    res.status(200).json(site.supervisorsId);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: error.message });
  }
};

export const getSupervisorById = async (req, res) => {
  try {
    const { supervisorId } = req.params;
    const supervisor = await Supervisors.findById(supervisorId).populate(
      "engineerId",
      "name"
    );

    if (!supervisor) {
      return res.status(404).json({ message: "Supervisor not found" });
    }

    res.status(200).json(supervisor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const uploadExcel = async (req, res) => {
  try {
    const { engineerId } = req.user;
    const { siteId } = req.query;

    if (!req.files || !req.files.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const file = req.files.file;
    const workbook = XLSX.read(file.data, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(sheet);

    const supervisors = [];
    jsonData.forEach((row) => {
      const { name, email, address, phoneNo, password, role } = row;
      if (name && email && address && phoneNo && password && role) {
        supervisors.push({
          name,
          email,
          address,
          phoneNo,
          password,
          role,
          engineerId,
        });
      }
    });

    if (supervisors.length === 0) {
      return res.status(400).json({ error: "No valid data found in the file" });
    }

    const savedSupervisors = await Supervisors.insertMany(supervisors);

    if (siteId) {
      const site = await Sites.findById(siteId);
      if (!site) {
        return res.status(404).json({ message: "Site not found" });
      }

      savedSupervisors.forEach((supervisor) => {
        if (!site.supervisorsId.includes(supervisor._id)) {
          site.supervisorsId.push(supervisor._id);
        }
      });

      await site.save();
    }

    res.status(200).json({
      message: "Supervisors uploaded successfully",
      supervisors: savedSupervisors,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: error.message });
  }
};
export const deleteSupervisor = async (req, res) => {
  try {
    const { supervisorId } = req.params;
    const { siteId } = req.query;

    const updatedSupervisor = await Supervisors.findByIdAndUpdate(
      supervisorId,
      { isDel: true },
      { new: true }
    );

    if (!updatedSupervisor) {
      return res.status(404).json({ message: "Supervisor not found" });
    }

    if (siteId) {
      const site = await Sites.findById(siteId);
      if (!site) {
        return res.status(404).json({ message: "Site not found" });
      }

      site.supervisorsId = site.supervisorsId.filter(
        (id) => id.toString() !== supervisorId
      );
      await site.save();
    }

    res.status(200).json({
      message: "Supervisor marked as deleted successfully",
      supervisor: updatedSupervisor,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getGlobalSupervisors = async (req, res) => {
  try {
    const { engineerId } = req.user;

    if (!engineerId) {
      return res.status(400).json({ message: "Engineer ID is required" });
    }

    const globalSupervisors = await Supervisors.find({
      engineerId,
      role: "global",
    });

    if (globalSupervisors.length === 0) {
      return res.status(404).json({ message: "No global supervisors found" });
    }

    res.status(200).json(globalSupervisors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createGloablSupervisor = async (req, res) => {
  try {
    const { name, email, address, phoneNo, password, role } = req.body;
    const { engineerId } = req.user;

    const supervisorExists = await Supervisors.findOne({ email });
    if (supervisorExists) {
      if (supervisorExists.role === "global")
        return res.status(208).json({
          message:
            "the supervisor is alredy a global supervisor so no need to add",
        });
    }

    const newSupervisor = new Supervisors({
      name,
      email,
      address,
      phoneNo,
      password,
      role,
      engineerId,
    });
    await newSupervisor.save();
    res.status(201).json({
      message: "Supervisor created successfully",
      supervisor: newSupervisor,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: error.message });
  }
};

export const downloadSupervisors = async (req, res) => {
  try {
    const { supervisorIds } = req.body;
    const { siteId } = req.query;

    if (!siteId) {
      return res
        .status(400)
        .json({ error: "Site ID is required in the query" });
    }

    if (
      !supervisorIds ||
      !Array.isArray(supervisorIds) ||
      supervisorIds.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "Supervisor IDs are required in the request body" });
    }

    const supervisors = await Supervisors.find({ _id: { $in: supervisorIds } });

    if (supervisors.length === 0) {
      console.log("m");

      return res.status(404).json({
        error: "No supervisors found for the provided IDs and site ID",
      });
    }

    const jsonData = supervisors.map(
      ({ name, email, address, phoneNo, role }) => ({
        name,
        email,
        address,
        phoneNo,
        role,
      })
    );

    const worksheet = XLSX.utils.json_to_sheet(jsonData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Supervisors");

    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="supervisors.xlsx"'
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.send(buffer);
  } catch (error) {
    console.log(error);
    res.status(500).json({
      message: error.message,
      redirectUrl: "http://.....",
    });
  }
};

export const deleteMultipleSupervisors = async (req, res) => {
  try {
    const { supervisorIds } = req.body;
    const { siteId } = req.query;

    if (
      !supervisorIds ||
      !Array.isArray(supervisorIds) ||
      supervisorIds.length === 0
    ) {
      return res
        .status(400)
        .json({ message: "Invalid supervisor IDs provided" });
    }

    const updatedSupervisors = await Supervisors.updateMany(
      { _id: { $in: supervisorIds } },
      { isDel: true }
    );

    if (updatedSupervisors.matchedCount === 0) {
      return res.status(404).json({ message: "No supervisors found" });
    }

    if (siteId) {
      const site = await Sites.findById(siteId);
      if (!site) {
        return res.status(404).json({ message: "Site not found" });
      }

      site.supervisorsId = site.supervisorsId.filter(
        (id) => !supervisorIds.includes(id.toString())
      );
      await site.save();
    }

    res.status(200).json({
      message: "Supervisors marked as deleted successfully",
      supervisors: updatedSupervisors,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
