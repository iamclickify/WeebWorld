const CACHE_NAME = 'weebworld-cache-v1';
const DYNAMIC_CACHE_NAME = 'weebworld-dynamic-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './updates.html',
  './anime.js',
  './updates.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== DYNAMIC_CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Dynamic Cache for MyAnimeList CDN images (Cache-first)
  if (url.hostname.includes('myanimelist.net') && url.pathname.includes('/images/')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(DYNAMIC_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => {
          // Silent catch for offline image failures
        });
      })
    );
  } else {
    // Standard static cache-first with network updates for local assets
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        return cachedResponse || fetch(event.request).then((networkResponse) => {
          const isStaticAsset = ASSETS.some(asset => {
            const cleanAsset = asset.replace('./', '');
            return cleanAsset && url.pathname.endsWith(cleanAsset);
          });
          if (isStaticAsset && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return networkResponse;
        }).catch(() => {
          // If offline and not in cache
        });
      })
    );
  }
});
