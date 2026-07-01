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

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------
// Card-place sounds use .ogg -- if your actual files have a different
// extension (the original request said ".aug", which isn't a real audio
// format, so this assumes it was a typo for ".ogg"), just change the 4
// filenames below to match.
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

// Preload every sound once as a reusable <audio> element. We don't reuse
// the SAME element for overlapping/rapid-fire plays though -- see
// playSound() below, which clones a fresh Audio() each time so quick
// successive sounds don't cut each other off.
const SOUND_CACHE = {};
[...CARD_PLACE_SOUNDS, ...DRAW_SOUNDS, ...PACK_OPEN_SOUNDS].forEach((src) => {
  const audio = new Audio(src);
  audio.preload = 'auto';
  SOUND_CACHE[src] = audio;
});

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Plays one sound from `list` at random. Clones the cached element so
// overlapping calls (rapid-fire card sounds) don't interrupt each other --
// reusing one shared <audio> element would restart-and-cut-off on every
// call instead of layering naturally.
function playSound(list) {
  const src = pickRandom(list);
  const cached = SOUND_CACHE[src];
  const node = cached ? cached.cloneNode(true) : new Audio(src);
  // Swallow play() rejections quietly -- browsers block autoplay before
  // any user interaction, which can briefly happen right as the page
  // loads; once the player has clicked anything at all, this won't fire.
  node.play().catch(() => {});
}

function playPackOpenSound() {
  playSound(PACK_OPEN_SOUNDS);
}

// A randomized gap (ms) between two consecutive sounds in a burst --
// shared by both the multi-card-play case (greed) and the multi-card-
// draw case (gluttony etc), so neither ever sounds metronomic.
function randomGap() {
  return 60 + Math.random() * 160; // ~60-220ms
}

// Tracks the highest event id already turned into a sound, so repeated
// polls (which always return the same recent-events window) never
// double-play a sound for something already handled. Starts at -1 (no
// events processed yet) rather than 0, since event ids start at 1.
let lastProcessedEventId = -1;

