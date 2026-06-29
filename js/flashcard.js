/**
 * @module flashcard
 * @description Flashcard study mode for the Wayground quiz application.
 * Provides card-flip interactions, sequential navigation, and
 * completion flow with modal-based UX (never uses alert/confirm).
 */

import { GameState, resetRoundState } from './state.js';
import { deepClone, shuffleArray, setTextContent } from './utils.js';
import { playSound } from './audio.js';
import {
  $,
  switchScreen,
  showModal,
  hideModal,
} from './ui.js';

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Start a flashcard study session for a given topic.
 * Loads questions, shuffles them, resets flashcard state,
 * and renders the first card.
 *
 * @param {string} topicName - The topic key in GameState.globalDatabase.
 */
export function startFlashcardRound(topicName) {
  const topicQuestions = GameState.globalDatabase[topicName];
  if (!topicQuestions || topicQuestions.length === 0) {
    showModal('Lỗi', 'Không tìm thấy câu hỏi cho chủ đề này.');
    return;
  }

  GameState.gameMode = 'flashcard';
  GameState.activeTopicPlayingName = topicName;

  const cloned = deepClone(topicQuestions);
  shuffleArray(cloned);

  GameState.questions = cloned;
  GameState.currentIdx = 0;
  GameState.isFlashcardFlipped = false;

  resetRoundState();
  switchScreen(null, 'flashcard-screen');
  renderCurrentCard();
}

/**
 * Toggle the flip state of the current flashcard.
 * Plays a flip sound and applies/removes the CSS flip class.
 */
export function flipCard() {
  GameState.isFlashcardFlipped = !GameState.isFlashcardFlipped;

  const cardInner = $('flashcard-trigger-inner');
  if (cardInner) {
    if (GameState.isFlashcardFlipped) {
      cardInner.classList.add('flipped');
    } else {
      cardInner.classList.remove('flipped');
    }
  }

  playSound('flip');
}

/**
 * Advance to the next flashcard. If the deck is finished,
 * show a congratulations modal with options to return to
 * the dashboard or restart the deck.
 */
export function nextCard() {
  const nextIdx = GameState.currentIdx + 1;

  if (nextIdx >= GameState.questions.length) {
    showCompletionModal();
    return;
  }

  GameState.currentIdx = nextIdx;
  renderCurrentCard();
  playSound('flip');
}

/**
 * Render the current flashcard based on GameState.currentIdx.
 * Updates the card counter, question (front) text, and answer (back) text.
 * Resets the flip state so the front face is shown.
 */
export function renderCurrentCard() {
  const idx = GameState.currentIdx;
  const questions = GameState.questions;

  if (!questions || idx < 0 || idx >= questions.length) return;

  const q = questions[idx];

  /* Reset flip state */
  GameState.isFlashcardFlipped = false;
  const cardInner = $('flashcard-trigger-inner');
  if (cardInner) {
    cardInner.classList.remove('flipped');
  }

  /* Update counter */
  const counterEl = $('flashcard-counter');
  if (counterEl) {
    setTextContent(counterEl, `${idx + 1} / ${questions.length}`);
  }

  /* Update front face — question text */
  const frontEl = $('flashcard-front-text');
  if (frontEl) {
    setTextContent(frontEl, q.question || '');
  }

  /* Update back face — correct answer text */
  const backEl = $('flashcard-back-text');
  if (backEl) {
    const correctAnswer = getCorrectAnswerText(q);
    setTextContent(backEl, correctAnswer);
  }

  /* Update progress bar if present */
  const progressEl = $('flashcard-progress');
  if (progressEl) {
    const pct = ((idx + 1) / questions.length) * 100;
    progressEl.style.width = `${pct}%`;
  }
}

/* ------------------------------------------------------------------ */
/*  Private helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Extract the correct answer text from a question object.
 *
 * @param {object} q - Question object with `options` and `correct`.
 * @returns {string} The text of the correct answer.
 * @private
 */
function getCorrectAnswerText(q) {
  if (!q || !Array.isArray(q.options)) return '';

  const correctIdx = typeof q.correct === 'number' ? q.correct : 0;
  return q.options[correctIdx] || '';
}

/**
 * Show a completion modal when all flashcards have been viewed.
 * Offers two choices: return to dashboard or restart the deck.
 * @private
 */
function showCompletionModal() {
  const totalCards = GameState.questions.length;

  const modalBody = document.createElement('div');
  modalBody.className = 'flashcard-complete-modal';

  const heading = document.createElement('p');
  heading.className = 'modal-congrats-text';
  setTextContent(heading, `🎉 Chúc mừng! Bạn đã hoàn thành ${totalCards} thẻ!`);
  modalBody.appendChild(heading);

  const btnContainer = document.createElement('div');
  btnContainer.className = 'modal-btn-group';

  /* Button: return to dashboard */
  const btnHome = document.createElement('button');
  btnHome.className = 'btn btn-primary';
  setTextContent(btnHome, 'Về Dashboard');
  btnHome.addEventListener('click', () => {
    hideModal();
    switchScreen(null, 'dashboard-screen');
  });
  btnContainer.appendChild(btnHome);

  /* Button: restart deck */
  const btnRestart = document.createElement('button');
  btnRestart.className = 'btn btn-secondary';
  setTextContent(btnRestart, 'Ôn lại từ đầu');
  btnRestart.addEventListener('click', () => {
    hideModal();
    restartDeck();
  });
  btnContainer.appendChild(btnRestart);

  modalBody.appendChild(btnContainer);

  showModal('Hoàn thành!', modalBody);
  playSound('result');
}

/**
 * Restart the current flashcard deck from the beginning,
 * re-shuffling the cards for variety.
 * @private
 */
function restartDeck() {
  shuffleArray(GameState.questions);
  GameState.currentIdx = 0;
  GameState.isFlashcardFlipped = false;
  renderCurrentCard();
}
