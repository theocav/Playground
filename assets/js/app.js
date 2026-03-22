document.body.classList.add('js');

const prefersReducedMotion = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

const runtimeEnv = window.__POLYPLACES_ENV__ || {};

if (prefersReducedMotion) {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
} else {
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          obs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.1 }
  );

  document.querySelectorAll('.reveal').forEach((el) => obs.observe(el));
}

const cartStorageKey = 'polyplaces_cart_v1';
const apiBase =
  String(
    runtimeEnv.POLYPLACES_API_BASE_URL ||
      document.querySelector('meta[name="api-base"]')?.getAttribute('content') ||
      ''
  ).replace(/\/$/, '');
const NOMINATIM_SEARCH_URL =
  String(runtimeEnv.POLYPLACES_NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search').replace(
    /\/$/,
    ''
  );
const SEARCH_COUNTRY_CODES = runtimeEnv.POLYPLACES_SEARCH_COUNTRY_CODES || 'gb';
const SEARCH_VIEWBOX = runtimeEnv.POLYPLACES_SEARCH_VIEWBOX || '-8.7,60.9,1.9,49.8';

let storeInited = false;
let products = [];
let selectedProduct = null;
let handleIcon = null;

const fallbackProducts = [
  {
    id: 'neighbourhood',
    name: 'Neighbourhood',
    displaySize: '500m × 500m',
    sizeCode: 500,
    aspectRatio: 1,
    unitAmount: null,
    // Placeholder. If the backend is down, we still want the UI usable, but Stripe checkout must be disabled.
    priceId: 'fallback_neighbourhood',
  },
  {
    id: 'district',
    name: 'District',
    displaySize: '1km × 1km',
    sizeCode: 1000,
    aspectRatio: 1,
    unitAmount: null,
    priceId: 'fallback_district',
  },
  {
    id: 'quarter',
    name: 'Quarter',
    displaySize: '2km × 2km',
    sizeCode: 2000,
    aspectRatio: 1,
    unitAmount: null,
    priceId: 'fallback_quarter',
  },
  {
    id: 'frame',
    name: 'Frame',
    displaySize: '750m × 1.05km',
    sizeCode: 750,
    aspectRatio: 1.4,
    unitAmount: null,
    priceId: 'fallback_frame',
  },
];

function showCheckoutBanner() {
  const banner = document.getElementById('checkout-banner');
  const textEl = document.getElementById('checkout-banner-text');
  const closeBtn = document.getElementById('checkout-banner-close');
  if (!banner || !textEl || !closeBtn) return;

  const params = new URLSearchParams(window.location.search);
  const status = params.get('checkout');
  if (!status) return;

  const messages = {
    success: 'Payment successful. We have received your order.',
    fail: 'Payment failed. Please try again or use a different card.',
    abort: 'Checkout cancelled. You can resume anytime from your cart.',
  };
  const message = messages[status] || 'Checkout updated.';

  banner.classList.add('show');
  banner.classList.add(`is-${status}`);
  banner.setAttribute('aria-hidden', 'false');
  textEl.textContent = message;

  closeBtn.onclick = () => {
    banner.classList.remove('show', 'is-success', 'is-fail', 'is-abort');
    banner.setAttribute('aria-hidden', 'true');
  };

  if (window.history && window.history.replaceState) {
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    window.history.replaceState({}, '', url);
  }
}

function formatPriceFromAmount(amount) {
  if (amount === null || typeof amount === 'undefined') return '\u00A3\u2014';
  const value = Number(amount) / 100;
  if (!Number.isFinite(value)) return '\u00A3\u2014';
  return `\u00A3${value.toFixed(0)}`;
}

