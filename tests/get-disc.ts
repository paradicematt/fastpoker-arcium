import crypto from 'crypto';

const name = process.argv[2] || 'showdown';
const disc = crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
console.log(`${name} discriminator:`, Array.from(disc));
console.log('Buffer:', `Buffer.from([${Array.from(disc).join(', ')}])`);
