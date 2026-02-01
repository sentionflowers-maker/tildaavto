const axios = require('axios');
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

function safeString(obj, key) {
  const v = obj ? obj[key] : undefined;
  if (v === undefined || v === null) return '';
  return String(v);
}

module.exports = async (req, res) => {
  console.log('Init Payment Request Method:', req.method);
  
  // Log body keys to debug what Tilda is actually sending
  if (req.body) {
    console.log('Request Body Keys:', Object.keys(req.body));
    console.log('Request Body Content:', JSON.stringify(req.body));
  } else {
    console.error('Request Body is empty!');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // Tilda might send keys in different casing or names
    const body = coerceBody(req.body);
    const amount = safeString(body, 'amount') || safeString(body, 'AMOUNT');
    const orderid =
      safeString(body, 'orderid') ||
      safeString(body, 'order_id') ||
      safeString(body, 'ORDERID') ||
      safeString(body, 'orderId');
    const name = safeString(body, 'name') || safeString(body, 'NAME');
    const email = safeString(body, 'email') || safeString(body, 'EMAIL');
    const phone = safeString(body, 'phone') || safeString(body, 'PHONE');
    
    // Tilda usually doesn't send payment_id in init request, but just in case
    const payment_id = safeString(body, 'payment_id') || safeString(body, 'PAYMENT_ID');

    // Capture dynamic callback URL if provided by Tilda (via "URL для уведомлений" field mapping)
    const callback_url = safeString(body, 'callback_url') || safeString(body, 'CALLBACK_URL');

    const tildaPayload = {
      projectid:
        safeString(body, 'projectid') ||
        safeString(body, 'projectId') ||
        safeString(body, 'project_id') ||
        safeString(body, 'PROJECTID') ||
        safeString(body, 'PROJECT_ID'),
      referer: safeString(body, 'referer') || safeString(body, 'REFERER'),
      city: safeString(body, 'city') || safeString(body, 'CITY'),
      delivery_type:
        safeString(body, 'delivery_type') || safeString(body, 'DELIVERY_TYPE') || safeString(body, 'deliveryType'),
      building: safeString(body, 'building') || safeString(body, 'BUILDING'),
      office: safeString(body, 'office') || safeString(body, 'OFFICE'),
      delivery_date: safeString(body, 'delivery_date') || safeString(body, 'DELIVERY_DATE'),
      delivery_time: safeString(body, 'delivery_time') || safeString(body, 'DELIVERY_TIME'),
      products: safeString(body, 'products') || safeString(body, 'PRODUCTS'),
      name,
      email,
      phone,
      orderid,
      amount
    };

    if (!amount) {
      console.error('Missing amount in request');
      return res.status(400).send('Missing amount');
    }

    if (!orderid) {
      console.error('Missing orderid in request. Keys received:', Object.keys(body));
      return res.status(400).send('Missing orderid');
    }

    // Convert amount to fils (Ziina expects amount in minor units, e.g. 100 AED = 10000 fils)
    const amountInFils = Math.round(parseFloat(amount) * 100);

    const ziinaToken = process.env.ZIINA_API_TOKEN || process.env.ZIINA_API_KEY;
    if (!ziinaToken) {
      console.error('ZIINA_API_TOKEN or ZIINA_API_KEY is missing');
      return res.status(500).send('Configuration Error: Missing Ziina Token');
    }

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    console.log(`Creating payment intent: Amount=${amount}, OrderID=${orderid}, CallbackURL=${callback_url}`);
    const currencyCode = process.env.ZIINA_CURRENCY_CODE || 'AED';
    const successUrl = process.env.PAYMENT_SUCCESS_URL || `${baseUrl}/ordersuccess`;
    const cancelUrl = process.env.PAYMENT_CANCEL_URL || `${baseUrl}/orderfailed`;

    const response = await axios.post(
      'https://api-v2.ziina.com/api/payment_intent',
      {
        amount: amountInFils,
        currency_code: currencyCode,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          tilda_order_id: orderid,
          tilda_payment_id: payment_id || 'manual',
          tilda_amount: amount, 
          customer_name: name,
          customer_email: email,
          customer_phone: phone,
          tilda_callback_url: callback_url,
          tilda_payload: JSON.stringify(tildaPayload)
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${ziinaToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data && response.data.redirect_url) {
      console.log('Payment intent created, redirecting to:', response.data.redirect_url);
      return res.redirect(303, response.data.redirect_url);
    } else {
      console.error('Ziina response missing redirect_url:', response.data);
      return res.status(500).send('Failed to initiate payment: No redirect URL');
    }

  } catch (error) {
    console.error('Error creating payment intent:', error.response?.data || error.message);
    return res.status(500).send('Internal Server Error: ' + (error.response?.data?.message || error.message));
  }
};
