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

function envState(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'missing';
  if (typeof value === 'string' && value.trim() === '') return 'empty';
  return 'present';
}

function detectClientMode({ req, body }) {
  const accept = String(req.headers.accept || '').toLowerCase();
  const xRequestedWith = String(req.headers['x-requested-with'] || '').toLowerCase();
  const secFetchMode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
  const secFetchDest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  const secFetchUser = String(req.headers['sec-fetch-user'] || '').toLowerCase();
  const upgradeInsecureRequests = String(req.headers['upgrade-insecure-requests'] || '').toLowerCase();
  const acceptsHtml = accept.includes('text/html') || accept.includes('application/xhtml+xml');
  const wantsJsonHint =
    accept.includes('application/json') ||
    xRequestedWith === 'xmlhttprequest' ||
    secFetchMode === 'cors' ||
    secFetchDest === 'empty' ||
    (body && (body.response_type === 'json' || body.responseType === 'json'));
  const looksLikeNavigateByHeaders =
    acceptsHtml ||
    secFetchMode === 'navigate' ||
    secFetchDest === 'document' ||
    secFetchUser === '?1' ||
    upgradeInsecureRequests === '1';

  const isNavigate = looksLikeNavigateByHeaders && xRequestedWith !== 'xmlhttprequest';

  const wantsJson = !isNavigate && (wantsJsonHint || !acceptsHtml);

  return { wantsJson, isNavigate };
}

function sendInitPaymentError({ req, res, body, title, message, statusCode, details }) {
  const client = detectClientMode({ req, body });
  const payload = {
    ok: false,
    error: title,
    message,
    status: Number(statusCode) || 500,
    details: details || null
  };

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-InitPayment-Error', title);

  if (client.wantsJson) {
    return res.status(200).json(payload);
  }

  const safeDetailsText = details ? JSON.stringify(details, null, 2) : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${String(title)}</title>
    <style>
      body { font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif; padding: 16px; }
      .box { background: #f6f7f9; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-top: 12px; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { margin: 6px 0; }
      pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
    </style>
  </head>
  <body>
    <h1>Ошибка шлюза оплаты</h1>
    <p><strong>${String(title)}</strong></p>
    <p>${String(message || '')}</p>
    <div class="box">
      <p><strong>HTTP статус:</strong> ${Number(statusCode) || 500}</p>
      ${safeDetailsText ? `<p><strong>Детали:</strong></p><pre>${safeDetailsText}</pre>` : ''}
    </div>
  </body>
</html>`
  );
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin;
  const originStr = origin ? String(origin) : '';
  const allowedExactOrigins = new Set(['https://sention.ae', 'https://www.sention.ae', 'https://tildaavto.vercel.app']);
  const isAllowedOrigin =
    (originStr && allowedExactOrigins.has(originStr)) ||
    (originStr && (originStr.endsWith('.tilda.ws') || originStr.endsWith('.tilda.cc')));

  if (originStr && isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', originStr);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  const requestedHeaders = req.headers['access-control-request-headers'];
  if (requestedHeaders) {
    res.setHeader('Access-Control-Allow-Headers', String(requestedHeaders));
  } else {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Requested-With');
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const q = req.query || {};
    const wantsHealth = q.health === '1' || q.debug === '1';
    if (wantsHealth) {
      const ziinaTokenPresent = Boolean(
        (process.env.ZIINA_API_TOKEN && String(process.env.ZIINA_API_TOKEN).trim()) ||
          (process.env.ZIINA_API_KEY && String(process.env.ZIINA_API_KEY).trim())
      );
      return res.status(200).json({
        ok: true,
        ziinaTokenPresent,
        env: {
          ZIINA_API_TOKEN: envState(process.env.ZIINA_API_TOKEN),
          ZIINA_API_KEY: envState(process.env.ZIINA_API_KEY),
          TILDA_SECRET: envState(process.env.TILDA_SECRET),
          TILDA_LOGIN: envState(process.env.TILDA_LOGIN)
        }
      });
    }
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
      return sendInitPaymentError({
        req,
        res,
        body,
        title: 'Invalid amount',
        message: 'Не удалось определить сумму для оплаты (amount).',
        statusCode: 400,
        details: { receivedAmount: amount ?? null, bodyKeys: Object.keys(body || {}) }
      });
    }

    if (!orderid) {
      return sendInitPaymentError({
        req,
        res,
        body,
        title: 'Missing orderid',
        message: 'Не удалось определить номер заказа (orderid).',
        statusCode: 400,
        details: { bodyKeys: Object.keys(body || {}) }
      });
    }

    const ziinaToken = process.env.ZIINA_API_TOKEN || process.env.ZIINA_API_KEY;
    if (!ziinaToken || String(ziinaToken).trim() === '') {
      return sendInitPaymentError({
        req,
        res,
        body,
        title: 'Missing Ziina token',
        message: 'На сервере не найден токен Ziina (ZIINA_API_KEY / ZIINA_API_TOKEN) в окружении Production.',
        statusCode: 500,
        details: {
          env: {
            ZIINA_API_TOKEN: envState(process.env.ZIINA_API_TOKEN),
            ZIINA_API_KEY: envState(process.env.ZIINA_API_KEY)
          }
        }
      });
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
        timeout: 12000,
        headers: {
          Authorization: `Bearer ${ziinaToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const redirectUrl = response.data && response.data.redirect_url ? String(response.data.redirect_url) : null;
    if (redirectUrl) {
      const { wantsJson, isNavigate } = detectClientMode({ req, body });

      if (isNavigate) {
        res.setHeader('Location', redirectUrl);
        return res.status(303).end();
      }

      if (wantsJson) {
        return res.status(200).json({ redirect_url: redirectUrl });
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

    return sendInitPaymentError({
      req,
      res,
      body,
      title: 'No redirect_url from Ziina',
      message: 'Ziina не вернула redirect_url для оплаты.',
      statusCode: 502,
      details: { ziinaResponse: response.data || null }
    });
  } catch (error) {
    const errStatus = error.response?.status || 500;
    const errData = error.response?.data || null;
    const errMessage = error.message || 'Unknown error';
    return sendInitPaymentError({
      req,
      res,
      body: coerceBody(req.body),
      title: 'Init-payment failed',
      message: 'Шлюз оплаты вернул ошибку. Сделайте скриншот и отправьте в поддержку.',
      statusCode: errStatus,
      details: {
        message: errMessage,
        ziinaStatus: error.response?.status || null,
        ziinaData: errData,
        env: {
          ZIINA_API_TOKEN: envState(process.env.ZIINA_API_TOKEN),
          ZIINA_API_KEY: envState(process.env.ZIINA_API_KEY),
          TILDA_SECRET: envState(process.env.TILDA_SECRET),
          TILDA_LOGIN: envState(process.env.TILDA_LOGIN)
        }
      }
    });
  }
};
