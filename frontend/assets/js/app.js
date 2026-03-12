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

const prices = { '500': 89, '1000': 129, '2000': 179, a4: 129 };
const scaleNames = {
  '500': 'Neighbourhood \u00B7 500m\u00D7500m',
  '1000': 'District \u00B7 1km\u00D71km',
  '2000': 'Quarter \u00B7 2km\u00D72km',
  a4: 'Portrait \u00B7 1km\u00D7A4',
};
const cartStorageKey = 'polyplaces_cart_v1';
const apiBase =
  document.querySelector('meta[name="api-base"]')?.getAttribute('content')?.replace(/\/$/, '') || '';

let storeInited = false;

function showStore() {
  document.getElementById('landing').style.display = 'none';
  document.getElementById('storePage').style.display = 'block';
  document.body.classList.add('store-open');
  window.scrollTo(0, 0);
  if (!storeInited) {
    initMap();
    storeInited = true;
  }
}

function showLanding() {
  document.getElementById('storePage').style.display = 'none';
  document.getElementById('landing').style.display = 'block';
  document.body.classList.remove('store-open');
  window.scrollTo(0, 0);
}

let map, layerGroup, bbox, bboxLayer, handle, selectedSize;
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
  map = L.map('store-map', { zoomControl: true }).setView([51.505, -0.09], 14);
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

  document.querySelectorAll('.size-opt').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.size-opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSize = btn.dataset.size;
      layerGroup.clearLayers();
      resetReviewState();
      createBBox(map.getCenter(), hIcon);
      document.getElementById('sel-run').disabled = false;
      document.getElementById('sel-run').textContent = 'Continue to review \u2192';
      document.getElementById('map-hint').textContent = 'Drag the corner handle to reposition';
      document.getElementById('order-scale').textContent = scaleNames[selectedSize];
      document.getElementById('order-price').textContent = `\u00A3${prices[selectedSize]}`;
      document.getElementById('order-status-msg').textContent = 'Looking good! Adjust the frame then continue.';
      updateLocationDisplay();
    };
  });

  document.getElementById('sel-run').onclick = reviewSelection;
  document.getElementById('sel-clear').onclick = clearMap;

  selectedSize = '500';
  createBBox(map.getCenter(), hIcon);
  document.getElementById('sel-run').disabled = false;
  document.getElementById('map-hint').textContent = 'Drag the corner handle to reposition';
  document.getElementById('order-scale').textContent = scaleNames['500'];
  document.getElementById('order-price').textContent = '\u00A389';
  updateLocationDisplay();
  document.getElementById('order-status-msg').textContent = 'Frame placed. Drag to adjust, then continue to review.';
}

function mToLat(m) {
  return m / 111320;
}

function mToLon(m, lat) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}

function computeBBox(c) {
  let w, h;
  if (selectedSize === 'a4') {
    w = 1000;
    h = 1000 * Math.sqrt(2);
  } else {
    w = h = parseFloat(selectedSize);
  }
  const dLat = mToLat(h / 2);
  const dLon = mToLon(w / 2, c.lat);
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon };
}

function createBBox(c, icon) {
  bbox = computeBBox(c);
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

function clearMap() {
  layerGroup.clearLayers();
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
  document.getElementById('sel-run').disabled = true;
  document.getElementById('sel-run').textContent = 'Continue to review \u2192';
  document.getElementById('order-scale').textContent = '\u2014';
  document.getElementById('order-price').textContent = '\u2014';
  document.getElementById('order-location').textContent = 'Select on map';
  document.getElementById('order-location').classList.add('pending');
  document.getElementById('order-status-msg').textContent =
    'Choose a scale, place the frame, then continue to review.';
  document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
  document.querySelectorAll('.size-opt').forEach((b) => b.classList.remove('active'));
  selectedSize = null;
  selectionMeta = null;
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
  } catch {
    cart = [];
  }
}

function saveCart() {
  localStorage.setItem(cartStorageKey, JSON.stringify(cart));
}

function formatPrice(value) {
  return `\u00A3${value.toFixed(0)}`;
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
    total += item.price;
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
  if (!selectedSize || !selectionMeta) return;
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const item = {
    id,
    name: scaleNames[selectedSize],
    price: prices[selectedSize],
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

initCartUI();

async function reviewSelection() {
  if (!selectedSize || !bbox || !selectionMeta) return;
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
