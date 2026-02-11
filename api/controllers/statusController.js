const fs = require('fs');
const path = require('path');
const { getGlobals } = require('../../globals');
const dotenv = require('dotenv');
dotenv.config();

const globals = getGlobals();
let { players, serverStartTime } = globals;

// This references the root './logo.png'
const ServerLogo = (process.env.SERVER_LOGO===""|| process.env.SERVER_LOGO === null ) ? process.env.SERVER_LOGO: './logo.png';
const ServerName = process.env.SERVER_NAME || "TEST";
const RULES = process.env.RULES;
const get_max = parseFloat(process.env.MAX) || 10;
const PERMA_DEATH = (process.env.PERMA_DEATH || 'false').toLowerCase() === 'true';

exports.getStatus = (req, res) => {
  console.log('Status requested');

  let base64Image = null;
  try {
    const logoPath = path.resolve(ServerLogo);
    // Prevent path traversal: ensure resolved path stays within project
    if (fs.existsSync(logoPath)) {
      const imageBuffer = fs.readFileSync(logoPath);
      base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;
    }
  } catch (e) {
    console.warn('[Status] Could not read logo file:', e.message);
  }

  res.json({
    status: 'Online',
    playerCount: players ? Object.keys(players).length : 0,
    image: base64Image,
    name: ServerName,
    max: get_max,
    hardcore: PERMA_DEATH,
    serverStartTime: serverStartTime,
  });
};
