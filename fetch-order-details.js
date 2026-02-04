const axios = require('axios');
const citiesConfig = require('./api/cities-config');

async function fetchOrderDetails() {
  const city = citiesConfig.cities.msk;
  if (!city || !city.apiLogin) {
    console.error('No API login for MSK');
    return;
  }

  const orderId = '22f6ceb4-b991-4d2f-a114-4bb8815e6493'; // Pick one from previous list

  try {
    console.log('Getting token...');
    const tokenRes = await axios.post('https://api-ru.iiko.services/api/1/access_token', {
      apiLogin: city.apiLogin
    });
    const token = tokenRes.data.token;
    console.log('Token received.');

    console.log(`Fetching order ${orderId}...`);

    // Use retrieve endpoint if available, or just re-fetch with more detail if possible.
    // Actually, there isn't a simple "get by ID" in the new API transport usually, 
    // but let's try 'deliveries/by_id' if it exists or use the same list method but inspect deeper.
    // Oh, I see I can use 'deliveries/by_id' (deprecated?) or 'deliveries/retrieve' ?
    // Let's check documentation or try standard retrieve.
    // Actually, I'll just use the previous method but log the FULL object to see if I missed fields.
    // Wait, the previous output showed "Ext: null". 
    
    // Let's try to search by ID specifically.
    
    /* 
       Actually, let's just use 'retrieve' which is common.
    */
    
    // If that fails, I will assume the previous list was complete and they really are empty.
    // But 'by_delivery_date_and_status' should return full objects.
    
    // Maybe these are NOT delivery orders? Maybe they are table orders?
    // But I queried 'deliveries'.
    
    // Let's try to print the FULL JSON of the first order from the list again.
    
    const now = Date.now();
    const from = new Date(now - 3 * 60 * 60 * 1000);
    const to = new Date(now + 1 * 60 * 60 * 1000);
    const deliveryDateFrom = from.toISOString().replace('T', ' ').replace('Z', '');
    const deliveryDateTo = to.toISOString().replace('T', ' ').replace('Z', '');

    const res = await axios.post(
      'https://api-ru.iiko.services/api/1/deliveries/by_delivery_date_and_status',
      {
        organizationIds: [city.organizationId],
        deliveryDateFrom,
        deliveryDateTo,
        statuses: null
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    
    const groups = (res.data && res.data.ordersByOrganizations) || [];
    if (groups.length > 0 && groups[0].orders.length > 0) {
        console.log(JSON.stringify(groups[0].orders[0], null, 2));
    } else {
        console.log('No orders found.');
    }

  } catch (err) {
    console.error('Error:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  }
}

fetchOrderDetails();
