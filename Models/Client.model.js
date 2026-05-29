import mongoose from "mongoose";

const ClientSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        phoneNo: {
            type: String,
            required: true,
            validate: {
                validator: function (v) {
                    return /^\d{10}$/.test(v); 
                },
                message: (props) => `${props.value} is not a valid phone number!`,
            },
        },
        address: { type: String, required: true, trim: true },
        panGstNo: { type: String, required: true },
        siteId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
        },
    },
    { timestamps: true }
);

export default mongoose.model("Clients", ClientSchema);
