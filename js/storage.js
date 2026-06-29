/**
 * @module storage
 * @description Persistence layer for Wayground.
 * All reads/writes go through localStorage with well-defined keys.
 * Provides export/import for full data backup.
 */

import { GameState } from './state.js';


// ─── Storage Keys ──────────────────────────────────────────────────────────

/**
 * Canonical localStorage key names.
 * Centralised here so no other module needs to know them.
 * @type {Object<string, string>}
 */
const KEYS = {
  DATABASE: 'wayground_ultimate_db',
  RAW_INPUT: 'wayground_raw_input',
  RECENT_LOGS: 'wayground_recent_logs',
  STATS: 'wayground_stats',
  SPACED_REP: 'wayground_spaced_rep',
  SETTINGS: 'wayground_settings',
  COINS: 'wayground_coins'
};


// ─── Internal Helpers ──────────────────────────────────────────────────────

/**
 * Safely read and parse JSON from localStorage.
 *
 * @param {string} key — localStorage key.
 * @returns {*} Parsed value, or `null` if the key is missing or the JSON is invalid.
 */
function _readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[storage] Failed to parse key "${key}":`, err);
    return null;
  }
}

/**
 * Safely serialise a value and write it to localStorage.
 *
 * @param {string} key — localStorage key.
 * @param {*} value — Any JSON-serialisable value.
 * @returns {boolean} `true` if the write succeeded, `false` otherwise (e.g. quota exceeded).
 */
function _writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error(`[storage] Failed to write key "${key}":`, err);
    return false;
  }
}

/**
 * Read a raw string from localStorage (no JSON parsing).
 *
 * @param {string} key
 * @returns {string|null}
 */
function _readRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    console.warn(`[storage] Failed to read key "${key}":`, err);
    return null;
  }
}

/**
 * Write a raw string to localStorage.
 *
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
function _writeRaw(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error(`[storage] Failed to write key "${key}":`, err);
    return false;
  }
}


// ─── Database ──────────────────────────────────────────────────────────────

/**
 * Persist the question database and its original raw text input.
 *
 * @param {Object<string, Array>} db — The parsed database object (topic → questions[]).
 * @param {string} rawText — The raw text the user pasted/typed to create the database.
 * @returns {boolean} `true` if both writes succeeded.
 */
export function saveDatabase(db, rawText) {
  const a = _writeJSON(KEYS.DATABASE, db);
  const b = _writeRaw(KEYS.RAW_INPUT, typeof rawText === 'string' ? rawText : '');
  return a && b;
}

/**
 * Load the question database and its raw source text.
 *
 * @returns {{ db: Object<string, Array>, rawText: string } | null}
 *   `null` if no database has been saved yet.
 */
export function loadDatabase() {
  const db = _readJSON(KEYS.DATABASE);
  if (!db || typeof db !== 'object' || Object.keys(db).length === 0) return null;
  const rawText = _readRaw(KEYS.RAW_INPUT) || '';
  return { db, rawText };
}


// ─── Recent Activity Logs ──────────────────────────────────────────────────

/**
 * Save the recent activity log array.
 *
 * @param {Array<{time: string, message: string, type?: string}>} logs
 * @returns {boolean}
 */
export function saveLogs(logs) {
  return _writeJSON(KEYS.RECENT_LOGS, Array.isArray(logs) ? logs : []);
}

/**
 * Load recent activity logs.
 *
 * @returns {Array<{time: string, message: string, type?: string}>}
 *   Always returns an array (empty if nothing stored).
 */
export function loadLogs() {
  const data = _readJSON(KEYS.RECENT_LOGS);
  return Array.isArray(data) ? data : [];
}


// ─── Long-Term Stats ──────────────────────────────────────────────────────

/**
 * Save aggregated statistics data.
 *
 * @param {Object} statsData — Arbitrary stats object
 *   (e.g. `{ totalGames: 42, totalCorrect: 300, avgAccuracy: 0.72, … }`).
 * @returns {boolean}
 */
export function saveStats(statsData) {
  return _writeJSON(KEYS.STATS, statsData);
}

/**
 * Load aggregated statistics data.
 *
 * @returns {Object|null} The stored stats object, or `null` if none exists.
 */
export function loadStats() {
  return _readJSON(KEYS.STATS);
}


// ─── Spaced Repetition ─────────────────────────────────────────────────────

/**
 * Persist the spaced-repetition metadata map.
 *
 * @param {Object<string, {interval: number, easeFactor: number, repetitions: number, nextReview: number}>} data
 * @returns {boolean}
 */
export function saveSpacedRepData(data) {
  return _writeJSON(KEYS.SPACED_REP, data);
}

/**
 * Load spaced-repetition metadata.
 *
 * @returns {Object<string, {interval: number, easeFactor: number, repetitions: number, nextReview: number}>}
 *   Returns an empty object if nothing stored.
 */
export function loadSpacedRepData() {
  const data = _readJSON(KEYS.SPACED_REP);
  return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}


// ─── User Settings ─────────────────────────────────────────────────────────

/**
 * Save user-configurable settings.
 *
 * @param {Object} settings — e.g. `{ timeLimitSec: 15, showAnswerSec: 4, audioMuted: false }`.
 * @returns {boolean}
 */
export function saveSettings(settings) {
  return _writeJSON(KEYS.SETTINGS, settings);
}

/**
 * Load user settings.
 *
 * @returns {Object|null} The settings object, or `null` if none stored.
 */
export function loadSettings() {
  return _readJSON(KEYS.SETTINGS);
}


// ─── Coins ─────────────────────────────────────────────────────────────────

/**
 * Save the player's coin balance.
 * Convenience wrapper so coins can be persisted independently of stats.
 *
 * @param {number} coins
 * @returns {boolean}
 */
export function saveCoins(coins) {
  return _writeJSON(KEYS.COINS, typeof coins === 'number' ? coins : 0);
}

/**
 * Load the player's coin balance.
 *
 * @returns {number} Coin count (defaults to 0 if nothing stored).
 */
export function loadCoins() {
  const v = _readJSON(KEYS.COINS);
  return typeof v === 'number' ? v : 0;
}


// ─── Full Export / Import ──────────────────────────────────────────────────

/**
 * Export ALL persisted data as a single JSON string.
 * Suitable for downloading as a backup file.
 *
 * @returns {string} Pretty-printed JSON containing every storage key's data.
 */
export function exportAllData() {
  const bundle = {
    _wayground_export: true,
    _exportedAt: new Date().toISOString(),
    _version: 1,
    database: _readJSON(KEYS.DATABASE),
    rawInput: _readRaw(KEYS.RAW_INPUT),
    recentLogs: _readJSON(KEYS.RECENT_LOGS),
    stats: _readJSON(KEYS.STATS),
    spacedRep: _readJSON(KEYS.SPACED_REP),
    settings: _readJSON(KEYS.SETTINGS),
    coins: _readJSON(KEYS.COINS)
  };
  return JSON.stringify(bundle, null, 2);
}

/**
 * Import a previously-exported JSON string and restore all data.
 * Validates the format before overwriting anything.
 *
 * @param {string} jsonString — The JSON string produced by `exportAllData()`.
 * @returns {boolean} `true` if import succeeded, `false` if the data is invalid.
 */
export function importAllData(jsonString) {
  let bundle;
  try {
    bundle = JSON.parse(jsonString);
  } catch (err) {
    console.error('[storage] Import failed — invalid JSON:', err);
    return false;
  }

  // Sanity check: must have our marker
  if (!bundle || bundle._wayground_export !== true) {
    console.error('[storage] Import failed — not a Wayground export file.');
    return false;
  }

  // Restore each key — silently skip nulls (key wasn't present in the export)
  if (bundle.database != null) _writeJSON(KEYS.DATABASE, bundle.database);
  if (bundle.rawInput != null) _writeRaw(KEYS.RAW_INPUT, bundle.rawInput);
  if (bundle.recentLogs != null) _writeJSON(KEYS.RECENT_LOGS, bundle.recentLogs);
  if (bundle.stats != null) _writeJSON(KEYS.STATS, bundle.stats);
  if (bundle.spacedRep != null) _writeJSON(KEYS.SPACED_REP, bundle.spacedRep);
  if (bundle.settings != null) _writeJSON(KEYS.SETTINGS, bundle.settings);
  if (bundle.coins != null) _writeJSON(KEYS.COINS, bundle.coins);

  // Hydrate GameState with the freshly imported data
  const dbResult = loadDatabase();
  if (dbResult) {
    GameState.globalDatabase = dbResult.db;
  }
  GameState.spacedRepData = loadSpacedRepData();
  const coins = loadCoins();
  if (coins > 0) {
    GameState.totalCoins = coins;
  }
  const settings = loadSettings();
  if (settings) {
    if (typeof settings.timeLimitSec === 'number') {
      GameState.TIME_LIMIT_PER_QUESTION_SEC = settings.timeLimitSec;
    }
    if (typeof settings.showAnswerSec === 'number') {
      GameState.SHOW_ANSWER_WINDOW_SEC = settings.showAnswerSec;
    }
    if (typeof settings.audioMuted === 'boolean') {
      GameState.audioMuted = settings.audioMuted;
    }
  }

  return true;
}


// ─── File Download Helper ──────────────────────────────────────────────────

/**
 * Trigger a browser file download with the given content.
 * Creates a temporary `<a>` element with a Blob URL.
 *
 * @param {string} filename — Suggested download filename (e.g. `'wayground-backup.json'`).
 * @param {string} content — File content (UTF-8 text).
 * @param {string} [mimeType='application/json'] — MIME type for the Blob.
 */
export function triggerDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';

  document.body.appendChild(anchor);
  anchor.click();

  // Cleanup — small delay to ensure the download starts
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 150);
}
