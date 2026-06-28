// ---------------------------------------------------------------------------
// game.js -- the actual gameplay screen. Polls the server for state and
// renders it in plain readable text (no raw JSON shown anywhere), and
// turns each card in your hand into a clickable button that plays it.
//
// SERVER_URL, gameId, and myName all come from the URL query string, set
// by index.js when it redirects here after the leader starts the game.
// This means whatever server address you typed on the entry screen (your
// own computer, an ngrok tunnel, a LAN IP, etc) carries through
// automatically -- there's nothing to re-enter on this page.
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const gameId = params.get('gid');
const myName = params.get('name');

// Falls back to localhost only if this page was somehow opened directly
// without going through index.html's redirect (e.g. a stale bookmark) --
// normal play always has ?server=... already filled in by index.js.
const SERVER_URL = (params.get('server') || 'http://127.0.0.1:5000').replace(/\/+$/, '');

// Tracks whether the bottom-of-hand UI is showing the normal card list or
// the greed follow-up picker. Local UI state only -- the server doesn't
// know about it until a card is actually submitted. (Envy no longer has
// a picker: it auto-targets the next player, same as sloth/lust/gluttony.)
let mode = 'normal'; // 'normal' | 'greed_followup'
let greedSelected = []; // up to 2 {value, color} objects chosen for greed's follow-up

// Human-readable labels for colors, since the server's internal names
// (e.g. "bluish_green") aren't what a player should see on a button.
const COLOR_LABELS = {
  blue: 'blue',
  orange: 'orange',
  bluish_green: 'green',
  reddish_purple: 'purple',
};

function $(id) {
  return document.getElementById(id);
}

function cardLabel(card) {
  return `${COLOR_LABELS[card.color] || card.color} ${card.commandment}`;
}

// ----- API helper -----
async function callApi(path, method, body) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

function setMessage(text) {
  $('messageText').textContent = text || '';
}

// ----- fetching state -----
async function fetchState() {
  return callApi(`/game/${gameId}/state?name=${encodeURIComponent(myName)}`, 'GET');
}

// ----- rendering -----
function render(state) {
  // --- table info ---
  $('lastPlayed').textContent = state.last_played
    ? cardLabel(state.last_played)
    : (state.wild_open ? 'open (any card is playable)' : '—');

  $('lastSinPlayed').textContent = state.last_sin_played
    ? `${state.last_sin_played.by} played ${state.last_sin_played.sin}`
    : '—';

  $('turnOrder').textContent = state.turn_order.join(' → ');
  $('currentTurn').textContent = state.finished ? '—' : (state.current_player || '—');

  // --- other players ---
  const list = $('otherPlayers');
  list.innerHTML = '';
  for (const p of state.players) {
    if (p.name === myName) continue;
    const li = document.createElement('li');
    let line = `${p.name}: ${p.blue_count} commandment card(s), ${p.black_count} sin card(s)`;
    if (p.used_sins.length > 0) {
      line += ` — used: ${p.used_sins.join(', ')}`;
    }
    if (p.eliminated) {
      line += ' — eliminated';
    }
    if (p.has_won) {
      line += ' — won, now spectating';
    }
    if (p.pride_immune) {
      line += ' — immune (pride)';
    }
    li.textContent = line;
    list.appendChild(li);
  }

  // --- my own spectator notice (eliminated OR already won) ---
  const myInfo = state.your_hand;
  if (myInfo && myInfo.eliminated) {
    $('spectatorNotice').style.display = '';
    $('spectatorText').textContent = "You've been eliminated. You can keep watching the game.";
  } else if (myInfo && myInfo.has_won && !state.finished) {
    $('spectatorNotice').style.display = '';
    $('spectatorText').textContent = "You've already won! You can keep watching the rest of the game.";
  } else {
    $('spectatorNotice').style.display = 'none';
  }

  // --- whose turn is it ---
  const isSpectating = myInfo && (myInfo.eliminated || myInfo.has_won);
  const isMyTurn = !state.finished && state.current_player === myName && myInfo && !isSpectating;
  $('myTurnNotice').style.display = isMyTurn ? '' : 'none';

  // --- game over handling ---
  if (state.finished) {
    $('gameOverSection').style.display = '';
    if (state.winners.length === 1) {
      $('gameOverText').textContent = state.winners[0] === myName
        ? 'You win!'
        : `${state.winners[0]} wins!`;
      $('gameOverDetails').textContent = '';
    } else if (state.winners.length > 1) {
      const iWon = state.winners.includes(myName);
      $('gameOverText').textContent = iWon ? 'You won!' : 'Game over!';
      $('gameOverDetails').textContent = `Winners, in order: ${state.winners.join(', ')}`;
    } else {
      $('gameOverText').textContent = 'The game has ended.';
      $('gameOverDetails').textContent = '';
    }
    renderRematchArea(state);

    // Hide all the active-play UI once the game's over.
    $('myBlueCards').innerHTML = '';
    $('mySinCards').innerHTML = '';
    $('noMovesSection').style.display = 'none';
    $('greedFollowupSection').style.display = 'none';
    return;
  } else {
    $('gameOverSection').style.display = 'none';
  }

  // --- my hand ---
  renderHand(state, isMyTurn);
}

