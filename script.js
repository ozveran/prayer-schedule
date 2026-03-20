/* ================================================================
   JADWAL SHOLAT PWA — script.js
   Description: Main application logic
   Features:
     - HTML5 Geolocation API
     - AlAdhan API (Kemenag RI calculation method)
     - Web Notifications API
     - Hijri calendar conversion
     - Live clock with countdown
     - Dark / light theme toggle
     - PWA install prompt
     - Service Worker registration
================================================================ */

'use strict';

/* ────────────────────────────────────────────────────────────────
   CONSTANTS & CONFIGURATION
──────────────────────────────────────────────────────────────── */

/**
 * AlAdhan API — method 20 = Majlis Ugama Islam Singapura
 * (Fajr: 20°, Isha: 18°) — closest publicly available method 
 * to the Kemenag RI standard used in Indonesia.
 * 
 * school=1 = Hanafi Asr, school=0 = Shafi'i Asr (standard Indonesia)
 */
const CONFIG = {
  API_BASE:       'https://api.aladhan.com/v1/timings',
  CALC_METHOD:    20,       // Kemenag-equivalent (MUIS — 20° Fajr, 18° Isha)
  MADHAB:         0,        // 0 = Shafi'i (standard Indonesia)
  LOCATION_TIMEOUT:  12000, // 12 seconds
  RETRY_DELAY:      5000,   // 5 seconds before auto-retry on error
  NOTIFICATION_ADVANCE_SECONDS: 0, // fire exactly on time (0 = no advance)
  STORAGE_KEYS: {
    THEME:       'jadwal-sholat-theme',
    NOTIF_PERM:  'jadwal-sholat-notif',
    LAST_COORDS: 'jadwal-sholat-coords',
    PRAYER_DATA: 'jadwal-sholat-data',
    INSTALL_DIM: 'jadwal-sholat-install-dismissed',
  },
};

/**
 * Prayer definitions with display names (Indonesian), 
 * icons, and the API key they map to.
 */
const PRAYERS = [
  { key: 'Fajr',    name: 'Shubuh',  icon: '🌅', apiKey: 'Fajr'    },
  { key: 'Dhuhr',   name: 'Dzuhur',  icon: '☀️', apiKey: 'Dhuhr'   },
  { key: 'Asr',     name: 'Ashar',   icon: '🌤️', apiKey: 'Asr'     },
  { key: 'Maghrib', name: 'Maghrib', icon: '🌇', apiKey: 'Maghrib' },
  { key: 'Isha',    name: 'Isya',    icon: '🌙', apiKey: 'Isha'    },
];

/** Hijri month names in Indonesian */
const HIJRI_MONTHS = [
  'Muharram', 'Safar', "Rabi'ul Awal", "Rabi'ul Akhir",
  'Jumadal Ula', 'Jumadal Akhir', 'Rajab', "Sya'ban",
  'Ramadan', 'Syawal', "Dzulqa'dah", 'Dzulhijjah',
];

/* ────────────────────────────────────────────────────────────────
   APPLICATION STATE
──────────────────────────────────────────────────────────────── */
const state = {
  coords:            null,   // { latitude, longitude }
  locationName:      '',     // City name from reverse geocoding
  prayerTimes:       null,   // Object with prayer time strings { Fajr: "04:30", ... }
  hijriDate:         null,   // Hijri date object from API
  notifPermission:   'default',
  notifTimers:       [],     // Array of scheduled notification setTimeout IDs
  currentDate:       null,   // Date string 'DD-MM-YYYY' used to detect day change
  clockInterval:     null,
  retryTimeout:      null,
  theme:             'light',
};

