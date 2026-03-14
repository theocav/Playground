import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://127.0.0.1:5500,http://localhost:5500';
const FRONTEND_ORIGINS = FRONTEND_URL.split(',').map((item) => item.trim()).filter(Boolean);
const PRIMARY_FRONTEND_URL = 'http://127.0.0.1:5500';
const BACKEND_URL = process.env.BACKEND_URL || `http://127.0.0.1:${PORT}`;
const SUCCESS_REDIRECT_URL = process.env.STRIPE_SUCCESS_URL || `${PRIMARY_FRONTEND_URL}/?checkout=success`;
const FAIL_REDIRECT_URL = process.env.STRIPE_FAIL_URL || `${PRIMARY_FRONTEND_URL}/?checkout=fail`;
const ABORT_REDIRECT_URL = process.env.STRIPE_ABORT_URL || `${PRIMARY_FRONTEND_URL}/?checkout=abort`;
const USER_AGENT = process.env.USER_AGENT || 'Polyplaces/1.0 (contact@polyplaces.local)';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/reverse';
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!FRONTEND_URL || FRONTEND_URL === '*') return cb(null, true);
      const allowed = FRONTEND_ORIGINS;
      if (allowed.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);

const geoCache = new Map();
const GEO_TTL_MS = 60 * 60 * 1000;

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/checkout/return/success', (req, res) => {
  res.redirect(SUCCESS_REDIRECT_URL);
});

app.get('/checkout/return/fail', (req, res) => {
  res.redirect(FAIL_REDIRECT_URL);
});

app.get('/checkout/return/abort', (req, res) => {
  res.redirect(ABORT_REDIRECT_URL);
});

app.get('/api/products', async (req, res) => {
  if (!stripe) {
    res.status(501).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
    return;
  }

  try {
    const response = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ['data.default_price'],
    });

    const products = response.data
      .map((product) => {
        const price = typeof product.default_price === 'object' ? product.default_price : null;
        if (!price || price.currency !== 'gbp') return null;
        const sizeCode = product.metadata?.sizeCode || null;
        const displaySize = product.metadata?.displaySize || null;
        const aspectRatioRaw = product.metadata?.aspectRatio ?? null;
        const sortOrderRaw = product.metadata?.sortOrder ?? null;
        const aspectRatio = Number(aspectRatioRaw);
        const sortOrder = Number(sortOrderRaw);
        if (!sizeCode || !displaySize) return null;
        return {
          id: product.id,
          name: product.name,
          priceId: price.id,
          unitAmount: price.unit_amount,
          currency: price.currency,
          sizeCode,
          displaySize,
          aspectRatio: Number.isFinite(aspectRatio) ? aspectRatio : null,
          sortOrder: Number.isFinite(sortOrder) ? sortOrder : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => productOrder(a, b));

    if (products.length === 0) {
      res.json({ products: [], warning: 'No active products found.' });
      return;
    }

    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unable to load products.' });
  }
});

app.get('/api/reverse-geocode', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Invalid lat/lon.' });
    return;
  }

  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = geoCache.get(key);
  if (cached && Date.now() - cached.ts < GEO_TTL_MS) {
    res.json(cached.data);
    return;
  }

  try {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      res.status(502).json({ error: 'Reverse geocoding failed.' });
      return;
    }

    const data = await response.json();
    const address = data.address || {};
    const label = formatLocationLabel(data);
    const payload = {
      label,
      display_name: data.display_name || null,
      address: {
        name: data.name || null,
        neighbourhood: address.neighbourhood || null,
        suburb: address.suburb || null,
        quarter: address.quarter || null,
        city_district: address.city_district || null,
        city: address.city || null,
        town: address.town || null,
        village: address.village || null,
        hamlet: address.hamlet || null,
        county: address.county || null,
        state: address.state || null,
        country: address.country || null,
      },
    };
    geoCache.set(key, { ts: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Reverse geocoding error.' });
  }
});

