import PaymentsModel from "../Models/Payments.model.js";

export const getPayments = async (req, res) => {
  try {
    const { siteId, type } = req.query;
    const { engineerId } = req.user;
    console.log(siteId);
    if (!siteId || !type)
      return res.status(400).json({ msg: "Missing siteId or type" });

    if (siteId === "outer") {
      const payments = await PaymentsModel.find({ engineerId, type });
      return res.status(200).json(payments);
    }
    const payments = await PaymentsModel.find({ siteId, type });
    res.status(200).json(payments);
  } catch (error) {
    res.status(500).json({ msg: error.message });
  }
};

export const createPayment = async (req, res) => {
  try {
    const { siteId, type } = req.query;
    const { engineerId } = req.user;
    let date, name, description, amount, quantity, unit, costPerUnit;

    switch (type) {
      case "labour":
        ({ name, date, description, amount } = req.body);
        if (!date || !description || !amount || !name)
          return res
            .status(400)
            .json({ msg: "Missing date, description, or amount" });
        const newLabourPayment = new PaymentsModel({
          siteId,
          name,
          type,
          date,
          description,
          amount,
        });
        await newLabourPayment.save();
        return res.status(200).json(newLabourPayment);

      case "vendor":
        ({ date, name, description, amount } = req.body);
        if (!date || !name || !description || !amount)
          return res.status(400).json({
            msg: "Missing date, description, amount, quantity, unit, or costPerUnit",
          });
        const newVendorPayment = new PaymentsModel({
          siteId,
          type,
          date,
          name,
          description,
          amount,
          quantity,
          unit,
          costPerUnit,
        });
        await newVendorPayment.save();
        return res.status(200).json(newVendorPayment);

      case "client":
        let paymentReceived, paymentAs, paymentBy;
        ({ date, name, paymentReceived, paymentAs, paymentBy } = req.body);

        if (!date || !name || !paymentReceived || !paymentAs || !paymentBy)
          return res.status(400).json({
            msg: "Missing date, paymentReceived, paymentAs, or paymentBy",
          });
        const newClientPayment = new PaymentsModel({
          siteId,
          type,
          date,
          name,
          paymentReceived,
          paymentAs,
          paymentBy,
        });
        await newClientPayment.save();
        return res.status(200).json(newClientPayment);

      case "others":
        ({ date, description, amount } = req.body);
        if (!date || !description || !amount)
          return res
            .status(400)
            .json({ msg: "Missing date, description, or amount" });
        const newOthersPayment = new PaymentsModel({
          siteId: siteId !== "outer" ? siteId : undefined,
          engineerId: siteId !== "outer" ? undefined : engineerId,
          type,
          date,
          description,
          amount,
        });
        await newOthersPayment.save();
        return res.status(200).json(newOthersPayment);

      default:
        return res.status(400).json({ msg: "Invalid payment type" });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: error.message });
  }
};

export const editPayment = async (req, res) => {
  try {
    const { id } = req.params; // Unique identifier for the payment to edit
    const { type } = req.body; // Payment type for validation
    let updateData;

    switch (type) {
      case "labour":
        const { date, description, amount } = req.body;
        if (!date || !description || !amount)
          return res
            .status(400)
            .json({ msg: "Missing date, description, or amount" });
        updateData = { date, description, amount };
        break;

      case "vendor":
        const {
          date: vendorDate,
          description: vendorDescription,
          amount: vendorAmount,
          quantity,
          unit,
          costPerUnit,
        } = req.body;
        if (
          !vendorDate ||
          !vendorDescription ||
          !vendorAmount ||
          !quantity ||
          !unit ||
          !costPerUnit
        )
          return res.status(400).json({
            msg: "Missing date, description, amount, quantity, unit, or costPerUnit",
          });
        updateData = {
          date: vendorDate,
          description: vendorDescription,
          amount: vendorAmount,
          quantity,
          unit,
          costPerUnit,
        };
        break;

      case "client":
        const {
          date: clientDate,
          paymentReceived,
          paymentAs,
          paymentBy,
        } = req.body;
        if (!clientDate || !paymentReceived || !paymentAs || !paymentBy)
          return res.status(400).json({
            msg: "Missing date, paymentReceived, paymentAs, or paymentBy",
          });
        updateData = {
          date: clientDate,
          paymentReceived,
          paymentAs,
          paymentBy,
        };
        break;

      case "others":
        const {
          date: othersDate,
          description: othersDescription,
          amount: othersAmount,
        } = req.body;
        if (!othersDate || !othersDescription || !othersAmount)
          return res
            .status(400)
            .json({ msg: "Missing date, description, or amount" });
        updateData = {
          date: othersDate,
          description: othersDescription,
          amount: othersAmount,
        };
        break;

      default:
        return res.status(400).json({ msg: "Invalid payment type" });
    }

    // Update the payment record
    const updatedPayment = await PaymentsModel.findByIdAndUpdate(
      id,
      { ...updateData, type },
      { new: true } // Return the updated document
    );

    if (!updatedPayment)
      return res.status(404).json({ msg: "Payment not found" });

    res.status(200).json(updatedPayment);
  } catch (error) {
    res.status(500).json({ msg: error.message });
  }
};

export const deletePayment = async (req, res) => {
  try {
    const { id } = req.params;
    //const { siteId, type } = req.query;

    const payment = await PaymentsModel.findOneAndDelete({
      _id: id,
    });

    if (!payment) {
      return res.status(404).json({ msg: "Payment not found" });
    }

    res.status(200).json({ msg: "Payment deleted successfully", payment });
  } catch (error) {
    // Handle server error
    res.status(500).json({ msg: error.message });
  }
};