/* ────────────────────────────────────────────────────────────────
   DOM ELEMENT REFERENCES
──────────────────────────────────────────────────────────────── */
const dom = {
  // Clock
  clockTime:         document.getElementById('clock-time'),
  clockDate:         document.getElementById('clock-date'),
  clockHijri:        document.getElementById('clock-hijri'),

  // Location
  locationDetail:    document.getElementById('location-detail'),
  footerCoords:      document.getElementById('footer-coords'),

  // Next prayer banner
  nextPrayerName:    document.getElementById('next-prayer-name'),
  nextPrayerTime:    document.getElementById('next-prayer-time'),
  nextPrayerCountdown: document.getElementById('next-prayer-countdown'),

  // Prayer list
  loadingSkeleton:   document.getElementById('loading-skeleton'),
  errorMessage:      document.getElementById('error-message'),
  errorText:         document.getElementById('error-text'),
  prayerList:        document.getElementById('prayer-list'),

  // Notification
  btnNotification:   document.getElementById('btn-notification'),
  notifBtnIcon:      document.getElementById('notif-btn-icon'),
  notifBtnText:      document.getElementById('notif-btn-text'),
  notificationStatus:document.getElementById('notification-status'),

  // Controls
  btnTheme:          document.getElementById('btn-theme'),
  btnRefreshLoc:     document.getElementById('btn-refresh-location'),
  btnRetry:          document.getElementById('btn-retry'),

  // Install banner
  installBanner:     document.getElementById('install-banner'),
  btnInstall:        document.getElementById('btn-install'),
  btnInstallDismiss: document.getElementById('btn-install-dismiss'),
};

/* ────────────────────────────────────────────────────────────────
   UTILITY FUNCTIONS
──────────────────────────────────────────────────────────────── */

/**
 * Parses a time string like "04:32" into total minutes since midnight.
 * @param {string} timeStr
 * @returns {number} Total minutes
 */
function timeStringToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Formats total seconds into a human-readable countdown string.
 * @param {number} totalSeconds
 * @returns {string} e.g. "2 jam 15 menit lagi"
 */
function formatCountdown(totalSeconds) {
  if (totalSeconds <= 0) return 'Sekarang';
  const hours   = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours   > 0) parts.push(`${hours} jam`);
  if (minutes > 0) parts.push(`${minutes} menit`);
  if (hours === 0 && minutes < 5) parts.push(`${seconds} detik`); // show seconds when < 5 min

  return parts.length ? `${parts.join(' ')} lagi` : 'Sebentar lagi';
}

/**
 * Formats a JS Date to Indonesian locale string.
 * @param {Date} date
 * @returns {string}
 */