app.get('/api/buildings', async (req, res) => {
  const bboxParam = String(req.query.bbox || '');
  const parts = bboxParam.split(',').map((v) => Number(v));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    res.status(400).json({ error: 'Invalid bbox.' });
    return;
  }

  const [south, west, north, east] = parts;
  const query = `[out:json][timeout:25];(
way["building"](${south},${west},${north},${east});
relation["building"]["type"="multipolygon"](${south},${west},${north},${east});
way["building:part"](${south},${west},${north},${east});
relation["building:part"]["type"="multipolygon"](${south},${west},${north},${east});
);out geom;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      res.json({ features: [], warning: 'Overpass request failed.' });
      return;
    }

    const data = await response.json();
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const ways = new Map();
    const relations = [];
    const relationWayIds = new Set();

    elements.forEach((el) => {
      if (el.type === 'way' && Array.isArray(el.geometry)) {
        ways.set(el.id, el);
      } else if (el.type === 'relation') {
        relations.push(el);
        (el.members || []).forEach((m) => {
          if (m.type === 'way') relationWayIds.add(m.ref);
        });
      }
    });

    const features = [];

    ways.forEach((el) => {
      if (relationWayIds.has(el.id)) return;
      const coords = normalizeRing(el.geometry);
      if (!coords) return;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [coords],
        },
        properties: {
          id: el.id,
          source: 'way',
        },
      });
    });

    relations.forEach((rel) => {
      const parsed = relationToFeature(rel, ways);
      if (parsed) features.push(parsed);
    });

    const clipped = clipFeaturesToBBox(features, {
      south,
      west,
      north,
      east,
    });

    res.json({ features: clipped });
  } catch (err) {
    clearTimeout(timer);
    res.json({ features: [], warning: err.message || 'Overpass error.' });
  }
});

app.post('/api/checkout', async (req, res) => {
  if (!stripe) {
    res.status(501).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
    return;
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) {
    res.status(400).json({ error: 'Cart is empty.' });
    return;
  }
  if (items.some((item) => !item?.priceId)) {
    res.status(400).json({ error: 'Cart items must include priceId.' });
    return;
  }

  try {
    const bboxList = items
      .map((item) => item?.bbox)
      .filter(Boolean)
      .map((bbox) => `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);
    const metadata = {};
    if (bboxList.length === 1) metadata.bbox = bboxList[0];
    if (bboxList.length > 1) metadata.bboxes = bboxList.join('|');

    const productIds = items.map((item) => item?.productId).filter(Boolean);
    const sizeCodes = items.map((item) => item?.sizeCode).filter(Boolean);
    if (productIds.length > 0) metadata.productIds = productIds.join('|');
    if (sizeCodes.length > 0) metadata.sizeCodes = sizeCodes.join('|');

    const lineItems = items.map((item) => ({
      price: item.priceId,
      quantity: 1,
    }));

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: `${BACKEND_URL}/checkout/return/success`,
      cancel_url: `${BACKEND_URL}/checkout/return/abort`,
      metadata,
      shipping_address_collection: {
        allowed_countries: ['GB', 'US', 'CA', 'AU', 'NZ', 'IE'],
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unable to create checkout session.' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});

function sizeOrder(sizeCode) {
  if (!sizeCode) return Number.POSITIVE_INFINITY;
  if (String(sizeCode).toLowerCase() === 'a4') return 1000.5;
  const value = Number(sizeCode);
  if (Number.isFinite(value)) return value;
  return Number.POSITIVE_INFINITY;
}

function productOrder(a, b) {
  const aSort = Number.isFinite(a.sortOrder) ? a.sortOrder : null;
  const bSort = Number.isFinite(b.sortOrder) ? b.sortOrder : null;
  if (aSort !== null || bSort !== null) {
    if (aSort === null) return 1;
    if (bSort === null) return -1;
    if (aSort !== bSort) return aSort - bSort;
  }
  return sizeOrder(a.sizeCode) - sizeOrder(b.sizeCode);
}

function formatLocationLabel(data) {
  if (!data) return null;
  const address = data.address || {};
  const name =
    data.name ||
    address.neighbourhood ||
    address.suburb ||
    address.quarter ||
    address.city_district ||
    null;
  const city = address.city || address.town || address.village || address.hamlet || address.county || null;
  const country = address.country || null;
  const parts = [name, city, country].filter(Boolean);
  if (parts.length === 0) return data.display_name || null;
  const seen = new Set();
  const deduped = [];
  parts.forEach((part) => {
    const key = part.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(part);
  });
  return deduped.join(', ');
}

function normalizeRing(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 3) return null;
  const coords = geometry.map((p) => [p.lon, p.lat]);
  if (coords.length === 0) return null;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
  if (coords.length < 4) return null;
  return coords;
}

function coordKey(coord) {
  return `${coord[0].toFixed(7)},${coord[1].toFixed(7)}`;
}

