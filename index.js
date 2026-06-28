// ---------------------------------------------------------------------------
// index.js -- lobby screen logic: create a game, join a game, wait for
// other players, and (if you're the leader) start it. Once the server
// reports the game has started, this page redirects everyone to
// game.html, carrying the server address, game ID, and your name along
// in the URL so the game page knows everything it needs without any
// shared browser storage.
//
// The server address is no longer a hardcoded constant -- it's read from
// the "Server address" text field on the page, so each person playing
// can point at wherever the host's server actually is (their own
// computer, an ngrok tunnel, a LAN IP, etc).
// ---------------------------------------------------------------------------

let myName = null;
let gameId = null;
let pollHandle = null;

function $(id) {
  return document.getElementById(id);
}

function getServerUrl() {
  // Trim trailing slashes so "http://host:5000/" and "http://host:5000"
  // both work identically when we build paths like `${serverUrl}/game/...`.
  return $('serverInput').value.trim().replace(/\/+$/, '');
}

function showEntryError(msg) {
  $('entryError').textContent = msg;
}

// ----- screen switching -----
function showLobby() {
  $('entryScreen').style.display = 'none';
  $('lobbyScreen').style.display = '';
}

// ----- API helper -----
async function callApi(serverUrl, path, method, body) {
  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Most common cause here: the server address is wrong/unreachable,
    // or (for an ngrok URL specifically) the request got blocked by a
    // browser CORS/network error rather than a clean HTTP error.
    throw new Error(`Could not reach the server at ${serverUrl}. Double-check the address.`);
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

// ----- create / join -----
$('createBtn').addEventListener('click', async () => {
  const serverUrl = getServerUrl();
  const name = $('nameInput').value.trim();
  if (!serverUrl) {
    showEntryError('Enter the server address first.');
    return;
  }
  if (!name) {
    showEntryError('Enter your name first.');
    return;
  }
  try {
    const data = await callApi(serverUrl, '/game/create', 'POST', { name });
    myName = name;
    gameId = data.game_id;
    enterLobby(serverUrl, data);
  } catch (err) {
    showEntryError(err.message);
  }
});

$('joinBtn').addEventListener('click', async () => {
  const serverUrl = getServerUrl();
  const name = $('nameInput').value.trim();
  const gid = $('gameIdInput').value.trim();
  if (!serverUrl) {
    showEntryError('Enter the server address first.');
    return;
  }
  if (!name) {
    showEntryError('Enter your name first.');
    return;
  }
  if (!gid) {
    showEntryError('Enter a game ID to join.');
    return;
  }
  try {
    const data = await callApi(serverUrl, `/game/${gid}/join`, 'POST', { name });
    myName = name;
    gameId = gid;
    enterLobby(serverUrl, data);
  } catch (err) {
    showEntryError(err.message);
  }
});

// ----- lobby -----
function enterLobby(serverUrl, state) {
  showLobby();
  $('lobbyGameId').textContent = gameId;
  renderLobby(state);
  startPolling(serverUrl);
}

function renderLobby(state) {
  const isLeader = state.leader === myName;

  if (isLeader) {
    $('lobbyMessage').textContent = 'Share this game ID with other players, then start when everyone has joined.';
  } else {
    $('lobbyMessage').textContent = `Waiting for ${state.leader} to start the game...`;
  }

  $('lobbyPlayerList').innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    li.textContent = p.name + (p.name === state.leader ? ' (leader)' : '');
    $('lobbyPlayerList').appendChild(li);
  }

  if (isLeader && state.players.length >= 2) {
    $('startBtn').style.display = '';
  } else {
    $('startBtn').style.display = 'none';
  }
}

$('startBtn').addEventListener('click', async () => {
  const serverUrl = getServerUrl();
  try {
    await callApi(serverUrl, `/game/${gameId}/start`, 'POST', { name: myName });
    // The next poll tick will see started:true and redirect.
  } catch (err) {
    showEntryError(err.message);
  }
});

// ----- background polling: detect when the leader starts the game -----
function startPolling(serverUrl) {
  pollHandle = setInterval(async () => {
    try {
      const data = await callApi(serverUrl, `/game/${gameId}/state?name=${encodeURIComponent(myName)}`, 'GET');
      if (data.started) {
        clearInterval(pollHandle);
        const url = `game.html?server=${encodeURIComponent(serverUrl)}` +
          `&gid=${encodeURIComponent(gameId)}` +
          `&name=${encodeURIComponent(myName)}`;
        window.location.href = url;
        return;
      }
      renderLobby(data);
    } catch (err) {
      // Transient network errors while polling shouldn't spam the lobby UI;
      // just leave the last known state on screen.
    }
  }, 1500);
}
