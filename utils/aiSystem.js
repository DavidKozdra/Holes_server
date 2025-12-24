// aiSystem.js - Server-side AI entity spawning and management
const { getGlobals } = require('../globals');
const { CHUNKSIZE, TILESIZE } = require('./map');

let globals = getGlobals();

class ServerAIEntity {
    constructor(x, y, race, level, id) {
        this.id = id;
        this.pos = { x, y };
        this.race = race; // 0 = gnome, 2 = skizzard
        this.level = level;
        this.name = race === 0 ? `Gnome_${id.substring(0, 5)}` : `Skizzard_${id.substring(0, 5)}`;
        this.color = 0; // AI is neutral color
        this.hp = this.getMaxHP();
        this.alive = true;
        this.lastUpdate = Date.now();
    }

    getMaxHP() {
        const baseHP = [100, 100, 100]; // gnome, aylah, skizzard
        const growthHP = [10, 5, 8];
        return baseHP[this.race] + (growthHP[this.race] * (this.level - 1));
    }

    takeDamage(damage) {
        this.hp -= damage;
        if (this.hp <= 0) {
            this.alive = false;
        }
        return this.hp;
    }
}

class AISpawningSystem {
    constructor(io) {
        this.io = io;
        this.aiEntities = {};
        this.spawnTimer = 0;
        this.spawnInterval = 5 * 60 * 1000; // Spawn every 5 minutes
        this.serverStartTime = Date.now();
        this.lastSpawnTime = Date.now();
        
        // Spawn initial test entities at (0, 0)
        this.spawnInitialTestEntities();
    }

    spawnInitialTestEntities() {
        const anchor = { pos: { x: 0, y: 0 } };
        const first = this.findValidSpawnNear(anchor) || { x: 0, y: 0 };
        const second = this.findValidSpawnNear(anchor) || { x: 150, y: 150 };

        // Spawn Gnome and Skizzard near origin but in breathable tiles
        this.spawnAIEntityAtPosition(first.x, first.y, 0, 1); // race 0 = gnome
        this.spawnAIEntityAtPosition(second.x, second.y, 2, 1); // race 2 = skizzard
        
        console.log('[AI] Spawned initial test entities at (0,0)');
    }

    spawnAIEntityAtPosition(x, y, race, level) {
        // Create AI entity with unique ID
        let entityId = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        let aiEntity = new ServerAIEntity(x, y, race, level, entityId);
        
        this.aiEntities[entityId] = aiEntity;
        
        // Broadcast to all clients
        this.io.emit('NEW_AI_ENTITY', {
            id: entityId,
            pos: { x: x, y: y },
            race: race,
            level: level,
            color: 0
        });
        
        console.log(`[AI] Spawned ${race === 0 ? 'Gnome' : 'Skizzard'} level ${level} at (${x}, ${y})`);
    }

    getAveragePlayerLevel() {
        const { players } = getGlobals();
        let playerArray = Object.values(players).filter(p => p && p.statBlock && typeof p.statBlock.level === 'number');
        
        if (playerArray.length === 0) return 1;
        
        let totalLevel = 0;
        for (let p of playerArray) {
            totalLevel += p.statBlock.level;
        }
        
        return Math.floor(totalLevel / playerArray.length);
    }

    getServerAgeModifier() {
        // Return a multiplier based on server age in minutes
        const ageInMinutes = Math.floor((Date.now() - this.serverStartTime) / (60 * 1000));
        // Start at 1.0, increase by 0.1 every 30 minutes (max around 2.0 after 5+ hours)
        return Math.min(1 + (ageInMinutes / 300), 2.0);
    }

    calculateAILevel() {
        const avgPlayerLevel = this.getAveragePlayerLevel();
        const ageModifier = this.getServerAgeModifier();
        
        // Level = average player level with some randomness, boosted by age modifier
        let baseLevel = avgPlayerLevel;
        let variance = Math.floor(random() * 3) - 1; // -1, 0, or 1
        let aiLevel = Math.max(1, Math.floor((baseLevel + variance) * ageModifier));
        
        return aiLevel;
    }

