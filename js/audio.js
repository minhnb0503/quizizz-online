/**
 * @module audio
 * @description Procedural sound effects using the Web Audio API.
 * All sounds are generated with oscillators — zero external audio files.
 *
 * Supported sound types:
 *   - 'good'     — rising two-tone chime for correct answers
 *   - 'bad'      — low descending buzz for wrong answers
 *   - 'tick'     — soft click for timer countdown (last 3 s)
 *   - 'complete' — ascending arpeggio for round completion
 *   - 'flip'     — filtered noise whoosh for flashcard flip
 */

import { GameState } from './state.js';


// ─── Constants ─────────────────────────────────────────────────────────────

/** Master gain level (0–1) for all sound effects */
const MASTER_VOLUME = 0.25;

/** Duration constants in seconds */
const DUR = {
  GOOD_NOTE: 0.12,
  GOOD_GAP: 0.08,
  BAD: 0.25,
  TICK: 0.05,
  ARPEGGIO_NOTE: 0.10,
  ARPEGGIO_GAP: 0.06,
  FLIP: 0.15
};

/** Frequencies for the "complete" arpeggio (C5–E5–G5–C6) */
const ARPEGGIO_NOTES = [523.25, 659.25, 783.99, 1046.50];


// ─── AudioContext Management ───────────────────────────────────────────────

/**
 * Ensure the shared AudioContext exists and is in the `running` state.
 * Browsers require a user gesture before allowing audio playback; call this
 * inside a click/touch handler to satisfy that policy.
 *
 * @returns {AudioContext} The active audio context.
 */
export function ensureAudioContext() {
  if (!GameState.audioCtx) {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxClass) {
      // Environment has no Web Audio support — return a stub-safe object
      // (all play calls will bail out via the muted check anyway)
      return null;
    }
    GameState.audioCtx = new AudioCtxClass();
  }

  // Resume if suspended (autoplay policy)
  if (GameState.audioCtx.state === 'suspended') {
    GameState.audioCtx.resume().catch(() => {
      // Swallow — user hasn't interacted yet
    });
  }

  return GameState.audioCtx;
}


// ─── Internal Helpers ──────────────────────────────────────────────────────

/**
 * Create a gain node connected to the context destination with the given volume.
 *
 * @param {AudioContext} ctx
 * @param {number} volume — 0–1 gain value.
 * @returns {GainNode}
 */
function _makeGain(ctx, volume) {
  const gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  return gain;
}

/**
 * Schedule a single oscillator tone.
 *
 * @param {AudioContext} ctx
 * @param {GainNode} dest — Destination node to connect to.
 * @param {string} waveType — 'sine' | 'square' | 'sawtooth' | 'triangle'
 * @param {number} freq — Frequency in Hz.
 * @param {number} startTime — AudioContext time to start.
 * @param {number} duration — Length in seconds.
 * @param {number} [endFreq] — Optional end frequency for a slide.
 */
function _scheduleTone(ctx, dest, waveType, freq, startTime, duration, endFreq) {
  const osc = ctx.createOscillator();
  osc.type = waveType;
  osc.frequency.setValueAtTime(freq, startTime);
  if (typeof endFreq === 'number') {
    osc.frequency.linearRampToValueAtTime(endFreq, startTime + duration);
  }
  osc.connect(dest);
  osc.start(startTime);
  osc.stop(startTime + duration);
}


// ─── Sound Generators ──────────────────────────────────────────────────────

/**
 * Play the "correct answer" sound — two rising sine tones.
 * @param {AudioContext} ctx
 */
function _playGood(ctx) {
  const now = ctx.currentTime;
  const gain = _makeGain(ctx, MASTER_VOLUME);

  // Envelope: quick fade-out to avoid click
  gain.gain.setValueAtTime(MASTER_VOLUME, now);
  gain.gain.linearRampToValueAtTime(0, now + DUR.GOOD_NOTE * 2 + DUR.GOOD_GAP + 0.05);

  _scheduleTone(ctx, gain, 'sine', 587.33, now, DUR.GOOD_NOTE);                              // D5
  _scheduleTone(ctx, gain, 'sine', 880.00, now + DUR.GOOD_NOTE + DUR.GOOD_GAP, DUR.GOOD_NOTE); // A5
}

/**
 * Play the "wrong answer" sound — low descending sawtooth buzz.
 * @param {AudioContext} ctx
 */
