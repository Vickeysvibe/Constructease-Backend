import mongoose from "mongoose";
import bcrypt from "bcrypt";
const EngineersSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true, // Removes leading/trailing spaces
    },
    companyName: {
      type: String,
      required: [true, "Company name is required"],
      trim: true,
    },
    companyLogo: {
      type: String,
      required: [true, "Company logo URL is required"],
      validate: {
        validator: function (v) {
          return /^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)$/i.test(v); // Validate URL format
        },
        message: (props) => `${props.value} is not a valid image URL!`,
      },
    },
    companyDesc: {
      type: String,
      required: [true, "Company description is required"],
      maxlength: [500, "Description cannot exceed 500 characters"], // Limit description size
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true, // Ensures no duplicates
      lowercase: true, // Normalizes email casing
      validate: {
        validator: function (v) {
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); // Basic email regex
        },
        message: (props) => `${props.value} is not a valid email!`,
      },
    },
    phoneNo: {
      type: String,
      required: [true, "Phone number is required"],
      validate: {
        validator: function (v) {
          return /^\d{10}$/.test(v); // Validates 10-digit phone number
        },
        message: (props) => `${props.value} is not a valid phone number!`,
      },
    },
    address: {
      type: String,
      required: [true, "Address is required"],
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"], // Enforce password strength
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt fields automatically
  }
);

EngineersSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

export default mongoose.model("Engineers", EngineersSchema);
