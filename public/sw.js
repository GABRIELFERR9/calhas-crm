const CACHE_NAME = 'calhas-v1';
const STATIC_ASSETS = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './logo.png',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // Estratégia para API (Network First, then Cache)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/tickets') || url.pathname.startsWith('/clients') || url.pathname.startsWith('/settings')) {
        if (request.method !== 'GET') {
            // POST/PATCH/DELETE: tentamos ir pra rede direto. 
            // Para suporte offline completo precisaríamos de Background Sync / IndexedDB aqui.
            return;
        }
        
        event.respondWith(
            fetch(request)
                .then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                    return response;
                })
                .catch(() => caches.match(request))
        );
        return;
    }

    // Estratégia para arquivos estáticos (Stale-While-Revalidate ou Cache First)
    event.respondWith(
        caches.match(request).then(cached => {
            const networkFetch = fetch(request).then(response => {
                caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
                return response;
            }).catch(() => {});
            return cached || networkFetch;
        })
    );
});
