/**
 * Poker Sound Effects Engine
 * 
 * Synthesizes all standard poker table sounds using Web Audio API.
 * No external files needed — all sounds are generated procedurally.
 * 
 * Sounds: cardDeal, cardFlip, chipBet, chipCollect, check, fold,
 *         allIn, yourTurn, timerTick, timerWarning, win, newHand
 */

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

// ─── Utility: create noise buffer ───
function createNoiseBuffer(ctx: AudioContext, duration: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

// ─── Card Deal — quick "thwip" slide ───
export function playCardDeal() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // Filtered white noise burst
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.08);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(3000, now);
  bp.frequency.exponentialRampToValueAtTime(6000, now + 0.04);
  bp.Q.value = 1.5;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.3, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
  noise.connect(bp).connect(gain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.08);

  // Subtle click at start
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1200, now);
  osc.frequency.exponentialRampToValueAtTime(400, now + 0.03);
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.15, now);
  clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
  osc.connect(clickGain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.03);
}

// ─── Card Flip — for community cards ───
export function playCardFlip() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.12);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2000, now);
  bp.frequency.exponentialRampToValueAtTime(5000, now + 0.06);
  bp.Q.value = 2;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.25, now);
  gain.gain.linearRampToValueAtTime(0.35, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  noise.connect(bp).connect(gain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.12);

  // "Snap" transient
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(800, now);
  osc.frequency.exponentialRampToValueAtTime(200, now + 0.05);
  const snapGain = ctx.createGain();
  snapGain.gain.setValueAtTime(0.2, now);
  snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
  osc.connect(snapGain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.05);
}

// ─── Chip Bet — ceramic chips clinking ───
export function playChipBet() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // Layer 3 quick "clink" tones at slightly different times
  const freqs = [4200, 5800, 3600];
  const delays = [0, 0.025, 0.05];
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + delays[i]);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, now + delays[i] + 0.06);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now + delays[i]);
    gain.gain.exponentialRampToValueAtTime(0.001, now + delays[i] + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + delays[i]);
    osc.stop(now + delays[i] + 0.08);
  });

  // Add noise texture
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.1);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 6000;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.08, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
  noise.connect(hp).connect(noiseGain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.1);
}

// ─── Chip Collect — winning pot, longer cascade ───
export function playChipCollect() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // Rapid succession of chip clinks
  for (let i = 0; i < 8; i++) {
    const t = now + i * 0.04;
    const freq = 3500 + Math.random() * 3000;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + 0.06);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.1 + Math.random() * 0.05, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  // Subtle swipe noise underneath
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.35);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 5000;
  bp.Q.value = 0.8;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.06, now);
  noiseGain.gain.linearRampToValueAtTime(0.1, now + 0.15);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
  noise.connect(bp).connect(noiseGain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.35);
}

// ─── Check — double tap on table ───
export function playCheck() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  [0, 0.08].forEach((delay) => {
    const t = now + delay;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.04);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);

    // Impact noise
    const noise = ctx.createBufferSource();
    noise.buffer = createNoiseBuffer(ctx, 0.03);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 800;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.15, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    noise.connect(lp).connect(nGain).connect(ctx.destination);
    noise.start(t);
    noise.stop(t + 0.03);
  });
}

// ─── Fold — swoosh card toss ───
export function playFold() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // Swoosh noise
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.2);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(1000, now);
  bp.frequency.exponentialRampToValueAtTime(4000, now + 0.1);
  bp.frequency.exponentialRampToValueAtTime(2000, now + 0.2);
  bp.Q.value = 1;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.01, now);
  gain.gain.linearRampToValueAtTime(0.2, now + 0.06);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  noise.connect(bp).connect(gain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.2);
}

