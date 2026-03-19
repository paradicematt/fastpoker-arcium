#!/usr/bin/env node
/**
 * CLI Bot for testing Sit & Go poker games
 * Usage: node scripts/bot.js [--queue heads-up|6max|9max] [--count N]
 */

const API_BASE = process.env.API_URL || 'http://localhost:3000';

// Parse command line args
function parseArgs() {
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

// Generate random pubkey-like string for bot
function generateBotPubkey(index) {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = 'Bot';
  for (let i = 0; i < 40; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result + index;
}

// Fetch available queues
async function getQueues() {
  const res = await fetch(`${API_BASE}/api/tables`);
  const data = await res.json();
  return data.queues;
}

// Join a queue
async function joinQueue(queueId, playerPubkey) {
  const res = await fetch(`${API_BASE}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'join', queueId, playerPubkey }),
  });
  return res.json();
}

// Simple bot AI - makes random decisions
function decideBotAction() {
  const rand = Math.random();
  const actions = ['fold', 'check', 'call', 'raise', 'allin'];
  const weights = [0.10, 0.30, 0.35, 0.20, 0.05];
  
  let cumulative = 0;
  for (let i = 0; i < actions.length; i++) {
    cumulative += weights[i];
    if (rand < cumulative) {
      if (actions[i] === 'raise') {
        return { action: 'raise', amount: Math.floor(Math.random() * 200) + 50 };
      }
      return { action: actions[i] };
    }
  }
  return { action: 'call' };
}

// Bot game simulation
async function simulateBotGame(bot, tablePda) {
  console.log(`[${bot.name}] 🎮 Playing at table ${tablePda?.slice(0, 8) || 'unknown'}...`);
  
  // Simulate game rounds
  const rounds = ['PreFlop', 'Flop', 'Turn', 'River'];
  for (const round of rounds) {
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
    
    const decision = decideBotAction();
    const actionStr = decision.amount ? `${decision.action} ${decision.amount}` : decision.action;
    console.log(`[${bot.name}] ${round}: ${actionStr}`);
    
    // Random chance to "win" the hand
    if (Math.random() < 0.3 && round === 'River') {
      console.log(`[${bot.name}] 🏆 Won the hand!`);
    }
  }
}

// Main bot runner
async function main() {
  const { queueType, botCount } = parseArgs();
  
  console.log('');
  console.log('🤖 FAST POKER - Bot Runner');
  console.log('==========================');
  console.log(`Queue type: ${queueType}`);
  console.log(`Bot count: ${botCount}`);
  console.log(`API: ${API_BASE}`);
  console.log('');

  // Create bots
  const bots = [];
  for (let i = 0; i < botCount; i++) {
    const pubkey = generateBotPubkey(i + 1);
    bots.push({
      pubkey,
      name: `Bot${i + 1}`,
      queueId: null,
      position: 0,
    });
    console.log(`Created ${bots[i].name}: ${pubkey.slice(0, 12)}...`);
  }
  console.log('');

  // Fetch queues
  console.log('Fetching available queues...');
  let queues;
  try {
    queues = await getQueues();
  } catch (e) {
    console.error(`Failed to fetch queues: ${e.message}`);
    console.log('Make sure the dev server is running: npm run dev');
    process.exit(1);
  }
  
  console.log(`Found ${queues.length} queues:`);
  queues.forEach(q => {
    const typeLabel = q.type === 'heads_up' ? 'Heads Up' : q.type === '6max' ? '6-Max' : '9-Max';
    console.log(`  • ${q.id}: ${typeLabel} (${q.currentPlayers}/${q.maxPlayers}) [${q.status}]`);
  });
  console.log('');

  // Find matching queue that is WAITING (not in progress)
  const targetQueue = queues.find(q => {
    const typeMatch = (
      (queueType === 'heads-up' || queueType === 'hu') ? q.type === 'heads_up' :
      (queueType === '6max' || queueType === '6-max') ? q.type === '6max' :
      (queueType === '9max' || queueType === '9-max') ? q.type === '9max' :
      q.id.includes(queueType)
    );
    return typeMatch && q.status === 'waiting';
  });

  if (!targetQueue) {
    console.error(`❌ No queue found matching "${queueType}"`);
    console.log('Available types: heads-up, 6max, 9max');
    process.exit(1);
  }

  const typeLabel = targetQueue.type === 'heads_up' ? 'Heads Up' : targetQueue.type === '6max' ? '6-Max' : '9-Max';
  console.log(`Joining queue: ${targetQueue.id} (${typeLabel})`);
  console.log('');

  // Join bots to queue
  for (const bot of bots) {
    try {
      const result = await joinQueue(targetQueue.id, bot.pubkey);
      if (result.success) {
        bot.queueId = result.queue.id;
        bot.position = result.queue.position;
        console.log(`✅ [${bot.name}] Joined at position ${bot.position} (${result.queue.currentPlayers}/${result.queue.maxPlayers})`);
        
        // Check if game is starting
        if (result.queue.status === 'starting') {
          console.log(`🎮 [${bot.name}] Game is starting!`);
        }
      } else {
        console.log(`❌ [${bot.name}] Failed: ${result.error}`);
      }
    } catch (e) {
      console.log(`❌ [${bot.name}] Error: ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('');
  console.log('Waiting for game to start...');
  console.log('(Join from the web UI to fill the queue, or run more bots)');
  console.log('Press Ctrl+C to exit');
  console.log('');

  // Poll for game start
  let gameStarted = false;
  let lastStatus = '';
  
  while (!gameStarted) {
    await new Promise(r => setTimeout(r, 2000));
    
    try {
      const currentQueues = await getQueues();
      const currentQueue = currentQueues.find(q => q.id === targetQueue.id);
      
      if (currentQueue) {
        const status = `${currentQueue.currentPlayers}/${currentQueue.maxPlayers} [${currentQueue.status}]`;
        if (status !== lastStatus) {
          console.log(`  Queue status: ${status}`);
          lastStatus = status;
        }
        
        if (currentQueue.status === 'starting' || currentQueue.status === 'in_progress') {
          console.log('');
          console.log('🎮 Game started!');
          gameStarted = true;
          
          // Simulate game for each bot
          console.log('');
          for (const bot of bots) {
            await simulateBotGame(bot, currentQueue.tablePda);
          }
        }
      }
    } catch (e) {
      // Ignore fetch errors during polling
    }
  }

  console.log('');
  console.log('✅ Bot session complete!');
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down bots...');
  process.exit(0);
});

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
