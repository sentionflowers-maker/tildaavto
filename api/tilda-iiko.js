const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
const { URL } = require('url');

let cachedMapping = null;
let cachedMappingLoadedAtMs = 0;
const cachedTokenByApiLogin = new Map();

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function coerceBody(body) {
  if (!body) return {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return querystring.parse(trimmed);
  }
}

function parseWeightKey(text) {
  const s = normalizeString(text);
  const m = s.match(/(\d{2,4})\s*(г|гр|g)\b/);
  if (m) return m[1];
  return '';
}

function parseProducts(productsRaw) {
  if (!productsRaw) return [];

  if (Array.isArray(productsRaw)) {
    return productsRaw
      .map((p) => {
        if (!p) return null;
        const name = p.name || p.title || p.product || p.product_name || '';
        const modifierText = p.modifier || p.variant || p.option || '';
        const tildaProductId =
          p.tilda_product_id ||
          p.tildaProductId ||
          p.product_id ||
          p.productId ||
          p.id ||
          p.sku ||
          p.article ||
          p.code ||
          '';
        const iikoProductId = p.iiko_product_id || p.iikoProductId || '';
        const quantity = Number(p.quantity || p.amount || 1);
        return {
          raw: JSON.stringify(p),
          tildaProductId: tildaProductId ? String(tildaProductId).trim() : '',
          iikoProductId: iikoProductId ? String(iikoProductId).trim() : '',
          name: String(name).trim(),
          modifierText: String(modifierText).trim(),
          weightKey: parseWeightKey(modifierText),
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1
        };
      })
      .filter(Boolean);
  }

  const productsStr = String(productsRaw).trim();
  if (!productsStr) return [];

  if (productsStr.startsWith('[') || productsStr.startsWith('{')) {
    try {
      const parsed = JSON.parse(productsStr);
      return parseProducts(parsed);
    } catch (_) {}
  }

  const parts = productsStr
    .split(/;\s*/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const items = [];

  for (const part of parts) {
    const match = part.match(/^(.*?)\s*-\s*(\d+)\s*x\s*([\d.,]+)\s*=\s*([\d.,]+)\s*(.*)?$/i);
    const rawTitle = match ? match[1].trim() : part;
    const qty = match ? Number(match[2]) : 1;

    let name = rawTitle;
    let modifierText = '';

    const parenMatch = rawTitle.match(/^(.*)\(([^()]*)\)\s*$/);
    if (parenMatch) {
      name = parenMatch[1].trim();
      modifierText = parenMatch[2].trim();
    }

    items.push({
      raw: part,
      name,
      modifierText,
      weightKey: parseWeightKey(modifierText),
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1
    });
  }

  return items;
}

function extractTotal(body) {
  const candidates = [
    body.price,
    body.total,
    body.amount,
    body.sum,
    body.subtotal,
    body.ORDER_SUM,
    body.AMOUNT
  ].filter((v) => v !== undefined && v !== null);

  for (const c of candidates) {
    const n = Number(String(c).replace(',', '.').replace(/[^\d.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function inferCityKey({ urlCity, projectId, projectIdToCity, bodyCity, referer, host }) {
  const fromUrl = normalizeString(urlCity);
  if (fromUrl) return fromUrl;

  const projectIdStr = projectId === null || projectId === undefined ? '' : String(projectId).trim();
  if (projectIdStr) {
    const mapped =
      projectIdToCity && typeof projectIdToCity === 'object'
        ? projectIdToCity[projectIdStr] || projectIdToCity[String(Number(projectIdStr))]
        : '';
    const fromProject = normalizeString(mapped);
    if (fromProject) return fromProject;
    if (projectIdStr === '820503') return 'msk';
  }

  const fromBody = normalizeString(bodyCity);
  if (fromBody) return fromBody;

  const refStr = referer ? String(referer) : '';
  if (refStr) {
    try {
      const refUrl = new URL(refStr);
      const path = refUrl.pathname || '';
      const segment = path.split('/').filter(Boolean)[0];
      const fromPath = normalizeString(segment);
      if (fromPath) return fromPath;
    } catch (_) {}
  }

  const hostStr = host ? String(host) : '';
  if (hostStr) {
    const subdomain = hostStr.split('.')[0];
    const fromHost = normalizeString(subdomain);
    if (fromHost && fromHost !== 'www') return fromHost;
  }

  return '';
}

function loadCitiesConfig() {
  const raw = process.env.TILDA_IIKO_CITIES_JSON || '';
  if (!raw.trim()) {
    return { defaultCity: '', cities: {}, projectIdToCity: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      defaultCity: parsed.defaultCity ? String(parsed.defaultCity) : '',
      cities: parsed.cities && typeof parsed.cities === 'object' ? parsed.cities : {},
      projectIdToCity:
        (parsed.projectIdToCity && typeof parsed.projectIdToCity === 'object' ? parsed.projectIdToCity : null) ||
        (parsed.projectidToCity && typeof parsed.projectidToCity === 'object' ? parsed.projectidToCity : null) ||
        (parsed.projectIdCity && typeof parsed.projectIdCity === 'object' ? parsed.projectIdCity : null) ||
        {}
    };
  } catch (_) {
    return { defaultCity: '', cities: {}, projectIdToCity: {} };
  }
}

function inferIsPaid({ body, paymentId }) {
  if (paymentId) return true;

  const candidates = [
    safeString(body, 'payment_status'),
    safeString(body, 'paymentStatus'),
    safeString(body, 'status'),
    safeString(body, 'paid'),
    safeString(body, 'is_paid'),
    safeString(body, 'success'),
    safeString(body, 'payment_success')
  ];

  for (const c of candidates) {
    const s = normalizeString(c);
    if (!s) continue;
    if (s === '1' || s === 'true' || s === 'yes') return true;
    if (s.includes('paid') || s.includes('success') || s.includes('оплач')) return true;
  }

  return false;
}

async function loadMapping() {
  const ttlMs = Number(process.env.TILDA_IIKO_MAPPING_CACHE_TTL_MS || 5 * 60 * 1000);
  const now = Date.now();
  if (cachedMapping && now - cachedMappingLoadedAtMs < ttlMs) return cachedMapping;

  const mode = (process.env.TILDA_IIKO_MAPPING_MODE || 'env').toLowerCase();

  if (mode === 'csv_url') {
    const csvUrl = process.env.TILDA_IIKO_MAPPING_CSV_URL;
    if (!csvUrl) {
      cachedMapping = [];
      cachedMappingLoadedAtMs = now;
      return cachedMapping;
    }

    const res = await axios.get(csvUrl, { timeout: 15000, responseType: 'text' });
    const lines = String(res.data)
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .filter(Boolean);

    const header = lines[0].split(',').map((h) => normalizeString(h));
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.replace(/^"|"$/g, ''));
      const row = {};
      for (let j = 0; j < header.length; j++) {
        row[header[j]] = cols[j] || '';
      }
      rows.push({
        city: row.city || row['город'] || row['citykey'] || '',
        tildaProductId: row.tilda_product_id || row['tilda product id'] || row['tilda_productid'] || '',
        tildaName: row.tilda_product_name || row['tilda name'] || row['product_name'] || '',
        tildaModifier: row.tilda_modifier || row['tilda_modifier_value'] || row['modifier'] || '',
        iikoProductId: row.iiko_product_id || row['iiko product id'] || row['iiko_productid'] || '',
        iikoModifierId: row.iiko_modifier_id || row['iiko modifier id'] || row['iiko_modifierid'] || ''
      });
    }

    cachedMapping = rows;
    cachedMappingLoadedAtMs = now;
    return cachedMapping;
  }

  const raw = process.env.TILDA_IIKO_MAPPING_JSON || '[]';
  try {
    const parsed = JSON.parse(raw);
    cachedMapping = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    cachedMapping = [];
  }

  cachedMappingLoadedAtMs = now;
  return cachedMapping;
}

function findIikoProduct({ mapping, cityKey, tildaProductId, name, modifierText, weightKey }) {
  const cityNorm = normalizeString(cityKey);
  const idNorm = normalizeString(tildaProductId);
  const nameNorm = normalizeString(name);
  const modNorm = normalizeString(modifierText);
  const weightNorm = normalizeString(weightKey);

  const byCity = mapping.filter((m) => normalizeString(m.city) === cityNorm);
  if (!byCity.length) return null;

  if (idNorm) {
    const byId = byCity.find((m) => normalizeString(m.tildaProductId) === idNorm);
    if (byId && byId.iikoProductId) return byId;
  }

  const byName = byCity.find((m) => {
    if (normalizeString(m.tildaName) !== nameNorm) return false;

    const mModRaw = m.tildaModifier || '';
    const mMod = normalizeString(mModRaw);
    if (!mMod && !modNorm) return true;

    const mWeight = parseWeightKey(mModRaw);
    if (mWeight && weightNorm) return normalizeString(mWeight) === weightNorm;
    return mMod === modNorm;
  });

  if (byName && byName.iikoProductId) return byName;
  return null;
}

function sanitizePhone(phoneRaw) {
  const str = phoneRaw ? String(phoneRaw) : '';
  const digits = str.replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

async function getIikoToken({ baseUrl, apiLogin }) {
  const cacheKey = `${baseUrl}::${apiLogin}`;
  const cached = cachedTokenByApiLogin.get(cacheKey);
  const now = Date.now();
  if (cached && now < cached.expiresAtMs) return cached.token;

  const res = await axios.post(
    `${baseUrl}/api/1/access_token`,
    { apiLogin },
    { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
  );

  const token = res.data && (res.data.token || res.data.accessToken || res.data.access_token);
  if (!token) throw new Error('IIKO access token missing in response');

  cachedTokenByApiLogin.set(cacheKey, { token, expiresAtMs: now + 50 * 60 * 1000 });
  return token;
}

async function createDeliveryInIiko({ baseUrl, token, payload }) {
  const res = await axios.post(`${baseUrl}/api/1/deliveries/create`, payload, {
    timeout: 20000,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  });
  return res.data;
}

function buildOrderComment({ cityKey, tildaOrderId, paymentId, deliveryType, extraFields, productsParsed }) {
  const lines = [];

  if (cityKey) lines.push(`Город: ${cityKey}`);
  if (tildaOrderId) lines.push(`Tilda order: ${tildaOrderId}`);
  if (paymentId) lines.push(`Payment: ${paymentId}`);
  if (deliveryType) lines.push(`Доставка: ${deliveryType}`);

  const timeFields = [];
  if (extraFields.delivery_date) timeFields.push(`Дата: ${extraFields.delivery_date}`);
  if (extraFields.delivery_time) timeFields.push(`Время: ${extraFields.delivery_time}`);
  if (timeFields.length) lines.push(timeFields.join(', '));

  const addressFields = [];
  if (extraFields.city) addressFields.push(`Город (поле): ${extraFields.city}`);
  if (extraFields.building) addressFields.push(`Адрес: ${extraFields.building}`);
  if (extraFields.office) addressFields.push(`Этаж/кв: ${extraFields.office}`);
  if (addressFields.length) lines.push(addressFields.join(', '));

  const messenger = extraFields.messenger ? String(extraFields.messenger) : '';
  if (messenger) lines.push(`Мессенджер: ${messenger}`);

  const normalizedProducts = productsParsed
    .map((p) => {
      const mod = p.modifierText ? ` (${p.modifierText})` : '';
      const qty = p.quantity ? ` x${p.quantity}` : '';
      return `${p.name}${mod}${qty}`;
    })
    .filter(Boolean);

  if (normalizedProducts.length) {
    lines.push('Состав:');
    for (const p of normalizedProducts) lines.push(`- ${p}`);
  }

  return lines.join('\n');
}

function safeString(obj, key) {
  const v = obj ? obj[key] : undefined;
  if (v === undefined || v === null) return '';
  return String(v);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const requestId = crypto.randomBytes(8).toString('hex');

  try {
    const body = coerceBody(req.body);

    const secret = process.env.TILDA_WEBHOOK_SECRET;
    if (secret) {
      const headerSecret =
        req.headers['x-webhook-secret'] ||
        req.headers['x-tilda-secret'] ||
        req.headers['x-tilda-webhook-secret'];
      const provided = (headerSecret || body.secret || body.token || '').toString();
      if (provided !== secret) return res.status(401).json({ ok: false, requestId, error: 'Unauthorized' });
    }

    const baseUrl = process.env.IIKO_BASE_URL || 'https://api-ru.iiko.services';
    const citiesConfig = loadCitiesConfig();

    const urlObj = new URL(req.url, 'http://localhost');
    const urlCity = urlObj.searchParams.get('city');
    const urlProjectId = urlObj.searchParams.get('projectid') || urlObj.searchParams.get('projectId');
    const bodyProjectId =
      safeString(body, 'projectid') ||
      safeString(body, 'projectId') ||
      safeString(body, 'project_id') ||
      safeString(body, 'PROJECTID') ||
      safeString(body, 'PROJECT_ID');
    const projectId = bodyProjectId || urlProjectId || '';
    const referer = safeString(body, 'referer') || req.headers.referer || '';
    const cityKey = inferCityKey({
      urlCity,
      projectId,
      projectIdToCity: citiesConfig.projectIdToCity,
      bodyCity: body.city,
      referer,
      host: req.headers['x-forwarded-host'] || req.headers.host
    });

    const effectiveCity = cityKey || normalizeString(citiesConfig.defaultCity) || 'default';
    const cityCfg = (citiesConfig.cities && citiesConfig.cities[effectiveCity]) || null;
    if (!cityCfg) {
      return res.status(400).json({ ok: false, requestId, error: 'Unknown city', city: effectiveCity });
    }

    const tildaOrderId =
      body.orderid || body.order_id || body.ORDERID || body.ORDER_ID || body.orderId || body.payment_order_id || '';
    const paymentId = body.paymentid || body.payment_id || body.PAYMENT_ID || '';

    const productsParsed = parseProducts(body.products || body.PRODUCTS || '');
    const total = extractTotal(body);

    const extraFields = {
      name: body.name || body.NAME,
      email: body.email || body.EMAIL,
      phone: body.phone || body.PHONE,
      messenger: body.messenger,
      city: body.city,
      delivery_type: body.delivery_type,
      building: body.building,
      office: body.office,
      delivery_date: body.delivery_date,
      delivery_time: body.delivery_time
    };

    const deliveryTypeNorm = normalizeString(extraFields.delivery_type);
    const orderServiceType = deliveryTypeNorm.includes('курьер') ? 'DeliveryByCourier' : 'Pickup';

    const mapping = await loadMapping();
    const unmapped = [];

    const iikoItems = [];
    for (const product of productsParsed) {
      if (product.iikoProductId) {
        iikoItems.push({ type: 'Product', productId: product.iikoProductId, amount: product.quantity });
        continue;
      }
      const found = findIikoProduct({
        mapping,
        cityKey: effectiveCity,
        tildaProductId: product.tildaProductId,
        name: product.name,
        modifierText: product.modifierText,
        weightKey: product.weightKey
      });

      if (found && found.iikoProductId) {
        iikoItems.push({ type: 'Product', productId: found.iikoProductId, amount: product.quantity });
      } else {
        unmapped.push(product);
      }
    }

    if (!iikoItems.length) {
      const fallbackProductId = cityCfg.fallbackProductId || '';
      if (!fallbackProductId) {
        return res.status(400).json({
          ok: false,
          requestId,
          error: 'No mapped items and no fallbackProductId configured',
          city: effectiveCity
        });
      }
      iikoItems.push({ type: 'Product', productId: fallbackProductId, amount: 1 });
    }

    const comment = buildOrderComment({
      cityKey: effectiveCity,
      tildaOrderId,
      paymentId,
      deliveryType: extraFields.delivery_type,
      extraFields,
      productsParsed
    });

    const externalNumber = tildaOrderId ? String(tildaOrderId).slice(0, 50) : String(Date.now());

    const token = await getIikoToken({ baseUrl, apiLogin: cityCfg.apiLogin });

    const orderPayload = {
      organizationId: cityCfg.organizationId,
      terminalGroupId: cityCfg.terminalGroupId,
      order: {
        externalNumber,
        orderServiceType,
        phone: sanitizePhone(extraFields.phone),
        customer: { name: extraFields.name ? String(extraFields.name) : 'Клиент' },
        comment,
        items: iikoItems
      }
    };

    const isPaid = inferIsPaid({ body, paymentId });
    if (cityCfg.paymentTypeId && total && isPaid) {
      orderPayload.order.payments = [
        {
          paymentTypeKind: cityCfg.paymentTypeKind || 'Card',
          sum: total,
          paymentTypeId: cityCfg.paymentTypeId,
          isProcessedExternally: true
        }
      ];
    }

    const iikoResponse = await createDeliveryInIiko({ baseUrl, token, payload: orderPayload });

    return res.status(200).json({
      ok: true,
      requestId,
      city: effectiveCity,
      mappedItems: iikoItems.length,
      unmappedItems: unmapped.map((u) => ({ name: u.name, modifierText: u.modifierText, raw: u.raw })),
      iiko: iikoResponse
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data;
    return res.status(status).json({ ok: false, requestId, error: error.message, iikoError: data || null });
  }
};
