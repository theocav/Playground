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

const _hintSentinel = document.getElementById('map-hint-sentinel');
const _mapHint = document.getElementById('map-hint');
if (_hintSentinel && _mapHint) {
  new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => _mapHint.classList.toggle('is-docked', e.isIntersecting));
    },
    { threshold: 0 }
  ).observe(_hintSentinel);
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
let cartFocusCleanup = null;
let navFocusCleanup = null;
let lastCartFocus = null;

const PRODUCT_NAME_OVERRIDES = {
  neighbourhood: 'Small',
  quarter: 'Large',
  portrait: 'A4',
};
const PRODUCT_ID_BLACKLIST = new Set(['district']);

function sanitizeProductList(list) {
  const input = Array.isArray(list) ? list : [];
  return input
    .filter((product) => product && !PRODUCT_ID_BLACKLIST.has(String(product.id)))
    .map((product) => {
      const overrideName = PRODUCT_NAME_OVERRIDES[String(product.id)];
      return overrideName ? { ...product, name: overrideName } : product;
    });
}

const fallbackProducts = [
  {
    id: 'neighbourhood',
    name: 'Small',
    displaySize: '500m × 500m',
    sizeCode: 500,
    aspectRatio: 1,
    unitAmount: null,
    // Placeholder. If the backend is down, we still want the UI usable, but Stripe checkout must be disabled.
    priceId: 'fallback_neighbourhood',
  },
  {
    id: 'quarter',
    name: 'Large',
    displaySize: '2km × 2km',
    sizeCode: 2000,
    aspectRatio: 1,
    unitAmount: null,
    priceId: 'fallback_quarter',
  },
  {
    id: 'portrait',
    name: 'A4',
    displaySize: '750m × 1.05km',
    sizeCode: 750,
    aspectRatio: 1.4,
    unitAmount: null,
    priceId: 'fallback_portrait',
  },
];

const productMeta = {
  neighbourhood: { artSize: '20\u00D720cm', badge: 'Most popular' },
  portrait:      { artSize: '20\u00D728cm', badge: 'Best for gifting' },
  quarter:       { artSize: '40\u00D740cm', badge: null },
};

// Custom size configuration. ratePerSqm can be overridden by the API response.
const CUSTOM_SIZE_MIN_MM = 100;
const CUSTOM_SIZE_MAX_MM = 330;
const CUSTOM_SIZE_LARGE_THRESHOLD_MM = 250;
const CUSTOM_SIZE_LARGE_SURCHARGE_GBP = 5;
const CUSTOM_SIZE_DEFAULT_RATE_PER_SQM = 1500; // £ per m²
const CUSTOM_MAP_SCALE = 3; // 1 mm of print = 3 m of map coverage
let customSizeRatePerSqm = CUSTOM_SIZE_DEFAULT_RATE_PER_SQM;

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}

