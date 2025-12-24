// aiSystem.js - Server-side AI entity spawning and management
const { getGlobals } = require('../globals');

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
        // Spawn Gnome at (0, 0)
        this.spawnAIEntityAtPosition(0, 100, 0, 1); // race 0 = gnome
        
        // Spawn Skizzard at (0, 0)
        this.spawnAIEntityAtPosition(100, 100, 2, 1); // race 2 = skizzard
        
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
        
        // Spawn away from player (1500-3000 pixels)
        let distance = 1500 + Math.random() * 1500;
        let angle = Math.random() * Math.PI * 2;
        let spawnX = targetPlayer.pos.x + Math.cos(angle) * distance;
        let spawnY = targetPlayer.pos.y + Math.sin(angle) * distance;
        
        // Randomly choose Gnome or Skizzard
        let race = Math.random() < 0.5 ? 0 : 2; // 0 = gnome, 2 = skizzard
        let level = this.calculateAILevel();
        
        console.log(`[AI] Spawning ${race === 0 ? 'Gnome' : 'Skizzard'} level ${level} at (${Math.floor(spawnX)}, ${Math.floor(spawnY)})`);
        
        this.spawnAIEntityAtPosition(spawnX, spawnY, race, level);
        
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