function renderRematchArea(state) {
  const area = $('rematchArea');
  area.innerHTML = '';
  if (state.leader === myName) {
    const btn = document.createElement('button');
    btn.textContent = 'Play again';
    btn.addEventListener('click', async () => {
      try {
        await callApi(`/game/${gameId}/rematch`, 'POST', { name: myName });
      } catch (err) {
        setMessage(err.message);
      }
    });
    area.appendChild(btn);
  } else {
    const p = document.createElement('p');
    p.textContent = `Waiting for ${state.leader} to start a rematch...`;
    area.appendChild(p);
  }
}

function renderHand(state, isMyTurn) {
  const myInfo = state.your_hand;
  const blueDiv = $('myBlueCards');
  const sinDiv = $('mySinCards');
  blueDiv.innerHTML = '';
  sinDiv.innerHTML = '';

  const isSpectating = myInfo && (myInfo.eliminated || myInfo.has_won);
  if (!myInfo || isSpectating) {
    $('noMovesSection').style.display = 'none';
    $('greedFollowupSection').style.display = 'none';
    return;
  }

  // While picking greed follow-ups, hide the normal hand buttons so the
  // player isn't tempted to click something else mid-selection.
  if (mode === 'greed_followup') {
    return;
  }

  // --- commandment card buttons ---
  for (const card of myInfo.hand_blue) {
    const btn = document.createElement('button');
    btn.textContent = cardLabel(card);
    btn.disabled = !isMyTurn || !cardMatches(card, state);
    btn.addEventListener('click', () => playCommandment(card));
    blueDiv.appendChild(btn);
  }

  // --- sin card buttons ---
  for (const sin of myInfo.hand_sins) {
    const btn = document.createElement('button');
    btn.textContent = sin;
    // Wrath is special: only enabled as a reaction, not on your normal turn.
    const isReactionWindow = state.pending_wrath_target === myName;
    if (sin === 'wrath') {
      btn.disabled = !isReactionWindow;
    } else {
      btn.disabled = !isMyTurn;
    }
    btn.addEventListener('click', () => onSinButtonClicked(sin));
    sinDiv.appendChild(btn);
  }

  // --- no legal move at all ---
  const hasValidBlue = myInfo.hand_blue.some((c) => cardMatches(c, state));
  const hasAnySin = myInfo.hand_sins.length > 0;
  if (isMyTurn && !hasValidBlue && !hasAnySin) {
    $('noMovesSection').style.display = '';
  } else {
    $('noMovesSection').style.display = 'none';
  }

  $('greedFollowupSection').style.display = 'none';
}

function cardMatches(card, state) {
  if (state.wild_open || !state.last_played) return true;
  return card.color === state.last_played.color || card.commandment === state.last_played.commandment;
}

// ----- playing cards -----
async function playCommandment(card) {
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName,
      type: 'com',
      value: card.commandment,
      color: card.color,
    });
    setMessage('');
  } catch (err) {
    setMessage(err.message);
  }
}

