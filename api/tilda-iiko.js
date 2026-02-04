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

function isLikelyIncompleteAddress(addressLineRaw) {
  const raw = addressLineRaw ? String(addressLineRaw).trim() : '';
  if (!raw) return true;
  const hasLetter = /[a-zа-яё]/i.test(raw);
  if (!hasLetter) return true;
  return false;
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

function looksLikeUuid(value) {
  const s = value ? String(value).trim() : '';
  if (!s) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function pickFirstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function normalizeModifierField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) {
    return value
      .map((v) => normalizeModifierField(v))
      .filter(Boolean)
      .join(', ')
      .trim();
  }
  if (typeof value === 'object') {
    const s = pickFirstString(value, ['name', 'title', 'value', 'option', 'variant', 'text', 'label']);
    return s ? String(s).trim() : '';
  }
  return String(value).trim();
}

function parseProducts(productsRaw) {
  if (!productsRaw) return [];

  if (Array.isArray(productsRaw)) {
    return productsRaw
      .map((p) => {
        if (!p) return null;
        const name = p.name || p.title || p.product || p.product_name || '';
        const modifierText = normalizeModifierField(p.modifier || p.variant || p.option || '');
        const externalProductId = pickFirstString(p, [
          'externalid',
          'externalId',
          'external_id',
          'externalID',
          'external_code',
          'externalCode',
          'external',
          'extid',
          'extId',
          'vendorCode',
          'vendor_code'
        ]);
        const externalVariantId =
          pickFirstString(p, [
            'variant_externalid',
            'variantExternalId',
            'variant_external_id',
            'modification_externalid',
            'modificationExternalId',
            'modification_external_id',
            'offer_externalid',
            'offerExternalId',
            'offer_external_id'
          ]) ||
          pickFirstString(p.variant && typeof p.variant === 'object' ? p.variant : null, [
            'externalid',
            'externalId',
            'external_id',
            'externalID',
            'external_code',
            'externalCode'
          ]) ||
          pickFirstString(p.modifier && typeof p.modifier === 'object' ? p.modifier : null, [
            'externalid',
            'externalId',
            'external_id',
            'externalID',
            'external_code',
            'externalCode'
          ]);

        const tildaProductIdRaw =
          p.tilda_product_id ||
          p.tildaProductId ||
          p.product_id ||
          p.productId ||
          p.id ||
          p.sku ||
          p.article ||
          p.code ||
          '';

        const tildaIdCandidates = [externalVariantId, externalProductId, tildaProductIdRaw, p.sku, p.article, p.code]
          .map((v) => (v === undefined || v === null ? '' : String(v).trim()))
          .filter(Boolean);

        const iikoProductIdRaw = p.iiko_product_id || p.iikoProductId || '';
        const iikoProductId =
          (iikoProductIdRaw ? String(iikoProductIdRaw).trim() : '') ||
          (looksLikeUuid(externalVariantId) ? String(externalVariantId).trim() : '') ||
          (looksLikeUuid(externalProductId) ? String(externalProductId).trim() : '');
        const quantity = Number(p.quantity || p.amount || 1);
        return {
          raw: JSON.stringify(p),
          tildaProductId: tildaIdCandidates[0] || '',
          tildaIdCandidates,
          iikoProductId,
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

function inferCityKey({ urlCity, projectId, pageId, projectIdToCity, pageIdToCity, bodyCity, referer, host }) {
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

  const pageIdStr = pageId === null || pageId === undefined ? '' : String(pageId).trim();
  if (pageIdStr) {
    const mapped =
      pageIdToCity && typeof pageIdToCity === 'object'
        ? pageIdToCity[pageIdStr] || pageIdToCity[String(Number(pageIdStr))]
        : '';
    const fromPage = normalizeString(mapped);
    if (fromPage) return fromPage;
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
    const firstHost = hostStr.split(',')[0].trim();
    const hostNoPort = firstHost.split(':')[0].trim();
    const hostLower = hostNoPort.toLowerCase();
    const ignoreHostCity =
      hostLower.includes('vercel.app') ||
      hostLower.includes('now.sh') ||
      hostLower.includes('ngrok.io') ||
      hostLower.includes('ngrok-free.app') ||
      hostLower === 'localhost' ||
      hostLower === '127.0.0.1';
    if (!ignoreHostCity) {
      const subdomain = hostNoPort.split('.')[0];
      const fromHost = normalizeString(subdomain);
      if (fromHost && fromHost !== 'www') return fromHost;
    }
  }

  return '';
}

const citiesConfig = require('./cities-config');

function loadCitiesConfig() {
  // Use local config file instead of environment variable
  return citiesConfig;
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

  // Try to load from local file first
  try {
    const localMapping = require('./mapping');
    if (localMapping && Array.isArray(localMapping) && localMapping.length > 0) {
      cachedMapping = localMapping;
      cachedMappingLoadedAtMs = now;
      return cachedMapping;
    }
  } catch (e) {
    // ignore
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

function findIikoProduct({ mapping, cityKey, tildaProductIds, name, modifierText, weightKey }) {
  const cityNorm = normalizeString(cityKey);
  const ids = (Array.isArray(tildaProductIds) ? tildaProductIds : [tildaProductIds])
    .map((v) => normalizeString(v))
    .filter(Boolean);
  const nameNorm = normalizeString(name);
  const modNorm = normalizeString(modifierText);
  const weightNorm = normalizeString(weightKey);

  const byCity = mapping.filter((m) => normalizeString(m.city) === cityNorm);
  if (!byCity.length) return null;

  if (ids.length) {
    for (const idNorm of ids) {
      const byId = byCity.find((m) => normalizeString(m.tildaProductId) === idNorm);
      if (byId && byId.iikoProductId) return byId;
    }
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

function formatIikoDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return null;
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

async function findExistingDeliveryOrderIdByPhoneAndExternalNumber({
  baseUrl,
  token,
  organizationId,
  phone,
  externalNumber
}) {
  const phoneStr = phone ? String(phone).trim() : '';
  const extStr = externalNumber ? String(externalNumber).trim() : '';
  if (!phoneStr || !extStr) return null;

  const now = Date.now();
  const from = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const to = new Date(now + 24 * 60 * 60 * 1000);

  const deliveryDateFrom = formatIikoDateTime(from);
  const deliveryDateTo = formatIikoDateTime(to);

  const res = await axios.post(
    `${baseUrl}/api/1/deliveries/by_delivery_date_and_phone`,
    {
      phone: phoneStr,
      deliveryDateFrom,
      deliveryDateTo,
      organizationIds: [organizationId],
      rowsCount: 50
    },
    {
      timeout: 20000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    }
  );

  const groups = (res.data && res.data.ordersByOrganizations) || [];
  for (const g of groups) {
    const orders = (g && g.orders) || [];
    for (const o of orders) {
      const oExt = o && o.externalNumber ? String(o.externalNumber).trim() : '';
      if (oExt === extStr && o.id) return String(o.id);
    }
  }

  return null;
}

async function changeDeliveryOrderPayments({ baseUrl, token, organizationId, orderId, payments }) {
  const res = await axios.post(
    `${baseUrl}/api/1/deliveries/change_payments`,
    { organizationId, orderId, payments },
    {
      timeout: 20000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    }
  );
  return res.data;
}

function buildOrderComment({
  cityKey,
  tildaOrderId,
  paymentId,
  deliveryType,
  deliveryOverrideNote,
  extraFields,
  productsParsed
}) {
  const lines = [];

  if (cityKey) lines.push(`Город: ${cityKey}`);
  if (tildaOrderId) lines.push(`Tilda order: ${tildaOrderId}`);
  if (paymentId) lines.push(`Payment: ${paymentId}`);
  if (deliveryType) lines.push(`Доставка: ${deliveryType}`);
  if (deliveryOverrideNote) lines.push(deliveryOverrideNote);

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
    const urlObj = new URL(req.url, 'http://localhost');

    const bodyKeys = Object.keys(body || {});
    const onlyAuthFields =
      bodyKeys.length === 0 || bodyKeys.every((k) => normalizeString(k) === 'secret' || normalizeString(k) === 'token');
    if (onlyAuthFields) {
      return res.status(200).json({ ok: true, requestId });
    }

    const secret = process.env.TILDA_WEBHOOK_SECRET;
    if (secret) {
      const expected = String(secret)
        .split(',')
        .map((s) => String(s).trim())
        .filter(Boolean);
      const headerSecret =
        req.headers['x-webhook-secret'] ||
        req.headers['x-tilda-secret'] ||
        req.headers['x-tilda-webhook-secret'] ||
        req.headers['x-api-key'] ||
        req.headers['x-apikey'];
      const querySecret =
        urlObj.searchParams.get('secret') ||
        urlObj.searchParams.get('token') ||
        urlObj.searchParams.get('apikey') ||
        urlObj.searchParams.get('api_key');
      const candidates = [headerSecret, body.secret, body.token, body.api_key, body.apikey, querySecret]
        .map((v) => (v === undefined || v === null ? '' : String(v).trim()))
        .filter(Boolean);

      const isAuthorized =
        expected.length > 0 && candidates.length > 0 && candidates.some((c) => expected.some((e) => e === c));

      if (!isAuthorized) {
        const candidateHashes = candidates
          .slice(0, 6)
          .map((c) => crypto.createHash('sha256').update(c).digest('hex').slice(0, 10));
        const expectedHashes = expected
          .slice(0, 6)
          .map((e) => crypto.createHash('sha256').update(e).digest('hex').slice(0, 10));

        return res.status(401).json({
          ok: false,
          requestId,
          error: 'Unauthorized',
          authDebug: {
            expectedCount: expected.length,
            candidateCount: candidates.length,
            expectedHashes,
            candidateHashes,
            candidateSources: {
              header: Boolean(headerSecret),
              bodySecret: Boolean(body.secret),
              bodyToken: Boolean(body.token),
              bodyApiKey: Boolean(body.api_key || body.apikey),
              query: Boolean(querySecret)
            }
          }
        });
      }
    }

    const baseUrl = process.env.IIKO_BASE_URL || 'https://api-ru.iiko.services';
    const citiesConfig = loadCitiesConfig();

    const urlCity = urlObj.searchParams.get('city');
    const urlProjectId = urlObj.searchParams.get('projectid') || urlObj.searchParams.get('projectId');
    const bodyProjectId =
      safeString(body, 'projectid') ||
      safeString(body, 'projectId') ||
      safeString(body, 'project_id') ||
      safeString(body, 'PROJECTID') ||
      safeString(body, 'PROJECT_ID');
    const projectId = bodyProjectId || urlProjectId || '';

    const pageId = safeString(body, 'pageid') || safeString(body, 'page_id') || safeString(body, 'PAGEID') || '';

    const referer = safeString(body, 'referer') || req.headers.referer || '';
    const cityKey = inferCityKey({
      urlCity,
      projectId,
      pageId,
      projectIdToCity: citiesConfig.projectIdToCity,
      pageIdToCity: citiesConfig.pageIdToCity,
      bodyCity: body.city,
      referer,
      host: req.headers['x-forwarded-host'] || req.headers.host
    });

    const defaultCityNorm = normalizeString(citiesConfig.defaultCity);
    let effectiveCity = cityKey || defaultCityNorm || 'default';
    let cityCfg = (citiesConfig.cities && citiesConfig.cities[effectiveCity]) || null;

    if (!cityCfg && defaultCityNorm && effectiveCity !== defaultCityNorm) {
      effectiveCity = defaultCityNorm;
      cityCfg = (citiesConfig.cities && citiesConfig.cities[effectiveCity]) || null;
    }

    if (!cityCfg && citiesConfig.cities && typeof citiesConfig.cities === 'object') {
      const keys = Object.keys(citiesConfig.cities);
      if (keys.length === 1) {
        effectiveCity = keys[0];
        cityCfg = citiesConfig.cities[effectiveCity] || null;
      }
    }

    if (!cityCfg) {
      return res.status(400).json({ ok: false, requestId, error: 'Unknown city', city: effectiveCity });
    }

    let paymentObj = body.payment || body.PAYMENT;
    if (typeof paymentObj === 'string') {
      try {
        paymentObj = JSON.parse(paymentObj);
      } catch (e) {
        // ignore
      }
    }

    const tildaOrderId =
      body.orderid ||
      body.order_id ||
      body.ORDERID ||
      body.ORDER_ID ||
      body.orderId ||
      body.payment_order_id ||
      (paymentObj && (paymentObj.orderid || paymentObj.order_id)) ||
      '';
      
    const paymentId = body.paymentid || body.payment_id || body.PAYMENT_ID || '';

    let rawProducts = body.products || body.PRODUCTS;
    if (!rawProducts && paymentObj && paymentObj.products) {
      rawProducts = paymentObj.products;
    }

    const productsParsed = parseProducts(rawProducts);
    const total = extractTotal(body) || (paymentObj && paymentObj.amount);

    if (productsParsed.length === 0) {
      console.log('No products parsed from body:', JSON.stringify(body));
      return res.status(200).json({ ok: true, requestId, skipped: true });
    }
    
    console.log('Incoming products:', JSON.stringify(productsParsed));

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
    const courierRequested = deliveryTypeNorm.includes('курьер') || deliveryTypeNorm.includes('delivery');
    const addressIncomplete = courierRequested && isLikelyIncompleteAddress(extraFields.building);
    const orderServiceType = courierRequested && !addressIncomplete ? 'DeliveryByCourier' : 'Pickup';
    const deliveryOverrideNote = addressIncomplete
      ? 'ВНИМАНИЕ: запрошена доставка курьером, но адрес неполный. Создано как самовывоз, нужно уточнить адрес.'
      : '';

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
        tildaProductIds: product.tildaIdCandidates || [product.tildaProductId],
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
      deliveryOverrideNote,
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
    const payments =
      cityCfg.paymentTypeId && total && isPaid
        ? [
            {
              paymentTypeKind: cityCfg.paymentTypeKind || 'Card',
              sum: total,
              paymentTypeId: cityCfg.paymentTypeId,
              isProcessedExternally: true
            }
          ]
        : null;

    if (payments) {
      const existingId = await findExistingDeliveryOrderIdByPhoneAndExternalNumber({
        baseUrl,
        token,
        organizationId: cityCfg.organizationId,
        phone: sanitizePhone(extraFields.phone),
        externalNumber
      });

      if (existingId) {
        const changePaymentsResponse = await changeDeliveryOrderPayments({
          baseUrl,
          token,
          organizationId: cityCfg.organizationId,
          orderId: existingId,
          payments
        });

        return res.status(200).json({
          ok: true,
          requestId,
          city: effectiveCity,
          mappedItems: iikoItems.length,
          unmappedItems: unmapped.map((u) => ({ name: u.name, modifierText: u.modifierText, raw: u.raw })),
          iiko: { updatedPayments: true, orderId: existingId, changePaymentsResponse }
        });
      }

      orderPayload.order.payments = payments;
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