function renderSizeOptions() {
  const container = document.getElementById('size-options');
  const empty = document.getElementById('size-options-empty');
  if (!container || !empty) return;
  container.innerHTML = '';

  if (products.length === 0) {
    empty.textContent = 'No sizes available right now.';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  products.forEach((product) => {
    const btn = document.createElement('div');
    btn.className = 'size-opt';
    btn.dataset.productId = product.id;
    btn.innerHTML = `
      <div class="size-opt-info">
        <div class="size-opt-name">${product.name}</div>
        <div class="size-opt-sub">${product.displaySize}</div>
      </div>
      <div class="size-opt-price">${formatPriceFromAmount(product.unitAmount)}</div>
    `;
    btn.onclick = () => selectProduct(product);
    container.appendChild(btn);
  });
}

function selectProduct(product) {
  if (!product) return;
  const prevBBox = bbox ? { ...bbox } : null;
  const prevCenter = prevBBox
    ? { lat: (prevBBox.south + prevBBox.north) / 2, lng: (prevBBox.west + prevBBox.east) / 2 }
    : null;
  selectedProduct = product;
  document.querySelectorAll('.size-opt').forEach((b) => b.classList.remove('active'));
  const activeBtn = document.querySelector(`.size-opt[data-product-id="${product.id}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  if (layerGroup) layerGroup.clearLayers();
  resetReviewState();

  document.getElementById('sel-run').disabled = true;
  document.getElementById('map-hint').textContent = 'Placing your frame…';

  document.getElementById('order-scale').textContent = `${product.name} \u00B7 ${product.displaySize}`;
  document.getElementById('order-price').textContent = formatPriceFromAmount(product.unitAmount);

  // Place (or morph) the frame immediately at the center of the current viewport.
  if (map && handleIcon) {
    const center = prevCenter || map.getCenter();
    const nextBBox = computeBBoxForProduct(center, product);
    if (nextBBox) {
      if (prevBBox && bboxLayer && handle) {
        animateBBoxTo(nextBBox, 420);
      } else {
        createBBox(center, handleIcon);
      }
      document.getElementById('sel-run').disabled = false;
      document.getElementById('map-hint').textContent = 'Drag the corner handle to reposition';
      document.getElementById('order-status-msg').textContent = 'Adjust the frame, then continue to review.';
    } else {
      document.getElementById('order-status-msg').textContent = 'Unable to place the frame for this size.';
      document.getElementById('map-hint').textContent = 'Select a different size';
    }
  } else {
    document.getElementById('order-status-msg').textContent =
      'Select a scale, then click the map to place your frame.';
    document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
  }
}

async function loadProducts() {
  try {
    const res = await fetch(`${apiBase}/api/products`);
    const data = await res.json();
    const list = Array.isArray(data?.products) ? data.products : Array.isArray(data) ? data : [];
    products = Array.isArray(list) ? list : [];
    if (products.length === 0) {
      products = fallbackProducts.slice();
    }
    renderSizeOptions();
    return products;
  } catch {
    products = fallbackProducts.slice();
    renderSizeOptions();
    return [];
  }
}

async function initStore() {
  if (storeInited) return;
  storeInited = true;
  await loadProducts();
  initMap();
  if (selectedProduct) {
    // If the user selected a size before the map finished initializing, re-run selection to auto-place the frame.
    selectProduct(selectedProduct);
    return;
  }
  if (products.length > 0) selectProduct(products[0]);
}

function setupMapSearch() {
  const input = document.getElementById('map-search-input');
  const button = document.getElementById('map-search-btn');
  const resultsEl = document.getElementById('map-search-results');
  if (!input || !button || !resultsEl) return;

  const clearResults = () => {
    resultsEl.innerHTML = '';
    resultsEl.classList.remove('show');
  };

  const applyResult = (item) => {
    const lat = Number(item?.lat);
    const lon = Number(item?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: false });
    createBBox({ lat, lng: lon }, handleIcon);
    if (bbox) {
      document.getElementById('sel-run').disabled = false;
      document.getElementById('map-hint').textContent = 'Drag the corner handle to reposition';
      document.getElementById('order-status-msg').textContent = 'Looking good! Adjust the frame then continue.';
    }
    clearResults();
  };

  const renderResults = (items) => {
    resultsEl.innerHTML = '';
    if (!items || items.length === 0) {
      resultsEl.innerHTML = '<div class="map-search-result">No results found.</div>';
      resultsEl.classList.add('show');
      return;
    }
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'map-search-result';
      row.innerHTML = `<strong>${item.display_name}</strong>`;
      row.onclick = () => applyResult(item);
      resultsEl.appendChild(row);
    });
    resultsEl.classList.add('show');
  };

  const runSearch = async (autoSelectTop = false) => {
    const query = input.value.trim();
    if (!query) {
      clearResults();
      return;
    }
    try {
      const url = new URL(NOMINATIM_SEARCH_URL);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '6');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('countrycodes', SEARCH_COUNTRY_CODES);
      url.searchParams.set('bounded', '1');
      url.searchParams.set('viewbox', SEARCH_VIEWBOX);
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      const results = Array.isArray(data) ? data : [];
      if (autoSelectTop && results.length > 0) {
        applyResult(results[0]);
        return;
      }
      renderResults(results);
    } catch {
      renderResults([]);
    }
  };

  button.onclick = () => runSearch(false);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch(true);
    }
    if (e.key === 'Escape') {
      clearResults();
    }
  };

  document.addEventListener('click', (e) => {
    if (!resultsEl.classList.contains('show')) return;
    if (e.target === input || resultsEl.contains(e.target) || e.target === button) return;
    clearResults();
  });
}

function showStore() {
  window.location.href = '/store/';
}

function showLanding() {
  window.location.href = '/';
}

let map, layerGroup, bbox, bboxLayer, handle;
let selectionMeta = null;
let cart = [];
let buildingsFillLayer = null;
let buildingsOutlineLayer = null;
let buildingsAnimation = null;
let buildingsOutlineAnimation = null;
let reverseGeocodeTimer = null;
let lastReverseStamp = 0;
let reviewReady = false;

function initMap() {
  const ukBounds = L.latLngBounds([49.8, -8.7], [60.9, 1.9]);
  map = L.map('store-map', {
    zoomControl: true,
    maxBounds: ukBounds,
    maxBoundsViscosity: 1.0,
  }).setView([51.505, -0.09], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '\u00A9 OpenStreetMap',
  }).addTo(map);
  layerGroup = L.layerGroup().addTo(map);

  const hIcon = L.divIcon({
    className: '',
    html: `<div style="width:28px;height:28px;border-radius:50%;background:white;border:2.5px solid #c94f2c;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.2);cursor:grab"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#c94f2c" stroke-width="2.5"><path d="M12 2v20M2 12h20"/></svg></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  handleIcon = hIcon;
  setupMapSearch();

  document.getElementById('sel-run').onclick = reviewSelection;
  document.getElementById('sel-clear').onclick = clearMap;

  map.on('click', (e) => {
    if (!selectedProduct) return;
    createBBox(e.latlng, handleIcon);
    document.getElementById('sel-run').disabled = false;
    document.getElementById('map-hint').textContent = 'Drag the corner handle to reposition';
    document.getElementById('order-status-msg').textContent = 'Looking good! Adjust the frame then continue.';
  });

  map.on('zoomend', () => {
    if (!bbox) return;
    if (map.getZoom() < 12) {
      clearFrame();
    }
  });
}

function mToLat(m) {
  return m / 111320;
}

function mToLon(m, lat) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}

function computeBBox(c) {
  if (!selectedProduct) return null;
  const width = Number(selectedProduct.sizeCode);
  if (!Number.isFinite(width)) return null;
  const ratio = Number(selectedProduct.aspectRatio);
  const aspectRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const w = width;
  const h = width * aspectRatio;
  const dLat = mToLat(h / 2);
  const dLon = mToLon(w / 2, c.lat);
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon };
}

