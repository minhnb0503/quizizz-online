/**
 * @module network
 * @description MQTT-based multiplayer networking for the Wayground quiz app.
 * Uses the Paho MQTT.js client to communicate via broker.hivemq.com over
 * WSS (port 8884).  Provides connection resilience with auto-reconnect
 * (up to 3 attempts) and message deduplication.
 *
 * Message protocol — JSON payloads with a `type` field:
 *   REQ_JOIN, REGISTER_LOBBY, SYNC_QUESTIONS, START_GAME,
 *   SCORE_UPDATE, HOST_TICK_TIMER, HOST_FORCE_END_ROUND,
 *   HOST_NEXT_ROUND, HOST_END_GAME
 */

import { GameState, resetRoundState } from './state.js';
import { generateRoomCode, deepClone, escapeHtml, setTextContent } from './utils.js';
import { playSound } from './audio.js';
import {
  $,
  switchScreen,
  showModal,
  hideModal,
  renderLobbyPlayers,
  renderLeaderboard,
  updateTimerBar,
  showCorrectAnswer,
  showMemeFeedback,
  hideMemeFeedback,
  resetAnswerOptions,
} from './ui.js';
import { handleOptionClick, executeNewRound, showResults } from './game.js';
import { calculateQuality, updateCardReview } from './spaced-repetition.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** MQTT broker hostname. */
const BROKER_HOST = 'broker.hivemq.com';

/** MQTT broker WSS port. */
const BROKER_PORT = 8884;

/** Maximum auto-reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** Delay between reconnect attempts (ms). */
const RECONNECT_DELAY_MS = 3000;

/** Prefix for the MQTT topic namespace. */
const TOPIC_PREFIX = 'wayground/room/';

/** Interval for host timer sync broadcasts (ms). */
const HOST_TIMER_SYNC_INTERVAL_MS = 500;

/* ------------------------------------------------------------------ */
/*  Module state                                                      */
/* ------------------------------------------------------------------ */

/** @type {number} Current reconnect attempt counter. */
let reconnectAttempts = 0;

/** @type {number|null} Reconnect timer ID. */
let reconnectTimerId = null;

/** @type {Set<string>} Seen message IDs for deduplication. */
const seenMessageIds = new Set();

/** @type {number} Auto-incrementing message counter. */
let messageCounter = 0;

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Initialise the MQTT network connection for a given room.
 *
 * @param {string}   roomCode    - The room code to join/create.
 * @param {Function} onConnected - Callback invoked once connected.
 */
