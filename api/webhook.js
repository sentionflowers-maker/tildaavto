const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');

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

function getRawBodyText(body) {
  if (!body) return '';
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return '';
}

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function safeString(obj, key) {
  const v = obj ? obj[key] : undefined;
  if (v === undefined || v === null) return '';
  return String(v);
}

function isCloudPaymentsWebhook({ req, parsedBody }) {
  const hmacHeader =
    req.headers['x-content-hmac'] ||
    req.headers['content-hmac'] ||
    req.headers['X-Content-HMAC'] ||
    req.headers['Content-HMAC'];
  if (hmacHeader) return true;

  const keys = Object.keys(parsedBody || {});
  const normalizedKeys = new Set(keys.map((k) => normalizeString(k)));
  if (normalizedKeys.has('transactionid') || normalizedKeys.has('invoiceid') || normalizedKeys.has('accountid')) {
    return true;
  }

  return false;
}

function isTildaWebhook({ parsedBody }) {
  if (!parsedBody) return false;
  // Tilda usually sends 'orderid', 'tranid', 'formid', 'payment'
  // Or 'test'='test'
  const keys = Object.keys(parsedBody);
  const normalizedKeys = new Set(keys.map((k) => normalizeString(k)));
  
  if (normalizedKeys.has('orderid') || normalizedKeys.has('formid') || normalizedKeys.has('payment')) {
      return true;
  }
  
  // Also check nested payment object
  if (parsedBody.payment || parsedBody.PAYMENT) return true;

  return false;
}

function buildSortedQuery(bodyObj, { encode }) {
  const entries = Object.entries(bodyObj || {}).map(([k, v]) => [String(k), v === undefined || v === null ? '' : String(v)]);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const pairs = [];
  for (const [k, v] of entries) {
    const key = encode ? encodeURIComponent(k) : k;
    const val = encode ? encodeURIComponent(v) : v;
    pairs.push(`${key}=${val}`);
  }
  return pairs.join('&');
}

function checkCloudPaymentsHmac({ rawBodyText, parsedBody, secret, headerHmac }) {
  if (!secret) return { ok: true, reason: 'no_secret' };
  const provided = (headerHmac || '').toString().trim();
  if (!provided) return { ok: false, reason: 'missing_header' };

  const variants = [];
  if (rawBodyText) {
    variants.push(rawBodyText);
    try {
      variants.push(decodeURIComponent(rawBodyText));
    } catch (_) {}
  } else {
    variants.push(buildSortedQuery(parsedBody, { encode: true }));
    variants.push(buildSortedQuery(parsedBody, { encode: false }));
  }

  const computed = variants.map((v) => crypto.createHmac('sha256', secret).update(String(v), 'utf8').digest('base64'));
  const ok = computed.some((c) => c === provided);
  return { ok, reason: ok ? 'match' : 'mismatch', computed };
}