// Consumes state.events (in id order) and triggers sound for each new
// one. All NEW events arriving in a single poll are treated as one
// "burst" and staggered together -- e.g. greed playing 3 cards shows up
// as 3 separate events (1 play_sin + 2 play_commandment) that all
// arrive in the same poll response, and should sound like 3 quick,
// unevenly-spaced taps, not 3 simultaneous sounds or one sound per
// 1.5s poll cycle. A `draw` event with count > 1 (e.g. gluttony's 3
// commandment cards at once) staggers its own multiple sounds the same
// way, inline within the burst.
function processSoundEvents(events) {
  if (!events || events.length === 0) return;

  const newEvents = events.filter((ev) => ev.id > lastProcessedEventId);
  if (newEvents.length === 0) return;
  lastProcessedEventId = Math.max(...newEvents.map((ev) => ev.id));

  let elapsed = 0;
  for (const ev of newEvents) {
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

// Tracks whether the bottom-of-hand UI is showing the normal card list or
// the greed follow-up picker. Local UI state only -- the server doesn't
// know about it until a card is actually submitted. (Envy no longer has
// a picker: it auto-targets the next player, same as sloth/lust/gluttony.)
let mode = 'normal'; // 'normal' | 'greed_followup' | 'pride_commandment' | 'react_pride_commandment'
let greedSelected = []; // up to 2 indices into hand_blue chosen for greed's follow-up
// When pride needs a commandment card (proactive or reactive), we store
// what kind of request to fire after the player picks the card.
let prideContext = null; // null | 'proactive' | 'reactive'

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
  let res;
  try {
    res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        // Free ngrok URLs show an HTML warning page on first contact
        // instead of forwarding the request -- this header tells ngrok
        // to skip that and forward straight through. Harmless to send
        // to any other kind of server.
        'ngrok-skip-browser-warning': 'true',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Could not reach the server at ${SERVER_URL}.`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(
      'The server responded with something unexpected (not game data). ' +
      'If this is an ngrok address, open it directly in a new browser ' +
      'tab once and click through any ngrok warning page, then retry.'
    );
  }
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
    if (p.pending_lust_burns > 0) {
      line += ` — owes ${p.pending_lust_burns} sin burn(s)`;
    }
    if (p.pride_immune) {
      line += ' — immune (pride)';
    }
    li.textContent = line;
    list.appendChild(li);
  }

  // --- my own spectator notice (eliminated OR already won) ---
  const myInfo = state.your_hand;
  if (myInfo) {
    $('myUsedSins').textContent = myInfo.used_sins.length > 0
      ? `Sins you've used: ${myInfo.used_sins.join(', ')}`
      : "Sins you've used: none yet";
  } else {
    $('myUsedSins').textContent = '';
  }

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
        playPackOpenSound();
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
    $('lustBurnSection').style.display = 'none';
    $('reactionSection').style.display = 'none';
    $('prideCommandmentSection').style.display = 'none';
    return;
  }

  // Lust burns are highest priority -- resolve before anything else.
  if (isMyTurn && myInfo.pending_lust_burns > 0) {
    $('noMovesSection').style.display = 'none';
    $('greedFollowupSection').style.display = 'none';
    $('reactionSection').style.display = 'none';
    $('prideCommandmentSection').style.display = 'none';
    renderLustBurnPicker(myInfo);
    return;
  }
  $('lustBurnSection').style.display = 'none';

  // Sloth reaction: it's my turn but I have a pending skip to resolve first.
  // Show wrath/pride/accept options instead of the normal hand.
  const hasPendingSloth = isMyTurn && myInfo.pending_sloth_reaction;
  const hasPendingReaction = isMyTurn && state.pending_reaction && state.pending_reaction.target === myName;
  if (hasPendingSloth || hasPendingReaction) {
    $('noMovesSection').style.display = 'none';
    $('greedFollowupSection').style.display = 'none';
    $('prideCommandmentSection').style.display = 'none';
    renderReactionPicker(state, myInfo);
    return;
  }
  $('reactionSection').style.display = 'none';

  // While picking a pride commandment card or greed follow-ups,
  // hide the normal hand buttons.
  if (mode === 'pride_commandment' || mode === 'react_pride_commandment') {
    $('greedFollowupSection').style.display = 'none';
    return;
  }
  $('prideCommandmentSection').style.display = 'none';

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
    // Wrath is only usable when you have a pending reaction to resolve
    // (on your own turn now -- no longer an out-of-turn interrupt).
    if (sin === 'wrath') {
      const canReactWrath = hasPendingReaction && state.pending_reaction.can_wrath;
      btn.disabled = !canReactWrath;
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
  if (sin === 'greed') {
    enterGreedFollowupMode();
    return;
  }
  // Pride always requires a commandment card -- show the picker before submitting.
  if (sin === 'pride') {
    prideContext = 'proactive';
    enterPrideCommandmentMode();
    return;
  }
  // Wrath on your own turn means reacting to a pending punishment.
  if (sin === 'wrath') {
    reactWrath();
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

// greedSelected now tracks the INDEX of each chosen card within
// your_hand.hand_blue, not its value -- this is what makes duplicate
// cards (e.g. two separate "orange truth" cards) independently
// selectable instead of being treated as interchangeable. The server
// itself still only cares about {value, color} (it has no concept of
// "which specific copy"), so we translate index -> {value, color} only
// at the moment we actually send the request.
function renderGreedChoices(state) {
  const container = $('greedFollowupChoices');
  container.innerHTML = '';

  const myInfo = state.your_hand;
  const atSelectionLimit = greedSelected.length >= 2;

  myInfo.hand_blue.forEach((card, index) => {
    const isPicked = greedSelected.includes(index);
    const btn = document.createElement('button');
    btn.textContent = cardLabel(card) + (isPicked ? ' (selected)' : '');
    // A selected card stays clickable so the player can deselect it.
    // An unselected card becomes disabled once 2 are already chosen,
    // since greed allows at most 2 follow-up cards.
    btn.disabled = !isPicked && atSelectionLimit;
    btn.addEventListener('click', () => toggleGreedCard(index, state));
    container.appendChild(btn);
  });

  $('greedSelectedText').textContent =
    greedSelected.length === 0
      ? 'none'
      : greedSelected.map((i) => cardLabel(myInfo.hand_blue[i])).join(', ');
}

function toggleGreedCard(index, state) {
  const pos = greedSelected.indexOf(index);
  if (pos >= 0) {
    greedSelected.splice(pos, 1);
  } else if (greedSelected.length < 2) {
    greedSelected.push(index);
  }
  renderGreedChoices(state);
}

$('confirmGreedBtn').addEventListener('click', async () => {
  try {
    const myInfo = lastKnownState.your_hand;
    // Translate the chosen INDICES into the {value, color} shape the
    // server expects, one per selected card -- this is also where
    // duplicates get resolved correctly: if both indices happen to
    // point at "orange truth" (because the player explicitly picked
    // both copies), the server receives two separate follow-up entries
    // and plays both, exactly as it should.
    const followups = greedSelected.map((i) => ({
      value: myInfo.hand_blue[i].commandment,
      color: myInfo.hand_blue[i].color,
    }));
    await callApi(`/game/${gameId}/play`, 'POST', {
      name: myName,
      type: 'sin',
      value: 'greed',
      greed_followups: followups,
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

// ----- reaction picker (sloth/lust/gluttony pending reaction) -----
function renderReactionPicker(state, myInfo) {
  const section = $('reactionSection');
  section.style.display = '';
  const container = $('reactionChoices');
  container.innerHTML = '';

  const pendingReaction = state.pending_reaction;
  const hasPendingSloth = myInfo.pending_sloth_reaction;
  const sin = pendingReaction ? pendingReaction.sin : 'sloth';

  $('reactionPrompt').textContent = hasPendingSloth || sin === 'sloth'
    ? `You are being skipped (sloth). You may fight back or accept the skip.`
    : `${pendingReaction.from} hit you with ${sin}. You may react or accept the punishment.`;

  // Wrath option
  const canWrath = pendingReaction ? pendingReaction.can_wrath : myInfo.hand_sins.includes('wrath');
  if (canWrath) {
    const btn = document.createElement('button');
    btn.textContent = sin === 'sloth'
      ? 'Use wrath (A misses their next 2 turns)'
      : 'Use wrath (undo punishment, redirect doubled to original thrower)';
    btn.addEventListener('click', reactWrath);
    container.appendChild(btn);
  }

  // Pride option
  const canPride = pendingReaction ? pendingReaction.can_pride : myInfo.hand_sins.includes('pride');
  if (canPride) {
    const btn = document.createElement('button');
    btn.textContent = sin === 'sloth'
      ? 'Use pride (skip undone, you get immunity + play a free card)'
      : 'Use pride (punishment undone, immunity granted, play a free card)';
    btn.addEventListener('click', () => {
      prideContext = 'reactive';
      enterPrideCommandmentMode();
    });
    container.appendChild(btn);
  }

  // Accept option
  const acceptBtn = document.createElement('button');
  acceptBtn.textContent = sin === 'sloth'
    ? 'Accept skip (skip your turn)'
    : 'Accept punishment (do nothing)';
  acceptBtn.addEventListener('click', acceptPunishment);
  container.appendChild(acceptBtn);
}

async function reactWrath() {
  try {
    await callApi(`/game/${gameId}/react_wrath`, 'POST', { name: myName });
    setMessage('');
    mode = 'normal';
  } catch (err) {
    setMessage(err.message);
  }
}

async function acceptPunishment() {
  try {
    await callApi(`/game/${gameId}/accept_skip`, 'POST', { name: myName });
    setMessage('');
  } catch (err) {
    setMessage(err.message);
  }
}

// ----- pride commandment picker (proactive pride OR reactive pride) -----
function enterPrideCommandmentMode() {
  $('reactionSection').style.display = 'none';
  $('greedFollowupSection').style.display = 'none';
  $('noMovesSection').style.display = 'none';
  $('myBlueCards').innerHTML = '';
  $('mySinCards').innerHTML = '';
  mode = prideContext === 'reactive' ? 'react_pride_commandment' : 'pride_commandment';
  renderPrideCommandmentChoices(lastKnownState);
}

function renderPrideCommandmentChoices(state) {
  const section = $('prideCommandmentSection');
  section.style.display = '';
  const container = $('prideCommandmentChoices');
  container.innerHTML = '';

  const myInfo = state.your_hand;
  $('prideCommandmentPrompt').textContent = prideContext === 'reactive'
    ? 'Use pride to undo the punishment. Choose any commandment card to play alongside it (free/wild):'
    : 'Choose any commandment card to play alongside pride (free/wild):';

  for (let i = 0; i < myInfo.hand_blue.length; i++) {
    const card = myInfo.hand_blue[i];
    const btn = document.createElement('button');
    btn.textContent = cardLabel(card);
    btn.addEventListener('click', () => confirmPride(card));
    container.appendChild(btn);
  }

  if (myInfo.hand_blue.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'You have no commandment cards to play with pride.';
    container.appendChild(p);
  }
}

async function confirmPride(card) {
  try {
    if (prideContext === 'reactive') {
      await callApi(`/game/${gameId}/react_pride`, 'POST', {
        name: myName,
        commandment: card.commandment,
        color: card.color,
      });
    } else {
      // Proactive pride: use the /play route with the commandment in greed_followups
      await callApi(`/game/${gameId}/play`, 'POST', {
        name: myName,
        type: 'sin',
        value: 'pride',
        greed_followups: [{ value: card.commandment, color: card.color }],
      });
    }
    setMessage('');
  } catch (err) {
    setMessage(err.message);
  }
  exitSpecialMode();
}

$('cancelPrideBtn').addEventListener('click', exitSpecialMode);

function exitSpecialMode() {
  mode = 'normal';
  prideContext = null;
  greedSelected = [];
  $('greedFollowupSection').style.display = 'none';
  $('prideCommandmentSection').style.display = 'none';
  $('reactionSection').style.display = 'none';
}

// ----- forced lust burn -----
// Shows whichever choice applies: if the player holds sin cards, they
// pick one to burn; if they hold none, there's nothing to pick -- a
// single button just triggers drawing-then-burning automatically.
function renderLustBurnPicker(myInfo) {
  const section = $('lustBurnSection');
  section.style.display = '';

  $('lustBurnPrompt').textContent = myInfo.hand_sins.length > 0
    ? `You must burn ${myInfo.pending_lust_burns} sin card(s) before playing (lust). Choose one to burn now:`
    : `You must burn ${myInfo.pending_lust_burns} sin card(s) before playing (lust). You have none -- draw one to burn:`;

  const container = $('lustBurnChoices');
  container.innerHTML = '';

  if (myInfo.hand_sins.length > 0) {
    for (const sin of myInfo.hand_sins) {
      const btn = document.createElement('button');
      btn.textContent = `Burn ${sin}`;
      btn.addEventListener('click', () => resolveLustBurn(sin));
      container.appendChild(btn);
    }
  } else {
    const btn = document.createElement('button');
    btn.textContent = 'Draw and burn';
    btn.addEventListener('click', () => resolveLustBurn(null));
    container.appendChild(btn);
  }
}

async function resolveLustBurn(chosenSin) {
  try {
    const body = { name: myName };
    if (chosenSin) body.sin = chosenSin;
    await callApi(`/game/${gameId}/burn_sin`, 'POST', body);
    setMessage('');
  } catch (err) {
    setMessage(err.message);
  }
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

    // Detect a rematch: the server resets its event-id counter back to 1
    // on every fresh round, so if the new batch's ids are LOWER than
    // what we've already processed, the game was reset out from under
    // us -- clear the tracker so the new round's events play sounds
    // again instead of being silently skipped as "already seen".
    if (state.events && state.events.length > 0) {
      const maxNewId = Math.max(...state.events.map((ev) => ev.id));
      if (maxNewId < lastProcessedEventId) {
        lastProcessedEventId = -1;
      }
    }
    processSoundEvents(state.events);

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
