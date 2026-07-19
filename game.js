// game.js -- Sins & Commandments gameplay screen

const params = new URLSearchParams(window.location.search);
const gameId = params.get('gid');
const myName = params.get('name');
const SERVER_URL = (params.get('server') || 'http://127.0.0.1:5000').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------
const CARD_PLACE_SOUNDS = [
  'assets/sfx/card-place-1.ogg',
  'assets/sfx/card-place-2.ogg',
  'assets/sfx/card-place-3.ogg',
  'assets/sfx/card-place-4.ogg',
];
const DRAW_SOUNDS = [
  'assets/sfx/draw_card_1.mp3',
  'assets/sfx/draw_card_2.mp3',
];
const PACK_OPEN_SOUNDS = [
  'assets/sfx/cards-pack-open-1.ogg',
  'assets/sfx/cards-pack-open-2.ogg',
];

const SOUND_CACHE = {};
[...CARD_PLACE_SOUNDS, ...DRAW_SOUNDS, ...PACK_OPEN_SOUNDS].forEach((src) => {
  const a = new Audio(src);
  a.preload = 'auto';
  SOUND_CACHE[src] = a;
});

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function playSound(list) {
  const src = pickRandom(list);
  const node = (SOUND_CACHE[src] ? SOUND_CACHE[src].cloneNode(true) : new Audio(src));
  node.play().catch(() => {});
}

function playPackOpenSound() { playSound(PACK_OPEN_SOUNDS); }

function randomGap() { return 60 + Math.random() * 160; }

let lastProcessedEventId = -1;

