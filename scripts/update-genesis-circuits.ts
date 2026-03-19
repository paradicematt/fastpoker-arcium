/**
 * Updates the genesis JSON files in artifacts/ with fresh circuit bytecode
 * from build/*.arcis. This is needed because arcium localnet pre-seeds these
 * accounts at genesis, and uploadCircuit() skips accounts that already exist.
 * 
 * Run: npx ts-node --transpile-only scripts/update-genesis-circuits.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const ARTIFACTS = path.resolve(__dirname, '..', 'artifacts');
const BUILD = path.resolve(__dirname, '..', 'build');

// Circuit name -> genesis JSON file pattern
const CIRCUITS = ['shuffle_and_deal', 'reveal_community', 'reveal_showdown'];

for (const circuit of CIRCUITS) {
  const arcisPath = path.join(BUILD, `${circuit}.arcis`);
  if (!fs.existsSync(arcisPath)) {
    console.log(`  ${circuit}: .arcis not found, skipping`);
    continue;
  }
  
  const arcisData = fs.readFileSync(arcisPath);
  console.log(`${circuit}: ${arcisData.length} bytes from ${arcisPath}`);

  // Find matching genesis JSON files (e.g. shuffle_and_deal_raw_circuit_0.json)
  const genesisFiles = fs.readdirSync(ARTIFACTS)
    .filter(f => f.startsWith(`${circuit}_raw_circuit_`) && f.endsWith('.json'))
    .sort();

  if (genesisFiles.length === 0) {
    console.log(`  No genesis files found for ${circuit}`);
    continue;
  }

  // Calculate chunk sizes (same logic as @arcium-hq/client)
  const MAX_ACCOUNT_SIZE = 10_485_760; // 10MB
  const HEADER_SIZE = 9; // 8-byte discriminator + 1-byte bump
  const MAX_CIRCUIT_PER_ACC = MAX_ACCOUNT_SIZE - HEADER_SIZE;
  const numChunks = Math.ceil(arcisData.length / MAX_CIRCUIT_PER_ACC);

  console.log(`  ${genesisFiles.length} genesis files, need ${numChunks} chunks`);

  for (let i = 0; i < numChunks; i++) {
    const genesisFile = genesisFiles[i];
    if (!genesisFile) {
      console.log(`  WARNING: Need chunk ${i} but no genesis file exists for it`);
      continue;
    }

    const genesisPath = path.join(ARTIFACTS, genesisFile);
    const genesis = JSON.parse(fs.readFileSync(genesisPath, 'utf8'));

    // Extract the chunk of circuit data for this account
    const start = i * MAX_CIRCUIT_PER_ACC;
    const end = Math.min(start + MAX_CIRCUIT_PER_ACC, arcisData.length);
    const chunk = arcisData.subarray(start, end);

    // Read existing account data to get discriminator + bump (first 9 bytes)
    const existingData = Buffer.from(genesis.account.data[0], 'base64');
    const header = existingData.subarray(0, HEADER_SIZE);

    // Build new account data: header (9 bytes) + new circuit chunk
    const newData = Buffer.concat([header, chunk]);

    // The account size might need to match or exceed the original
    // Pad with zeros if the new data is smaller than the account allocation
    const accountSize = Math.max(newData.length, existingData.length);
    const paddedData = Buffer.alloc(accountSize);
    newData.copy(paddedData);

    // Update the genesis JSON
    genesis.account.data[0] = paddedData.toString('base64');

    fs.writeFileSync(genesisPath, JSON.stringify(genesis));
    console.log(`  Updated ${genesisFile}: header(${HEADER_SIZE}) + circuit(${chunk.length}) = ${paddedData.length} bytes`);
  }

  // Handle case where old genesis had more chunks than needed
  for (let i = numChunks; i < genesisFiles.length; i++) {
    console.log(`  WARNING: Extra genesis file ${genesisFiles[i]} — old circuit had more chunks`);
  }
}

console.log('\nDone. Restart localnet to pick up the new genesis data.');