function createFocusTrap(container, onClose) {
  const handler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose?.();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusables = getFocusableElements(container);
    if (focusables.length === 0) {
      e.preventDefault();
      container?.focus?.();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
      return;
    }
    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

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

  if (status === 'success') {
    // Stripe returned successfully; clear the cart so users don't accidentally repurchase.
    clearCart();
  }

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

function showBanner(message, type = 'fail') {
  const banner = document.getElementById('checkout-banner');
  const textEl = document.getElementById('checkout-banner-text');
  const closeBtn = document.getElementById('checkout-banner-close');
  if (!banner || !textEl || !closeBtn) return;
  textEl.textContent = message;
  banner.className = `checkout-banner show is-${type}`;
  banner.setAttribute('aria-hidden', 'false');
  closeBtn.onclick = () => {
    banner.classList.remove('show', 'is-success', 'is-fail', 'is-abort');
    banner.setAttribute('aria-hidden', 'true');
  };
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
    const meta = productMeta[product.id] || {};
    const badge = meta.badge ? `<span class="size-opt-badge">${meta.badge}</span>` : '';
    const artSize = meta.artSize ? ` &middot; <span class="size-opt-art">${meta.artSize}</span>` : '';
    btn.innerHTML = `
      <div class="size-opt-info">
        <div class="size-opt-name-row"><div class="size-opt-name">${product.name}</div>${badge}</div>
        <div class="size-opt-sub">${product.displaySize}${artSize}</div>
      </div>
      <div class="size-opt-price">${formatPriceFromAmount(product.unitAmount)}</div>
    `;
    btn.onclick = () => selectProduct(product);
    container.appendChild(btn);
  });

  // Custom size option — always appended last.
  const customBtn = document.createElement('div');
  customBtn.className = 'size-opt size-opt-custom';
  customBtn.dataset.productId = 'custom';
  customBtn.innerHTML = `
    <div class="size-opt-info">
      <div class="size-opt-name-row"><div class="size-opt-name">Custom</div></div>
      <div class="size-opt-sub">Up to ${CUSTOM_SIZE_MAX_MM}\u00D7${CUSTOM_SIZE_MAX_MM}mm</div>
    </div>
    <div class="size-opt-price size-opt-price-custom">&darr; Set size</div>
  `;
  customBtn.onclick = () => activateCustomSize();
  container.appendChild(customBtn);
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

  // Show or hide the custom size inputs panel.
  const customPanel = document.getElementById('custom-size-panel');
  if (customPanel) customPanel.hidden = product.id !== 'custom';

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
      document.getElementById('order-status-msg').textContent = 'Adjust the frame, then add to cart.';
    } else {
      document.getElementById('order-status-msg').textContent = 'Unable to place the frame for this size.';
      document.getElementById('map-hint').textContent = 'Select a different size';
    }
  } else {
    document.getElementById('order-status-msg').textContent =
      'Select a scale to place your frame.';
    document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
  }
}

async function loadProducts() {
  try {
    const res = await fetch(`${apiBase}/api/products`);
    const data = await res.json();
    const list = Array.isArray(data?.products) ? data.products : Array.isArray(data) ? data : [];
    products = sanitizeProductList(list);
    if (products.length === 0) products = sanitizeProductList(fallbackProducts.slice());
    if (Number.isFinite(Number(data?.customSizePricePerSqm)) && Number(data.customSizePricePerSqm) > 0) {
      customSizeRatePerSqm = Number(data.customSizePricePerSqm);
    }
    renderSizeOptions();
    return products;
  } catch {
    products = sanitizeProductList(fallbackProducts.slice());
    renderSizeOptions();
    return [];
  }
}