function _playBad(ctx) {
  const now = ctx.currentTime;
  const gain = _makeGain(ctx, MASTER_VOLUME * 0.7);

  gain.gain.setValueAtTime(MASTER_VOLUME * 0.7, now);
  gain.gain.linearRampToValueAtTime(0, now + DUR.BAD + 0.05);

  _scheduleTone(ctx, gain, 'sawtooth', 220, now, DUR.BAD, 110); // A3 → A2 slide down
}

/**
 * Play a soft tick sound for the countdown timer.
 * @param {AudioContext} ctx
 */
function _playTick(ctx) {
  const now = ctx.currentTime;
  const gain = _makeGain(ctx, MASTER_VOLUME * 0.4);

  gain.gain.setValueAtTime(MASTER_VOLUME * 0.4, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + DUR.TICK + 0.04);

  _scheduleTone(ctx, gain, 'sine', 1200, now, DUR.TICK); // short high click
}

/**
 * Play an ascending arpeggio for round completion.
 * @param {AudioContext} ctx
 */
function _playComplete(ctx) {
  const now = ctx.currentTime;
  const gain = _makeGain(ctx, MASTER_VOLUME);

  const totalDuration = ARPEGGIO_NOTES.length * (DUR.ARPEGGIO_NOTE + DUR.ARPEGGIO_GAP);
  gain.gain.setValueAtTime(MASTER_VOLUME, now);
  gain.gain.linearRampToValueAtTime(0, now + totalDuration + 0.15);

  for (let i = 0; i < ARPEGGIO_NOTES.length; i++) {
    const t = now + i * (DUR.ARPEGGIO_NOTE + DUR.ARPEGGIO_GAP);
    _scheduleTone(ctx, gain, 'triangle', ARPEGGIO_NOTES[i], t, DUR.ARPEGGIO_NOTE);
  }
}

/**
 * Play a filtered-noise whoosh for flashcard flip.
 * Uses a bandpass-filtered white-noise burst to simulate a soft "swipe" sound.
 * @param {AudioContext} ctx
 */
function _playFlip(ctx) {
  const now = ctx.currentTime;
  const duration = DUR.FLIP;

  // Create white noise buffer
  const sampleRate = ctx.sampleRate;
  const bufferLength = Math.ceil(sampleRate * duration);
  const noiseBuffer = ctx.createBuffer(1, bufferLength, sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferLength; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;

  // Bandpass filter to shape the noise into a "whoosh"
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(2000, now);
  filter.frequency.linearRampToValueAtTime(800, now + duration);
  filter.Q.value = 1.5;

  // Gain envelope: quick attack, smooth decay
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(MASTER_VOLUME * 0.5, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  source.start(now);
  source.stop(now + duration);
}


// ─── Dispatch Map ──────────────────────────────────────────────────────────

/**
 * Map of sound type strings to their generator functions.
 * @type {Object<string, function(AudioContext): void>}
 */
const SOUND_MAP = {
  good: _playGood,
  bad: _playBad,
  tick: _playTick,
  complete: _playComplete,
  flip: _playFlip
};


// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Play a sound effect by type name.
 * No-ops silently if audio is muted or the AudioContext is unavailable.
 *
 * @param {'good'|'bad'|'tick'|'complete'|'flip'} type — Sound to play.
 *
 * @example
 * playSound('good');   // correct answer chime
 * playSound('tick');   // timer countdown tick
 */
export function playSound(type) {
  if (GameState.audioMuted) return;

  const ctx = ensureAudioContext();
  if (!ctx) return;

  const generator = SOUND_MAP[type];
  if (!generator) {
    console.warn(`[audio] Unknown sound type: "${type}"`);
    return;
  }

  try {
    generator(ctx);
  } catch (err) {
    // Web Audio can throw if context is in a bad state
    console.warn(`[audio] Failed to play "${type}":`, err);
  }
}

/**
 * Toggle the global mute flag.
 *
 * @returns {boolean} The new muted state (`true` = muted, `false` = unmuted).
 *
 * @example
 * const isMuted = toggleMute();
 * muteButton.textContent = isMuted ? '🔇' : '🔊';
 */
export function toggleMute() {
  GameState.audioMuted = !GameState.audioMuted;
  return GameState.audioMuted;
}