function computeBBoxForProduct(c, product) {
  if (!product) return null;
  const width = Number(product.sizeCode);
  if (!Number.isFinite(width)) return null;
  const ratio = Number(product.aspectRatio);
  const aspectRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const w = width;
  const h = width * aspectRatio;
  const dLat = mToLat(h / 2);
  const dLon = mToLon(w / 2, c.lat);
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function setBBoxLive(next) {
  bbox = next;
  if (bboxLayer) {
    bboxLayer.setLatLngs([
      [bbox.south, bbox.west],
      [bbox.south, bbox.east],
      [bbox.north, bbox.east],
      [bbox.north, bbox.west],
    ]);
  }
  if (handle) handle.setLatLng([bbox.north, bbox.west]);
}

let bboxAnim = null;
function animateBBoxTo(targetBBox, durationMs = 420) {
  if (!bbox || !targetBBox) return;
  if (bboxAnim) cancelAnimationFrame(bboxAnim);

  const from = { ...bbox };
  const start = performance.now();

  if (bboxLayer) bboxLayer.setStyle({ dashArray: '0', fillOpacity: 0.04 });

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeInOutCubic(t);
    const next = {
      south: lerp(from.south, targetBBox.south, e),
      north: lerp(from.north, targetBBox.north, e),
      west: lerp(from.west, targetBBox.west, e),
      east: lerp(from.east, targetBBox.east, e),
    };
    setBBoxLive(next);

    if (t < 1) {
      bboxAnim = requestAnimationFrame(step);
      return;
    }

    setBBoxLive(targetBBox);
    if (bboxLayer) bboxLayer.setStyle({ dashArray: '6 4', fillOpacity: 0.05 });
    updateLocationDisplay();
    bboxAnim = null;
  };

  bboxAnim = requestAnimationFrame(step);
}

