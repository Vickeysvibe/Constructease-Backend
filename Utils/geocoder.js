import NodeGeocoder from "node-geocoder";

const options = {
  provider: "openstreetmap", 
  httpAdapter: "https",    
};

const geocoder = NodeGeocoder(options);

export default geocoder;