async function initStore() {
  if (storeInited) return;
  storeInited = true;
  await loadProducts();
  initMap();
  initCustomSizePanel();
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

  let activeIndex = -1;
  let activeResults = [];

  const clearResults = () => {
    resultsEl.innerHTML = '';
    resultsEl.classList.remove('show');
    resultsEl.setAttribute('aria-hidden', 'true');
    activeIndex = -1;
    activeResults = [];
  };

  const applyResult = (item) => {
    const lat = Number(item?.lat);
    const lon = Number(item?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: false });

    // After search, always center the frame on the new viewport center (if a product is selected).
    if (selectedProduct && map && handleIcon) {
      const center = map.getCenter();
      const next = computeBBoxForProduct(center, selectedProduct);
      if (next) {
        if (bbox && bboxLayer && handle) {
          animateBBoxTo(next, 420);
        } else {
          createBBox(center, handleIcon);
        }
        document.getElementById('sel-run').disabled = false;
        document.getElementById('map-hint').textContent = 'Drag the corner handle to reposition';
        document.getElementById('order-status-msg').textContent = 'Looking good! Adjust the frame then add to cart.';
      }
    }
    clearResults();
  };

  const setActiveIndex = (nextIndex, { focus = false } = {}) => {
    if (!Array.isArray(activeResults) || activeResults.length === 0) return;
    const clamped = Math.max(0, Math.min(activeResults.length - 1, nextIndex));
    activeIndex = clamped;
    resultsEl.querySelectorAll('.map-search-result[role="option"]').forEach((el) => {
      const idx = Number(el.dataset.index);
      el.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
    });
    if (focus) {
      const el = resultsEl.querySelector(`.map-search-result[data-index="${activeIndex}"]`);
      el?.focus?.();
    }
  };

  const renderResults = (items) => {
    resultsEl.innerHTML = '';
    if (!items || items.length === 0) {
      const row = document.createElement('div');
      row.className = 'map-search-result is-empty';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.textContent = 'No results found.';
      resultsEl.appendChild(row);
      resultsEl.classList.add('show');
      resultsEl.setAttribute('aria-hidden', 'false');
      activeIndex = -1;
      activeResults = [];
      return;
    }
    activeResults = items.slice();
    activeIndex = 0;
    items.forEach((item, idx) => {
      const row = document.createElement('button');
      row.className = 'map-search-result';
      row.type = 'button';
      row.dataset.index = String(idx);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
      row.innerHTML = `<strong>${item.display_name}</strong>`;
      row.onclick = () => applyResult(item);
      row.onmouseenter = () => setActiveIndex(idx);
      row.onfocus = () => setActiveIndex(idx);
      resultsEl.appendChild(row);
    });
    resultsEl.classList.add('show');
    resultsEl.setAttribute('aria-hidden', 'false');
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
    const isOpen = resultsEl.classList.contains('show');
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && activeIndex >= 0 && activeResults[activeIndex]) {
        applyResult(activeResults[activeIndex]);
        return;
      }
      runSearch(true);
    }
    if (e.key === 'Escape') {
      clearResults();
    }
    if (e.key === 'ArrowDown') {
      if (!isOpen || activeResults.length === 0) return;
      e.preventDefault();
      setActiveIndex(activeIndex + 1, { focus: true });
    }
    if (e.key === 'ArrowUp') {
      if (!isOpen || activeResults.length === 0) return;
      e.preventDefault();
      setActiveIndex(activeIndex - 1, { focus: true });
    }
  };

  resultsEl.addEventListener('keydown', (e) => {
    const isOpen = resultsEl.classList.contains('show');
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      clearResults();
      input.focus();
    }
    if (e.key === 'ArrowDown') {
      if (activeResults.length === 0) return;
      e.preventDefault();
      setActiveIndex(activeIndex + 1, { focus: true });
    }
    if (e.key === 'ArrowUp') {
      if (activeResults.length === 0) return;
      e.preventDefault();
      setActiveIndex(activeIndex - 1, { focus: true });
    }
  });

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
let reverseGeocodeTimer = null;
let lastReverseStamp = 0;
let cartPreviewMaps = new Map();

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

  // No map click handler: frame placement is driven by the scale selector only (see selectProduct).

  map.on('zoomend', () => {
    if (!bbox) return;
    if (map.getZoom() < 12) {
      clearFrame();
    }
  });
}

function clearCart() {
  cart = [];
  try {
    localStorage.removeItem(cartStorageKey);
  } catch {
    // ignore
  }
  renderCart();
}

function bboxToBounds(b) {
  if (!b) return null;
  const south = Number(b.south);
  const west = Number(b.west);
  const north = Number(b.north);
  const east = Number(b.east);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  return L.latLngBounds([south, west], [north, east]);
}

