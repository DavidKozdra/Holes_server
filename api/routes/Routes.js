const express = require('express');
const router = express.Router();
const statusController = require('../controllers/statusController');
const playersController = require('../controllers/playersController');

router.get('/status', statusController.getStatus);
router.get('/playerinfo', playersController.getPlayerInfo);
router.post('/save-player-data', playersController.savePlayerData);

module.exports = router;