// ─── All-In — dramatic rising tone + chip cascade ───
export function playAllIn() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // Rising dramatic tone
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(200, now);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.3);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(400, now);
  lp.frequency.exponentialRampToValueAtTime(2000, now + 0.3);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.linearRampToValueAtTime(0.2, now + 0.2);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
  osc.connect(lp).connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.4);

  // Big chip push (delayed)
  for (let i = 0; i < 12; i++) {
    const t = now + 0.15 + i * 0.03;
    const freq = 3000 + Math.random() * 4000;
    const chipOsc = ctx.createOscillator();
    chipOsc.type = 'sine';
    chipOsc.frequency.setValueAtTime(freq, t);
    chipOsc.frequency.exponentialRampToValueAtTime(freq * 0.4, t + 0.05);
    const chipGain = ctx.createGain();
    chipGain.gain.setValueAtTime(0.08 + Math.random() * 0.06, t);
    chipGain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    chipOsc.connect(chipGain).connect(ctx.destination);
    chipOsc.start(t);
    chipOsc.stop(t + 0.07);
  }
}

// ─── Your Turn — gentle notification bell ───
export function playYourTurn() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // Two-note chime: ascending
  [660, 880].forEach((freq, i) => {
    const t = now + i * 0.12;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.3);

    // Harmonic overtone
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, t);
    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0.06, t);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(t);
    osc2.stop(t + 0.2);
  });
}

// ─── Timer Tick — subtle clock tick ───
export function playTimerTick() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1800, now);
  osc.frequency.exponentialRampToValueAtTime(800, now + 0.015);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.1, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.03);
}

// ─── Timer Warning — urgent beeps (last 5 seconds) ───
export function playTimerWarning() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(880, now);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.12, now);
  gain.gain.setValueAtTime(0.12, now + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.08);
}

// ─── Win — ascending celebratory arpeggio ───
export function playWin() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // C major arpeggio: C5 E5 G5 C6
  const notes = [523, 659, 784, 1047];
  notes.forEach((freq, i) => {
    const t = now + i * 0.1;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.5);

    // Softer octave up
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, t);
    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0.05, t);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(t);
    osc2.stop(t + 0.3);
  });

  // Delayed chip collect sound
  setTimeout(() => playChipCollect(), 350);
}

// ─── New Hand — shuffle sound ───
export function playNewHand() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // Extended riffle/shuffle noise
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.5);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2000, now);
  bp.frequency.linearRampToValueAtTime(4000, now + 0.15);
  bp.frequency.linearRampToValueAtTime(2500, now + 0.3);
  bp.frequency.linearRampToValueAtTime(5000, now + 0.45);
  bp.Q.value = 2;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.01, now);
  gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
  gain.gain.linearRampToValueAtTime(0.08, now + 0.2);
  gain.gain.linearRampToValueAtTime(0.18, now + 0.3);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  noise.connect(bp).connect(gain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.5);
}

// ─── Master volume control ───
let masterVolume = 1.0;
let soundEnabled = true;

export function setSoundEnabled(enabled: boolean) {
  soundEnabled = enabled;
}

export function getSoundEnabled(): boolean {
  return soundEnabled;
}

export function setMasterVolume(vol: number) {
  masterVolume = Math.max(0, Math.min(1, vol));
}

export function getMasterVolume(): number {
  return masterVolume;
}

// ─── Wrapped play functions with volume/mute control ───
type SoundName = 'cardDeal' | 'cardFlip' | 'chipBet' | 'chipCollect' | 'check' | 'fold' | 'allIn' | 'yourTurn' | 'timerTick' | 'timerWarning' | 'win' | 'newHand';

const soundMap: Record<SoundName, () => void> = {
  cardDeal: playCardDeal,
  cardFlip: playCardFlip,
  chipBet: playChipBet,
  chipCollect: playChipCollect,
  check: playCheck,
  fold: playFold,
  allIn: playAllIn,
  yourTurn: playYourTurn,
  timerTick: playTimerTick,
  timerWarning: playTimerWarning,
  win: playWin,
  newHand: playNewHand,
};

export function playSound(name: SoundName) {
  if (!soundEnabled) return;
  if (typeof window === 'undefined') return;
  try {
    soundMap[name]();
  } catch (e) {
    // Silently fail — audio might not be available
  }
}

// Initialize audio context on first user interaction
export function initAudio() {
  if (typeof window === 'undefined') return;
  const handler = () => {
    getCtx();
    window.removeEventListener('click', handler);
    window.removeEventListener('keydown', handler);
    window.removeEventListener('touchstart', handler);
  };
  window.addEventListener('click', handler, { once: true });
  window.addEventListener('keydown', handler, { once: true });
  window.addEventListener('touchstart', handler, { once: true });
}