function createBBox(c, icon) {
  bbox = computeBBox(c);
  if (!bbox) return;
  drawBBox(icon);
  updateLocationDisplay();
}

function drawBBox(icon) {
  if (!bbox) return;
  const coords = [
    [bbox.south, bbox.west],
    [bbox.south, bbox.east],
    [bbox.north, bbox.east],
    [bbox.north, bbox.west],
  ];
  if (bboxLayer) map.removeLayer(bboxLayer);
  bboxLayer = L.polygon(coords, {
    color: '#c94f2c',
    weight: 2,
    fillColor: '#c94f2c',
    fillOpacity: 0.05,
    dashArray: '6 4',
  }).addTo(map);
  const h = [bbox.north, bbox.west];
  if (!handle) {
    handle = L.marker(h, { draggable: true, icon }).addTo(map);
    handle.on('dragstart', () => {
      resetReviewState();
    });
    handle.on('drag', (e) => {
      layerGroup.clearLayers();
      moveFromHandle(e.target.getLatLng(), false);
    });
    handle.on('dragend', (e) => {
      moveFromHandle(e.target.getLatLng(), true);
    });
  } else {
    handle.setLatLng(h);
  }
}

function moveFromHandle(ll, updateLocation = true) {
  const w = bbox.east - bbox.west;
  const h = bbox.north - bbox.south;
  bbox = { south: ll.lat - h, north: ll.lat, west: ll.lng, east: ll.lng + w };
  if (bboxLayer) {
    bboxLayer.setLatLngs([
      [bbox.south, bbox.west],
      [bbox.south, bbox.east],
      [bbox.north, bbox.east],
      [bbox.north, bbox.west],
    ]);
  }
  if (handle) handle.setLatLng([bbox.north, bbox.west]);
  if (updateLocation) updateLocationDisplay();
}

function clearFrame() {
  if (layerGroup) layerGroup.clearLayers();
  resetReviewState();
  if (bboxLayer) {
    map.removeLayer(bboxLayer);
    bboxLayer = null;
  }
  if (handle) {
    map.removeLayer(handle);
    handle = null;
  }
  bbox = null;
  selectionMeta = null;
  document.getElementById('sel-run').disabled = true;
  document.getElementById('sel-run').textContent = 'Continue to review \u2192';
  document.getElementById('order-location').textContent = 'Select on map';
  document.getElementById('order-location').classList.add('pending');
  document.getElementById('order-status-msg').textContent =
    'Click on the map to place your frame, then drag the handle to adjust.';
  document.getElementById('map-hint').textContent = 'Click the map to place your frame';
}

function clearMap() {
  clearFrame();
  document.getElementById('sel-run').disabled = true;
  document.getElementById('sel-run').textContent = 'Continue to review \u2192';
  document.getElementById('order-scale').textContent = '\u2014';
  document.getElementById('order-price').textContent = '\u2014';
  document.getElementById('order-status-msg').textContent =
    'Choose a scale, then click the map to place your frame.';
  document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
  document.querySelectorAll('.size-opt').forEach((b) => b.classList.remove('active'));
  selectedProduct = null;
}

