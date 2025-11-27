const fs = require('fs');
const path = require('path');
const { getGlobals } = require('../../globals');
const dotenv = require('dotenv');
dotenv.config();

const globals = getGlobals();
let { players } = globals;

// This references the root './logo.png'
const ServerLogo = (process.env.SERVER_LOGO===""|| process.env.SERVER_LOGO === null ) ? process.env.SERVER_LOGO: './logo.png';
const ServerName = process.env.SERVER_NAME || "TEST";
const RULES = process.env.RULES;
const get_max = parseFloat(process.env.MAX) || 1;

exports.getStatus = (req, res) => {
  console.log('Status requested');

  // Read file as binary and convert to base64
  const logoPath = path.resolve(ServerLogo);
  console.log("LOGO : ", logoPath)
  const imageBuffer = fs.readFileSync(logoPath);
  const base64Image = imageBuffer.toString('base64');

  res.json({
    status: 'Online',
    playerCount: players ? Object.keys(players).length : 0,
    image: `data:image/png;base64,${base64Image}`,  // <- binary as base64
    name: ServerName,
    max: get_max,

  });
};
