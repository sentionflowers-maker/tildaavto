const axios = require('axios');
const citiesConfig = require('./api/cities-config');

async function fetchRecentOrders() {
  const city = citiesConfig.cities.msk;
  if (!city || !city.apiLogin) {
    console.error('No API login for MSK');
    return;
  }

  try {
    console.log('Getting token...');
    const tokenRes = await axios.post('https://api-ru.iiko.services/api/1/access_token', {
      apiLogin: city.apiLogin
    });
    const token = tokenRes.data.token;
    console.log('Token received.');

    const now = Date.now();
    const from = new Date(now - 3 * 60 * 60 * 1000); // 3 hours ago
    const to = new Date(now + 1 * 60 * 60 * 1000);   // 1 hour ahead

    const deliveryDateFrom = from.toISOString().replace('T', ' ').replace('Z', '');
    const deliveryDateTo = to.toISOString().replace('T', ' ').replace('Z', '');

    console.log(`Fetching ALL orders from ${deliveryDateFrom} to ${deliveryDateTo}...`);

    const res = await axios.post(
      'https://api-ru.iiko.services/api/1/deliveries/by_delivery_date_and_status',
      {
        organizationIds: [city.organizationId],
        deliveryDateFrom,
        deliveryDateTo,
        statuses: null // All statuses
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const groups = (res.data && res.data.ordersByOrganizations) || [];
    let allOrders = [];

    groups.forEach(g => {
        const orders = g.orders || [];
        orders.forEach(o => {
            allOrders.push(o);
        });
    });

    if (allOrders.length > 0) {
        console.log(`\n✅ FOUND ${allOrders.length} ORDERS RECENTLY:`);
        allOrders.forEach(o => {
            console.log('--------------------------------------------------');
            console.log(`ID: ${o.id}`);
            console.log(`Ext: ${o.externalNumber}`);
            console.log(`Phone: ${o.customer ? o.customer.phone : 'N/A'}`);
            console.log(`Name: ${o.customer ? o.customer.name : 'N/A'}`);
            console.log(`Created: ${o.creationStatus}`);
            console.log(`Time: ${o.completeBefore}`);
        });
    } else {
        console.log('\n❌ No orders found in the last 3 hours.');
    }

  } catch (err) {
    console.error('Error:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  }
}

fetchRecentOrders();