    spawnAIEntity() {
        const { players, serverMap } = getGlobals();
        
        // Only spawn if there are players on server
        let playerArray = Object.values(players).filter(p => p && p.pos);
        if (playerArray.length === 0) return;
        
        // Pick a random player to spawn near
        let targetPlayer = playerArray[Math.floor(Math.random() * playerArray.length)];
        
        // Pick a breathable tile near the player so clients already tracking that area can simulate AI
        const spawnPos = this.findValidSpawnNear(targetPlayer);
        if (!spawnPos) {
            console.warn('[AI] Failed to find valid spawn tile near player, skipping spawn');
            return;
        }
        
        // Randomly choose Gnome or Skizzard
        let race = Math.random() < 0.5 ? 0 : 2; // 0 = gnome, 2 = skizzard
        let level = this.calculateAILevel();
        
        console.log(`[AI] Spawning ${race === 0 ? 'Gnome' : 'Skizzard'} level ${level} at (${Math.floor(spawnPos.x)}, ${Math.floor(spawnPos.y)})`);
        
        this.spawnAIEntityAtPosition(spawnPos.x, spawnPos.y, race, level);
        
        this.lastSpawnTime = Date.now();
    }

    update() {
        // Check if it's time to spawn
        if (Date.now() - this.lastSpawnTime > this.spawnInterval) {
            this.spawnAIEntity();
        }
        
        // Remove dead AI entities
        let deadIds = [];
        for (let id in this.aiEntities) {
            if (!this.aiEntities[id].alive) {
                deadIds.push(id);
            }
        }
        
        for (let id of deadIds) {
            delete this.aiEntities[id];
            this.io.emit('REMOVE_AI_ENTITY', id);
        }
    }

    handleAIDamage(id, damage) {
        if (this.aiEntities[id]) {
            let hp = this.aiEntities[id].takeDamage(damage);
            return { alive: this.aiEntities[id].alive, hp: hp };
        }
        return null;
    }

    getAIEntity(id) {
        return this.aiEntities[id] || null;
    }

    removeAIEntity(id) {
        if (this.aiEntities[id]) {
            delete this.aiEntities[id];
            this.io.emit('REMOVE_AI_ENTITY', id);
        }
    }

    findValidSpawnNear(targetPlayer) {
        const { serverMap } = getGlobals();
        const minDist = 600; // stay off-screen but within loaded chunk radius
        const maxDist = 1100;
        const attempts = 28;

        for (let i = 0; i < attempts; i++) {
            const distance = minDist + Math.random() * (maxDist - minDist);
            const angle = Math.random() * Math.PI * 2;
            const spawnX = targetPlayer.pos.x + Math.cos(angle) * distance;
            const spawnY = targetPlayer.pos.y + Math.sin(angle) * distance;

            const chunkX = Math.floor(spawnX / (TILESIZE * CHUNKSIZE));
            const chunkY = Math.floor(spawnY / (TILESIZE * CHUNKSIZE));
            const chunk = serverMap.getChunk(chunkX, chunkY);
            const tileX = Math.floor(spawnX / TILESIZE) - chunkX * CHUNKSIZE;
            const tileY = Math.floor(spawnY / TILESIZE) - chunkY * CHUNKSIZE;

            if (tileX < 0 || tileX >= CHUNKSIZE || tileY < 0 || tileY >= CHUNKSIZE) continue;

            const tileIdx = tileX + tileY * CHUNKSIZE;
            const density = chunk.data[tileIdx];

            // If the initial tile is blocked, look for the closest breathable spot nearby
            let targetTile = null;
            if (density < 0.35) {
                targetTile = { x: tileX, y: tileY };
            } else {
                const nearby = this.findNearbyOpenTile(chunk, tileX, tileY, 8);
                if (nearby) targetTile = nearby;
            }

            if (targetTile) {
                return {
                    x: (chunkX * CHUNKSIZE + targetTile.x + 0.5) * TILESIZE,
                    y: (chunkY * CHUNKSIZE + targetTile.y + 0.5) * TILESIZE
                };
            }
        }

        return null;
    }

    findNearbyOpenTile(chunk, tileX, tileY, radius = 6) {
        let best = null;
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                const nx = tileX + dx;
                const ny = tileY + dy;
                if (nx < 0 || nx >= CHUNKSIZE || ny < 0 || ny >= CHUNKSIZE) continue;

                const val = chunk.data[nx + ny * CHUNKSIZE];
                if (val < 0.35) {
                    const manhattan = Math.abs(dx) + Math.abs(dy);
                    if (!best || manhattan < best.dist) {
                        best = { x: nx, y: ny, dist: manhattan };
                    }
                }
            }
        }
        return best;
    }
}

// Helper for random (polyfill for p5.random since we're in Node)
function random(min, max) {
    if (min === undefined) {
        return Math.random();
    } else if (max === undefined) {
        return Math.random() * min;
    } else {
        return Math.random() * (max - min) + min;
    }
}

module.exports = { AISpawningSystem, ServerAIEntity };
