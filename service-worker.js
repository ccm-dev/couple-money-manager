/* Couple Money Manager service worker.
   Bump VERSION each time you upload a new index.html so phones pick up the update. */
const VERSION = 'cmm-v1.60-beta94-1';
const APP_SHELL = [
  './',
  './index.html',
  './couple-money-manager.css',
  './couple-money-manager.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg'
];
/* Libraries the app loads on demand (Firebase SDK, Excel and PDF readers). Cached after first use so they work offline. */
const LIB_HOSTS = ['www.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
/* Never cached: live data and sign-in. */
const NO_CACHE = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|googleapis\.com\/.*(token|auth)|firebaseinstallations|google-analytics|googletagmanager|api\.openai\.com|generativelanguage\.googleapis\.com|\/__\/auth\//;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') { self.skipWaiting(); return; }
  /* the app (or a test) can ask for an immediate reminder check */
  if (event.data && event.data.type === 'cmm-rem-check') {
    const done = reminderCheck().then(shown => {
      if (event.source && event.source.postMessage) event.source.postMessage({ type: 'cmm-rem-checked', shown });
    });
    if (event.waitUntil) event.waitUntil(done);
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NO_CACHE.test(req.url)) return;

  /* The app page: network first so updates arrive, cached copy when offline. */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  /* Own files and known libraries: cache first, refresh in the background. */
  if (url.origin === self.location.origin || LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then(cached => {
        const net = fetch(req)
          .then(res => {
            if (res && (res.ok || res.type === 'opaque')) {
              const copy = res.clone();
              caches.open(VERSION).then(c => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || net;
      })
    );
  }
});

/* ---------- Payment reminders while the app is closed (v1.60 beta 32) ----------
   The page keeps a reminder schedule in IndexedDB ('cmm-reminders' / 'kv' / 'schedule') and
   registers Periodic Background Sync (tag 'cmm-reminders'). On each sync this worker shows
   every reminder that is due today and has not been shown today by the page or the worker
   (shared log 'kv' / 'sent'). The schedule never contains partner-private reminders, and holds
   no names or amounts when the app lock or "Hide amounts in notifications" is on. */
const REM_DB = 'cmm-reminders', REM_STORE = 'kv', REM_TAG = 'cmm-reminders';

function remIdb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(REM_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(REM_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function remGet(key) {
  return remIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(REM_STORE, 'readonly'), q = tx.objectStore(REM_STORE).get(key);
    q.onsuccess = () => resolve(q.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}
function remPut(key, value) {
  return remIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(REM_STORE, 'readwrite');
    tx.objectStore(REM_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}
function remToday() {
  const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function reminderCheck() {
  const td = remToday();
  return Promise.all([remGet('schedule'), remGet('sent')]).then(([sc, sentIn]) => {
    if (!sc || !Array.isArray(sc.items) || !sc.items.length) return 0;
    const sent = {}, pageSent = sc.sentToday || {}, jobs = [];
    Object.keys(sentIn || {}).forEach(k => { if (sentIn[k] === td) sent[k] = td; });   /* keep today only */
    sc.items.forEach(it => {
      if (td < it.from || td > it.until) return;
      if (sent[it.key] === td || pageSent[it.key] === td) return;                       /* once a day */
      const over = td > it.due;
      sent[it.key] = td;
      jobs.push(self.registration.showNotification(over ? it.overdueTitle : it.title, {
        body: over ? it.overdueBody : it.body,
        tag: 'cmm32|' + it.key,
        renotify: false,
        data: { cmm32: true, remKey: it.remKey, url: sc.url || self.registration.scope }
      }));
    });
    return Promise.all(jobs).then(() => remPut('sent', sent)).then(() => jobs.length);
  }).catch(() => 0);
}

self.addEventListener('periodicsync', event => {
  if (event.tag === REM_TAG) event.waitUntil(reminderCheck());
});

/* Payment reminders: tapping a notification opens (or focuses) the app on the payment.
   Background reminders and (since beta 43) reminders shown by the open page both carry the
   payment key; a notification without one opens the Reminder centre. */
self.addEventListener('notificationclick', event => {
  const data = (event.notification && event.notification.data) || {};
  const remKey = data.cmm32 ? (data.remKey || '') : '';
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'cmm-open-reminder', remKey });
          return c.focus();
        }
      }
      return self.clients.openWindow('./index.html#rem=' + encodeURIComponent(remKey));
    })
  );
});