function processSoundEvents(events) {
  if (!events || !events.length) return;
  const newEvs = events.filter((e) => e.id > lastProcessedEventId);
  if (!newEvs.length) return;
  lastProcessedEventId = Math.max(...newEvs.map((e) => e.id));
  let elapsed = 0;
  for (const ev of newEvs) {
    if (ev.type === 'play_commandment' || ev.type === 'play_sin') {
      setTimeout(() => playSound(CARD_PLACE_SOUNDS), elapsed);
      elapsed += randomGap();
    } else if (ev.type === 'draw') {
      const count = ev.count || 1;
      for (let i = 0; i < count; i++) {
        setTimeout(() => playSound(DRAW_SOUNDS), elapsed);
        elapsed += randomGap();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

async function callApi(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(SERVER_URL + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Server error');
  return data;
}

function setMessage(msg) {
  $('messageText').textContent = msg;
}

function cardLabel(card) {
  return `${card.commandment} (${card.color})`;
}

function cardMatches(card, state) {
  if (state.wild_open || !state.last_played) return true;
  return card.color === state.last_played.color ||
         card.commandment === state.last_played.commandment;
}

async function fetchState() {
  return callApi(`/game/${gameId}/state?name=${encodeURIComponent(myName)}`);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render(state) {
  // Table state
  // Show the single most-recent card on the table.
  // If a commandment was last played, show its name and color.
  // If a sin was last played (making the table wild/open), show the sin name.
  // If the table is wild-open at game start with nothing played yet, show "Open".
  let lastCardText = '—';
  if (state.last_played && state.last_sin_played) {
    // Both exist -- whichever is newer is the true last card. We can't know
    // which is newer from the snapshot alone, but the server sets wild_open=true
    // after any sin play and wild_open=false after any commandment play, so:
    // wild_open=true means a sin was played more recently than any commandment.
    lastCardText = state.wild_open
      ? `${state.last_sin_played.sin} (by ${state.last_sin_played.by}) — table is open`
      : `${state.last_played.commandment} (${state.last_played.color})`;
  } else if (state.last_played) {
    lastCardText = `${state.last_played.commandment} (${state.last_played.color})`;
  } else if (state.last_sin_played) {
    lastCardText = `${state.last_sin_played.sin} (by ${state.last_sin_played.by}) — table is open`;
  } else if (state.wild_open) {
    lastCardText = 'Open (game start)';
  }
  $('lastPlayed').textContent = lastCardText;

  // Turn order -- only active players
  const activePlayers = new Set(
    state.players.filter((p) => !p.eliminated && !p.has_won).map((p) => p.name)
  );
  $('turnOrder').textContent = state.turn_order.filter((n) => activePlayers.has(n)).join(' → ');
  $('currentTurn').textContent = state.finished ? '—' : (state.current_player || '—');

  // Other players
  const list = $('otherPlayers');
  list.innerHTML = '';
  for (const p of state.players) {
    if (p.name === myName) continue;
    const li = document.createElement('li');
    let line = `${p.name}: ${p.blue_count} commandment(s), ${p.black_count} sin(s)`;
    if (p.used_sins.length > 0) line += ` — used: ${p.used_sins.join(', ')}`;
    if (p.restrictions.length > 0) line += ` — restricted: ${p.restrictions.join(', ')}`;
    if (p.eliminated) line += ' — eliminated';
    if (p.has_won) line += ' — won';
    if (p.pride_immune) line += ' — pride immune';
    li.textContent = line;
    list.appendChild(li);
  }

  const myInfo = state.your_hand;
  if (!myInfo) return;

  // Used sins
  $('myUsedSins').textContent = myInfo.used_sins.length > 0
    ? `Sins used: ${myInfo.used_sins.join(', ')}`
    : 'Sins used: none yet';

  // Spectating
  if (myInfo.eliminated || myInfo.has_won) {
    $('spectatorNotice').style.display = '';
    $('spectatorText').textContent = myInfo.has_won ? 'You won! Spectating...' : 'You were eliminated. Spectating...';
    $('myTurnNotice').style.display = 'none';
    $('myBlueCards').innerHTML = '';
    $('mySinCards').innerHTML = '';
    $('noMovesSection').style.display = 'none';
    $('turnContextBanner').style.display = 'none';
    $('prideFollowupSection').style.display = 'none';
    $('greedFollowupSection').style.display = 'none';
    renderGameOver(state);
    return;
  }
  $('spectatorNotice').style.display = 'none';

  // Game over
  if (state.finished) {
    renderGameOver(state);
    renderHand(state, false);
    return;
  }
  $('gameOverSection').style.display = 'none';

  const isMyTurn = state.current_player === myName;
  $('myTurnNotice').style.display = isMyTurn ? '' : 'none';

  // Defer to special modes
  if (mode === 'pride_followup') {
    renderPrideFollowup(state);
    return;
  }
  if (mode === 'greed_followup') {
    $('greedFollowupSection').style.display = '';
    renderGreedChoices(state);
    $('prideFollowupSection').style.display = 'none';
    return;
  }
  $('greedFollowupSection').style.display = 'none';
  $('prideFollowupSection').style.display = 'none';

  renderHand(state, isMyTurn);
}

function renderGameOver(state) {
  if (!state.finished) return;
  $('gameOverSection').style.display = '';
  $('gameOverText').textContent = state.winners.includes(myName)
    ? '🎉 You won!'
    : state.losers.includes(myName)
    ? '💀 You were eliminated.'
    : 'Game over.';
  $('gameOverDetails').textContent = `Winners: ${state.winners.join(', ')} | Losers: ${state.losers.join(', ')}`;
  renderRematchArea(state);
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
        playPackOpenSound();
        setMessage('');
      } catch (err) { setMessage(err.message); }
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
  const banner = $('turnContextBanner');
  blueDiv.innerHTML = '';
  sinDiv.innerHTML = '';
  banner.style.display = 'none';
  $('noMovesSection').style.display = 'none';

  if (!myInfo || myInfo.eliminated || myInfo.has_won) return;
  if (!isMyTurn) {
    // Show cards but disabled
    renderBlueCards(myInfo, state, false);
    renderSinCards(myInfo, state, false, null);
    return;
  }

  // Determine what mode we're in based on server state
  const myRestriction = myInfo.restrictions.length > 0 ? myInfo.restrictions[0] : null;
  const gluttonyWindow = state.last_gluttony && state.last_gluttony.target === myName;

  if (myRestriction === 'sloth') {
    banner.style.display = '';
    banner.textContent = 'SLOTH RESTRICTION: You may play wrath, use pride, or accept the skip. No commandments.';
    renderSinCards(myInfo, state, true, 'sloth');
    // Accept button
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept skip (take the sloth penalty)';
    acceptBtn.addEventListener('click', () => acceptTurn());
    sinDiv.appendChild(acceptBtn);
    return;
  }

  if (myRestriction === 'lust') {
    banner.style.display = '';
    banner.textContent = 'LUST RESTRICTION: You must play a sin card (it burns with no effect, unless you use wrath or pride). No commandments.';
    renderSinCards(myInfo, state, true, 'lust');
    return;
  }

  if (gluttonyWindow) {
    banner.style.display = '';
    banner.textContent = 'GLUTTONY WINDOW: You may play wrath (undo + double back) or pride (undo + immunity) as your first card, or play normally.';
  }

  // Normal turn (or gluttony window — wrath/pride enabled in sin section)
  renderBlueCards(myInfo, state, true);
  renderSinCards(myInfo, state, true, gluttonyWindow ? 'gluttony_window' : null);

  // Forced draw if no valid moves
  const hasValidBlue = myInfo.hand_blue.some((c) => cardMatches(c, state));
  const hasPlayableSin = myInfo.hand_sins.some((s) =>
    !myInfo.used_sins.includes(s) && (s !== 'wrath' || gluttonyWindow)
  );
  if (!hasValidBlue && !hasPlayableSin) {
    $('noMovesSection').style.display = '';
  }
}

function renderBlueCards(myInfo, state, enabled) {
  const blueDiv = $('myBlueCards');
  for (const card of myInfo.hand_blue) {
    const btn = document.createElement('button');
    btn.textContent = cardLabel(card);
    const valid = cardMatches(card, state);
    btn.disabled = !enabled || !valid;
    btn.addEventListener('click', () => playCommandment(card));
    blueDiv.appendChild(btn);
  }
}

function renderSinCards(myInfo, state, enabled, context) {
  // context: null | 'sloth' | 'lust' | 'gluttony_window'
  const sinDiv = $('mySinCards');
  for (const sin of myInfo.hand_sins) {
    const alreadyUsed = myInfo.used_sins.includes(sin);
    const btn = document.createElement('button');
    let label = sin;
    let disabled = !enabled || alreadyUsed;
    let clickHandler = null;

    if (alreadyUsed) {
      label = `${sin} (already used)`;
    } else if (context === 'sloth') {
      // Sloth restriction: only wrath and pride are allowed
      if (sin === 'wrath') {
        label = 'Wrath — redirect 2 sloth skips back to thrower';
        clickHandler = () => playSinUnderRestriction('wrath');
      } else if (sin === 'pride') {
        label = 'Pride — cancel skip, gain immunity, play a free card';
        clickHandler = () => startPrideFollowup('restriction_sloth');
      } else {
        disabled = true; // can't play other sins under sloth
        label = `${sin} (not allowed under sloth)`;
      }
    } else if (context === 'lust') {
      // Lust restriction: must play a sin (burns with no effect unless wrath/pride)
      if (sin === 'wrath') {
        label = 'Wrath — redirect 2 lust restrictions back to thrower';
        clickHandler = () => playSinUnderRestriction('wrath');
      } else if (sin === 'pride') {
        label = 'Pride — cancel lust restriction, gain immunity, play a free card';
        clickHandler = () => startPrideFollowup('restriction_lust');
      } else {
        label = `${sin} — burn (no effect, satisfies lust)`;
        clickHandler = () => playSinUnderRestriction(sin);
      }
    } else if (context === 'gluttony_window') {
      // Gluttony window: wrath/pride have special roles
      if (sin === 'wrath') {
        label = 'Wrath — undo gluttony cards, double back to thrower';
        clickHandler = () => playSinNormal('wrath');
      } else if (sin === 'pride') {
        label = 'Pride — undo gluttony cards, gain immunity, play a free card';
        clickHandler = () => startPrideFollowup('gluttony');
      } else {
        label = `${sin} (play normally — closes gluttony window)`;
        clickHandler = () => playSin(sin);
      }
    } else {
      // Normal turn
      if (sin === 'wrath') {
        disabled = true;
        label = 'Wrath (only usable under restriction or after gluttony)';
      } else if (sin === 'pride') {
        label = 'Pride (play + follow with any card)';
        clickHandler = () => startPrideFollowup('normal');
      } else if (sin === 'greed') {
        label = 'Greed (play + optional follow-up cards)';
        clickHandler = () => enterGreedFollowupMode();
      } else {
        clickHandler = () => playSin(sin);
      }
    }

    if (!disabled && clickHandler) btn.addEventListener('click', clickHandler);
    btn.disabled = disabled;
    btn.textContent = label;
    sinDiv.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function playCommandment(card) {
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName, type: 'com',
      value: card.commandment, color: card.color,
      extra_cards: [],
    });
    setMessage('');
  } catch (err) { setMessage(err.message); }
}

async function playSin(sinName) {
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName, type: 'sin', value: sinName, extra_cards: [],
    });
    setMessage('');
  } catch (err) { setMessage(err.message); }
}

async function playSinNormal(sinName) {
  // Used for wrath/pride in gluttony window (wrath has no extra_cards)
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName, type: 'sin', value: sinName, extra_cards: [],
    });
    setMessage('');
  } catch (err) { setMessage(err.message); }
}

