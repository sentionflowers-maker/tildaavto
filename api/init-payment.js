const axios = require('axios');
const querystring = require('querystring');

function normalizeAmountToFils(amount) {
  const raw = String(amount ?? '').trim();
  if (!raw) return null;
  const normalized = raw.replace(',', '.').replace(/[^\d.]/g, '');
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100);
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

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigins = new Set(['https://sention.ae', 'https://www.sention.ae', 'https://tildaavto.vercel.app']);
  if (origin && allowedOrigins.has(String(origin))) {
    res.setHeader('Access-Control-Allow-Origin', String(origin));
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(200).send('OK');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const body = coerceBody(req.body);

    const amount =
      body.amount ??
      body.AMOUNT ??
      body.sum ??
      body.SUM;

    const orderid =
      body.orderid ??
      body.order_id ??
      body.ORDERID ??
      body.orderId ??
      body.invoiceId ??
      body.InvoiceId;

    const callbackUrl =
      body.callback_url ??
      body.CALLBACK_URL ??
      body.callbackUrl ??
      body.notification_url ??
      body.NOTIFICATION_URL;

    const amountInFils = normalizeAmountToFils(amount);
    if (!amountInFils) {
      return res.status(400).send('Missing or invalid amount');
    }

    if (!orderid) {
      return res.status(400).send('Missing orderid');
    }

    const ziinaToken = process.env.ZIINA_API_TOKEN || process.env.ZIINA_API_KEY;
    if (!ziinaToken) {
      return res.status(500).send('Configuration Error: Missing Ziina Token');
    }

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    const response = await axios.post(
      'https://api-v2.ziina.com/api/payment_intent',
      {
        amount: amountInFils,
        currency_code: 'AED',
        success_url: 'https://sention.ae/ordersuccess',
        cancel_url: `${baseUrl}/orderfailed`,
        metadata: {
          tilda_order_id: String(orderid),
          tilda_amount: String(amount),
          tilda_callback_url: callbackUrl ? String(callbackUrl) : null,
          tilda_payload: body
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ziinaToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const redirectUrl = response.data && response.data.redirect_url ? String(response.data.redirect_url) : null;
    if (redirectUrl) {
      const accept = String(req.headers.accept || '').toLowerCase();
      const xRequestedWith = String(req.headers['x-requested-with'] || '').toLowerCase();
      const secFetchMode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
      const secFetchDest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
      const wantsJson =
        accept.includes('application/json') ||
        xRequestedWith === 'xmlhttprequest' ||
        secFetchMode === 'cors' ||
        secFetchDest === 'empty' ||
        body.response_type === 'json' ||
        body.responseType === 'json';

      const isNavigate = secFetchMode === 'navigate' || secFetchDest === 'document';

      if (wantsJson) {
        return res.status(200).json({ redirect_url: redirectUrl });
      }

      if (isNavigate) {
        res.setHeader('Location', redirectUrl);
        return res.status(303).end();
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(
        `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0;url=${redirectUrl}" />
    <title>Redirecting to payment...</title>
  </head>
  <body>
    <script>
      (function() {
        var url = ${JSON.stringify(redirectUrl)};
        try {
          if (window.top) {
            window.top.location.href = url;
            return;
          }
        } catch (e) {}
        window.location.href = url;
      })();
    </script>
    <noscript>
      <a href="${redirectUrl}">Continue to payment</a>
    </noscript>
  </body>
</html>`
      );
    }

    return res.status(500).send('Failed to initiate payment: No redirect URL');
  } catch (error) {
    const details = error.response?.data?.message || error.response?.data || error.message;
    return res.status(500).send(`Internal Server Error: ${details}`);
  }
};
