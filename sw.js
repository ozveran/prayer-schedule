/* ================================================================
   JADWAL SHOLAT PWA — sw.js (Service Worker)
   Description: Handles:
     1. App Shell caching (offline support)
     2. Background push / notification display
     3. Notification action handling (click/dismiss)
     4. Periodic background prayer time checks
     5. Message passing with the main app thread
================================================================ */

'use strict';

/* ────────────────────────────────────────────────────────────────
   CACHE CONFIGURATION
──────────────────────────────────────────────────────────────── */

/** Version this cache so updates force a fresh install */
const CACHE_VERSION = 'jadwal-sholat-v1.2';

/**
 * App Shell files — cached on install.
 * These files are served from cache on all subsequent requests,
 * making the app work fully offline.
 */
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
];

/**
 * External origins we cache with a Network-First strategy.
 * (API responses and geocoding)
 */
const NETWORK_FIRST_ORIGINS = [
  'https://api.aladhan.com',
  'https://nominatim.openstreetmap.org',
];

/* ────────────────────────────────────────────────────────────────
   PRAYER STATE (held in SW memory)
   This is reset on SW restart — the main thread re-sends it
   via postMessage when the page loads.
──────────────────────────────────────────────────────────────── */
let prayerSchedule = {
  timings: null,   // { Fajr: "04:30", Dhuhr: "12:15", ... }
  date:    null,   // "DD-MM-YYYY"
  timers:  [],     // setTimeout IDs
};

/* ────────────────────────────────────────────────────────────────
   PRAYER DEFINITIONS (mirrored from script.js)
──────────────────────────────────────────────────────────────── */
const PRAYERS = [
  { key: 'Fajr',    name: 'Shubuh',  apiKey: 'Fajr',    icon: '🌅' },
  { key: 'Dhuhr',   name: 'Dzuhur',  apiKey: 'Dhuhr',   icon: '☀️' },
  { key: 'Asr',     name: 'Ashar',   apiKey: 'Asr',     icon: '🌤️' },
  { key: 'Maghrib', name: 'Maghrib', apiKey: 'Maghrib', icon: '🌇' },
  { key: 'Isha',    name: 'Isya',    apiKey: 'Isha',    icon: '🌙' },
];

/* ────────────────────────────────────────────────────────────────
   INSTALL EVENT
   Pre-caches the App Shell so the app works offline immediately.
──────────────────────────────────────────────────────────────── */
self.addEventListener('install', event => {
  console.log('[SW] Install event — caching App Shell');

  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => {
        // addAll fails atomically if ANY file 404s.
        // We use add individually and swallow single-file errors gracefully.
        return Promise.allSettled(
          APP_SHELL.map(url =>
            cache.add(url).catch(err =>
              console.warn(`[SW] Cache miss for ${url}:`, err.message)
            )
          )
        );
      })
      .then(() => {
        console.log('[SW] App Shell cached successfully');
        // Activate immediately — don't wait for old SW to die
        return self.skipWaiting();
      })
  );
});

