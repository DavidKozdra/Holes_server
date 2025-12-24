const express = require('express');
const router = express.Router();
const statusController = require('../controllers/statusController');
const playersController = require('../controllers/playersController');
const worldsController = require('../controllers/worldsController');

router.get('/status', statusController.getStatus);
router.get('/playerinfo', playersController.getPlayerInfo);
router.get('/worlds', worldsController.listWorlds);
router.post('/worlds', worldsController.createWorld);
router.delete('/worlds/:id', worldsController.deleteWorldHandler);

module.exports = router;