async function playSinUnderRestriction(sinName) {
  // Wrath, pride (handled by pride followup), or burn under lust
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName, type: 'sin', value: sinName, extra_cards: [],
    });
    setMessage('');
  } catch (err) { setMessage(err.message); }
}

async function acceptTurn() {
  try {
    await callApi(`/game/${gameId}/accept_turn`, 'POST', { name: myName });
    setMessage('');
  } catch (err) { setMessage(err.message); }
}

$('forcedDrawBtn').addEventListener('click', async () => {
  try {
    await callApi(`/game/${gameId}/forced_draw`, 'POST', { name: myName });
    setMessage('');
  } catch (err) { setMessage(err.message); }
});

// ---------------------------------------------------------------------------
// Pride follow-up card picker
// ---------------------------------------------------------------------------
// prideContext tracks what kind of pride play we're completing:
//   'normal'           -- proactive pride on a normal turn
//   'restriction_sloth' -- pride under sloth restriction
//   'restriction_lust'  -- pride under lust restriction  
//   'gluttony'          -- pride as first card after gluttony
let mode = 'normal'; // 'normal' | 'pride_followup' | 'greed_followup'
let prideContext = null;
let lastKnownState = null;

function startPrideFollowup(context) {
  prideContext = context;
  mode = 'pride_followup';
  // Immediately render the picker with the last known state
  if (lastKnownState) renderPrideFollowup(lastKnownState);
}

