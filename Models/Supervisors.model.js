import mongoose from "mongoose";
import bcrypt from "bcrypt";

const SupervisorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      validate: {
        validator: function (v) {
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); // Basic email regex
        },
        message: (props) => `${props.value} is not a valid email address!`,
      },
    },
    address: { type: String, required: true, trim: true },
    phoneNo: {
      type: String,
      required: true,
      validate: {
        validator: function (v) {
          return /^\d{10}$/.test(v); // Validates a 10-digit phone number
        },
        message: (props) => `${props.value} is not a valid phone number!`,
      },
    },
    password: {
      type: String,
      required: true,
      minlength: [6, "Password must be at least 6 characters long"],
    },
    role: {
      type: String,
      enum: ["global", "local"],
      required: true,
    },
    engineerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Engineers",
      required: true,
    },
    isDel:{
      type: Boolean,
      default: false

    },
  },
  { timestamps: true }
);

SupervisorSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

export default mongoose.model("Supervisors", SupervisorSchema);
