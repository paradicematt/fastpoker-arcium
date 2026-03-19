#!/usr/bin/env npx ts-node
/**
 * CLI Bot for testing Sit & Go poker games
 * Usage: npx ts-node scripts/bot.ts [--queue heads-up|6max|9max] [--count N]
 */

import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

const API_BASE = process.env.API_URL || 'http://localhost:3000';

interface SitNGoQueue {
  id: string;
  type: 'heads_up' | '6max' | '9max';
  currentPlayers: number;
  maxPlayers: number;
  buyIn: number;
  status: 'waiting' | 'starting' | 'in_progress';
  tablePda?: string;
}

interface Bot {
  keypair: Keypair;
  name: string;
  queueId: string | null;
  position: number;
}

// Parse command line args
function parseArgs(): { queueType: string; botCount: number } {
  const args = process.argv.slice(2);
  let queueType = 'heads-up';
  let botCount = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--queue' && args[i + 1]) {
      queueType = args[i + 1];
      i++;
    } else if (args[i] === '--count' && args[i + 1]) {
      botCount = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { queueType, botCount };
}

// Load or generate bot keypair
function loadOrCreateKeypair(index: number): Keypair {
  const keysDir = path.join(__dirname, '../keys');
  const keyPath = path.join(keysDir, `bot${index}.json`);

  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }

  if (fs.existsSync(keyPath)) {
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(keyData));
  }

  const keypair = Keypair.generate();
  fs.writeFileSync(keyPath, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`Generated new bot keypair: ${keypair.publicKey.toBase58()}`);
  return keypair;
}

// Fetch available queues
async function getQueues(): Promise<SitNGoQueue[]> {
  const res = await fetch(`${API_BASE}/api/tables`);
  const data = await res.json();
  return data.queues;
}

// Join a queue
async function joinQueue(queueId: string, playerPubkey: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'join', queueId, playerPubkey }),
  });
  return res.json();
}

// Leave a queue
async function leaveQueue(queueId: string, playerPubkey: string): Promise<void> {
  await fetch(`${API_BASE}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'leave', queueId, playerPubkey }),
  });
}

// Simple bot AI - makes random decisions
function decideBotAction(gameState: any): { action: string; amount?: number } {
  const rand = Math.random();
  
  // 60% call/check, 25% raise, 15% fold
  if (rand < 0.15) {
    return { action: 'fold' };
  } else if (rand < 0.40) {
    const raiseAmount = Math.floor(Math.random() * 100) + 50;
    return { action: 'raise', amount: raiseAmount };
  } else {
    return { action: 'call' };
  }
}

// Bot game loop
async function runBotGameLoop(bot: Bot, tablePda: string): Promise<void> {
  console.log(`[${bot.name}] Starting game loop for table ${tablePda.slice(0, 8)}...`);
  
  // Simulate playing - in production, this would subscribe to WebSocket updates
  let round = 0;
  while (round < 10) {
    await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds between actions
    
    const decision = decideBotAction({});
    console.log(`[${bot.name}] Round ${round + 1}: ${decision.action}${decision.amount ? ` ${decision.amount}` : ''}`);
    
    round++;
  }
  
  console.log(`[${bot.name}] Game finished!`);
}

// Main bot runner
async function main() {
  const { queueType, botCount } = parseArgs();
  
  console.log('🤖 FAST POKER - Bot Runner');
  console.log('========================');
  console.log(`Queue type: ${queueType}`);
  console.log(`Bot count: ${botCount}`);
  console.log('');

  // Create bots
  const bots: Bot[] = [];
  for (let i = 0; i < botCount; i++) {
    const keypair = loadOrCreateKeypair(i + 1);
    bots.push({
      keypair,
      name: `Bot${i + 1}`,
      queueId: null,
      position: 0,
    });
    console.log(`Created ${bots[i].name}: ${keypair.publicKey.toBase58().slice(0, 8)}...`);
  }
  console.log('');

  // Fetch queues
  console.log('Fetching available queues...');
  const queues = await getQueues();
  console.log(`Found ${queues.length} queues:`);
  queues.forEach(q => {
    console.log(`  - ${q.id}: ${q.type} (${q.currentPlayers}/${q.maxPlayers}) [${q.status}]`);
  });
  console.log('');

  // Find matching queue
  const targetQueue = queues.find(q => {
    if (queueType === 'heads-up' || queueType === 'hu') return q.type === 'heads_up';
    if (queueType === '6max') return q.type === '6max';
    if (queueType === '9max') return q.type === '9max';
    return q.id.includes(queueType);
  });

  if (!targetQueue) {
    console.error(`No queue found matching "${queueType}"`);
    process.exit(1);
  }

  console.log(`Joining queue: ${targetQueue.id} (${targetQueue.type})`);
  console.log('');

  // Join bots to queue
  for (const bot of bots) {
    try {
      const result = await joinQueue(targetQueue.id, bot.keypair.publicKey.toBase58());
      if (result.success) {
        bot.queueId = result.queue.id;
        bot.position = result.queue.position;
        console.log(`✅ [${bot.name}] Joined queue at position ${bot.position} (${result.queue.currentPlayers}/${result.queue.maxPlayers})`);
        
        // Check if game is starting
        if (result.queue.status === 'starting' && result.queue.tablePda) {
          console.log(`🎮 [${bot.name}] Game starting! Table: ${result.queue.tablePda.slice(0, 8)}...`);
        }
      } else {
        console.log(`❌ [${bot.name}] Failed to join: ${result.error}`);
      }
    } catch (e: any) {
      console.log(`❌ [${bot.name}] Error: ${e.message}`);
    }
    
    // Small delay between joins
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('');
  console.log('Bots are waiting for the game to start...');
  console.log('Press Ctrl+C to exit');
  console.log('');

  // Poll for game start
  let gameStarted = false;
  while (!gameStarted) {
    await new Promise(r => setTimeout(r, 2000));
    
    const currentQueues = await getQueues();
    const currentQueue = currentQueues.find(q => q.id === targetQueue.id);
    
    if (currentQueue) {
      process.stdout.write(`\r  Queue: ${currentQueue.currentPlayers}/${currentQueue.maxPlayers} players [${currentQueue.status}]    `);
      
      if (currentQueue.status === 'starting' || currentQueue.status === 'in_progress') {
        console.log('\n\n🎮 Game is starting!');
        gameStarted = true;
        
        if (currentQueue.tablePda) {
          // Run game loop for each bot
          await Promise.all(bots.map(bot => runBotGameLoop(bot, currentQueue.tablePda!)));
        }
      }
    }
  }

  console.log('\n✅ Bot session complete!');
}

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down bots...');
  process.exit(0);
});

main().catch(console.error);