function syncCartPreviewMaps() {
  if (typeof L === 'undefined') return;
  const previewEls = Array.from(document.querySelectorAll('.cart-item-preview'));
  const keep = new Set();
  let cartMutated = false;

  const resolveCartItemBBox = (item) => {
    const existingBounds = bboxToBounds(item?.bbox);
    if (existingBounds) return existingBounds;

    // Back-compat: older carts may be missing `bbox`, but we can often recompute it from
    // the stored `center` and known product dimensions.
    const center = item?.center;
    if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lng))) return null;

    const resolvedProduct =
      products.find((p) => String(p?.id) === String(item?.productId)) ||
      fallbackProducts.find((p) => String(p?.id) === String(item?.productId));

    // If we can't resolve a product entry (e.g., cart opened on pages where products
    // aren't loaded), fall back to dimensions stored on the cart item itself.
    const pseudoProduct = resolvedProduct
      ? resolvedProduct
      : {
          sizeCode: item?.sizeCode,
          aspectRatio: item?.aspectRatio,
        };

    const computed = computeBBoxForProduct({ lat: Number(center.lat), lng: Number(center.lng) }, pseudoProduct);
    const computedBounds = bboxToBounds(computed);
    if (!computedBounds) return null;

    item.bbox = computed;
    cartMutated = true;
    return computedBounds;
  };

  previewEls.forEach((el) => {
    const id = String(el.dataset.itemId || '');
    const item = cart.find((i) => String(i?.id) === id);
    if (!id) return;

    const bounds = resolveCartItemBBox(item);
    if (!bounds) {
      // Older carts (or fallback data) may not include enough info to preview.
      el.classList.add('is-fallback');
      el.innerHTML = '<div class="cart-item-preview-fallback">Preview unavailable</div>';
      return;
    }

    el.classList.remove('is-fallback');
    keep.add(id);
    const existing = cartPreviewMaps.get(id);
    if (existing) {
      const existingContainer = existing?.container || existing?.map?._container || null;
      const containerDetached = existingContainer ? !document.body.contains(existingContainer) : true;
      const containerMismatch = existingContainer ? existingContainer !== el : true;
      if (containerDetached || containerMismatch) {
        try {
          existing.map.remove();
        } catch {
          // ignore
        }
        cartPreviewMaps.delete(id);
      } else {
      existing.rect.setBounds(bounds);
      existing.map.fitBounds(bounds, { padding: [10, 10], animate: false });
      existing.map.invalidateSize(false);
      return;
      }
    }

    // Ensure container is empty (Leaflet will inject its own DOM)
    el.innerHTML = '';

    const m = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      touchZoom: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '\u00A9 OpenStreetMap',
    }).addTo(m);

    const rect = L.rectangle(bounds, {
      color: '#c94f2c',
      weight: 3,
      fillColor: '#c94f2c',
      fillOpacity: 0.12,
      dashArray: '5 4',
    }).addTo(m);

    m.fitBounds(bounds, { padding: [10, 10], animate: false });

    cartPreviewMaps.set(id, { map: m, rect, container: el });

    // If the drawer is animating open, sizes can be wrong at first render.
    setTimeout(() => {
      try {
        m.invalidateSize(false);
        m.fitBounds(bounds, { padding: [10, 10], animate: false });
      } catch {
        // ignore
      }
    }, 80);
    setTimeout(() => {
      try {
        m.invalidateSize(false);
        m.fitBounds(bounds, { padding: [10, 10], animate: false });
      } catch {
        // ignore
      }
    }, 360);
  });

  for (const [id, entry] of cartPreviewMaps.entries()) {
    if (keep.has(id)) continue;
    try {
      entry.map.remove();
    } catch {
      // ignore
    }
    cartPreviewMaps.delete(id);
  }

  if (cartMutated) {
    try {
      saveCart();
    } catch {
      // ignore
    }
  }
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
  document.getElementById('sel-run').textContent = 'Add to cart \u2192';
  document.getElementById('order-location').textContent = 'Select on map';
  document.getElementById('order-location').classList.add('pending');
  document.getElementById('order-status-msg').textContent =
    'Select a scale to place your frame.';
  document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
}