function updateLocationDisplay() {
  if (!bbox) return;
  const center = {
    lat: (bbox.south + bbox.north) / 2,
    lng: (bbox.west + bbox.east) / 2,
  };
  const locationText = 'Locating...';
  selectionMeta = {
    center,
    bbox,
    locationText,
  };
  const locationEl = document.getElementById('order-location');
  locationEl.textContent = locationText;
  locationEl.classList.remove('pending');
  const btn = document.getElementById('sel-run');
  if (btn && btn.textContent.includes('Added to cart')) {
    btn.textContent = 'Continue to review \u2192';
  }
  queueReverseGeocode(center);
}

function queueReverseGeocode(center) {
  if (!center) return;
  if (reverseGeocodeTimer) clearTimeout(reverseGeocodeTimer);
  reverseGeocodeTimer = setTimeout(() => {
    const now = Date.now();
    if (now - lastReverseStamp < 1100) {
      queueReverseGeocode(center);
      return;
    }
    lastReverseStamp = now;
    reverseGeocode(center);
  }, 700);
}

async function reverseGeocode(center) {
  try {
    const url = `${apiBase}/api/reverse-geocode?lat=${center.lat}&lon=${center.lng}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Reverse geocoding failed.');
    const data = await res.json();
    const label = data?.label || data?.display_name || 'Location unavailable';
    selectionMeta = { ...selectionMeta, locationText: label };
    const locationEl = document.getElementById('order-location');
    locationEl.textContent = label;
    locationEl.classList.remove('pending');
  } catch {
    if (selectionMeta) {
      selectionMeta = { ...selectionMeta, locationText: 'Location unavailable' };
    }
    const locationEl = document.getElementById('order-location');
    if (locationEl) {
      locationEl.textContent = 'Location unavailable';
      locationEl.classList.remove('pending');
    }
  }
}

function loadCart() {
  try {
    const stored = JSON.parse(localStorage.getItem(cartStorageKey));
    cart = Array.isArray(stored) ? stored : [];
    cart = cart.filter((item) => item && item.priceId);
  } catch {
    cart = [];
  }
}

function saveCart() {
  localStorage.setItem(cartStorageKey, JSON.stringify(cart));
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '\u00A3\u2014';
  return `\u00A3${n.toFixed(0)}`;
}

function renderCart() {
  const cartItemsEl = document.getElementById('cart-items');
  const cartCountEl = document.getElementById('cart-count');
  const cartTotalEl = document.getElementById('cart-total');
  const checkoutBtn = document.getElementById('cart-checkout');

  cartItemsEl.innerHTML = '';
  cartCountEl.textContent = String(cart.length);

  if (cart.length === 0) {
    cartItemsEl.innerHTML = '<div class="cart-empty">Your cart is empty. Add a sculpture to continue.</div>';
    cartTotalEl.textContent = '\u00A30';
    checkoutBtn.disabled = true;
    return;
  }
  checkoutBtn.disabled = false;

  let total = 0;
  cart.forEach((item, idx) => {
    const p = Number(item.price);
    if (Number.isFinite(p)) total += p;
    const itemEl = document.createElement('div');
    itemEl.className = 'cart-item';
    itemEl.innerHTML = `
      <div class="cart-item-title">${item.name}</div>
      <div class="cart-item-meta">${item.location}</div>
      <div class="cart-item-row">
        <div class="cart-item-price">${formatPrice(item.price)}</div>
        <button class="cart-item-remove" data-index="${idx}">Remove</button>
      </div>
    `;
    cartItemsEl.appendChild(itemEl);
  });

  cartTotalEl.textContent = formatPrice(total);
  cartItemsEl.querySelectorAll('.cart-item-remove').forEach((btn) => {
    btn.onclick = () => {
      const index = Number(btn.dataset.index);
      cart.splice(index, 1);
      saveCart();
      renderCart();
    };
  });
}

function addSelectionToCart() {
  if (!selectedProduct || !selectionMeta) return;
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const item = {
    id,
    productId: selectedProduct.id,
    priceId: selectedProduct.priceId,
    name: selectedProduct.name,
    displaySize: selectedProduct.displaySize,
    sizeCode: selectedProduct.sizeCode,
    price: Number.isFinite(Number(selectedProduct.unitAmount)) ? Number(selectedProduct.unitAmount) / 100 : NaN,
    location: selectionMeta.locationText,
    bbox: selectionMeta.bbox,
    center: selectionMeta.center,
  };
  cart.push(item);
  saveCart();
  renderCart();
}

function openCart() {
  document.body.classList.add('cart-open');
  document.getElementById('cart-drawer').setAttribute('aria-hidden', 'false');
}

function closeCart() {
  document.body.classList.remove('cart-open');
  document.getElementById('cart-drawer').setAttribute('aria-hidden', 'true');
}

async function checkoutCart() {
  if (cart.length === 0) return;
  if (cart.some((i) => String(i?.priceId || '').startsWith('fallback_'))) {
    alert('Checkout is temporarily unavailable (sizes loaded from fallback config). Please try again shortly.');
    return;
  }
  const checkoutBtn = document.getElementById('cart-checkout');
  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Redirecting...';
  try {
    const res = await fetch(`${apiBase}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cart }),
    });
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || 'Checkout failed');
    window.location.href = data.url;
  } catch (err) {
    alert(err.message || 'Unable to start checkout.');
  } finally {
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Checkout securely with Stripe';
  }
}