function assembleRings(segments) {
  const unused = segments
    .map((seg) => {
      if (!Array.isArray(seg) || seg.length < 2) return null;
      return seg.map((p) => [p.lon, p.lat]);
    })
    .filter(Boolean);

  const rings = [];
  while (unused.length > 0) {
    const ring = unused.shift();
    if (!ring || ring.length < 2) continue;
    let closed = false;
    let guard = 0;
    while (!closed && guard < 5000) {
      guard += 1;
      const end = ring[ring.length - 1];
      const endKey = coordKey(end);
      const startKey = coordKey(ring[0]);
      if (endKey === startKey) {
        closed = true;
        break;
      }
      let mergedIndex = -1;
      let reversed = false;
      for (let i = 0; i < unused.length; i += 1) {
        const seg = unused[i];
        const segStartKey = coordKey(seg[0]);
        const segEndKey = coordKey(seg[seg.length - 1]);
        if (segStartKey === endKey) {
          mergedIndex = i;
          reversed = false;
          break;
        }
        if (segEndKey === endKey) {
          mergedIndex = i;
          reversed = true;
          break;
        }
      }
      if (mergedIndex === -1) break;
      const seg = unused.splice(mergedIndex, 1)[0];
      const toAdd = reversed ? seg.slice(0).reverse() : seg;
      ring.push(...toAdd.slice(1));
    }
    if (!closed) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (coordKey(first) === coordKey(last)) closed = true;
    }
    if (closed && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function relationToFeature(rel, ways) {
  const members = Array.isArray(rel.members) ? rel.members : [];
  if (members.length === 0) return null;
  const outerSegments = [];
  const innerSegments = [];
  members.forEach((m) => {
    if (m.type !== 'way') return;
    const geometry = Array.isArray(m.geometry) ? m.geometry : ways?.get(m.ref)?.geometry;
    if (!Array.isArray(geometry)) return;
    if (m.role === 'inner') {
      innerSegments.push(geometry);
    } else {
      outerSegments.push(geometry);
    }
  });

  const outers = assembleRings(outerSegments);
  if (outers.length === 0) return null;
  const inners = assembleRings(innerSegments);
  const holesByOuter = outers.map(() => []);
  inners.forEach((inner) => {
    const probe = inner[0];
    let assigned = false;
    for (let i = 0; i < outers.length; i += 1) {
      if (pointInRing(probe, outers[i])) {
        holesByOuter[i].push(inner);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      // drop unassigned inner rings
    }
  });

  const polygons = outers.map((outer, idx) => {
    const holes = holesByOuter[idx] || [];
    return [outer, ...holes];
  });

  if (polygons.length === 1) {
    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: polygons[0],
      },
      properties: {
        id: rel.id,
        source: 'relation',
      },
    };
  }

  return {
    type: 'Feature',
    geometry: {
      type: 'MultiPolygon',
      coordinates: polygons,
    },
    properties: {
      id: rel.id,
      source: 'relation',
    },
  };
}

function clipFeaturesToBBox(features, bbox) {
  return features
    .map((feature) => clipFeature(feature, bbox))
    .filter(Boolean);
}

function clipFeature(feature, bbox) {
  if (!feature || !feature.geometry) return null;
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    const clipped = clipPolygon(geom.coordinates, bbox);
    if (!clipped) return null;
    return {
      ...feature,
      geometry: {
        type: 'Polygon',
        coordinates: clipped,
      },
    };
  }
  if (geom.type === 'MultiPolygon') {
    const clipped = geom.coordinates
      .map((poly) => clipPolygon(poly, bbox))
      .filter(Boolean);
    if (clipped.length === 0) return null;
    return {
      ...feature,
      geometry: {
        type: 'MultiPolygon',
        coordinates: clipped,
      },
    };
  }
  return null;
}

function clipPolygon(rings, bbox) {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const outer = clipRingToBBox(rings[0], bbox);
  if (!outer) return null;
  const holes = [];
  for (let i = 1; i < rings.length; i += 1) {
    const hole = clipRingToBBox(rings[i], bbox);
    if (hole) holes.push(hole);
  }
  return [outer, ...holes];
}

function clipRingToBBox(ring, bbox) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const open = ring.slice();
  const last = open[open.length - 1];
  const first = open[0];
  if (last[0] === first[0] && last[1] === first[1]) {
    open.pop();
  }
  if (open.length < 3) return null;

  let output = open;
  output = clipEdge(output, (p) => p[0] >= bbox.west, (s, e) => intersectVertical(s, e, bbox.west));
  if (output.length === 0) return null;
  output = clipEdge(output, (p) => p[0] <= bbox.east, (s, e) => intersectVertical(s, e, bbox.east));
  if (output.length === 0) return null;
  output = clipEdge(output, (p) => p[1] >= bbox.south, (s, e) => intersectHorizontal(s, e, bbox.south));
  if (output.length === 0) return null;
  output = clipEdge(output, (p) => p[1] <= bbox.north, (s, e) => intersectHorizontal(s, e, bbox.north));
  if (output.length === 0) return null;

  if (output.length < 3) return null;
  const closed = output.slice();
  closed.push(closed[0]);
  if (closed.length < 4) return null;
  return closed;
}

function clipEdge(points, inside, intersect) {
  const output = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const prev = points[(i - 1 + points.length) % points.length];
    const currInside = inside(current);
    const prevInside = inside(prev);
    if (currInside) {
      if (!prevInside) {
        output.push(intersect(prev, current));
      }
      output.push(current);
    } else if (prevInside) {
      output.push(intersect(prev, current));
    }
  }
  return output;
}

function intersectVertical(s, e, x) {
  const [x1, y1] = s;
  const [x2, y2] = e;
  if (x1 === x2) return [x, y1];
  const t = (x - x1) / (x2 - x1);
  return [x, y1 + t * (y2 - y1)];
}

function intersectHorizontal(s, e, y) {
  const [x1, y1] = s;
  const [x2, y2] = e;
  if (y1 === y2) return [x1, y];
  const t = (y - y1) / (y2 - y1);
  return [x1 + t * (x2 - x1), y];
}