function clearMap() {
  clearFrame();
  document.getElementById('sel-run').disabled = true;
  document.getElementById('sel-run').textContent = 'Add to cart \u2192';
  document.getElementById('order-scale').textContent = '\u2014';
  document.getElementById('order-price').textContent = '\u2014';
  document.getElementById('order-status-msg').textContent =
    'Choose a scale to place your frame.';
  document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
  document.querySelectorAll('.size-opt').forEach((b) => b.classList.remove('active'));
  selectedProduct = null;
  const customPanel = document.getElementById('custom-size-panel');
  if (customPanel) customPanel.hidden = true;
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
    btn.textContent = 'Add to cart \u2192';
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
  const cartToggleEl = document.getElementById('cart-toggle');
  const cartTotalEl = document.getElementById('cart-total');
  const checkoutBtn = document.getElementById('cart-checkout');
  if (!cartItemsEl || !cartCountEl || !cartTotalEl || !checkoutBtn) return;

  cartItemsEl.innerHTML = '';
  cartCountEl.textContent = String(cart.length);
  if (cartToggleEl) {
    const suffix = cart.length === 1 ? 'item' : 'items';
    cartToggleEl.setAttribute('aria-label', `Open cart (${cart.length} ${suffix})`);
  }

  if (cart.length === 0) {
    cartItemsEl.innerHTML = '<div class="cart-empty">Your cart is empty. Add a sculpture to continue.</div>';
    cartTotalEl.textContent = '\u00A30';
    checkoutBtn.disabled = true;
    syncCartPreviewMaps();
    return;
  }
  checkoutBtn.disabled = false;

  let total = 0;
  cart.forEach((item, idx) => {
    const p = Number(item.price);
    if (Number.isFinite(p)) total += p;
    const itemEl = document.createElement('div');
    itemEl.className = 'cart-item';
    const labelLine = item.customLabel
      ? `<div class="cart-item-meta cart-item-custom-label">${item.customLabel}</div><div class="cart-item-geo">${item.location}</div>`
      : `<div class="cart-item-meta">${item.location}</div>`;
    itemEl.innerHTML = `
      <div class="cart-item-preview" data-item-id="${item.id}"></div>
      <div class="cart-item-title">${item.name}</div>
      ${labelLine}
      <div class="cart-item-row">
        <div class="cart-item-price">${formatPrice(item.price)}</div>
        <button type="button" class="cart-item-remove" data-index="${idx}">Remove</button>
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

  syncCartPreviewMaps();
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
    aspectRatio: selectedProduct.aspectRatio,
    price: Number.isFinite(Number(selectedProduct.unitAmount)) ? Number(selectedProduct.unitAmount) / 100 : NaN,
    location: selectionMeta.locationText,
    customLabel: (document.getElementById('custom-location-label')?.value || '').trim(),
    bbox: selectionMeta.bbox,
    center: selectionMeta.center,
    ...(selectedProduct.id === 'custom' && {
      customWidthMm: selectedProduct.customWidthMm,
      customHeightMm: selectedProduct.customHeightMm,
    }),
  };
  cart.push(item);
  saveCart();
  renderCart();
}

function openCart() {
  const drawer = document.getElementById('cart-drawer');
  const overlay = document.getElementById('cart-overlay');
  const toggle = document.getElementById('cart-toggle');
  const closeBtn = document.getElementById('cart-close');
  if (!drawer) return;
  if (document.body.classList.contains('cart-open')) return;

  lastCartFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.add('cart-open');
  drawer.setAttribute('aria-hidden', 'false');
  overlay?.setAttribute('aria-hidden', 'false');
  toggle?.setAttribute('aria-expanded', 'true');
  cartFocusCleanup?.();
  cartFocusCleanup = createFocusTrap(drawer, closeCart);
  if (closeBtn) closeBtn.focus();
  else drawer.focus();
  syncCartPreviewMaps();
  // Re-sync after the slide-in transition so Leaflet has the final layout box.
  setTimeout(syncCartPreviewMaps, 320);
  setTimeout(syncCartPreviewMaps, 700);
}

function closeCart() {
  const drawer = document.getElementById('cart-drawer');
  const overlay = document.getElementById('cart-overlay');
  const toggle = document.getElementById('cart-toggle');
  if (!drawer) return;
  if (!document.body.classList.contains('cart-open')) return;

  document.body.classList.remove('cart-open');
  drawer.setAttribute('aria-hidden', 'true');
  overlay?.setAttribute('aria-hidden', 'true');
  toggle?.setAttribute('aria-expanded', 'false');
  cartFocusCleanup?.();
  cartFocusCleanup = null;
  if (lastCartFocus && document.documentElement.contains(lastCartFocus)) lastCartFocus.focus();
  lastCartFocus = null;
}

async function checkoutCart() {
  if (cart.length === 0) return;
  if (cart.some((i) => String(i?.priceId || '').startsWith('fallback_'))) {
    showBanner('Checkout is temporarily unavailable. Please try again shortly.', 'fail');
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
    showBanner(err.message || 'Unable to start checkout. Please try again.', 'fail');
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
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.setAttribute('aria-expanded', 'false');
    drawer.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('aria-hidden', 'true');
    navFocusCleanup?.();
    navFocusCleanup = null;
    toggle.focus();
  };

  const openNav = () => {
    document.body.classList.add('nav-open');
    toggle.setAttribute('aria-label', 'Close menu');
    toggle.setAttribute('aria-expanded', 'true');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.setAttribute('aria-hidden', 'false');
    navFocusCleanup?.();
    navFocusCleanup = createFocusTrap(drawer, closeNav);
    const first = drawer.querySelector('a,button');
    if (first instanceof HTMLElement) first.focus();
    else if (drawer instanceof HTMLElement) drawer.focus();
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
}

// ── Custom size ────────────────────────────────────────────────────────────────

function calculateCustomPrice(widthMm, heightMm) {
  const areaSqm = (widthMm / 1000) * (heightMm / 1000);
  let price = Math.round(areaSqm * customSizeRatePerSqm);
  if (widthMm > CUSTOM_SIZE_LARGE_THRESHOLD_MM || heightMm > CUSTOM_SIZE_LARGE_THRESHOLD_MM) {
    price += CUSTOM_SIZE_LARGE_SURCHARGE_GBP;
  }
  return price; // whole pounds
}

function buildCustomProduct(widthMm, heightMm) {
  const w = Math.round(Math.max(CUSTOM_SIZE_MIN_MM, Math.min(CUSTOM_SIZE_MAX_MM, widthMm)));
  const h = Math.round(Math.max(CUSTOM_SIZE_MIN_MM, Math.min(CUSTOM_SIZE_MAX_MM, heightMm)));
  const pricePounds = calculateCustomPrice(w, h);
  return {
    id: 'custom',
    name: 'Custom',
    displaySize: `${w}\u00D7${h}mm`,
    sizeCode: w * CUSTOM_MAP_SCALE,
    aspectRatio: h / w,
    unitAmount: pricePounds * 100,
    priceId: 'custom',
    customWidthMm: w,
    customHeightMm: h,
  };
}

function activateCustomSize() {
  const panel = document.getElementById('custom-size-panel');
  if (panel) panel.hidden = false;
  document.querySelectorAll('.size-opt').forEach((b) => b.classList.remove('active'));
  const customBtn = document.querySelector('.size-opt[data-product-id="custom"]');
  if (customBtn) customBtn.classList.add('active');
  updateCustomSizeSelection();
}

function updateCustomSizeSelection() {
  const wInput = document.getElementById('custom-width');
  const hInput = document.getElementById('custom-height');
  if (!wInput || !hInput) return;

  const rawW = Number(wInput.value);
  const rawH = Number(hInput.value);
  if (!Number.isFinite(rawW) || rawW <= 0 || !Number.isFinite(rawH) || rawH <= 0) return;

  const w = Math.round(Math.max(CUSTOM_SIZE_MIN_MM, Math.min(CUSTOM_SIZE_MAX_MM, rawW)));
  const h = Math.round(Math.max(CUSTOM_SIZE_MIN_MM, Math.min(CUSTOM_SIZE_MAX_MM, rawH)));

  const product = buildCustomProduct(w, h);

  // Keep the custom button price label in sync.
  const priceLabelEl = document.querySelector('.size-opt[data-product-id="custom"] .size-opt-price');
  if (priceLabelEl) priceLabelEl.textContent = formatPrice(product.unitAmount / 100);

  // Show surcharge note if applicable.
  const surchargeEl = document.getElementById('custom-size-surcharge-note');
  if (surchargeEl) {
    const hasLarge = w > CUSTOM_SIZE_LARGE_THRESHOLD_MM || h > CUSTOM_SIZE_LARGE_THRESHOLD_MM;
    surchargeEl.hidden = !hasLarge;
  }

  selectProduct(product);
}

function initCustomSizePanel() {
  const wInput = document.getElementById('custom-width');
  const hInput = document.getElementById('custom-height');
  if (!wInput || !hInput) return;
  const onChange = () => {
    if (selectedProduct?.id !== 'custom') return;
    updateCustomSizeSelection();
  };
  wInput.addEventListener('input', onChange);
  hInput.addEventListener('input', onChange);
  wInput.addEventListener('change', onChange);
  hInput.addEventListener('change', onChange);
}

// ── End custom size ────────────────────────────────────────────────────────────

initCartUI();
initNavUI();
showCheckoutBanner();

if (document.getElementById('storePage')) {
  initStore();
}

function reviewSelection() {
  if (!selectedProduct || !bbox || !selectionMeta) return;
  addSelectionToCart();
  const btn = document.getElementById('sel-run');
  document.getElementById('order-status-msg').textContent = '\u2713 Added to cart.';
  btn.textContent = '\u2713 Added to cart';
  openCart();
}

function resetReviewState() {
  const btn = document.getElementById('sel-run');
  if (btn) btn.textContent = 'Add to cart \u2192';
  const statusEl = document.getElementById('order-status-msg');
  if (statusEl) statusEl.textContent = 'Frame placed. Drag to adjust, then add to cart.';
}


window.showStore = showStore;
window.showLanding = showLanding;