/* ────────────────────────────────────────────────────────────────
   ACTIVATE EVENT
   Cleans up old cache versions and takes control of all clients.
──────────────────────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  console.log('[SW] Activate event');

  event.waitUntil(
    Promise.all([
      // Delete old caches
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_VERSION)
            .map(key => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      ),
      // Take control of all open tabs immediately
      self.clients.claim(),
    ]).then(() => {
      console.log('[SW] Activated and controlling all clients');
      // Notify main thread that SW is ready
      self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: 'SW_READY' })
        );
      });
    })
  );
});

/* ────────────────────────────────────────────────────────────────
   FETCH EVENT — Cache Strategies
──────────────────────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip browser extension requests
  if (!request.url.startsWith('http')) return;

  // Strategy 1: NETWORK FIRST for API calls
  if (NETWORK_FIRST_ORIGINS.some(origin => request.url.startsWith(origin))) {
    event.respondWith(networkFirstStrategy(request));
    return;
  }

  // Strategy 2: CACHE FIRST for App Shell assets
  event.respondWith(cacheFirstStrategy(request));
});

/**
 * Cache First: serve from cache, fall back to network, then cache response.
 * Best for: static assets (HTML, CSS, JS, images).
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function cacheFirstStrategy(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    // Cache successful responses for future offline use
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // Return a basic offline fallback for navigation requests
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Offline — koneksi tidak tersedia', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * Network First: try network, fall back to cache.
 * Best for: API responses where freshness matters.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirstStrategy(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      // Update cache with fresh data
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // Fall back to cache
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline', code: 503 }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/* ────────────────────────────────────────────────────────────────
   MESSAGE EVENT — Communication from main thread
──────────────────────────────────────────────────────────────── */
self.addEventListener('message', event => {
  const { type, ...data } = event.data || {};
  console.log('[SW] Message received:', type);

  switch (type) {

    /**
     * Main app sends prayer times so SW can schedule background notifications.
     * This message is sent:
     *   - On every app load
     *   - After a successful API fetch
     *   - On date change (midnight)
     */
    case 'PRAYER_TIMES': {
      prayerSchedule.timings = data.timings;
      prayerSchedule.date    = data.date;
      scheduleSWNotifications(data.timings);
      break;
    }

    /**
     * Main app requests SW to show a notification immediately.
     * Used for test notifications and prayer time alerts when the
     * direct Notification API might be restricted.
     */
    case 'SHOW_NOTIFICATION': {
      const { title, options } = data;
      self.registration.showNotification(title, options || {})
        .catch(err => console.error('[SW] showNotification failed:', err));
      break;
    }

    /**
     * Main app requests cache invalidation (e.g. forced refresh).
     */
    case 'CLEAR_CACHE': {
      caches.delete(CACHE_VERSION)
        .then(() => console.log('[SW] Cache cleared on demand'));
      break;
    }
  }
});

/* ────────────────────────────────────────────────────────────────
   SW-SIDE NOTIFICATION SCHEDULING
   Uses setTimeout within the Service Worker scope.
   
   ⚠️  IMPORTANT BROWSER BEHAVIOUR NOTE:
   Service Workers are "ephemeral" — browsers CAN kill them when
   idle to save resources. On iOS Safari PWA and some Android browsers,
   setTimeout in a SW is NOT reliable for > 30 seconds.
   
   For guaranteed delivery without a push server:
     - The main thread (script.js) also schedules notifications
     - The SW is a second layer of redundancy
     - When the page reactivates, it re-schedules from script.js
   
   For a production app with a server, use the Push API instead.
──────────────────────────────────────────────────────────────── */

/**
 * Clears all SW-side notification timers.
 */
function clearSWTimers() {
  prayerSchedule.timers.forEach(id => clearTimeout(id));
  prayerSchedule.timers = [];
}

/**
 * Parses "HH:MM" into seconds since midnight.
 * @param {string} timeStr
 * @returns {number}
 */
function timeToSeconds(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 3600 + m * 60;
}

/**
 * Schedules SW notifications for each prayer in the provided timings.
 * This acts as a backup to the main thread's scheduling.
 * @param {Object} timings
 */
function scheduleSWNotifications(timings) {
  if (!timings) return;
  clearSWTimers();

  const now            = new Date();
  const nowSeconds     = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  PRAYERS.forEach(prayer => {
    const prayerSeconds = timeToSeconds(timings[prayer.apiKey]);
    const diffMs        = (prayerSeconds - nowSeconds) * 1000;

    if (diffMs <= 500) return; // Skip already-past prayers (500ms grace)

    /**
     * Use event.waitUntil to keep the SW alive during the timeout.
     * Note: This is a best-effort approach. For production-grade
     * background notifications, integrate a push notification server.
     */
    const timerId = setTimeout(async () => {
      try {
        await self.registration.showNotification(
          `🕌 Waktu ${prayer.name}`,
          {
            body:    `Telah masuk waktu ${prayer.name} — ${timings[prayer.apiKey]}`,
            icon:    './icons/icon-192.png',
            badge:   './icons/icon-96.png',
            tag:     `prayer-${prayer.key}-sw`,
            vibrate: [300, 100, 300, 100, 300],
            requireInteraction: true,
            silent:  false,
            data: {
              prayer:  prayer.key,
              time:    timings[prayer.apiKey],
              url:     self.registration.scope,
            },
            actions: [
              { action: 'open',    title: '📖 Buka Aplikasi' },
              { action: 'dismiss', title: '✓ Tutup'          },
            ],
          }
        );
        console.log(`[SW] Notification shown for ${prayer.name}`);
      } catch (err) {
        console.error(`[SW] Failed to show notification for ${prayer.name}:`, err);
      }
    }, diffMs);

    prayerSchedule.timers.push(timerId);
    console.log(
      `[SW] ${prayer.name} (${timings[prayer.apiKey]}) scheduled in ${Math.round(diffMs / 60000)} min`
    );
  });
}