function onSinButtonClicked(sin) {
  // sloth/envy/lust/gluttony all auto-target the next player on the
  // server now -- no target picker needed for any of them, including
  // envy. Only greed needs extra UI (the follow-up card picker).
  if (sin === 'greed') {
    enterGreedFollowupMode();
    return;
  }
  playSin(sin);
}

async function playSin(sin) {
  try {
    await callApi(`/game/${gameId}/play`, 'POST', { name: myName, type: 'sin', value: sin });
    setMessage('');
    mode = 'normal';
  } catch (err) {
    setMessage(err.message);
  }
}

// ----- greed follow-up picker -----
function enterGreedFollowupMode() {
  mode = 'greed_followup';
  greedSelected = [];
  $('myBlueCards').innerHTML = '';
  $('mySinCards').innerHTML = '';
  $('noMovesSection').style.display = 'none';

  $('greedFollowupSection').style.display = '';
  renderGreedChoicesFromLastState();
}

// Re-render uses the most recent poll's state, cached here so the picker
// can redraw itself after every selection without re-fetching.
let lastKnownState = null;

function renderGreedChoicesFromLastState() {
  if (lastKnownState) renderGreedChoices(lastKnownState);
}

function renderGreedChoices(state) {
  const container = $('greedFollowupChoices');
  container.innerHTML = '';

  const myInfo = state.your_hand;
  const atSelectionLimit = greedSelected.length >= 2;

  for (const card of myInfo.hand_blue) {
    const alreadyPicked = greedSelected.some(
      (c) => c.value === card.commandment && c.color === card.color
    );
    const btn = document.createElement('button');
    btn.textContent = cardLabel(card) + (alreadyPicked ? ' (selected)' : '');
    // A selected card stays clickable so the player can deselect it.
    // An unselected card becomes disabled once 2 are already chosen,
    // since greed allows at most 2 follow-up cards.
    btn.disabled = !alreadyPicked && atSelectionLimit;
    btn.addEventListener('click', () => toggleGreedCard(card, state));
    container.appendChild(btn);
  }

  $('greedSelectedText').textContent =
    greedSelected.length === 0 ? 'none' : greedSelected.map((c) => cardLabel({ commandment: c.value, color: c.color })).join(', ');
}

function toggleGreedCard(card, state) {
  const idx = greedSelected.findIndex(
    (c) => c.value === card.commandment && c.color === card.color
  );
  if (idx >= 0) {
    greedSelected.splice(idx, 1);
  } else if (greedSelected.length < 2) {
    // IMPORTANT: the server expects each follow-up object to use the key
    // "value" for the commandment name (matching how every other card
    // play is sent), NOT "commandment". Sending the wrong key here makes
    // the server reject the whole greed play as invalid.
    greedSelected.push({ value: card.commandment, color: card.color });
  }
  renderGreedChoices(state);
}

$('confirmGreedBtn').addEventListener('click', async () => {
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName,
      type: 'sin',
      value: 'greed',
      greed_followups: greedSelected,
    });
    setMessage('');
  } catch (err) {
    setMessage(err.message);
  }
  exitSpecialMode();
});

$('playGreedAloneBtn').addEventListener('click', async () => {
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName,
      type: 'sin',
      value: 'greed',
      greed_followups: [],
    });
    setMessage('');
  } catch (err) {
    setMessage(err.message);
  }
  exitSpecialMode();
});

$('cancelGreedBtn').addEventListener('click', exitSpecialMode);

function exitSpecialMode() {
  mode = 'normal';
  greedSelected = [];
  $('greedFollowupSection').style.display = 'none';
}

// ----- forced draw -----
$('forcedDrawBtn').addEventListener('click', async () => {
  try {
    await callApi(`/game/${gameId}/forced_draw`, 'POST', { name: myName });
    setMessage('');
  } catch (err) {
    setMessage(err.message);
  }
});

// ----- polling loop -----
async function pollLoop() {
  try {
    const state = await fetchState();
    lastKnownState = state;
    render(state);
  } catch (err) {
    setMessage(err.message);
  }
}

if (!gameId || !myName) {
  setMessage('Missing game ID or name in the URL. Go back to the start page.');
} else {
  pollLoop();
  setInterval(pollLoop, 1500);
}