function renderPrideFollowup(state) {
  $('greedFollowupSection').style.display = 'none';
  $('noMovesSection').style.display = 'none';
  $('myBlueCards').innerHTML = '';
  $('mySinCards').innerHTML = '';
  $('turnContextBanner').style.display = 'none';

  const section = $('prideFollowupSection');
  section.style.display = '';
  const myInfo = state.your_hand;

  const contextLabels = {
    normal: 'Pride played — choose any card to play alongside it (free/wild):',
    restriction_sloth: 'Pride (sloth) — skip cancelled! Choose any card to play as your free follow-up:',
    restriction_lust: 'Pride (lust) — lust cancelled! Choose any card to play as your free follow-up:',
    gluttony: 'Pride (gluttony) — cards undone! Choose any card to play as your free follow-up:',
  };
  $('prideFollowupPrompt').textContent = contextLabels[prideContext] || 'Choose a follow-up card:';

  const blueDiv = $('prideFollowupBlueCards');
  const sinDiv = $('prideFollowupSinCards');
  blueDiv.innerHTML = '';
  sinDiv.innerHTML = '';

  for (const card of myInfo.hand_blue) {
    const btn = document.createElement('button');
    btn.textContent = cardLabel(card);
    btn.addEventListener('click', () => confirmPrideFollowup({ type: 'com', value: card.commandment, color: card.color }));
    blueDiv.appendChild(btn);
  }

  for (const sin of myInfo.hand_sins) {
    if (myInfo.used_sins.includes(sin)) continue;
    if (sin === 'wrath') continue; // can't follow pride with wrath
    if (sin === 'pride') continue; // can't chain pride
    const btn = document.createElement('button');
    btn.textContent = `${sin} (play as follow-up)`;
    btn.addEventListener('click', () => confirmPrideFollowup({ type: 'sin', value: sin }));
    sinDiv.appendChild(btn);
  }

  if (myInfo.hand_blue.length === 0 && sinDiv.children.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No cards available for follow-up.';
    blueDiv.appendChild(p);
  }
}

