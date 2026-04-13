# Custom Size — Backend Spec

## Overview

Custom-size orders let buyers specify an exact print width and height (in mm). The price is derived client-side from the area (m²) of the sculpture at checkout time, but the backend must:

1. Return the per-m² rate via the products endpoint.
2. Handle `custom` line items at checkout by creating a Stripe one-off price rather than looking up a pre-created Price ID.

---

## 1. Products endpoint — return the custom size rate

`GET /api/products`

Add a top-level field `customSizePricePerSqm` to the response. The frontend reads this to compute prices dynamically.

### Current response shape
```json
{
  "products": [ ... ]
}
```

### Updated response shape
```json
{
  "products": [ ... ],
  "customSizePricePerSqm": 1500
}
```

| Field | Type | Description |
|---|---|---|
| `customSizePricePerSqm` | `number` | Price in GBP per square metre of print area. Default: `1500`. |

**Pricing formula (mirrors frontend logic):**

```
area_m2   = (width_mm / 1000) × (height_mm / 1000)
base_price = ROUND(area_m2 × customSizePricePerSqm)   # nearest whole £
surcharge  = width_mm > 250 OR height_mm > 250 ? 5 : 0
price_gbp  = base_price + surcharge
price_pence = price_gbp × 100
```

The backend **must re-derive the price independently** (using the same formula) at checkout time — never trust the price sent by the client.

---

## 2. Checkout endpoint — handle custom line items

`POST /api/checkout`

### Request body (unchanged shape)
```json
{
  "items": [
    {
      "id": "...",
      "productId": "custom",
      "priceId": "custom",
      "name": "Custom",
      "displaySize": "250×300mm",
      "sizeCode": 750,
      "aspectRatio": 1.2,
      "price": 118,
      "location": "...",
      "customLabel": "...",
      "customWidthMm": 250,
      "customHeightMm": 300,
      "bbox": { ... },
      "center": { ... }
    }
  ]
}
```

Custom items are identified by `priceId === "custom"`.

### Checkout logic changes

For each item in `items`:

**Standard item** (`priceId` is a real Stripe Price ID, e.g. `price_xxxxx`):
```js
{ price: item.priceId, quantity: 1 }
```

**Custom item** (`priceId === "custom"`):
```js
{
  price_data: {
    currency: 'gbp',
    unit_amount: recalculatedPricePence,   // server-derived, NOT from client
    product_data: {
      name: `Custom Sculpture — ${item.customWidthMm}×${item.customHeightMm}mm`,
      description: item.customLabel || item.location || undefined,
      metadata: {
        widthMm: String(item.customWidthMm),
        heightMm: String(item.customHeightMm),
        location: item.location || '',
      },
    },
  },
  quantity: 1,
}
```

Where `recalculatedPricePence` is computed server-side using the formula above (§1).

### Validation

Before creating the Stripe session, validate custom items:

| Check | Error |
|---|---|
| `customWidthMm` and `customHeightMm` are integers | 400 Bad Request |
| Both dimensions between 100 and 330 (inclusive) | 400 `Dimensions out of range` |
| Recalculated price ≥ 1 pence | 400 `Price calculation error` |
| Client-sent `price` within ±10% of server-recalculated price | Log warning, use server price (never fail for price mismatch — just trust the server value) |

### Example Node.js / Stripe SDK snippet

```js
function recalcCustomPricePence(widthMm, heightMm, ratePerSqm = 1500) {
  const areaSqm = (widthMm / 1000) * (heightMm / 1000);
  const base = Math.round(areaSqm * ratePerSqm);
  const surcharge = (widthMm > 250 || heightMm > 250) ? 5 : 0;
  return (base + surcharge) * 100; // pence
}

function buildLineItem(item, customSizeRatePerSqm) {
  if (item.priceId !== 'custom') {
    return { price: item.priceId, quantity: 1 };
  }

  const w = Number(item.customWidthMm);
  const h = Number(item.customHeightMm);

  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 100 || w > 330 || h < 100 || h > 330) {
    throw new Error('Dimensions out of range');
  }

  const unitAmount = recalcCustomPricePence(w, h, customSizeRatePerSqm);

  return {
    price_data: {
      currency: 'gbp',
      unit_amount: unitAmount,
      product_data: {
        name: `Custom Sculpture — ${w}×${h}mm`,
        description: item.customLabel || item.location || undefined,
        metadata: {
          widthMm: String(w),
          heightMm: String(h),
          location: item.location || '',
        },
      },
    },
    quantity: 1,
  };
}
```

---

## 3. Environment / configuration

Add `CUSTOM_SIZE_PRICE_PER_SQM_GBP` to the server environment (or a DB config row):

```env
CUSTOM_SIZE_PRICE_PER_SQM_GBP=1500
```

Return this from `GET /api/products` as `customSizePricePerSqm`. Changing the env var and redeploying will update both the price shown in the store and the server-side recalculation simultaneously.

---

## 4. Order fulfilment metadata

To make it easy to identify custom-size orders in the Stripe dashboard, ensure the Stripe session or payment intent metadata includes:

```js
metadata: {
  orderType: 'custom_size',
  customWidthMm: String(w),
  customHeightMm: String(h),
}
```

---

## 5. Webhook / order record

If you record orders in a database, add columns (or JSON fields):

| Column | Type | Nullable | Description |
|---|---|---|---|
| `custom_width_mm` | `smallint` | YES | Print width in mm; null for standard products |
| `custom_height_mm` | `smallint` | YES | Print height in mm; null for standard products |

---

## Summary of changes required

| File / area | Change |
|---|---|
| `GET /api/products` handler | Add `customSizePricePerSqm` field to response |
| `POST /api/checkout` handler | Detect `priceId === 'custom'`, use `price_data` instead of `price` |
| `POST /api/checkout` handler | Server-side price recalculation for custom items |
| Environment config | Add `CUSTOM_SIZE_PRICE_PER_SQM_GBP` |
| DB schema (if applicable) | Add `custom_width_mm` / `custom_height_mm` columns |
