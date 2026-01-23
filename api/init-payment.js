const axios = require('axios');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const { amount, orderid, name, email, phone, payment_id } = req.body;

    // Convert amount to fils (Ziina expects amount in minor units, e.g. 100 AED = 10000 fils)
    // Tilda usually sends amount as float or string.
    const amountInFils = Math.round(parseFloat(amount) * 100);

    const ziinaToken = process.env.ZIINA_API_TOKEN || process.env.ZIINA_API_KEY;
    if (!ziinaToken) {
      console.error('ZIINA_API_TOKEN or ZIINA_API_KEY is missing');
      return res.status(500).send('Configuration Error');
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
        cancel_url: `${baseUrl}/orderfailed`, // We might want to create this page too
        metadata: {
          tilda_order_id: orderid,
          tilda_payment_id: payment_id || 'manual', // Tilda might not send this in all cases
          tilda_amount: amount, // Save original amount string for signature verification
          customer_name: name,
          customer_email: email,
          customer_phone: phone
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
      // Redirect the user to Ziina payment page
      return res.redirect(303, response.data.redirect_url);
    } else {
      console.error('Ziina response missing redirect_url:', response.data);
      return res.status(500).send('Failed to initiate payment');
    }

  } catch (error) {
    console.error('Error creating payment intent:', error.response?.data || error.message);
    return res.status(500).send('Internal Server Error');
  }
};
