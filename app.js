const STORAGE_KEYS = {
  settings: "spotify-chords.settings.v4",
  tokens: "spotify-chords.tokens.v4"
};

const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-playback-state"];

const state = {
  settings: {
    clientId: ""
  },
  tokens: null,
  currentTrack: null,
  authTone: "muted",
  authText: "Sin conectar",
  playbackTone: "muted",
  playbackText: "Esperando",
  lyricsTone: "muted",
  lyricsText: "Esperando",
  lyricsBody: "La letra aparecera aqui cuando Spotify reporte una cancion activa.",
  lyricsSourceUrl: "",
  lastTrackKey: "",
  lastSyncAt: 0,
  pollTimer: null,
  progressTimer: null
};

const el = {};

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  cacheElements();
  bindEvents();
  hydrateState();
  renderAll();
  await maybeFinishSpotifyLogin();
  if (state.tokens) {
    startSpotifyPolling();
  } else {
    startProgressLoop();
  }
}

function cacheElements() {
  el.clientId = document.getElementById("spotify-client-id");
  el.redirectUri = document.getElementById("redirect-uri");
  el.copyUrlBtn = document.getElementById("copy-url-btn");
  el.connectBtn = document.getElementById("connect-btn");
  el.disconnectBtn = document.getElementById("disconnect-btn");
  el.authStatusPill = document.getElementById("auth-status-pill");
  el.authHelper = document.getElementById("auth-helper");
  el.playbackPill = document.getElementById("playback-pill");
  el.coverArt = document.getElementById("cover-art");
  el.trackKicker = document.getElementById("track-kicker");
  el.trackTitle = document.getElementById("track-title");
  el.trackArtist = document.getElementById("track-artist");
  el.trackAlbum = document.getElementById("track-album");
  el.progressLeft = document.getElementById("progress-left");
  el.progressRight = document.getElementById("progress-right");
  el.progressFill = document.getElementById("progress-fill");
  el.syncLabel = document.getElementById("sync-label");
  el.spotifyLink = document.getElementById("spotify-link");
  el.lyricsPill = document.getElementById("lyrics-pill");
  el.lyricsCopy = document.getElementById("lyrics-copy");
  el.lyricsView = document.getElementById("lyrics-view");
  el.lyricsSourceLink = document.getElementById("lyrics-source-link");
  el.matchPill = document.getElementById("match-pill");
  el.matchBox = document.getElementById("match-box");
  el.queryPrimary = document.getElementById("query-primary");
  el.querySecondary = document.getElementById("query-secondary");
  el.chordsView = document.getElementById("chords-view");
  el.externalPill = document.getElementById("external-pill");
  el.externalCopy = document.getElementById("external-copy");
  el.ddgChordsLink = document.getElementById("ddg-chords-link");
  el.ddgSpanishLink = document.getElementById("ddg-spanish-link");
  el.googleChordsLink = document.getElementById("google-chords-link");
  el.googleLyricsLink = document.getElementById("google-lyrics-link");
  el.copyQueryBtn = document.getElementById("copy-query-btn");
}

function bindEvents() {
  el.clientId.addEventListener("input", handleClientIdInput);
  el.copyUrlBtn.addEventListener("click", copyRedirectUri);
  el.connectBtn.addEventListener("click", startSpotifyLogin);
  el.disconnectBtn.addEventListener("click", disconnectSpotify);
  el.copyQueryBtn.addEventListener("click", copyPrimaryQuery);
}

function hydrateState() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || "null");
    if (savedSettings && typeof savedSettings.clientId === "string") {
      state.settings.clientId = savedSettings.clientId;
    }
  } catch (_) {
    // Ignore malformed local settings.
  }

  try {
    const savedTokens = JSON.parse(localStorage.getItem(STORAGE_KEYS.tokens) || "null");
    if (savedTokens && savedTokens.accessToken) {
      state.tokens = savedTokens;
      setAuthStatus("live", "Spotify autorizado");
    }
  } catch (_) {
    // Ignore malformed token cache.
  }
}