function formatIndonesianDate(date) {
  return date.toLocaleDateString('id-ID', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

/**
 * Returns today's date string in the DD-MM-YYYY format used by AlAdhan.
 * @param {Date} [date]
 * @returns {string}
 */
function getTodayString(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Safely stores a value in localStorage (fails silently in private mode).
 * @param {string} key
 * @param {string} value
 */
function storageSave(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

/**
 * Safely retrieves a value from localStorage.
 * @param {string} key
 * @returns {string|null}
 */
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/* ────────────────────────────────────────────────────────────────
   THEME MANAGEMENT
──────────────────────────────────────────────────────────────── */

/**
 * Applies a theme ('light' or 'dark') to the document.
 * @param {'light'|'dark'} theme
 */
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  dom.btnTheme.querySelector('.icon-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
  dom.btnTheme.setAttribute('aria-label',
    theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'
  );
  storageSave(CONFIG.STORAGE_KEYS.THEME, theme);
}

/** Initialises theme from storage or system preference */
function initTheme() {
  const saved = storageGet(CONFIG.STORAGE_KEYS.THEME);
  if (saved === 'dark' || saved === 'light') {
    applyTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    applyTheme('dark');
  } else {
    applyTheme('light');
  }

  // Listen for OS theme changes
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', e => {
      if (!storageGet(CONFIG.STORAGE_KEYS.THEME)) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
}

dom.btnTheme.addEventListener('click', () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
});

/* ────────────────────────────────────────────────────────────────
   LIVE CLOCK
──────────────────────────────────────────────────────────────── */

/** Updates the clock display every second */
function updateClock() {
  const now  = new Date();
  const hh   = String(now.getHours()).padStart(2, '0');
  const mm   = String(now.getMinutes()).padStart(2, '0');
  const ss   = String(now.getSeconds()).padStart(2, '0');

  dom.clockTime.textContent = `${hh}:${mm}:${ss}`;

  // Update Gregorian date
  dom.clockDate.textContent = formatIndonesianDate(now);

  // Update Hijri from cached API data
  if (state.hijriDate) {
    const h = state.hijriDate;
    dom.clockHijri.textContent =
      `${h.day} ${HIJRI_MONTHS[parseInt(h.month.number, 10) - 1]} ${h.year} H`;
  }

  // Detect date change — refetch prayer times at midnight
  const todayString = getTodayString(now);
  if (state.currentDate && state.currentDate !== todayString) {
    state.currentDate = todayString;
    fetchPrayerTimes(); // new day → new schedule
  }
  if (!state.currentDate) state.currentDate = todayString;

  // Update the next prayer countdown every second
  if (state.prayerTimes) {
    updateNextPrayer(now);
  }
}

/** Starts the 1-second clock interval */
function startClock() {
  updateClock(); // Run immediately
  if (state.clockInterval) clearInterval(state.clockInterval);
  state.clockInterval = setInterval(updateClock, 1000);
}

/* ────────────────────────────────────────────────────────────────
   GEOLOCATION
──────────────────────────────────────────────────────────────── */

/** Updates the location label in the UI */
function setLocationStatus(text) {
  dom.locationDetail.textContent = text;
}

/**
 * Requests the user's coordinates using the HTML5 Geolocation API.
 * Falls back to cached coords if permission was previously granted.
 * @returns {Promise<GeolocationCoordinates>}
 */
function getCoordinates() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Browser Anda tidak mendukung Geolocation.'));
      return;
    }

    setLocationStatus('Meminta izin lokasi...');

    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      err => {
        // Try cached coords first
        const cached = storageGet(CONFIG.STORAGE_KEYS.LAST_COORDS);
        if (cached) {
          try {
            const { latitude, longitude, name } = JSON.parse(cached);
            if (name) state.locationName = name;
            resolve({ latitude, longitude });
            return;
          } catch {}
        }
        // Map GeolocationPositionError codes to friendly messages
        const messages = {
          1: 'Izin lokasi ditolak. Aktifkan di pengaturan browser Anda.',
          2: 'Posisi tidak tersedia saat ini. Coba lagi.',
          3: 'Permintaan lokasi habis waktu. Coba lagi.',
        };
        reject(new Error(messages[err.code] || 'Gagal mendapatkan lokasi.'));
      },
      {
        enableHighAccuracy: true,
        timeout:           CONFIG.LOCATION_TIMEOUT,
        maximumAge:        1000 * 60 * 5, // Accept 5-min old position
      }
    );
  });
}

