import Site from "../Models/Sites.model.js";  

const onlyForEngineers = async (req, res, next) => {
    try {
        const { engineerId, role } = req.user;
        const { siteId } = req.query;

        if (role !== "Engineer") {
            return res.status(403).json({ message: "Forbidden: Invalid role" });
        }

        // Validate siteId
        if (!siteId) {
            return res.status(400).json({ message: "Site ID is required" });
        }

        const site = await Site.findById(siteId).select("engineerId");

        // Check if site exists
        if (!site) {
            return res.status(404).json({ message: "Site not found" });
        }

        // Check if the engineerId matches
        if (site.engineerId.equals(engineerId)) {
            return next();
        } 

        return res.status(403).json({ message: "Forbidden: Engineer not assigned to this site" });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

export default onlyForEngineers;
