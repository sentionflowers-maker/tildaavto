const axios = require('axios');

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
    const body = req.body || {};
    const amount = body.amount || body.AMOUNT;
    const orderid = body.orderid || body.order_id || body.ORDERID || body.orderId;
    const name = body.name || body.NAME;
    const email = body.email || body.EMAIL;
    const phone = body.phone || body.PHONE;
    
    // Tilda usually doesn't send payment_id in init request, but just in case
    const payment_id = body.payment_id || body.PAYMENT_ID;

    // Capture dynamic callback URL if provided by Tilda (via "URL для уведомлений" field mapping)
    const callback_url = body.callback_url || body.CALLBACK_URL;

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

    const response = await axios.post(
      'https://api-v2.ziina.com/api/payment_intent',
      {
        amount: amountInFils,
        currency_code: 'AED',
        success_url: 'https://sention.ae/ordersuccess',
        cancel_url: `${baseUrl}/orderfailed`, 
        metadata: {
          tilda_order_id: orderid,
          tilda_payment_id: payment_id || 'manual',
          tilda_amount: amount, 
          customer_name: name,
          customer_email: email,
          customer_phone: phone,
          tilda_callback_url: callback_url // Store for webhook usage
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