function initCartUI() {
  loadCart();
  renderCart();
  document.getElementById('cart-toggle').onclick = openCart;
  document.getElementById('cart-close').onclick = closeCart;
  document.getElementById('cart-overlay').onclick = closeCart;
  document.getElementById('cart-checkout').onclick = checkoutCart;
}

function initNavUI() {
  const toggle = document.getElementById('nav-toggle');
  const drawer = document.getElementById('nav-drawer');
  const overlay = document.getElementById('nav-overlay');
  if (!toggle || !drawer || !overlay) return;

  const closeNav = () => {
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    drawer.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('aria-hidden', 'true');
  };

  const openNav = () => {
    document.body.classList.add('nav-open');
    toggle.setAttribute('aria-expanded', 'true');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.setAttribute('aria-hidden', 'false');
  };

  toggle.onclick = () => {
    const isOpen = document.body.classList.contains('nav-open');
    if (isOpen) {
      closeNav();
    } else {
      openNav();
    }
  };

  overlay.onclick = closeNav;
  drawer.addEventListener('click', (e) => {
    if (e.target.closest('a,button')) closeNav();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNav();
  });
}

initCartUI();
initNavUI();
showCheckoutBanner();

if (document.getElementById('storePage')) {
  initStore();
}

async function reviewSelection() {
  if (!selectedProduct || !bbox || !selectionMeta) return;
  const btn = document.getElementById('sel-run');
  if (reviewReady) {
    addSelectionToCart();
    document.getElementById('order-status-msg').textContent = '\u2713 Added to cart.';
    btn.textContent = '\u2713 Added to cart';
    openCart();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Loading building outlines...';
  document.getElementById('order-status-msg').textContent = 'Zooming to your frame and loading buildings.';

  const bounds = L.latLngBounds([bbox.south, bbox.west], [bbox.north, bbox.east]);
  map.fitBounds(bounds, { padding: [24, 24] });

  try {
    await loadBuildingsForBBox(bbox);
    reviewReady = true;
    document.getElementById('order-status-msg').textContent =
      '\u2713 Buildings outlined. Add to cart when ready.';
    btn.textContent = 'Add to cart';
  } catch (err) {
    const msg = err?.message || '';
    const hint =
      msg.includes('Failed to fetch') || msg.includes('Network')
        ? 'Could not reach the map service. Is the backend running?'
        : 'Could not load building outlines.';
    document.getElementById('order-status-msg').textContent =
      `${hint} Please try again.`;
    btn.textContent = 'Retry outlines';
  } finally {
    btn.disabled = false;
  }
}

function clearBuildings() {
  if (buildingsFillLayer) {
    map.removeLayer(buildingsFillLayer);
    buildingsFillLayer = null;
  }
  if (buildingsOutlineLayer) {
    map.removeLayer(buildingsOutlineLayer);
    buildingsOutlineLayer = null;
  }
  if (buildingsAnimation) {
    clearInterval(buildingsAnimation);
    buildingsAnimation = null;
  }
  if (buildingsOutlineAnimation) {
    clearInterval(buildingsOutlineAnimation);
    buildingsOutlineAnimation = null;
  }
}

function resetReviewState() {
  clearBuildings();
  reviewReady = false;
  const btn = document.getElementById('sel-run');
  if (btn) {
    btn.textContent = 'Continue to review \u2192';
  }
  document.getElementById('order-status-msg').textContent =
    'Frame placed. Drag to adjust, then continue to review.';
}

async function loadBuildingsForBBox(b) {
  clearBuildings();
  const bboxParam = `${b.south},${b.west},${b.north},${b.east}`;
  const res = await fetch(`${apiBase}/api/buildings?bbox=${bboxParam}`);
  if (!res.ok) throw new Error('Buildings API failed');
  const data = await res.json();
  const features = (data?.features || []).map((f) => f);
  buildingsFillLayer = L.geoJSON(features, {
    style: () => ({
      color: '#c94f2c',
      weight: 0.9,
      fillOpacity: 0.12,
      fillColor: '#c94f2c',
    }),
  }).addTo(map);
  buildingsOutlineLayer = L.geoJSON(features, {
    style: () => ({
      color: '#c94f2c',
      weight: 1.4,
      opacity: 0.95,
      fillOpacity: 0,
    }),
  }).addTo(map);

  startBuildingWave();
  startOutlineShimmer();
}

function startBuildingWave() {
  if (prefersReducedMotion) return;
  if (!buildingsFillLayer) return;
  const start = Date.now();
  buildingsAnimation = setInterval(() => {
    const t = (Date.now() - start) / 1000;
    buildingsFillLayer.eachLayer((layer) => {
      if (!layer.getBounds) return;
      const c = layer.getBounds().getCenter();
      const phase = t + c.lat * 8;
      const lightness = 38 + Math.sin(phase) * 8;
      const color = `hsl(12, 65%, ${lightness}%)`;
      layer.setStyle({ color, fillColor: color });
    });
  }, 160);
}

function startOutlineShimmer() {
  if (prefersReducedMotion) return;
  if (!buildingsOutlineLayer) return;
  const waveBounds = bbox
    ? {
        west: bbox.west,
        east: bbox.east,
        south: bbox.south,
        north: bbox.north,
      }
    : buildingsOutlineLayer.getBounds();
  const minX = waveBounds.getWest ? waveBounds.getWest() : waveBounds.west;
  const maxX = waveBounds.getEast ? waveBounds.getEast() : waveBounds.east;
  const minY = waveBounds.getSouth ? waveBounds.getSouth() : waveBounds.south;
  const maxY = waveBounds.getNorth ? waveBounds.getNorth() : waveBounds.north;
  const rangeX = Math.max(1e-9, maxX - minX);
  const rangeY = Math.max(1e-9, maxY - minY);

  const start = Date.now();
  buildingsOutlineAnimation = setInterval(() => {
    const t = (Date.now() - start) / 1000;
    buildingsOutlineLayer.eachLayer((layer) => {
      if (!layer.getBounds) return;
      const c = layer.getBounds().getCenter();
      const nx = (c.lng - minX) / rangeX;
      const ny = (c.lat - minY) / rangeY;
      const projection = (nx + ny) / 2;
      const speed = 0.18;
      const center = (t * speed) % 1;
      let dist = Math.abs(projection - center);
      if (dist > 0.5) dist = 1 - dist;
      const band = Math.exp(-Math.pow(dist / 0.18, 2));
      const opacity = 0.35 + band * 0.55;
      const lightness = 50 + band * 16;
      const color = `hsl(12, 70%, ${lightness}%)`;
      layer.setStyle({ color, opacity });
    });
  }, 110);
}

window.showStore = showStore;
window.showLanding = showLanding;
