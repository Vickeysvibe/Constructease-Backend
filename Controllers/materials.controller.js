import MaterialInwadsModel from "../Models/MaterialInwads.model.js";
import MaterialsModel from "../Models/Materials.model.js";

//get list of Material Inwards
export const getAllMaterialInwards = async (req, res) => {
  const { siteId } = req.params;
  if (!siteId) return res.status(400).json({ message: "Site ID is required" });

  try {
    const materials = await MaterialInwadsModel.find({ siteId })
      .populate({
        path: "POid",
        select: "vendorId",
        populate: { path: "vendorId", select: "name" },
      })
      .lean();

    const data = materials.map((mat) => {
      const formattedMaterial = {};

      formattedMaterial.MIid = mat._id;
      formattedMaterial.POid = mat.POid?._id || null; // Safe check
      formattedMaterial.vendorName = mat.POid?.vendorId?.name || "Unknown Vendor"; // Safe check
      formattedMaterial.subTotal = mat.subTotal;
      formattedMaterial.grandTotal = mat.grandTotal;
      formattedMaterial.materials = mat.materials?.length || 0; // Safe check
      formattedMaterial.date = mat.createdAt;

      return formattedMaterial;
    });

    res.status(200).json(data);
  } catch (err) {
    console.error("Error fetching materials:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};


//get MaterialInward details by ID
export const getMaterialInwardById = async (req, res) => {
  try {
    const { MIid } = req.params;
    const { siteId } = req.query;
    console.log(siteId, MIid);
    if (!MIid || !siteId)
      return res.status(400).json({ message: "MI ID and siteId is required" });
    const MI = await MaterialInwadsModel.findOne({ siteId, _id: MIid })
      .populate({
        path: "POid",
        select: "vendorId transport date",
        populate: { path: "vendorId" },
      })
      .populate({
        path: "materials",
        populate: { path: "productId", select: "name unit description" },
      })
      .lean();
    res.status(200).json(MI);
  } catch (error) {
    res.status(500).json(error);
  }
};

//create MaterialInward
export const createMaterialInward = async (req, res) => {
  const { POid, vendorId, order, subTotal, grandTotal, siteId } = req.body;
  if (!POid || !order || !vendorId || !subTotal || !grandTotal || !siteId)
    return res.status(400).json({ message: "Fill all the fields" });
  try {
    let matIds = [];
    order?.forEach((product) => {
      const newMat = new MaterialsModel({
        productId: product.productId,
        suppliedQty: product.suppliedQty,
        availableQty: product.suppliedQty,
        tax: product.tax,
        siteId,
        fromVendor: vendorId,
        unitPrice: product.unitPrice,
        POid,
      });
      newMat.save();
      matIds.push(newMat._id);
    });
    const newMI = new MaterialInwadsModel({
      POid,
      materials: matIds,
      subTotal,
      grandTotal,
      siteId,
    });
    await newMI.save();
    res.status(200).json(newMI);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//get Materials
export const getMaterials = async (req, res) => {
  try {
    const { siteId } = req.params;
    if (!siteId)
      return res.status(400).json({ message: "Site ID is required" });
    const materials = await MaterialsModel.find({ siteId: siteId })
      .populate("productId")
      .populate("fromVendor", "name");
    const maters = [];
    materials.map((mat) => {
      const formattedMaterials = {};
      formattedMaterials.matId = mat._id;
      formattedMaterials.productName = mat?.productId?.name;
      formattedMaterials.availableQty = mat?.availableQty;
      formattedMaterials.fromVendor = mat?.fromVendor?.name;
      formattedMaterials.suppliedQty = mat?.suppliedQty;
      formattedMaterials.usedQty = mat?.usedQty;
      maters.push(formattedMaterials);
    });
    res.status(200).json(maters);
  } catch (error) {
    console.log(error)
    res.status(500).json({ message: error.message });
  }
};

//create Materials
export const editMaterial = async (req, res) => {
  const { matId } = req.params;
  try {
    const mat = await MaterialsModel.findById(matId);
    console.log(mat)
    if (!mat) return res.status(404).json({ message: "Material not found" });
    const { usedQty } = req.body;
    mat.usedQty = usedQty;
    mat.availableQty = mat.suppliedQty - usedQty;
    await mat.save();
    res.status(200).json(mat);
  } catch (error) {
    console.log(error)
    res.status(500).json({ message: error.message });
  }
};
