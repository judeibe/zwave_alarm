// Minimal bundled dashboard (T030). No build step: plain browser JS served
// as a static asset alongside index.html/styles.css by src/api/app.ts.
// Talks to the REST API (contracts/rest-api.md, T027) for commands and the
// WebSocket push channel (contracts/websocket-events.md, T029) for live
// panel/zone/sensor state.

// Mirrors src/zwave/sensor-mapper.ts's DEFAULT_LOW_BATTERY_THRESHOLD_PERCENT
// so the dashboard's own "low battery" badge (independent of the server's
// sensor.fault event, which only fires on a state *edge*) agrees with it.
const LOW_BATTERY_THRESHOLD_PERCENT = 20;

const state = {
  user: null,
  panel: { mode: 'disarmed', pendingDelayEndsAt: null },
  zones: [],
};

let socket = null;
let countdownTimer = null;

const el = {
  connectionStatus: document.getElementById('connection-status'),
  loginSection: document.getElementById('login-section'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  dashboardSection: document.getElementById('dashboard-section'),
  currentUserName: document.getElementById('current-user-name'),
  currentUserRole: document.getElementById('current-user-role'),
  logoutButton: document.getElementById('logout-button'),
  panelMode: document.getElementById('panel-mode'),
  panelCountdown: document.getElementById('panel-countdown'),
  panelError: document.getElementById('panel-error'),
  armAwayButton: document.getElementById('arm-away-button'),
  armHomeButton: document.getElementById('arm-home-button'),
  disarmForm: document.getElementById('disarm-form'),
  zoneList: document.getElementById('zone-list'),
};

async function api(path, options) {
  const res = await fetch(`/api/v1${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message ?? `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function showDashboard(user) {
  state.user = user;
  el.currentUserName.textContent = user.name;
  el.currentUserRole.textContent = user.role;
  el.loginSection.hidden = true;
  el.dashboardSection.hidden = false;
  connectSocket();
}

function showLogin() {
  state.user = null;
  el.dashboardSection.hidden = true;
  el.loginSection.hidden = false;
  disconnectSocket();
}

function setConnectionState(connected) {
  el.connectionStatus.dataset.state = connected ? 'connected' : 'disconnected';
  el.connectionStatus.textContent = connected ? 'connected' : 'disconnected';
}

function renderPanel() {
  el.panelMode.textContent = state.panel.mode;

  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  const updateCountdown = () => {
    const endsAt = state.panel.pendingDelayEndsAt;
    if (endsAt === null) {
      el.panelCountdown.textContent = '';
      return;
    }
    const remainingMs = endsAt - Date.now();
    el.panelCountdown.textContent = remainingMs > 0 ? ` (${Math.ceil(remainingMs / 1000)}s)` : '';
  };

  updateCountdown();
  if (state.panel.pendingDelayEndsAt !== null) {
    countdownTimer = setInterval(updateCountdown, 1000);
  }

  const disarmable = state.panel.mode !== 'disarmed';
  const armable = state.panel.mode === 'disarmed';
  el.armAwayButton.disabled = !armable;
  el.armHomeButton.disabled = !armable;
  el.disarmForm.querySelector('button[type="submit"]').disabled = !disarmable;
}

function sensorBadges(sensor) {
  const badges = [];
  badges.push(
    `<span class="badge ${sensor.currentState === 'breached' ? 'badge-breached' : 'badge-normal'}">${sensor.currentState}</span>`,
  );
  if (sensor.connectivityStatus === 'offline') {
    badges.push('<span class="badge badge-fault">offline</span>');
  }
  if (sensor.batteryLevel !== null && sensor.batteryLevel <= LOW_BATTERY_THRESHOLD_PERCENT) {
    badges.push(`<span class="badge badge-fault">low battery (${sensor.batteryLevel}%)</span>`);
  }
  return badges.join(' ');
}

function renderZones() {
  el.zoneList.innerHTML = state.zones
    .map((zone) => {
      const sensorRows =
        zone.sensors.length === 0
          ? '<li class="sensor-row"><span class="sensor-name">No sensors assigned.</span></li>'
          : zone.sensors
              .map(
                (sensor) =>
                  `<li class="sensor-row"><span class="sensor-name">${sensor.name} <em>(${sensor.category})</em></span>${sensorBadges(sensor)}</li>`,
              )
              .join('');
      return `<li class="zone-card"><h3>${zone.name}</h3><ul>${sensorRows}</ul></li>`;
    })
    .join('');
}

function applySensorPatch(sensorId, changes) {
  for (const zone of state.zones) {
    const sensor = zone.sensors.find((candidate) => candidate.id === sensorId);
    if (sensor) {
      Object.assign(sensor, changes);
      break;
    }
  }
  renderZones();
}

function connectSocket() {
  disconnectSocket();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/api/v1/stream`);

  socket.addEventListener('open', () => setConnectionState(true));
  socket.addEventListener('close', () => setConnectionState(false));
  socket.addEventListener('error', () => setConnectionState(false));

  socket.addEventListener('message', (messageEvent) => {
    let message;
    try {
      message = JSON.parse(messageEvent.data);
    } catch {
      return;
    }

    switch (message.type) {
      case 'snapshot':
        state.panel = message.panel;
        state.zones = message.zones;
        renderPanel();
        renderZones();
        break;
      case 'panel.changed':
        state.panel = { mode: message.mode, pendingDelayEndsAt: message.pendingDelayEndsAt };
        renderPanel();
        break;
      case 'sensor.changed':
        applySensorPatch(message.sensorId, { currentState: message.currentState });
        break;
      case 'sensor.fault':
        applySensorPatch(message.sensorId, {
          connectivityStatus: message.connectivityStatus,
          batteryLevel: message.batteryLevel,
        });
        break;
      default:
        break;
    }
  });
}

function disconnectSocket() {
  if (socket !== null) {
    socket.close();
    socket = null;
  }
  setConnectionState(false);
}

async function refreshZones() {
  state.zones = await api('/zones');
  renderZones();
}

el.loginForm.addEventListener('submit', async (submitEvent) => {
  submitEvent.preventDefault();
  el.loginError.textContent = '';
  const code = new FormData(el.loginForm).get('code');
  try {
    const user = await api('/auth/login', { method: 'POST', body: JSON.stringify({ code }) });
    el.loginForm.reset();
    showDashboard(user);
    state.panel = await api('/panel');
    renderPanel();
    await refreshZones();
  } catch (err) {
    el.loginError.textContent = err.message;
  }
});

el.logoutButton.addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    showLogin();
  }
});

async function arm(mode) {
  el.panelError.textContent = '';
  try {
    state.panel = await api('/panel/arm', { method: 'POST', body: JSON.stringify({ mode }) });
    renderPanel();
  } catch (err) {
    el.panelError.textContent = err.message;
  }
}

el.armAwayButton.addEventListener('click', () => arm('armed_away'));
el.armHomeButton.addEventListener('click', () => arm('armed_home'));

el.disarmForm.addEventListener('submit', async (submitEvent) => {
  submitEvent.preventDefault();
  el.panelError.textContent = '';
  const code = new FormData(el.disarmForm).get('code');
  try {
    state.panel = await api('/panel/disarm', { method: 'POST', body: JSON.stringify({ code }) });
    el.disarmForm.reset();
    renderPanel();
  } catch (err) {
    el.panelError.textContent = err.message;
  }
});

// On load, GET /panel doubles as a session check: 401 means "not logged in
// yet" (there is no dedicated "who am I" endpoint in contracts/rest-api.md),
// so the login form is the fallback rather than a dashboard error state.
(async function init() {
  try {
    state.panel = await api('/panel');
    renderPanel();
    await refreshZones();
    el.loginSection.hidden = true;
    el.dashboardSection.hidden = false;
    el.currentUserName.textContent = '';
    el.currentUserRole.textContent = '';
    connectSocket();
  } catch {
    showLogin();
  }
})();
