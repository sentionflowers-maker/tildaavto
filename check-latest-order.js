const axios = require('axios');
const citiesConfig = require('./api/cities-config');

async function checkLatestOrder() {
  const city = citiesConfig.cities.msk;
  if (!city || !city.apiLogin) {
    console.error('No API login for MSK');
    return;
  }

  const phoneToFind = '+79045501567';

  try {
    // 1. Get Token
    console.log('Getting token...');
    const tokenRes = await axios.post('https://api-ru.iiko.services/api/1/access_token', {
      apiLogin: city.apiLogin
    });
    const token = tokenRes.data.token;
    console.log('Token received.');

    // 2. Search orders by phone for the last 1 hour
    const now = Date.now();
    const from = new Date(now - 2 * 60 * 60 * 1000); // 2 hours ago
    const to = new Date(now + 1 * 60 * 60 * 1000);   // 1 hour ahead (just in case)

    const deliveryDateFrom = from.toISOString().replace('T', ' ').replace('Z', '');
    const deliveryDateTo = to.toISOString().replace('T', ' ').replace('Z', '');

    console.log(`Searching orders for phone ${phoneToFind} from ${deliveryDateFrom} to ${deliveryDateTo}...`);

    const res = await axios.post(
      'https://api-ru.iiko.services/api/1/deliveries/by_delivery_date_and_phone',
      {
        phone: phoneToFind,
        deliveryDateFrom,
        deliveryDateTo,
        organizationIds: [city.organizationId],
        rowsCount: 20
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const groups = (res.data && res.data.ordersByOrganizations) || [];
    let foundOrders = [];

    groups.forEach(g => {
        const orders = g.orders || [];
        orders.forEach(o => {
            foundOrders.push(o);
        });
    });

    if (foundOrders.length > 0) {
        console.log(`\n✅ FOUND ${foundOrders.length} ORDERS!`);
        foundOrders.forEach(o => {
            console.log('--------------------------------------------------');
            console.log(`Order ID: ${o.id}`);
            console.log(`External Number: ${o.externalNumber}`);
            console.log(`Created: ${o.creationStatus}`);
            console.log(`Status: ${o.status}`);
            console.log(`Amount: ${o.order.sum}`);
            console.log(`Customer: ${o.customer ? o.customer.name : 'Unknown'}`);
            console.log(`Comment: ${o.order.comment}`);
        });
    } else {
        console.log('\n❌ No orders found for this phone number in the last 2 hours.');
    }

  } catch (err) {
    console.error('Error:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  }
}

checkLatestOrder();
