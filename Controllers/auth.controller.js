import EngineersModel from "../Models/Engineers.model.js";
import SupervisorsModel from "../Models/Supervisors.model.js";
import bcrypt from "bcrypt";
import generateJwt from "../Utils/generateJWTtoken.js";

export const login = async (req, res) => {
  try {
    const { email: e, password } = req.body;
    const email = e.toLowerCase();

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Not all fields have been entered." });
    }

    let user = {};

    user = await EngineersModel.findOne({ email });
    if (!user) {
      user = await SupervisorsModel.findOne({ email });
      if (!user) {
        return res
          .status(400)
          .json({ message: "No account with this email has been registered." });
      }
    }

    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    const role = user.companyName ? "Engineer" : "Supervisor";
    const scope = user.scope ? "global" : "local";
    const token = await generateJwt(user, role, scope);

    return res.status(200).json({ token, user, role });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