function handleClientIdInput() {
  state.settings.clientId = el.clientId.value.trim();
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

async function copyRedirectUri() {
  const uri = getRedirectUri();
  if (!uri) {
    setAuthStatus("warn", "Publica el sitio primero para tener una Redirect URI.");
    renderSetup();
    return;
  }

  try {
    await navigator.clipboard.writeText(uri);
    setAuthStatus("live", "Redirect URI copiada");
  } catch (_) {
    setAuthStatus("warn", "No pude copiarla; copiala manualmente.");
  }
  renderSetup();
}

async function startSpotifyLogin() {
  const clientId = state.settings.clientId.trim();
  const redirectUri = getRedirectUri();

  if (!clientId) {
    setAuthStatus("error", "Falta el Client ID de Spotify.");
    renderSetup();
    return;
  }

  if (!redirectUri) {
    setAuthStatus("warn", "Necesitas abrir esta app desde una URL HTTPS publicada.");
    renderSetup();
    return;
  }

  const verifier = randomString(96);
  const challenge = await pkceChallengeFromVerifier(verifier);
  const authState = randomString(24);
  sessionStorage.setItem("spotify-chords.verifier", verifier);
  sessionStorage.setItem("spotify-chords.state", authState);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state: authState
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function maybeFinishSpotifyLogin() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const incomingState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (!code && !error) {
    return;
  }

  if (error) {
    setAuthStatus("error", `Spotify devolvio: ${error}`);
    cleanupUrl();
    renderAll();
    return;
  }

  const expectedState = sessionStorage.getItem("spotify-chords.state");
  const verifier = sessionStorage.getItem("spotify-chords.verifier");

  if (!expectedState || !verifier || incomingState !== expectedState) {
    setAuthStatus("error", "No pude validar el regreso desde Spotify.");
    cleanupUrl();
    renderAll();
    return;
  }

  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: state.settings.clientId.trim(),
        code,
        redirect_uri: getRedirectUri(),
        code_verifier: verifier
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error_description || payload.error || "No pude obtener el token.");
    }

    state.tokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + ((payload.expires_in || 3600) * 1000) - 60000
    };
    persistTokens();
    setAuthStatus("live", "Spotify conectado");
  } catch (errorInstance) {
    setAuthStatus("error", errorInstance.message || "Fallo la autenticacion con Spotify.");
  } finally {
    cleanupUrl();
    sessionStorage.removeItem("spotify-chords.state");
    sessionStorage.removeItem("spotify-chords.verifier");
    renderAll();
  }
}

async function refreshSpotifyToken() {
  if (!state.tokens || !state.tokens.refreshToken) {
    disconnectSpotify();
    return false;
  }

  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: state.settings.clientId.trim(),
        refresh_token: state.tokens.refreshToken
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error_description || payload.error || "No pude refrescar el token.");
    }

    state.tokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || state.tokens.refreshToken,
      expiresAt: Date.now() + ((payload.expires_in || 3600) * 1000) - 60000
    };
    persistTokens();
    return true;
  } catch (errorInstance) {
    setAuthStatus("error", errorInstance.message || "Sesion de Spotify invalida.");
    disconnectSpotify();
    return false;
  }
}

async function ensureFreshSpotifyToken() {
  if (!state.tokens) {
    return false;
  }

  if (Date.now() < (state.tokens.expiresAt || 0)) {
    return true;
  }

  return refreshSpotifyToken();
}

function disconnectSpotify() {
  stopSpotifyPolling();
  localStorage.removeItem(STORAGE_KEYS.tokens);
  state.tokens = null;
  state.currentTrack = null;
  state.lastTrackKey = "";
  state.lastSyncAt = 0;
  resetLyrics("muted", "Esperando", "La letra aparecera aqui cuando Spotify reporte una cancion activa.");
  setAuthStatus("muted", "Sin conectar");
  setPlaybackStatus("muted", "Esperando");
  renderAll();
}

function startSpotifyPolling() {
  stopSpotifyPolling();
  fetchSpotifyPlayback();
  state.pollTimer = window.setInterval(fetchSpotifyPlayback, 4000);
  startProgressLoop();
}

function stopSpotifyPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function fetchSpotifyPlayback() {
  if (!(await ensureFreshSpotifyToken())) {
    renderAll();
    return;
  }

  try {
    const response = await fetch("https://api.spotify.com/v1/me/player", {
      headers: {
        Authorization: `Bearer ${state.tokens.accessToken}`
      }
    });

    if (response.status === 204) {
      state.currentTrack = null;
      state.lastTrackKey = "";
      state.lastSyncAt = 0;
      resetLyrics("warn", "Sin letra", "Spotify esta conectado, pero no hay reproduccion activa.");
      setAuthStatus("live", "Spotify conectado");
      setPlaybackStatus("warn", "Sin reproduccion activa");
      renderAll();
      return;
    }

    if (response.status === 401) {
      const refreshed = await refreshSpotifyToken();
      if (refreshed) {
        fetchSpotifyPlayback();
      }
      return;
    }

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error && payload.error.message ? payload.error.message : "Spotify no devolvio datos.");
    }

    if (!payload.item || payload.currently_playing_type !== "track") {
      state.currentTrack = null;
      state.lastTrackKey = "";
      state.lastSyncAt = 0;
      resetLyrics("warn", "Sin letra", "La reproduccion actual no es una cancion compatible.");
      setAuthStatus("live", "Spotify conectado");
      setPlaybackStatus("warn", "No es una cancion");
      renderAll();
      return;
    }

    const nextTrack = {
      id: payload.item.id,
      name: payload.item.name,
      artists: payload.item.artists.map((artist) => artist.name),
      album: payload.item.album.name,
      image: payload.item.album.images && payload.item.album.images[0] ? payload.item.album.images[0].url : "",
      durationMs: payload.item.duration_ms,
      progressMs: payload.progress_ms || 0,
      isPlaying: Boolean(payload.is_playing),
      spotifyUrl: payload.item.external_urls ? payload.item.external_urls.spotify : ""
    };

    const nextKey = buildTrackLookupKey(nextTrack);
    const trackChanged = nextKey !== state.lastTrackKey;

    state.currentTrack = nextTrack;
    state.lastSyncAt = Date.now();
    setAuthStatus("live", "Spotify conectado");
    setPlaybackStatus(nextTrack.isPlaying ? "live" : "warn", nextTrack.isPlaying ? "Reproduciendo" : "En pausa");
    renderAll();

    if (trackChanged) {
      state.lastTrackKey = nextKey;
      await loadTrackResources(nextTrack, nextKey);
    }
  } catch (errorInstance) {
    setPlaybackStatus("error", errorInstance.message || "No pude leer la pista actual.");
    renderAll();
  }
}

async function loadTrackResources(track, trackKey) {
  resetLyrics("warn", "Buscando", "Estoy buscando la letra automaticamente para esta cancion...");
  renderLyrics();
  renderSearchDeck();

  const lyrics = await fetchLyricsForTrack(track);
  if (trackKey !== state.lastTrackKey) {
    return;
  }

  if (lyrics) {
    state.lyricsTone = "live";
    state.lyricsText = "Encontrada";
    state.lyricsBody = lyrics;
  } else {
    state.lyricsTone = "warn";
    state.lyricsText = "No encontrada";
    state.lyricsBody = "No pude conseguir una letra automatica fiable para esta cancion. Usa el boton de busqueda o prueba con otra version del tema.";
  }

  const searchPlan = buildSearchPlan(track);
  state.lyricsSourceUrl = searchPlan.googleLyricsUrl;
  renderLyrics();
}

async function fetchLyricsForTrack(track) {
  const exact = await fetchLyricsFromLrclib(track);
  if (exact) {
    return exact;
  }

  const backup = await fetchLyricsFromLyricsOvh(track);
  if (backup) {
    return backup;
  }

  return "";
}

async function fetchLyricsFromLrclib(track) {
  const primaryArtist = track.artists[0] || "";
  const durationSeconds = track.durationMs ? Math.round(track.durationMs / 1000) : "";
  const title = cleanTrackLookupText(track.name);
  const getParams = new URLSearchParams({
    track_name: title,
    artist_name: primaryArtist
  });

  if (track.album) {
    getParams.set("album_name", track.album);
  }
  if (durationSeconds) {
    getParams.set("duration", String(durationSeconds));
  }

  const exactPayload = await fetchJson(`https://lrclib.net/api/get?${getParams.toString()}`);
  const exactLyrics = extractLyricsText(exactPayload);
  if (exactLyrics) {
    return exactLyrics;
  }

  const searchParams = new URLSearchParams({
    track_name: title,
    artist_name: primaryArtist
  });
  const searchPayload = await fetchJson(`https://lrclib.net/api/search?${searchParams.toString()}`);
  if (Array.isArray(searchPayload)) {
    for (const item of searchPayload) {
      const candidate = extractLyricsText(item);
      if (candidate) {
        return candidate;
      }
    }
  }

  return "";
}

