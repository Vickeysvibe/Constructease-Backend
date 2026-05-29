import mongoose from "mongoose";
import LabourAttendanceModel from "../Models/LabourAttendance.model.js";
import LabourModel from "../Models/Labors.model.js";
import SupervisorAttendancesModel from "../Models/SupervisorAttendances.model.js";

const getTodayLabourCategoryCount = async () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const result = await LabourAttendanceModel.aggregate([
    {
      $match: {
        date: { $gte: todayStart, $lt: tomorrowStart },
      },
    },
    { $unwind: "$attendance" },
    {
      $match: {
        "attendance.status": "present", // only present labours
      },
    },
    {
      $lookup: {
        from: "labours",
        localField: "attendance.labourId",
        foreignField: "_id",
        as: "labourDetails",
      },
    },
    { $unwind: "$labourDetails" },
    {
      $group: {
        _id: {
          category: "$labourDetails.category",
          subCategory: "$labourDetails.subCategory",
        },
        count: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: "$_id.category",
        subcategories: {
          $push: {
            k: "$_id.subCategory",
            v: "$count",
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        category: "$_id",
        subcategories: {
          $arrayToObject: "$subcategories",
        },
      },
    },
  ]);

  const formatted = {};
  result.forEach((item) => {
    formatted[item.category] = item.subcategories;
  });

  return formatted;
};

export const attendance = async (req, res) => {
  try {
    const { labourIds } = req.body;
    const { siteId } = req.query;

    if (!labourIds || labourIds.length === 0) {
      return res.status(400).json({ message: "No labor IDs provided" });
    }

    if (!siteId) {
      return res.status(400).json({ message: "Site ID is required" });
    }

    const validLabors = await LabourModel.find({
      _id: { $in: labourIds },
      siteId,
    }).select("_id");

    if (validLabors.length === 0) {
      return res
        .status(400)
        .json({ message: "No matching labor IDs for the provided site" });
    }

    const validLaborIds = validLabors.map((labor) => labor._id.toString());

    // Get the current date in UTC and set the time to midnight (UTC)
    const currentDate = new Date();
    currentDate.setUTCHours(0, 0, 0, 0);

    // Remove time part from the currentDate (store only the date part in ISO format)
    const dateOnly = currentDate.toISOString().split("T")[0]; // "YYYY-MM-DD"

    // Find the attendance document for the given site and date
    let attendanceDoc = await LabourAttendanceModel.findOne({
      siteId,
      date: dateOnly, // Compare only the date part
    });

    if (!attendanceDoc) {
      attendanceDoc = new LabourAttendanceModel({
        siteId,
        date: dateOnly, // Store only the date part
        attendance: [],
      });
    }

    const existingLaborIds = attendanceDoc.attendance.map((entry) =>
      entry.labourId.toString()
    );

    const newLaborIds = validLaborIds.filter(
      (id) => !existingLaborIds.includes(id)
    );

    newLaborIds.forEach((labourId) => {
      attendanceDoc.attendance.push({
        labourId,
        status: "present",
        shift: 1,
      });
    });

    await attendanceDoc.save();
    console.log("Attendance document stored successfully");

    res.status(200).json({ message: "Attendance recorded successfully" });
  } catch (error) {
    console.error("Error in attendance:", error);
    res.status(500).json({ message: "Internal server error", error });
  }
};

export const todayAttendance = async (req, res) => {
  const { siteId } = req.query;

  if (!siteId) {
    return res.status(400).json({ message: "Site ID is required" });
  }

  // Normalize current date (remove time part) in "YYYY-MM-DD" format
  const currentDate = new Date();
  currentDate.setUTCHours(0, 0, 0, 0); // Set to midnight UTC
  const dateOnly = currentDate.toISOString().split("T")[0]; // "YYYY-MM-DD"

  // Find the attendance document for the given site and dateOnly
  const populatedDoc = await LabourAttendanceModel.findOne({
    siteId,
    date: dateOnly, // Compare only the date part
  })
    .populate("attendance.labourId", "name category subCategory wagesPerShift")
    .select("attendance");

  if (!populatedDoc) {
    return res.status(404).json({ message: "No attendance found for today." });
  }

  // Map the attendance entries and calculate total wages
  const attendanceResponse = populatedDoc.attendance.map((entry) => {
    const labour = entry.labourId;
    const shift = entry.shift || 1;
    const wagesPerShift = labour.wagesPerShift || 0;
    const total = shift * wagesPerShift;
    const id = labour._id;

    return {
      Name: labour.name,
      Category: labour.category,
      SubCategory: labour.subCategory,
      Shift: shift,
      WagesPerShift: wagesPerShift,
      Total: total,
      id: id,
    };
  });

  const counts = await getTodayLabourCategoryCount();

  res.status(200).json({
    attendanceResponse,
    counts,
  });
};

export const getLabours = async (req, res) => {
  try {
    const { siteId } = req.query;

    if (!siteId) {
      return res.status(400).json({ message: "siteId is required" });
    }
    const labourData = await LabourModel.find({ siteId });
    const labourDetails = labourData.map((labour) => ({
      name: labour.name,
      category: labour.category,
      subCategory: labour.subCategory,
      wagesPerShift: labour.wagesPerShift,
      id: labour._id,
    }));
    res.status(200).json({
      labourDetails,
    });
  } catch (error) {
    console.error("Error fetching labour data:", error);
    res.status(500).json({ message: "Internal server error", error });
  }
};

// const subCategoryCounts = await LabourModel.aggregate([
//   { $match: { siteId: siteId } },
//   {
//     $group: {
//       _id: { category: "$category", subCategory: "$subCategory" },
//       count: { $sum: 1 },
//     },
//   },
//   {
//     $group: {
//       _id: "$_id.category",
//       subCategories: {
//         $push: {
//           subCategory: "$_id.subCategory",
//           count: "$count",
//         },
//       },
//     },
//   },
//   {
//     $project: {
//       _id: 0,
//       category: "$_id",
//       subCategories: "$subCategories",
//     },
//   },
// ]);

export const getSubCategoryCounts = async (req, res) => {
  try {
    const { siteId } = req.query;

    if (!siteId) {
      return res.status(400).json({ message: "Site ID is required" });
    }

    const objectId = new mongoose.Types.ObjectId(siteId);

    const subCategoryCounts = await LabourModel.aggregate([
      { $match: { siteId: objectId } },
      {
        $group: {
          _id: null,
          categories: { $addToSet: "$category" },
          subCategories: { $addToSet: "$subCategory" },
        },
      },
      {
        $project: {
          _id: 0,
          category: "$categories",
          subCategory: "$subCategories",
        },
      },
    ]);

    res
      .status(200)
      .json(subCategoryCounts[0] || { category: [], subCategory: [] });
  } catch (error) {
    console.error("Error fetching subcategories:", error);
    res.status(500).json({ message: "Internal server error", error });
  }
};

export const updateShift = async (req, res) => {
  try {
    const { labourId, newShift } = req.body;
    const { siteId } = req.query;

    if (!labourId || !newShift || !siteId) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // Normalize current date (remove time part) in "YYYY-MM-DD" format
    const currentDate = new Date();
    currentDate.setUTCHours(0, 0, 0, 0); // Set to midnight UTC
    const dateOnly = currentDate.toISOString().split("T")[0]; // "YYYY-MM-DD"

    // Find and update the shift for the given site and dateOnly
    const attendanceDoc = await LabourAttendanceModel.findOneAndUpdate(
      {
        siteId,
        date: dateOnly, // Use the normalized date for comparison
        "attendance.labourId": labourId,
      },
      { $set: { "attendance.$.shift": newShift } },
      { new: true }
    );

    if (!attendanceDoc) {
      return res.status(404).json({ message: "Attendance record not found." });
    }

    res.status(200).json({ message: "Shift updated successfully." });
  } catch (error) {
    console.error("Error updating shift:", error);
    res.status(500).json({ message: "Internal server error", error });
  }
};

export const getSupervisors = async (req, res) => {
  try {
    const { siteId } = req.query;

    if (!siteId) {
      return res.status(400).json({ message: "Site ID is required." });
    }

    const today = new Date();
    const todayISO = today.toISOString().split("T")[0];

    const supervisorsAttendance = await SupervisorAttendancesModel.findOne({
      siteId,
      date: {
        $gte: new Date(`${todayISO}T00:00:00.000Z`),
        $lte: new Date(`${todayISO}T23:59:59.999Z`),
      },
    }).populate("attendance.supervisorId", "name");

    if (!supervisorsAttendance || !supervisorsAttendance.attendance.length) {
      return res
        .status(200)
        .json({ message: "No attendance found for today." });
    }

    // Iterate through attendance records
    const formattedAttendance = supervisorsAttendance.attendance.map(
      (attendance) => {
        const checkinTimes = attendance.checkin || []; // Ensure it's an array
        const checkoutTimes = attendance.checkout || []; // Ensure it's an array
        const lastCheckin = checkinTimes.length
          ? checkinTimes[checkinTimes.length - 1]
          : "N/A";
        const lastCheckout = checkoutTimes.length
          ? checkoutTimes[checkoutTimes.length - 1]
          : "N/A";

        return {
          name: attendance.supervisorId?.name || "Unknown",
          location: attendance.location || "N/A",
          checkinTime: lastCheckin,
          checkoutTime: lastCheckout,
        };
      }
    );

    res.status(200).json(formattedAttendance);
  } catch (error) {
    console.error("Error fetching supervisors:", error);
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

export const deleteTodayAttendance = async (req, res) => {
  try {
    const { siteId } = req.query;
    const { labourId } = req.body;

    if (!siteId || !labourId) {
      return res
        .status(400)
        .json({ message: "Site ID and Labour ID are required." });
    }

    const currentDate = new Date();
    currentDate.setUTCHours(0, 0, 0, 0);
    const dateOnly = currentDate.toISOString().split("T")[0];

    const updatedAttendance = await LabourAttendanceModel.findOneAndUpdate(
      { siteId, date: dateOnly },
      { $pull: { attendance: { labourId } } },
      { new: true }
    );

    if (!updatedAttendance) {
      return res.status(404).json({
        message: "No attendance record found for this site on today's date.",
      });
    }

    res.status(200).json({
      message: "Labour attendance record removed successfully",
      updatedAttendance,
    });
  } catch (error) {
    console.error("Error deleting labour attendance:", error);
    res.status(500).json({ message: "Failed to delete labour attendance" });
  }
};