export function initializeNetwork(roomCode, onConnected) {
  if (!roomCode) {
    console.error('[Network] Room code is required.');
    return;
  }

  /* Prevent double-connections */
  if (GameState.mqttClient && GameState.mqttClient.isConnected()) {
    console.warn('[Network] Already connected — disconnecting first.');
    disconnectNetwork();
  }

  GameState.roomCode = roomCode;
  reconnectAttempts = 0;
  seenMessageIds.clear();

  const clientId = `wayground_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const topic = TOPIC_PREFIX + roomCode;

  /* Paho.MQTT.Client is expected on the global scope (loaded via CDN) */
  if (typeof Paho === 'undefined' || !Paho.MQTT) {
    console.error('[Network] Paho MQTT library not loaded.');
    showModal('Lỗi kết nối', 'Thư viện MQTT chưa được tải. Hãy kiểm tra kết nối mạng.');
    return;
  }

  const client = new Paho.MQTT.Client(BROKER_HOST, BROKER_PORT, clientId);
  GameState.mqttClient = client;

  /* Connection lost handler */
  client.onConnectionLost = (responseObject) => {
    console.warn('[Network] Connection lost:', responseObject.errorMessage || 'unknown');
    updateConnectionStatus('disconnected');

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      scheduleReconnect(roomCode, onConnected);
    } else {
      showModal('Mất kết nối', 'Không thể kết nối lại. Vui lòng thử lại sau.');
    }
  };

  /* Message handler */
  client.onMessageArrived = (mqttMessage) => {
    try {
      const payload = JSON.parse(mqttMessage.payloadString);
      handleNetworkMessage(payload);
    } catch (err) {
      console.error('[Network] Failed to parse message:', err);
    }
  };

  /* Connect */
  updateConnectionStatus('connecting');

  client.connect({
    useSSL: true,
    timeout: 10,
    onSuccess: () => {
      reconnectAttempts = 0;
      client.subscribe(topic);
      updateConnectionStatus('connected');

      if (typeof onConnected === 'function') {
        onConnected();
      }
    },
    onFailure: (err) => {
      console.error('[Network] Connection failed:', err.errorMessage || err);
      updateConnectionStatus('disconnected');

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        scheduleReconnect(roomCode, onConnected);
      } else {
        showModal('Lỗi kết nối', 'Không thể kết nối đến máy chủ MQTT.');
      }
    },
  });
}

/**
 * Send a JSON payload to the current room topic.
 *
 * @param {object} payload - Data to broadcast.
 */
export function sendMessage(payload) {
  const client = GameState.mqttClient;
  if (!client || !client.isConnected()) {
    console.warn('[Network] Cannot send — not connected.');
    return;
  }

  /* Attach message ID for deduplication and sender identity */
  messageCounter += 1;
  const enriched = {
    ...payload,
    _msgId: `${client.clientId}_${messageCounter}`,
    _sender: GameState.myName || 'anonymous',
    _ts: Date.now(),
  };

  const topic = TOPIC_PREFIX + GameState.roomCode;
  const message = new Paho.MQTT.Message(JSON.stringify(enriched));
  message.destinationName = topic;

  try {
    client.send(message);
  } catch (err) {
    console.error('[Network] Send failed:', err);
  }
}

/**
 * Cleanly disconnect from the MQTT broker and clear reconnect timers.
 */
export function disconnectNetwork() {
  clearReconnectTimer();
  clearHostTimer();

  const client = GameState.mqttClient;
  if (client) {
    try {
      if (client.isConnected()) {
        client.disconnect();
      }
    } catch (err) {
      console.warn('[Network] Disconnect error (non-fatal):', err);
    }
    GameState.mqttClient = null;
  }

  updateConnectionStatus('disconnected');
  GameState.roomCode = null;
  GameState.networkPlayers = [];
  seenMessageIds.clear();
}

/**
 * Join an existing room as a regular player (non-host).
 *
 * @param {string} roomCode - The room code to join.
 * @param {string} nickname - Display name for this player.
 */
export function joinRoomAsPlayer(roomCode, nickname) {
  if (!roomCode || roomCode.length === 0) {
    showModal('Lỗi', 'Vui lòng nhập mã phòng.');
    return;
  }
  if (!nickname || nickname.trim().length === 0) {
    nickname = 'Thành_Viên_Mới';
  }

  GameState.isHost = false;
  GameState.myName = nickname.trim();
  GameState.gameMode = 'multi';

  initializeNetwork(roomCode, () => {
    sendMessage({
      type: 'REQ_JOIN',
      nickname: GameState.myName,
    });
    switchScreen(null, 'lobby-screen');
    playSound('join');
  });
}

/**
 * Create and host a new room for a given topic.
 *
 * @param {string} topicName - Topic to play in the hosted game.
 */
export function hostRoom(topicName) {
  const topicQuestions = GameState.globalDatabase[topicName];
  if (!topicQuestions || topicQuestions.length === 0) {
    showModal('Lỗi', 'Không tìm thấy câu hỏi cho chủ đề này.');
    return;
  }

  const roomCode = generateRoomCode();
  GameState.isHost = true;
  GameState.myName = 'Host';
  GameState.gameMode = 'multi';
  GameState.activeTopicPlayingName = topicName;
  GameState.networkPlayers = [{ nickname: 'Host', score: 0, isHost: true }];

  /* Prepare questions */
  const cloned = deepClone(topicQuestions);
  GameState.questions = cloned;

  initializeNetwork(roomCode, () => {
    sendMessage({
      type: 'REGISTER_LOBBY',
      nickname: 'Host',
      topicName,
    });

    /* Show room code in lobby */
    const codeEl = $('room-code-display');
    if (codeEl) setTextContent(codeEl, roomCode);

    renderLobbyPlayers(GameState.networkPlayers);
    switchScreen(null, 'lobby-screen');
    playSound('join');
  });
}

/**
 * Host broadcasts START_GAME with synced questions.
 */
export function broadcastStartGame() {
  if (!GameState.isHost) return;

  if (GameState.networkPlayers.length < 2) {
    showModal('Thông báo', 'Cần ít nhất 2 người chơi để bắt đầu.');
    return;
  }

  /* Sync questions to all players */
  sendMessage({
    type: 'SYNC_QUESTIONS',
    questions: GameState.questions,
    topicName: GameState.activeTopicPlayingName,
  });

  /* Small delay to let sync arrive before start */
  setTimeout(() => {
    sendMessage({ type: 'START_GAME' });

    /* Host also starts */
    resetRoundState();
    switchScreen(null, 'game-screen');
    executeNewRound(0);
    runHostTimer();
  }, 300);
}

/**
 * Start the host's authoritative timer that syncs to all clients.
 * Sends a timer tick every HOST_TIMER_SYNC_INTERVAL_MS (500ms).
 */
export function runHostTimer() {
  clearHostTimer();

  if (!GameState.isHost) return;

  const timeLimitMs = GameState.TIME_LIMIT_PER_QUESTION_SEC * 1000;
  const startTime = Date.now();

  GameState.hostTimerInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, timeLimitMs - elapsed);
    const progress = remaining / timeLimitMs;

    sendMessage({
      type: 'HOST_TICK_TIMER',
      remaining,
      progress,
      questionIdx: GameState.currentIdx,
    });

    if (remaining <= 0) {
      clearHostTimer();

      sendMessage({
        type: 'HOST_FORCE_END_ROUND',
        questionIdx: GameState.currentIdx,
      });

      /* After the answer display window, move to next round */
      setTimeout(() => {
        const nextIdx = GameState.currentIdx + 1;
        if (nextIdx >= GameState.questions.length) {
          sendMessage({ type: 'HOST_END_GAME' });
          showResults();
        } else {
          sendMessage({
            type: 'HOST_NEXT_ROUND',
            questionIdx: nextIdx,
          });
          executeNewRound(nextIdx);
          runHostTimer();
        }
      }, GameState.SHOW_ANSWER_WINDOW_SEC * 1000);
    }
  }, HOST_TIMER_SYNC_INTERVAL_MS);
}

/* ------------------------------------------------------------------ */
/*  Message handler                                                   */
/* ------------------------------------------------------------------ */

/**
 * Process an incoming MQTT message payload.
 *
 * @param {object} msg - Parsed JSON message.
 * @private
 */
function handleNetworkMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;

  /* Deduplication */
  if (msg._msgId) {
    if (seenMessageIds.has(msg._msgId)) return;
    seenMessageIds.add(msg._msgId);

    /* Prevent unbounded memory growth */
    if (seenMessageIds.size > 5000) {
      const iterator = seenMessageIds.values();
      for (let i = 0; i < 2500; i++) {
        seenMessageIds.delete(iterator.next().value);
      }
    }
  }

  switch (msg.type) {
    case 'REQ_JOIN':
      handleReqJoin(msg);
      break;

    case 'REGISTER_LOBBY':
      handleRegisterLobby(msg);
      break;

    case 'SYNC_QUESTIONS':
      handleSyncQuestions(msg);
      break;

    case 'START_GAME':
      handleStartGame();
      break;

    case 'SCORE_UPDATE':
      handleScoreUpdate(msg);
      break;

    case 'HOST_TICK_TIMER':
      handleHostTickTimer(msg);
      break;

    case 'HOST_FORCE_END_ROUND':
      handleHostForceEndRound(msg);
      break;

    case 'HOST_NEXT_ROUND':
      handleHostNextRound(msg);
      break;

    case 'HOST_END_GAME':
      handleHostEndGame();
      break;

    default:
      console.warn('[Network] Unknown message type:', msg.type);
  }
}

/* ------------------------------------------------------------------ */
/*  Individual message handlers                                       */
/* ------------------------------------------------------------------ */

/**
 * Handle a player requesting to join (host only).
 * @param {object} msg
 * @private
 */
function handleReqJoin(msg) {
  if (!GameState.isHost) return;

  const nickname = sanitizeNickname(msg.nickname);
  const alreadyJoined = GameState.networkPlayers.some(
    (p) => p.nickname === nickname
  );

  if (!alreadyJoined) {
    GameState.networkPlayers.push({ nickname, score: 0, isHost: false });
    renderLobbyPlayers(GameState.networkPlayers);
    playSound('join');

    /* Broadcast updated lobby to everyone */
    sendMessage({
      type: 'REGISTER_LOBBY',
      players: GameState.networkPlayers,
    });
  }
}

/**
 * Handle lobby registration broadcast (players receive roster).
 * @param {object} msg
 * @private
 */
function handleRegisterLobby(msg) {
  if (GameState.isHost) return;

  if (Array.isArray(msg.players)) {
    GameState.networkPlayers = msg.players;
    renderLobbyPlayers(GameState.networkPlayers);
  }
}

/**
 * Handle question sync from host (players only).
 * @param {object} msg
 * @private
 */
function handleSyncQuestions(msg) {
  if (GameState.isHost) return;

  if (Array.isArray(msg.questions)) {
    GameState.questions = msg.questions;
    GameState.activeTopicPlayingName = msg.topicName || 'Multiplayer';
  }
}

/**
 * Handle the START_GAME broadcast (players only).
 * @private
 */
function handleStartGame() {
  if (GameState.isHost) return;

  resetRoundState();
  switchScreen(null, 'game-screen');
  executeNewRound(0);
}

/**
 * Handle a player's score update (host collects, everyone renders).
 * @param {object} msg
 * @private
 */
function handleScoreUpdate(msg) {
  const nickname = sanitizeNickname(msg._sender);
  const player = GameState.networkPlayers.find((p) => p.nickname === nickname);

  if (player) {
    player.score = typeof msg.score === 'number' ? msg.score : player.score;
  } else {
    GameState.networkPlayers.push({
      nickname,
      score: msg.score || 0,
      isHost: false,
    });
  }

  renderLeaderboard(GameState.networkPlayers);
}

/**
 * Handle timer sync from host (players only).
 * @param {object} msg
 * @private
 */
function handleHostTickTimer(msg) {
  if (GameState.isHost) return;

  if (typeof msg.progress === 'number') {
    updateTimerBar(msg.progress);
  }
}

/**
 * Handle forced round end from host (players only).
 * @param {object} msg
 * @private
 */
function handleHostForceEndRound(msg) {
  if (GameState.isHost) return;

  /* Force timeout behavior if player hasn't answered */
  if (GameState.canAnswer) {
    GameState.canAnswer = false;

    const q = GameState.questions[GameState.currentIdx];
    if (q) {
      GameState.wrongAnswersCount += 1;
      GameState.currentStreak = 0;
      showCorrectAnswer(q.correct, -1);
      updateCardReview(q, GameState.activeTopicPlayingName, 0);
    }

    showMemeFeedback(false);
  }
}

/**
 * Handle host advancing to the next round (players only).
 * @param {object} msg
 * @private
 */
function handleHostNextRound(msg) {
  if (GameState.isHost) return;

  const nextIdx = typeof msg.questionIdx === 'number' ? msg.questionIdx : GameState.currentIdx + 1;
  hideMemeFeedback();
  executeNewRound(nextIdx);
}

/**
 * Handle host ending the game (players only).
 * @private
 */
function handleHostEndGame() {
  if (GameState.isHost) return;
  showResults();
}

/* ------------------------------------------------------------------ */
/*  Reconnect logic                                                   */
/* ------------------------------------------------------------------ */

/**
 * Schedule an automatic reconnect attempt after a delay.
 *
 * @param {string}   roomCode    - The room to reconnect to.
 * @param {Function} onConnected - Original connected callback.
 * @private
 */
function scheduleReconnect(roomCode, onConnected) {
  clearReconnectTimer();
  reconnectAttempts += 1;

  console.warn(
    `[Network] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY_MS}ms`
  );
  updateConnectionStatus('reconnecting');

  reconnectTimerId = setTimeout(() => {
    initializeNetwork(roomCode, onConnected);
  }, RECONNECT_DELAY_MS);
}

/**
 * Clear any pending reconnect timer.
 * @private
 */
function clearReconnectTimer() {
  if (reconnectTimerId != null) {
    clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }
}

/* ------------------------------------------------------------------ */
/*  Host timer helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Clear the host's authoritative timer interval.
 * @private
 */
function clearHostTimer() {
  if (GameState.hostTimerInterval != null) {
    clearInterval(GameState.hostTimerInterval);
    GameState.hostTimerInterval = null;
  }
}

/* ------------------------------------------------------------------ */
/*  UI helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Update the connection status indicator in the UI.
 *
 * @param {'connected'|'connecting'|'reconnecting'|'disconnected'} status
 * @private
 */
function updateConnectionStatus(status) {
  const indicator = $('connection-status');
  if (!indicator) return;

  const labels = {
    connected: '🟢 Đã kết nối',
    connecting: '🟡 Đang kết nối…',
    reconnecting: '🟡 Đang kết nối lại…',
    disconnected: '🔴 Mất kết nối',
  };

  setTextContent(indicator, labels[status] || status);
  indicator.className = `connection-status ${status}`;
}

/**
 * Sanitize a nickname to a safe, bounded string.
 *
 * @param {string} raw - Raw nickname input.
 * @returns {string} Cleaned nickname.
 * @private
 */
function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return 'Ẩn danh';
  const cleaned = raw.trim().slice(0, 20);
  return cleaned.length > 0 ? cleaned : 'Ẩn danh';
}