async function fetchLyricsFromLyricsOvh(track) {
  const artist = encodeURIComponent(track.artists[0] || "");
  const title = encodeURIComponent(cleanTrackLookupText(track.name));
  const payload = await fetchJson(`https://api.lyrics.ovh/v1/${artist}/${title}`);
  if (payload && typeof payload.lyrics === "string" && payload.lyrics.trim()) {
    return payload.lyrics.trim();
  }
  return "";
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch (_) {
    return null;
  }
}

function extractLyricsText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (typeof payload.plainLyrics === "string" && payload.plainLyrics.trim()) {
    return payload.plainLyrics.trim();
  }

  if (typeof payload.syncedLyrics === "string" && payload.syncedLyrics.trim()) {
    const stripped = payload.syncedLyrics
      .replace(/\[[0-9:.]+\]/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");

    if (stripped) {
      return stripped;
    }
  }

  return "";
}

function startProgressLoop() {
  if (state.progressTimer) {
    window.clearInterval(state.progressTimer);
  }

  state.progressTimer = window.setInterval(() => {
    updateProgressDisplay();
    renderSyncLabel();
  }, 500);
}

function renderAll() {
  renderSetup();
  renderNowPlaying();
  renderLyrics();
  renderSearchDeck();
}

function renderSetup() {
  el.clientId.value = state.settings.clientId;
  el.redirectUri.value = getRedirectUri();
  el.authStatusPill.className = `status-pill ${pillClassForTone(state.authTone)}`;
  el.authStatusPill.textContent = state.authText;

  if (!getRedirectUri()) {
    el.authHelper.textContent = "Cuando publiques este repo en GitHub Pages, aqui aparecera la URL exacta que debes registrar en Spotify.";
  } else {
    el.authHelper.textContent = "Usa exactamente esta Redirect URI en Spotify. Si cambias el nombre del repo, cambia tambien esa URL en el dashboard de Spotify.";
  }
}

function renderNowPlaying() {
  const track = state.currentTrack;
  el.playbackPill.className = `status-pill ${pillClassForTone(state.playbackTone)}`;
  el.playbackPill.textContent = state.playbackText;

  if (!track) {
    el.coverArt.textContent = "SP";
    el.trackKicker.textContent = "Conecta Spotify para empezar";
    el.trackTitle.textContent = "Sin cancion activa";
    el.trackArtist.textContent = "La app detecta automaticamente la pista actual y prepara letra y busquedas dirigidas.";
    el.trackAlbum.textContent = "";
    el.spotifyLink.classList.add("hidden");
    el.progressLeft.textContent = "0:00";
    el.progressRight.textContent = "0:00";
    el.progressFill.style.width = "0%";
    renderSyncLabel();
    return;
  }

  if (track.image) {
    el.coverArt.innerHTML = `<img alt="Portada del album" src="${escapeHtml(track.image)}">`;
  } else {
    el.coverArt.textContent = initialsFromTrack(track);
  }

  el.trackKicker.textContent = track.isPlaying ? "Spotify detectado en tiempo real" : "Spotify detectado, pero en pausa";
  el.trackTitle.textContent = track.name;
  el.trackArtist.textContent = track.artists.join(", ");
  el.trackAlbum.textContent = track.album;

  if (track.spotifyUrl) {
    el.spotifyLink.href = track.spotifyUrl;
    el.spotifyLink.classList.remove("hidden");
  } else {
    el.spotifyLink.classList.add("hidden");
  }

  updateProgressDisplay();
  renderSyncLabel();
}

