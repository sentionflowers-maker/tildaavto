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
    const event = coerceBody(req.body);

    console.log('Received webhook:', JSON.stringify(event, null, 2));

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