/**
 * Performs reverse geocoding using the Nominatim API (OpenStreetMap).
 * No API key required; throttled to 1 req/s by usage policy.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string>} City/district name
 */
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=id`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'JadwalSholatPWA/1.0' }
    });
    if (!res.ok) throw new Error('Geocode failed');
    const data = await res.json();
    const addr = data.address || {};
    // Build a city-level label
    return addr.city        ||
           addr.town        ||
           addr.village     ||
           addr.county      ||
           addr.state       ||
           'Lokasi Anda';
  } catch {
    return 'Lokasi Anda';
  }
}

/* ────────────────────────────────────────────────────────────────
   PRAYER TIMES API
──────────────────────────────────────────────────────────────── */

/** Shows the loading skeleton and hides list/error */
function showLoading() {
  dom.loadingSkeleton.classList.remove('hidden');
  dom.prayerList.classList.add('hidden');
  dom.errorMessage.classList.add('hidden');
}

/** Hides the loading skeleton */
function hideLoading() {
  dom.loadingSkeleton.classList.add('hidden');
}

/**
 * Displays an error message in the UI.
 * @param {string} message
 */
function showError(message) {
  hideLoading();
  dom.prayerList.classList.add('hidden');
  dom.errorMessage.classList.remove('hidden');
  dom.errorText.textContent = message;
  setLocationStatus('Gagal mendapatkan lokasi');
}

/**
 * Fetches prayer times from the AlAdhan API.
 * Uses Unix timestamp for today's date to ensure accurate DST handling.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<Object>} AlAdhan data.timings object
 */
async function fetchFromAlAdhan(lat, lon) {
  // Use the current Unix timestamp — AlAdhan derives date from it server-side
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(`${CONFIG.API_BASE}/${timestamp}`);

  url.searchParams.set('latitude',  lat.toFixed(6));
  url.searchParams.set('longitude', lon.toFixed(6));
  url.searchParams.set('method',    CONFIG.CALC_METHOD);
  url.searchParams.set('school',    CONFIG.MADHAB);
  url.searchParams.set('timezonestring', Intl.DateTimeFormat().resolvedOptions().timeZone);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);

  const json = await res.json();
  if (json.code !== 200 || !json.data) {
    throw new Error('Data tidak valid dari server.');
  }
  return json.data;
}

/**
 * Main entry point: gets location → fetches prayer times → renders UI.
 */
async function fetchPrayerTimes() {
  showLoading();

  // Clear any pending retry
  if (state.retryTimeout) {
    clearTimeout(state.retryTimeout);
    state.retryTimeout = null;
  }

  try {
    // --- Step 1: Get coordinates ---
    const coords = await getCoordinates();
    state.coords = { latitude: coords.latitude, longitude: coords.longitude };

    // Cache coordinates for offline fallback
    storageSave(CONFIG.STORAGE_KEYS.LAST_COORDS, JSON.stringify({
      latitude:  coords.latitude,
      longitude: coords.longitude,
      name:      state.locationName,
    }));

    // Update footer coordinates display
    dom.footerCoords.textContent =
      `${coords.latitude.toFixed(4)}°, ${coords.longitude.toFixed(4)}°`;

    // --- Step 2: Reverse geocode (non-blocking) ---
    setLocationStatus('Menentukan nama kota...');
    reverseGeocode(coords.latitude, coords.longitude)
      .then(name => {
        state.locationName = name;
        setLocationStatus(name);
        // Update cached coords with resolved name
        storageSave(CONFIG.STORAGE_KEYS.LAST_COORDS, JSON.stringify({
          latitude:  coords.latitude,
          longitude: coords.longitude,
          name,
        }));
      });

    // --- Step 3: Fetch prayer times ---
    setLocationStatus('Mengambil jadwal sholat...');
    const data = await fetchFromAlAdhan(coords.latitude, coords.longitude);

    // Extract and store prayer times
    state.prayerTimes = data.timings;
    state.hijriDate   = data.date?.hijri;

    // Cache prayer data
    storageSave(CONFIG.STORAGE_KEYS.PRAYER_DATA, JSON.stringify({
      timings:   data.timings,
      hijri:     data.date?.hijri,
      date:      getTodayString(),
      coords:    { lat: coords.latitude, lon: coords.longitude },
    }));

    // --- Step 4: Render UI ---
    hideLoading();
    renderPrayerList(data.timings);

    // Update Hijri date in the clock immediately
    if (state.hijriDate) {
      const h = state.hijriDate;
      dom.clockHijri.textContent =
        `${h.day} ${HIJRI_MONTHS[parseInt(h.month.number, 10) - 1]} ${h.year} H`;
    }

    // --- Step 5: Schedule notifications ---
    scheduleAllNotifications(data.timings);

    // Broadcast prayer times to the service worker for background scheduling
    broadcastToServiceWorker({
      type:    'PRAYER_TIMES',
      timings: data.timings,
      date:    getTodayString(),
    });

  } catch (err) {
    console.error('[PrayerApp] Error:', err);

    // Try to load from cache on failure
    const cached = storageGet(CONFIG.STORAGE_KEYS.PRAYER_DATA);
    if (cached) {
      try {
        const { timings, hijri, date } = JSON.parse(cached);
        // Only use cache if it's from today
        if (date === getTodayString()) {
          state.prayerTimes = timings;
          state.hijriDate   = hijri;
          hideLoading();
          renderPrayerList(timings);
          setLocationStatus(`${state.locationName || 'Lokasi Tersimpan'} (cache)`);
          scheduleAllNotifications(timings);
          return;
        }
      } catch {}
    }

    showError(err.message || 'Terjadi kesalahan tidak diketahui.');
  }
}

/* ────────────────────────────────────────────────────────────────
   PRAYER LIST RENDERING
──────────────────────────────────────────────────────────────── */

/**
 * Determines the status of each prayer relative to current time.
 * @param {Object} timings  AlAdhan timings object
 * @param {Date}   now
 * @returns {{ activePrayerKey: string|null, nextPrayerKey: string|null }}
 */
function getPrayerStatuses(timings, now) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentSeconds = currentMinutes * 60 + now.getSeconds();

  let nextPrayerKey    = null;
  let activePrayerKey  = null; // currently within 10 min window

  // Find the first upcoming prayer
  for (const prayer of PRAYERS) {
    const pMinutes = timeStringToMinutes(timings[prayer.apiKey]);
    if (pMinutes > currentMinutes) {
      nextPrayerKey = prayer.key;
      break;
    }
    // Check if we are within 10 minutes AFTER this prayer time
    const diffMinutes = currentMinutes - pMinutes;
    if (diffMinutes >= 0 && diffMinutes < 10) {
      activePrayerKey = prayer.key;
    }
  }

  // Edge case: after Isha → next is tomorrow's Fajr
  // We'll show Fajr as "next" but mark it with a note
  return { activePrayerKey, nextPrayerKey };
}

/**
 * Renders the prayer list to the DOM.
 * @param {Object} timings
 */
function renderPrayerList(timings) {
  dom.prayerList.innerHTML = '';
  dom.prayerList.classList.remove('hidden');

  const now = new Date();
  const { activePrayerKey, nextPrayerKey } = getPrayerStatuses(timings, now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  PRAYERS.forEach(prayer => {
    const timeStr    = timings[prayer.apiKey];
    const pMinutes   = timeStringToMinutes(timeStr);
    const isPassed   = pMinutes < currentMinutes;
    const isNext     = prayer.key === nextPrayerKey;
    const isCurrent  = prayer.key === activePrayerKey;

    // Build class list
    const classes = ['prayer-item'];
    if (isCurrent) classes.push('prayer-current');
    else if (isNext) classes.push('prayer-active');
    else if (isPassed) classes.push('prayer-passed');

    // Status label
    let statusLabel = '';
    if (isCurrent)      statusLabel = '🟢 Waktu sholat sekarang';
    else if (isNext)    statusLabel = '⏳ Berikutnya';
    else if (isPassed)  statusLabel = 'Sudah lewat';

    const li = document.createElement('li');
    li.className = classes.join(' ');
    li.setAttribute('role', 'listitem');

    // The time element carries the machine-readable datetime
    li.innerHTML = `
      <div class="prayer-icon" aria-hidden="true">${prayer.icon}</div>
      <div class="prayer-info">
        <span class="prayer-name">${prayer.name}</span>
        ${statusLabel ? `<span class="prayer-status">${statusLabel}</span>` : ''}
      </div>
      <time class="prayer-time" datetime="${timeStr}">${timeStr}</time>
    `;

    dom.prayerList.appendChild(li);
  });
}

/* ────────────────────────────────────────────────────────────────
   NEXT PRAYER COUNTDOWN (called every second)
──────────────────────────────────────────────────────────────── */

/**
 * Updates the "Next Prayer" banner and countdown display.
 * Also re-renders the prayer list to refresh status indicators.
 * @param {Date} now
 */
function updateNextPrayer(now) {
  const timings       = state.prayerTimes;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  let nextPrayer    = null;
  let secondsUntilNext = Infinity;

  for (const prayer of PRAYERS) {
    const pMinutes = timeStringToMinutes(timings[prayer.apiKey]);
    const pSeconds = pMinutes * 60;

    if (pSeconds > currentSeconds) {
      const diff = pSeconds - currentSeconds;
      if (diff < secondsUntilNext) {
        secondsUntilNext = diff;
        nextPrayer = prayer;
      }
      break; // PRAYERS is ordered, so first future prayer = next
    }
  }

  // After Isya — next prayer is Fajr tomorrow
  if (!nextPrayer) {
    nextPrayer = PRAYERS[0]; // Fajr
    const fajrMinutes  = timeStringToMinutes(timings['Fajr']);
    const minutesInDay = 24 * 60;
    const remaining    = (minutesInDay - currentMinutes + fajrMinutes) * 60 - now.getSeconds();
    secondsUntilNext   = remaining;
  }

  if (nextPrayer) {
    dom.nextPrayerName.textContent = nextPrayer.name;
    dom.nextPrayerTime.textContent = timings[nextPrayer.apiKey];
    dom.nextPrayerCountdown.textContent = formatCountdown(secondsUntilNext);

    // Re-render list only once per minute (on minute change) to avoid excessive DOM ops
    // The second-level update is handled by formatCountdown above
    if (now.getSeconds() === 0) {
      renderPrayerList(timings);
    }
  }
}

/* ────────────────────────────────────────────────────────────────
   NOTIFICATIONS
──────────────────────────────────────────────────────────────── */

/**
 * Updates the notification button and status text based on current permission.
 */
function updateNotificationUI() {
  const perm = Notification.permission;
  state.notifPermission = perm;

  if (perm === 'granted') {
    dom.btnNotification.setAttribute('aria-pressed', 'true');
    dom.notifBtnIcon.textContent  = '🔔';
    dom.notifBtnText.textContent  = 'Notifikasi Aktif';
    dom.notificationStatus.textContent = 'Status: Aktif — Anda akan mendapat pengingat waktu sholat';
    dom.btnNotification.classList.add('btn-notification');
  } else if (perm === 'denied') {
    dom.btnNotification.setAttribute('aria-pressed', 'false');
    dom.notifBtnIcon.textContent  = '🔕';
    dom.notifBtnText.textContent  = 'Notifikasi Diblokir';
    dom.notificationStatus.textContent =
      'Status: Diblokir — Aktifkan manual di pengaturan browser Anda';
    dom.btnNotification.disabled = true;
  } else {
    dom.btnNotification.setAttribute('aria-pressed', 'false');
    dom.notifBtnIcon.textContent  = '🔔';
    dom.notifBtnText.textContent  = 'Aktifkan Notifikasi';
    dom.notificationStatus.textContent = 'Status: Belum diaktifkan';
    dom.btnNotification.disabled = false;
  }
}

/**
 * Handles the "Aktifkan Notifikasi" button click.
 * Requests permission and sends a test notification.
 */
async function handleNotificationToggle() {
  if (!('Notification' in window)) {
    dom.notificationStatus.textContent = 'Status: Browser Anda tidak mendukung notifikasi.';
    return;
  }

  if (Notification.permission === 'granted') {
    // Send a test notification to confirm it's working
    sendNotification('✅ Notifikasi Aktif', {
      body: 'Anda akan menerima pengingat waktu sholat. Barakallahu fiikum.',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-96.png',
      tag: 'test-notification',
    });
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    updateNotificationUI();

    if (permission === 'granted') {
      storageSave(CONFIG.STORAGE_KEYS.NOTIF_PERM, 'granted');
      // Schedule prayers now that we have permission
      if (state.prayerTimes) {
        scheduleAllNotifications(state.prayerTimes);
      }
      // Send welcome notification
      setTimeout(() => {
        sendNotification('🕌 Jadwal Sholat Aktif', {
          body: `Notifikasi adzan akan tampil tepat waktu. ${state.locationName ? 'Lokasi: ' + state.locationName : ''}`,
          icon: 'icons/icon-192.png',
          tag: 'welcome',
        });
      }, 500);
    }
  } catch (err) {
    console.error('[Notif] Permission request failed:', err);
    dom.notificationStatus.textContent = 'Gagal meminta izin notifikasi.';
  }
}

/**
 * Sends a notification. Uses the Service Worker if available for
 * better reliability; falls back to the Notification constructor.
 * @param {string} title
 * @param {NotificationOptions} options
 */
function sendNotification(title, options = {}) {
  if (Notification.permission !== 'granted') return;

  const defaultOptions = {
    icon:    'icons/icon-192.png',
    badge:   'icons/icon-96.png',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    silent:  false,
  };

  const finalOptions = { ...defaultOptions, ...options };

  // Prefer Service Worker notifications (more reliable, works when app is backgrounded)
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type:    'SHOW_NOTIFICATION',
      title,
      options: finalOptions,
    });
  } else {
    // Fallback to direct Notification API
    try {
      new Notification(title, finalOptions);
    } catch (err) {
      console.warn('[Notif] Direct notification failed:', err);
    }
  }
}

/**
 * Clears all scheduled notification timers.
 */
function clearAllNotificationTimers() {
  state.notifTimers.forEach(id => clearTimeout(id));
  state.notifTimers = [];
}

/**
 * Schedules notifications for all prayer times today.
 * Uses setTimeout calculated from the current moment to each prayer time.
 * @param {Object} timings
 */
function scheduleAllNotifications(timings) {
  if (Notification.permission !== 'granted') return;
  clearAllNotificationTimers();

  const now            = new Date();
  const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  PRAYERS.forEach(prayer => {
    const [h, m]     = timings[prayer.apiKey].split(':').map(Number);
    const prayerSecs = h * 3600 + m * 60;
    const diffMs     = (prayerSecs - currentSeconds - CONFIG.NOTIFICATION_ADVANCE_SECONDS) * 1000;

    if (diffMs <= 0) return; // Prayer has already passed today

    const timerId = setTimeout(() => {
      sendNotification(`🕌 Waktu ${prayer.name}`, {
        body:  `Telah masuk waktu ${prayer.name} — ${timings[prayer.apiKey]} WIB\n${state.locationName ? '📍 ' + state.locationName : ''}`,
        tag:   `prayer-${prayer.key}`,
        icon:  'icons/icon-192.png',
        badge: 'icons/icon-96.png',
        vibrate: [300, 100, 300, 100, 300],
        requireInteraction: true,
        data: {
          prayer:     prayer.key,
          time:       timings[prayer.apiKey],
          url:        window.location.href,
        },
        actions: [
          { action: 'open',    title: '📖 Buka Aplikasi' },
          { action: 'dismiss', title: '✓ Tutup'          },
        ],
      });
    }, diffMs);

    state.notifTimers.push(timerId);
    console.log(
      `[Notif] ${prayer.name} (${timings[prayer.apiKey]}) dijadwalkan dalam ${Math.round(diffMs / 1000 / 60)} menit`
    );
  });
}

/* ────────────────────────────────────────────────────────────────
   SERVICE WORKER
──────────────────────────────────────────────────────────────── */

/**
 * Sends a message to the active Service Worker.
 * @param {Object} message
 */
function broadcastToServiceWorker(message) {
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(message);
  }
}

/**
 * Registers the Service Worker (sw.js).
 */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[SW] Service Worker not supported');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
    });

    console.log('[SW] Registered, scope:', registration.scope);

    // Listen for updates
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.statechange === 'installed' && navigator.serviceWorker.controller) {
          console.log('[SW] New version available');
        }
      });
    });

    // Listen for messages FROM the service worker
    navigator.serviceWorker.addEventListener('message', event => {
      const { type } = event.data || {};
      if (type === 'SW_READY') {
        console.log('[SW] Service Worker ready');
        // Re-send prayer times to newly activated SW
        if (state.prayerTimes) {
          broadcastToServiceWorker({
            type:    'PRAYER_TIMES',
            timings: state.prayerTimes,
            date:    getTodayString(),
          });
        }
      }
    });

  } catch (err) {
    console.error('[SW] Registration failed:', err);
  }
}

/* ────────────────────────────────────────────────────────────────
   PWA INSTALL PROMPT
──────────────────────────────────────────────────────────────── */

let deferredInstallPrompt = null;

/**
 * Listens for the browser's native install prompt event.
 * Defers it so we can show our custom banner at the right time.
 */
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;

  // Don't show if user dismissed before
  if (!storageGet(CONFIG.STORAGE_KEYS.INSTALL_DIM)) {
    // Show banner after a short delay (feels less intrusive)
    setTimeout(() => {
      dom.installBanner.classList.remove('hidden');
    }, 3000);
  }
});

/** Handles the "Pasang" button on the install banner */
dom.btnInstall.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;

  dom.installBanner.classList.add('hidden');
  deferredInstallPrompt.prompt();

  const { outcome } = await deferredInstallPrompt.userChoice;
  console.log('[PWA] Install outcome:', outcome);

  if (outcome === 'accepted') {
    deferredInstallPrompt = null;
  }
});

/** Dismisses the install banner */
dom.btnInstallDismiss.addEventListener('click', () => {
  dom.installBanner.classList.add('hidden');
  storageSave(CONFIG.STORAGE_KEYS.INSTALL_DIM, 'true');
  deferredInstallPrompt = null;
});

/* ────────────────────────────────────────────────────────────────
   EVENT LISTENERS
──────────────────────────────────────────────────────────────── */

// Refresh location button
dom.btnRefreshLoc.addEventListener('click', () => {
  // Clear cached coords to force a fresh lookup
  try { localStorage.removeItem(CONFIG.STORAGE_KEYS.LAST_COORDS); } catch {}
  fetchPrayerTimes();
});

// Retry button (shown on error)
dom.btnRetry.addEventListener('click', () => {
  fetchPrayerTimes();
});

// Notification button
dom.btnNotification.addEventListener('click', handleNotificationToggle);

// Re-schedule notifications when the page becomes visible again
// (the browser may have throttled or killed setTimeout while backgrounded)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.prayerTimes) {
    scheduleAllNotifications(state.prayerTimes);
  }
});

/* ────────────────────────────────────────────────────────────────
   ACCESSIBILITY — Announce to screen readers
──────────────────────────────────────────────────────────────── */

/**
 * Creates a live region announcement for screen readers.
 * @param {string} message
 */
function announceToScreenReader(message) {
  const el = document.createElement('div');
  el.setAttribute('aria-live', 'assertive');
  el.setAttribute('aria-atomic', 'true');
  el.className = 'visually-hidden';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ────────────────────────────────────────────────────────────────
   INITIALISATION
──────────────────────────────────────────────────────────────── */

/**
 * Application bootstrap function.
 * Called once DOM is ready.
 */
async function init() {
  console.log('[App] Jadwal Sholat PWA initialising...');

  // 1. Apply saved / system theme
  initTheme();

  // 2. Start the live clock immediately
  startClock();

  // 3. Register service worker
  registerServiceWorker();

  // 4. Check existing notification permission
  if ('Notification' in window) {
    updateNotificationUI();
  } else {
    dom.btnNotification.disabled = true;
    dom.notificationStatus.textContent = 'Browser tidak mendukung notifikasi.';
  }

  // 5. Fetch prayer times (main flow)
  await fetchPrayerTimes();

  console.log('[App] Initialisation complete.');
}

// Wait for DOM to be ready then boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