async function confirmPrideFollowup(followupCard) {
  // Determine which sin name to play (always 'pride')
  // The server expects the 'pride' sin play with extra_cards = [followupCard]
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName,
      type: 'sin',
      value: 'pride',
      extra_cards: [followupCard],
    });
    setMessage('');
  } catch (err) { setMessage(err.message); }
  exitSpecialMode();
}

$('cancelPrideFollowupBtn').addEventListener('click', exitSpecialMode);

// ---------------------------------------------------------------------------
// Greed follow-up card picker
// ---------------------------------------------------------------------------
let greedSelected = []; // indices into hand_blue

function enterGreedFollowupMode() {
  greedSelected = [];
  mode = 'greed_followup';
  if (lastKnownState) renderGreedChoices(lastKnownState);
}

function renderGreedChoices(state) {
  const myInfo = state.your_hand;
  const container = $('greedFollowupChoices');
  container.innerHTML = '';
  const atLimit = greedSelected.length >= 2;

  myInfo.hand_blue.forEach((card, idx) => {
    const isPicked = greedSelected.includes(idx);
    const btn = document.createElement('button');
    btn.textContent = cardLabel(card) + (isPicked ? ' ✓' : '');
    btn.disabled = !isPicked && atLimit;
    btn.addEventListener('click', () => toggleGreedCard(idx, state));
    container.appendChild(btn);
  });

  $('greedSelectedText').textContent = greedSelected.length === 0
    ? 'none'
    : greedSelected.map((i) => cardLabel(myInfo.hand_blue[i])).join(', ');
}

function toggleGreedCard(idx, state) {
  const pos = greedSelected.indexOf(idx);
  if (pos >= 0) greedSelected.splice(pos, 1);
  else if (greedSelected.length < 2) greedSelected.push(idx);
  renderGreedChoices(state);
}

$('confirmGreedBtn').addEventListener('click', async () => {
  try {
    const myInfo = lastKnownState.your_hand;
    const followups = greedSelected.map((i) => ({
      type: 'com',
      value: myInfo.hand_blue[i].commandment,
      color: myInfo.hand_blue[i].color,
    }));
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName, type: 'sin', value: 'greed', extra_cards: followups,
    });
    setMessage('');
  } catch (err) { setMessage(err.message); }
  exitSpecialMode();
});

$('playGreedAloneBtn').addEventListener('click', async () => {
  try {
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName, type: 'sin', value: 'greed', extra_cards: [],
    });
    setMessage('');
  } catch (err) { setMessage(err.message); }
  exitSpecialMode();
});

$('cancelGreedBtn').addEventListener('click', exitSpecialMode);

function exitSpecialMode() {
  mode = 'normal';
  prideContext = null;
  greedSelected = [];
  $('greedFollowupSection').style.display = 'none';
  $('prideFollowupSection').style.display = 'none';
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
async function pollLoop() {
  try {
    const state = await fetchState();

    // Detect rematch (event ids reset to 1)
    if (state.events && state.events.length > 0) {
      const maxNew = Math.max(...state.events.map((e) => e.id));
      if (maxNew < lastProcessedEventId) lastProcessedEventId = -1;
    }
    processSoundEvents(state.events);

    lastKnownState = state;
    render(state);
  } catch (err) {
    setMessage(err.message);
  }
}

if (!gameId || !myName) {
  setMessage('Missing game ID or name in URL. Go back to start page.');
} else {
  pollLoop();
  setInterval(pollLoop, 1500);
}
