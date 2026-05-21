// pwa-install.js — Script d'installation PWA Veridian pour sites clients.
// Charge dans le <head> du site client via :
//   <script src="https://analytics.app.veridian.site/pwa-install.js"
//           data-site-key="sk_..."
//           data-tenant="demo-analytics"
//           data-veridian-pwa="auto"
//           async></script>
//
// Le site client doit aussi avoir un fichier public/veridian-sw.js qui fait :
//   importScripts('https://analytics.app.veridian.site/client-sw.js');
//
// Supporte iOS (guide d'installation Safari) et Android (beforeinstallprompt).

(function () {
  'use strict';

  // ─── Config depuis les data-attributes du script tag ─────────────────
  var scriptTag = document.currentScript;
  if (!scriptTag) return;

  var siteKey = scriptTag.getAttribute('data-site-key') || '';
  var tenant = scriptTag.getAttribute('data-tenant') || '';
  var mode = scriptTag.getAttribute('data-veridian-pwa') || 'auto';
  // URL de base du serveur Analytics (deduite depuis le src du script)
  var analyticsUrl = '';
  try {
    var src = scriptTag.getAttribute('src') || '';
    var u = new URL(src);
    analyticsUrl = u.origin;
  } catch (_) {
    analyticsUrl = '';
  }

  if (!siteKey && !tenant) {
    console.warn('[veridian-pwa] data-site-key ou data-tenant requis');
    return;
  }

  // ─── Detection plateforme ───────────────────────────────────────────
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  var isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;

  // ─── 1. Injecter le lien manifest dans le <head> ────────────────────
  if (!document.querySelector('link[rel="manifest"]') && analyticsUrl && tenant) {
    var link = document.createElement('link');
    link.rel = 'manifest';
    link.href = analyticsUrl + '/api/manifest?tenant=' + encodeURIComponent(tenant) + '&mode=client';
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }

  // ─── 2. Enregistrer le Service Worker local ──────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/veridian-sw.js', { scope: '/' })
      .then(function (reg) {
        console.log('[veridian-pwa] SW enregistre, scope:', reg.scope);
        if (mode === 'auto') {
          waitForActivation(reg).then(function () {
            tryPushSubscribe(reg);
          });
        }
      })
      .catch(function (err) {
        console.warn('[veridian-pwa] SW registration echouee:', err.message);
      });
  }

  // ─── 3. Android : prompt d'installation via beforeinstallprompt ──────
  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;

    var buttons = document.querySelectorAll('[data-veridian-install]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].removeAttribute('hidden');
      buttons[i].style.display = '';
      buttons[i].addEventListener('click', handleInstallClick);
    }
  });

  function handleInstallClick() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function (choice) {
      if (choice.outcome === 'accepted') {
        var buttons = document.querySelectorAll('[data-veridian-install]');
        for (var i = 0; i < buttons.length; i++) {
          buttons[i].setAttribute('hidden', '');
        }
      }
      deferredPrompt = null;
    });
  }

  // ─── 4. iOS : bottom sheet guide d'installation Safari ──────────────
  if (isIOS && !isStandalone) {
    // Ne pas afficher si deja dismiss dans les 7 derniers jours
    if (document.cookie.indexOf('veridian_ios_install_dismissed=1') === -1) {
      // Attendre que le DOM soit pret puis injecter le popup apres un court delai
      // (laisser le temps a la page de se charger avant d'afficher le guide)
      setTimeout(showIOSInstallGuide, 3000);
    }
  }

  function showIOSInstallGuide() {
    // Creer le backdrop overlay
    var overlay = document.createElement('div');
    overlay.id = 'veridian-ios-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9998;' +
      'opacity:0;transition:opacity 0.3s ease;';

    // Creer le bottom sheet
    var sheet = document.createElement('div');
    sheet.id = 'veridian-ios-sheet';
    sheet.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:9999;' +
      'background:#fff;border-radius:16px 16px 0 0;' +
      'box-shadow:0 -4px 24px rgba(0,0,0,0.15);' +
      'padding:24px 20px env(safe-area-inset-bottom, 20px);' +
      'transform:translateY(100%);transition:transform 0.3s ease;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

    var tenantLabel = tenant.replace(/-/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });

    sheet.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' +
        '<div style="width:48px;height:48px;border-radius:12px;background:#2563eb;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:20px">' +
          tenantLabel.charAt(0) +
        '</div>' +
        '<div>' +
          '<div style="font-weight:600;font-size:16px;color:#111">' +
            'Installez ' + tenantLabel +
          '</div>' +
          '<div style="font-size:13px;color:#666">Acces rapide depuis l\'ecran d\'accueil</div>' +
        '</div>' +
      '</div>' +
      '<div style="background:#f5f5f5;border-radius:12px;padding:16px;margin-bottom:16px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:14px;color:#333">' +
          '<span style="font-size:18px">\u2B06\uFE0F</span>' +
          '<span>Appuyez sur <strong>Partager</strong></span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;font-size:14px;color:#333">' +
          '<span style="font-size:18px">\u2795</span>' +
          '<span>Puis <strong>Sur l\u2019ecran d\u2019accueil</strong></span>' +
        '</div>' +
      '</div>' +
      '<button id="veridian-ios-dismiss" style="' +
        'width:100%;padding:12px;border:none;border-radius:10px;' +
        'background:#f0f0f0;color:#333;font-size:15px;font-weight:500;' +
        'cursor:pointer;-webkit-tap-highlight-color:transparent' +
      '">Plus tard</button>';

    document.body.appendChild(overlay);
    document.body.appendChild(sheet);

    // Animation d'entree
    requestAnimationFrame(function () {
      overlay.style.opacity = '1';
      sheet.style.transform = 'translateY(0)';
    });

    function dismiss() {
      sheet.style.transform = 'translateY(100%)';
      overlay.style.opacity = '0';
      // Cookie 7 jours pour ne pas re-afficher
      document.cookie = 'veridian_ios_install_dismissed=1;max-age=604800;path=/;SameSite=Lax';
      setTimeout(function () {
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 350);
    }

    document.getElementById('veridian-ios-dismiss').addEventListener('click', dismiss);
    overlay.addEventListener('click', dismiss);
  }

  // ─── 5. Push subscribe ──────────────────────────────────────────────
  function waitForActivation(reg) {
    return new Promise(function (resolve) {
      if (reg.active) return resolve();
      var sw = reg.installing || reg.waiting;
      if (!sw) return resolve();
      sw.addEventListener('statechange', function () {
        if (sw.state === 'activated') resolve();
      });
    });
  }

  function tryPushSubscribe(reg) {
    if (!('PushManager' in window)) return;
    if (!analyticsUrl) return;
    if (Notification.permission === 'denied') return;

    // iOS : les push ne marchent que si la PWA est installee (standalone).
    // Sur iOS non-standalone, on ne tente meme pas.
    if (isIOS && !isStandalone) return;

    var currentlyStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      navigator.standalone === true;

    if (Notification.permission === 'granted') {
      subscribePush(reg);
    } else if (currentlyStandalone && Notification.permission === 'default') {
      // iOS EXIGE un geste utilisateur pour Notification.requestPermission().
      // Un appel automatique est bloque silencieusement. On affiche donc un
      // bandeau en haut de la page avec un bouton "Activer les notifications"
      // que le user doit cliquer explicitement.
      showPushOptInBanner(reg);
    }
  }

  function showPushOptInBanner(reg) {
    // Ne pas afficher si deja dismiss dans les 7 derniers jours
    if (document.cookie.indexOf('veridian_push_dismissed=1') !== -1) return;

    var banner = document.createElement('div');
    banner.id = 'veridian-push-banner';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;' +
      'background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;' +
      'padding:12px 16px;display:flex;align-items:center;gap:12px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,0.2);' +
      'transform:translateY(-100%);transition:transform 0.3s ease;';

    banner.innerHTML =
      '<span style="font-size:20px">\uD83D\uDD14</span>' +
      '<span style="flex:1">Activez les notifications pour ne rien manquer</span>' +
      '<button id="veridian-push-accept" style="' +
        'background:#fff;color:#2563eb;border:none;border-radius:8px;' +
        'padding:8px 16px;font-weight:600;font-size:13px;cursor:pointer;' +
        'white-space:nowrap;-webkit-tap-highlight-color:transparent' +
      '">Activer</button>' +
      '<button id="veridian-push-dismiss" style="' +
        'background:transparent;color:rgba(255,255,255,0.7);border:none;' +
        'font-size:18px;cursor:pointer;padding:4px 8px;' +
        '-webkit-tap-highlight-color:transparent' +
      '">\u2715</button>';

    document.body.appendChild(banner);

    // Animation d'entree
    requestAnimationFrame(function () {
      banner.style.transform = 'translateY(0)';
    });

    function removeBanner() {
      banner.style.transform = 'translateY(-100%)';
      setTimeout(function () {
        if (banner.parentNode) banner.parentNode.removeChild(banner);
      }, 350);
    }

    document.getElementById('veridian-push-accept').addEventListener('click', function () {
      // Le click utilisateur autorise l'appel a Notification.requestPermission()
      // sur iOS (et tous les autres browsers). C'est le geste explicite requis.
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') {
          subscribePush(reg);
        }
        removeBanner();
      });
    });

    document.getElementById('veridian-push-dismiss').addEventListener('click', function () {
      document.cookie = 'veridian_push_dismissed=1;max-age=604800;path=/;SameSite=Lax';
      removeBanner();
    });
  }

  function subscribePush(reg) {
    fetch(analyticsUrl + '/api/push/vapid-key')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.publicKey) return;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.publicKey),
        });
      })
      .then(function (subscription) {
        if (!subscription) return;
        // Collecte des metadonnees device disponibles sans permission
        // supplementaire. Utile pour croiser avec les appels telephoniques
        // (meme horaire = meme lead probable) et segmenter par plateforme.
        var deviceInfo = {
          userAgent: navigator.userAgent || null,
          language: navigator.language || null,
          screenSize: screen.width + 'x' + screen.height,
          platform: /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iOS'
            : /Android/.test(navigator.userAgent) ? 'Android' : 'Desktop',
          installPage: window.location.pathname || '/',
        };
        return fetch(analyticsUrl + '/api/push/client-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            siteKey: siteKey,
            subscription: subscription.toJSON(),
            device: deviceInfo,
          }),
        });
      })
      .then(function (res) {
        if (res && res.ok) {
          console.log('[veridian-pwa] Push subscribe OK');
        }
      })
      .catch(function (err) {
        console.warn('[veridian-pwa] Push subscribe echoue:', err.message);
      });
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
})();