function renderLyrics() {
  el.lyricsPill.className = `status-pill ${pillClassForTone(state.lyricsTone)}`;
  el.lyricsPill.textContent = state.lyricsText;
  el.lyricsView.textContent = state.lyricsBody;

  if (!state.currentTrack) {
    el.lyricsCopy.textContent = "Cuando cambie la cancion, la app intentara conseguir la letra automaticamente desde una fuente abierta.";
    el.lyricsSourceLink.classList.add("hidden");
    return;
  }

  if (state.lyricsTone === "live") {
    el.lyricsCopy.textContent = "La letra se obtuvo automaticamente. Se muestra como texto plano para lectura rapida.";
  } else if (state.lyricsTone === "warn") {
    el.lyricsCopy.textContent = "No hubo una letra automatica fiable para esta pista. Puedes abrir la busqueda externa.";
  } else {
    el.lyricsCopy.textContent = "Buscando letra automaticamente...";
  }

  if (state.lyricsSourceUrl) {
    el.lyricsSourceLink.href = state.lyricsSourceUrl;
    el.lyricsSourceLink.classList.remove("hidden");
  } else {
    el.lyricsSourceLink.classList.add("hidden");
  }
}

function renderSearchDeck() {
  const track = state.currentTrack;
  if (!track) {
    el.matchPill.className = "status-pill status-pill-muted";
    el.matchPill.textContent = "Inactivo";
    el.matchBox.textContent = "Cuando cambie la cancion, preparare consultas exactas para encontrar acordes rapido en sitios grandes.";
    el.queryPrimary.textContent = "Esperando una cancion activa.";
    el.querySecondary.textContent = "Aparecera una variante para buscar cifras y acordes.";
    el.chordsView.textContent = "Aqui no incrusto paginas externas fragiles. En vez de eso, preparo busquedas exactas para llevarte directo a resultados utiles.";
    el.externalPill.className = "status-pill status-pill-muted";
    el.externalPill.textContent = "Inactivo";
    el.externalCopy.textContent = "Sin iframes fragiles. Solo enlaces exactos orientados a resultados.";
    hideSearchLinks();
    return;
  }

  const plan = buildSearchPlan(track);
  el.matchPill.className = "status-pill status-pill-live";
  el.matchPill.textContent = "Listo";
  el.matchBox.textContent = `Busquedas preparadas para "${track.name}" de ${track.artists[0] || "artista desconocido"}.`;
  el.queryPrimary.textContent = plan.primaryQuery;
  el.querySecondary.textContent = plan.secondaryQuery;
  el.chordsView.textContent = `Ataque 1: DuckDuckGo con filtros de sitios grandes.\nAtaque 2: variante mas hispana para cifras.\nAtaque 3: Google como respaldo.\n\nIdea central: no intentar leer acordes dentro de esta pagina cuando el sitio externo no lo permite, sino lanzarte directo a resultados de alta probabilidad.`;
  el.externalPill.className = "status-pill status-pill-live";
  el.externalPill.textContent = "Armado";
  el.externalCopy.textContent = "Estos enlaces usan el titulo limpio y el artista principal para reducir falsos positivos.";

  el.ddgChordsLink.href = plan.ddgChordsUrl;
  el.ddgSpanishLink.href = plan.ddgSpanishUrl;
  el.googleChordsLink.href = plan.googleChordsUrl;
  el.googleLyricsLink.href = plan.googleLyricsUrl;
  el.ddgChordsLink.classList.remove("hidden");
  el.ddgSpanishLink.classList.remove("hidden");
  el.googleChordsLink.classList.remove("hidden");
  el.googleLyricsLink.classList.remove("hidden");
  el.copyQueryBtn.classList.remove("hidden");
}

function buildSearchPlan(track) {
  const primaryArtist = track.artists[0] || "";
  const title = cleanTrackLookupText(track.name);
  const exact = `"${title}" "${primaryArtist}"`;
  const primaryQuery = `${exact} (site:ultimate-guitar.com OR site:e-chords.com OR site:cifraclub.com OR site:lacuerda.net) chords`;
  const secondaryQuery = `${exact} (site:lacuerda.net OR site:cifraclub.com OR site:e-chords.com) acordes`;
  const lyricsQuery = `${exact} lyrics`;

  return {
    primaryQuery,
    secondaryQuery,
    ddgChordsUrl: `https://duckduckgo.com/?q=${encodeURIComponent(primaryQuery)}`,
    ddgSpanishUrl: `https://duckduckgo.com/?q=${encodeURIComponent(secondaryQuery)}`,
    googleChordsUrl: `https://www.google.com/search?q=${encodeURIComponent(primaryQuery)}`,
    googleLyricsUrl: `https://www.google.com/search?q=${encodeURIComponent(lyricsQuery)}`
  };
}