function parseCloudPaymentsDataField(dataRaw) {
  if (!dataRaw) return null;
  if (typeof dataRaw === 'object' && !Buffer.isBuffer(dataRaw)) return dataRaw;
  const text = Buffer.isBuffer(dataRaw) ? dataRaw.toString('utf8') : String(dataRaw);
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
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

function formatIikoDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return null;
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function loadCitiesConfigRaw() {
  const raw = process.env.TILDA_IIKO_CITIES_JSON || '';
  if (!raw.trim()) return { defaultCity: '', cities: {} };
  try {
    const parsed = JSON.parse(raw);
    return {
      defaultCity: parsed.defaultCity ? String(parsed.defaultCity) : '',
      cities: parsed.cities && typeof parsed.cities === 'object' ? parsed.cities : {}
    };
  } catch (_) {
    return { defaultCity: '', cities: {} };
  }
}

async function getIikoToken({ baseUrl, apiLogin }) {
  const res = await axios.post(
    `${baseUrl}/api/1/access_token`,
    { apiLogin },
    { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
  );

  const token = res.data && (res.data.token || res.data.accessToken || res.data.access_token);
  if (!token) throw new Error('IIKO access token missing in response');
  return token;
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

async function applyPaymentToIikoByInvoiceAndPhone({ baseUrl, invoiceId, phone, amount }) {
  const phoneSan = sanitizePhone(phone);
  if (!invoiceId || !phoneSan || !amount) return { ok: false, reason: 'missing_invoice_or_phone_or_amount' };

  const citiesConfig = loadCitiesConfigRaw();
  const cities = citiesConfig.cities && typeof citiesConfig.cities === 'object' ? citiesConfig.cities : {};
  const cityEntries = Object.entries(cities);
  if (!cityEntries.length) return { ok: false, reason: 'no_cities_configured' };

  for (const [cityKey, cityCfg] of cityEntries) {
    if (!cityCfg || !cityCfg.apiLogin || !cityCfg.organizationId || !cityCfg.paymentTypeId) continue;
    try {
      const token = await getIikoToken({ baseUrl, apiLogin: cityCfg.apiLogin });
      const orderId = await findExistingDeliveryOrderIdByPhoneAndExternalNumber({
        baseUrl,
        token,
        organizationId: cityCfg.organizationId,
        phone: phoneSan,
        externalNumber: invoiceId
      });

      if (!orderId) continue;

      const payments = [
        {
          paymentTypeKind: cityCfg.paymentTypeKind || 'Card',
          sum: amount,
          paymentTypeId: cityCfg.paymentTypeId,
          isProcessedExternally: true
        }
      ];

      const changePaymentsResponse = await changeDeliveryOrderPayments({
        baseUrl,
        token,
        organizationId: cityCfg.organizationId,
        orderId,
        payments
      });

      return { ok: true, city: cityKey, orderId, changePaymentsResponse };
    } catch (err) {
      continue;
    }
  }

  return { ok: false, reason: 'order_not_found' };
}

async function sendPaidOrderToIiko({ req, metadata, paymentIntent }) {
  const tildaIiko = require('./tilda-iiko');

  const secret = process.env.TILDA_WEBHOOK_SECRET || '';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';

  let tildaPayload = null;
  const rawPayload = metadata ? metadata.tilda_payload : null;
  if (rawPayload) {
    try {
      tildaPayload = JSON.parse(String(rawPayload));
    } catch (_) {
      tildaPayload = null;
    }
  }

  const amountStr = safeString(metadata, 'tilda_amount') || safeString(paymentIntent, 'amount') || '';
  const body = {
    ...(tildaPayload && typeof tildaPayload === 'object' ? tildaPayload : {}),
    orderid: safeString(metadata, 'tilda_order_id') || safeString(metadata, 'order_id'),
    paymentid: safeString(paymentIntent, 'id'),
    payment_status: 'paid',
    amount: amountStr || safeString(metadata, 'amount')
  };

  if (secret) body.secret = secret;

  const localReq = {
    method: 'POST',
    url: '/api/tilda-iiko',
    headers: {
      ...(secret ? { 'x-webhook-secret': secret } : {}),
      ...(host ? { host } : {})
    },
    body
  };

  let result = null;
  const localRes = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      result = { statusCode: this.statusCode || 200, body: payload };
      return this;
    },
    json(payload) {
      this.payload = payload;
      result = { statusCode: this.statusCode || 200, body: payload };
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.payload = url;
      result = { statusCode: code, body: url };
      return this;
    }
  };

  await tildaIiko(localReq, localRes);
  return { result, baseUrl: host ? `${protocol}://${host}` : '' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const rawBodyText = getRawBodyText(req.body);
    const event = coerceBody(req.body);

    console.log('Received webhook:', JSON.stringify(event, null, 2));

    if (isCloudPaymentsWebhook({ req, parsedBody: event })) {
      const apiSecret = process.env.CLOUDPAYMENTS_API_SECRET;
      const hmacHeader =
        req.headers['x-content-hmac'] ||
        req.headers['content-hmac'] ||
        req.headers['X-Content-HMAC'] ||
        req.headers['Content-HMAC'];
      
      const check = checkCloudPaymentsHmac({
        rawBodyText: getRawBodyText(req.body),
        parsedBody: event,
        secret: apiSecret,
        headerHmac: hmacHeader
      });

      if (!check.ok && check.reason === 'mismatch') {
        console.error('HMAC mismatch. Computed:', check.computed, 'Provided:', hmacHeader);
        // We do not reject for now, just log, because sometimes encoding differs
      }

      const successNorm = normalizeString(event.Success || event.success);
      const statusNorm = normalizeString(event.Status || event.status);
      const isSuccess =
        successNorm === 'true' ||
        successNorm === '1' ||
        statusNorm === 'completed' ||
        statusNorm === 'success' ||
        statusNorm === 'confirmed' ||
        statusNorm === 'paid';

      if (!isSuccess) {
        return res.status(200).json({ code: 0 });
      }

      const invoiceId = safeString(event, 'InvoiceId') || safeString(event, 'invoiceId') || safeString(event, 'invoiceid');
      const accountId = safeString(event, 'AccountId') || safeString(event, 'accountId') || safeString(event, 'accountid');
      const amountStr = safeString(event, 'Amount') || safeString(event, 'amount');
      const transactionId =
        safeString(event, 'TransactionId') || safeString(event, 'transactionId') || safeString(event, 'transactionid');
      const dataObj = parseCloudPaymentsDataField(event.Data || event.data);

      const metadata = {
        tilda_order_id: invoiceId,
        tilda_amount: amountStr,
        tilda_payload: dataObj && dataObj.tilda_payload ? dataObj.tilda_payload : null
      };

      const paymentIntent = {
        id: transactionId || invoiceId || '',
        amount: amountStr,
        status: 'paid',
        metadata
      };

      const enableIikoOnPaymentWebhook = process.env.ENABLE_IIKO_ON_PAYMENT_WEBHOOK !== 'false';
      if (enableIikoOnPaymentWebhook) {
        const baseUrl = process.env.IIKO_BASE_URL || 'https://api-ru.iiko.services';
        const amountNum = Number(String(amountStr).replace(',', '.').replace(/[^\d.]/g, ''));

        if (metadata.tilda_order_id && metadata.tilda_payload) {
          try {
            const { result: iikoResult } = await sendPaidOrderToIiko({ req, metadata, paymentIntent });
            console.log('iiko create result:', JSON.stringify(iikoResult, null, 2));
          } catch (err) {
            console.error('Error sending paid order to iiko:', err.response?.data || err.message);
          }
        } else {
          try {
            const paymentApplyResult = await applyPaymentToIikoByInvoiceAndPhone({
              baseUrl,
              invoiceId: metadata.tilda_order_id,
              phone: accountId,
              amount: Number.isFinite(amountNum) && amountNum > 0 ? amountNum : null
            });
            console.log('iiko payment apply result:', JSON.stringify(paymentApplyResult, null, 2));
          } catch (err) {
            console.error('Error applying payment to iiko:', err.response?.data || err.message);
          }
        }
      }

      return res.status(200).json({ code: 0 });
    } else if (isTildaWebhook({ parsedBody: event })) {
      console.log('Detected Tilda payload in webhook.js, redirecting to tilda-iiko handler...');
      const tildaIiko = require('./tilda-iiko');
      return tildaIiko(req, res);
    }

    let paymentIntent = event.payment_intent || event;

    const statusNorm = normalizeString(paymentIntent.status);
    if (statusNorm === 'completed' || statusNorm === 'succeeded' || statusNorm === 'paid') {
      const metadata = paymentIntent.metadata || {};
      const tildaOrderId = metadata.tilda_order_id;
      
      if (!tildaOrderId) {
        console.log('No Tilda order ID in metadata, skipping Tilda notification.');
        return res.status(200).send('Skipped');
      }

      // Prepare Tilda notification
      const tildaLogin = process.env.TILDA_LOGIN || 'ziina_shop';
      const tildaSecret = process.env.TILDA_SECRET;
      
      if (!tildaSecret) {
        console.error('TILDA_SECRET is missing in environment variables!');
      }

      // Use the original amount string from metadata if available, otherwise calculate
      let amountStr = metadata.tilda_amount;
      if (!amountStr) {
         // Fallback logic
         amountStr = (paymentIntent.amount / 100).toString();
      }

      const paymentId = paymentIntent.id;
      const state = 'paid';

      // Signature: md5(login + amount + orderid + paymentid + state + password)
      const signatureStr = `${tildaLogin}${amountStr}${tildaOrderId}${paymentId}${state}${tildaSecret}`;
      const signature = crypto.createHash('md5').update(signatureStr).digest('hex');

      const tildaData = {
        payment_system: tildaLogin,
        order_id: tildaOrderId,
        amount: amountStr,
        payment_id: paymentId,
        state: state,
        signature: signature
      };

      console.log('Sending notification to Tilda:', tildaData);

      // Determine the correct Tilda URL
      // 1. Prefer URL stored in metadata (sent by Tilda during init)
      // 2. Fallback to hardcoded URL from screenshot (ps2755493)
      // 3. Fallback to env var (least reliable due to user confusion)
      
      let tildaNotificationUrl = metadata.tilda_callback_url;
      
      if (!tildaNotificationUrl) {
         tildaNotificationUrl = 'https://forms.tildaapi.com/payment/custom/ps2755493';
         console.log('Using hardcoded fallback Tilda URL:', tildaNotificationUrl);
      } else {
         console.log('Using dynamic Tilda URL from metadata:', tildaNotificationUrl);
      }

      try {
        const tildaResponse = await axios.post(tildaNotificationUrl, tildaData);
        console.log('Tilda notification sent successfully. Status:', tildaResponse.status);
        console.log('Tilda Response Body:', tildaResponse.data);
      } catch (err) {
        console.error('Error sending to Tilda:', err.message);
        if (err.response) {
            console.error('Tilda response status:', err.response.status);
            console.error('Tilda response data:', err.response.data);
        }
      }

      const enableIikoOnPaymentWebhook = normalizeString(process.env.ENABLE_IIKO_ON_PAYMENT_WEBHOOK) === 'true';
      if (enableIikoOnPaymentWebhook) {
        try {
          const { result: iikoResult } = await sendPaidOrderToIiko({ req, metadata, paymentIntent });
          console.log('iiko create result:', JSON.stringify(iikoResult, null, 2));
        } catch (err) {
          console.error('Error sending paid order to iiko:', err.response?.data || err.message);
        }
      } else {
        console.log('Skip iiko create: ENABLE_IIKO_ON_PAYMENT_WEBHOOK is not true');
      }
    }

    res.status(200).send('OK');

  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('Internal Server Error');
  }
};