/* ────────────────────────────────────────────────────────────────
   NOTIFICATION CLICK EVENT
   Handles what happens when the user taps a prayer notification.
──────────────────────────────────────────────────────────────── */
self.addEventListener('notificationclick', event => {
  const { notification, action } = event;
  const notifData = notification.data || {};

  console.log('[SW] Notification clicked, action:', action || 'default');

  // Always close the notification
  notification.close();

  // Handle specific actions
  if (action === 'dismiss') return;

  // Default action or 'open' — focus or open the app
  event.waitUntil(
    self.clients.matchAll({
      type:                'window',
      includeUncontrolled: true,
    }).then(clients => {
      // If app is already open, focus it
      for (const client of clients) {
        if (client.url.includes(self.registration.scope)) {
          return client.focus();
        }
      }
      // Otherwise, open a new window
      const targetUrl = notifData.url || self.registration.scope;
      return self.clients.openWindow(targetUrl);
    })
  );
});

/* ────────────────────────────────────────────────────────────────
   NOTIFICATION CLOSE EVENT
   Fired when user dismisses the notification by swiping or via
   the notification centre (not by clicking).
──────────────────────────────────────────────────────────────── */
self.addEventListener('notificationclose', event => {
  const prayer = event.notification.data?.prayer;
  console.log(`[SW] Notification closed for prayer: ${prayer || 'unknown'}`);
  // Optionally: log analytics, update badge count, etc.
});

/* ────────────────────────────────────────────────────────────────
   PUSH EVENT (for future server-side push support)
   If you integrate a push notification server (e.g., Firebase FCM),
   this handler will receive and display the pushed payload.
──────────────────────────────────────────────────────────────── */
self.addEventListener('push', event => {
  console.log('[SW] Push event received');

  let payload = { title: '🕌 Waktu Sholat', body: 'Telah masuk waktu sholat.' };

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || '🕌 Waktu Sholat', {
      body:    payload.body,
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-96.png',
      tag:     payload.tag || 'push-notification',
      vibrate: [300, 100, 300],
      data:    payload.data || {},
      requireInteraction: true,
    })
  );
});

/* ────────────────────────────────────────────────────────────────
   PERIODIC BACKGROUND SYNC (Chrome 80+)
   Allows the SW to run periodically even when no page is open.
   NOTE: Requires the app to be installed as a PWA.
   
   To enable periodic sync, the main app must call:
     await registration.periodicSync.register('prayer-times-check', {
       minInterval: 24 * 60 * 60 * 1000  // once per day
     });
──────────────────────────────────────────────────────────────── */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'prayer-times-check') {
    console.log('[SW] Periodic sync: prayer-times-check');
    event.waitUntil(
      // In a real app with a backend, you'd re-fetch prayer times here.
      // For this client-only app, we log and wait for the user to open the app.
      Promise.resolve(
        console.log('[SW] Periodic sync completed — open app to refresh times.')
      )
    );
  }
});

/* ────────────────────────────────────────────────────────────────
   BACKGROUND SYNC (one-shot)
   Retries failed API requests when connectivity is restored.
──────────────────────────────────────────────────────────────── */
self.addEventListener('sync', event => {
  if (event.tag === 'prayer-times-sync') {
    console.log('[SW] Background sync: retrying prayer times fetch');
    // The main thread will handle the retry on next focus/visibility
    event.waitUntil(Promise.resolve());
  }
});

console.log('[SW] Service Worker loaded — version:', 'jadwal-sholat-v1.2');