async function copyPrimaryQuery() {
  const track = state.currentTrack;
  if (!track) {
    return;
  }

  const { primaryQuery } = buildSearchPlan(track);
  try {
    await navigator.clipboard.writeText(primaryQuery);
    el.externalCopy.textContent = "Query primaria copiada al portapapeles.";
  } catch (_) {
    el.externalCopy.textContent = "No pude copiar la query. Puedes seleccionarla manualmente.";
  }
}

function updateProgressDisplay() {
  if (!state.currentTrack) {
    return;
  }

  const progressMs = computeProgressMs();
  const durationMs = state.currentTrack.durationMs || 0;
  const ratio = durationMs ? Math.min(progressMs / durationMs, 1) : 0;

  el.progressLeft.textContent = formatMs(progressMs);
  el.progressRight.textContent = formatMs(durationMs);
  el.progressFill.style.width = `${ratio * 100}%`;
}

function renderSyncLabel() {
  if (!state.lastSyncAt) {
    el.syncLabel.textContent = "Sin sincronizar";
    return;
  }

  const seconds = Math.max(0, Math.floor((Date.now() - state.lastSyncAt) / 1000));
  el.syncLabel.textContent = `Ultima lectura hace ${seconds}s`;
}

function computeProgressMs() {
  if (!state.currentTrack) {
    return 0;
  }

  const base = state.currentTrack.progressMs || 0;
  if (!state.currentTrack.isPlaying) {
    return base;
  }

  const elapsed = Math.max(0, Date.now() - state.lastSyncAt);
  return Math.min(base + elapsed, state.currentTrack.durationMs || base);
}

function buildTrackLookupKey(track) {
  return `${normalizeText(track.artists ? track.artists[0] : "")}||${normalizeText(cleanTrackLookupText(track.name || ""))}`;
}

function cleanTrackLookupText(value) {
  return (value || "")
    .replace(/\(([^)]*(live|remaster|version|edit|deluxe|mono|stereo)[^)]*)\)/gi, "")
    .replace(/\[([^\]]*(live|remaster|version|edit|deluxe|mono|stereo)[^\]]*)\]/gi, "")
    .trim();
}

function normalizeText(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bfeat(?:uring)?\b.*$/gi, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hideSearchLinks() {
  el.ddgChordsLink.classList.add("hidden");
  el.ddgSpanishLink.classList.add("hidden");
  el.googleChordsLink.classList.add("hidden");
  el.googleLyricsLink.classList.add("hidden");
  el.copyQueryBtn.classList.add("hidden");
}

function resetLyrics(tone, text, body) {
  state.lyricsTone = tone;
  state.lyricsText = text;
  state.lyricsBody = body;
  state.lyricsSourceUrl = "";
}

function getRedirectUri() {
  if (window.location.protocol === "https:" || window.location.protocol === "http:") {
    return `${window.location.origin}${window.location.pathname}`;
  }
  return "";
}

function setAuthStatus(tone, text) {
  state.authTone = tone;
  state.authText = text;
}

function setPlaybackStatus(tone, text) {
  state.playbackTone = tone;
  state.playbackText = text;
}

function pillClassForTone(tone) {
  if (tone === "live") {
    return "status-pill-live";
  }
  if (tone === "warn") {
    return "status-pill-warn";
  }
  if (tone === "error") {
    return "status-pill-error";
  }
  return "status-pill-muted";
}

function persistTokens() {
  localStorage.setItem(STORAGE_KEYS.tokens, JSON.stringify(state.tokens));
}

function cleanupUrl() {
  const clean = new URL(window.location.href);
  clean.searchParams.delete("code");
  clean.searchParams.delete("state");
  clean.searchParams.delete("error");
  window.history.replaceState({}, "", clean.toString());
}

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (value) => chars[value % chars.length]).join("");
}

async function pkceChallengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function initialsFromTrack(track) {
  return (track.name || "SP")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0])
    .join("")
    .toUpperCase() || "SP";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
