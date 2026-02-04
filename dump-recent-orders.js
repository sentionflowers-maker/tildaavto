const axios = require('axios');
const citiesConfig = require('./api/cities-config');

async function dumpRecentOrders() {
  const city = citiesConfig.cities.msk;
  if (!city || !city.apiLogin) {
    console.error('No API login for MSK');
    return;
  }

  try {
    const tokenRes = await axios.post('https://api-ru.iiko.services/api/1/access_token', {
      apiLogin: city.apiLogin
    });
    const token = tokenRes.data.token;

    const now = Date.now();
    const from = new Date(now - 3 * 60 * 60 * 1000); 
    const to = new Date(now + 1 * 60 * 60 * 1000);

    const deliveryDateFrom = from.toISOString().replace('T', ' ').replace('Z', '');
    const deliveryDateTo = to.toISOString().replace('T', ' ').replace('Z', '');

    console.log(`Fetching orders from ${deliveryDateFrom} to ${deliveryDateTo}...`);

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
    let allOrders = [];
    groups.forEach(g => {
        if(g.orders) allOrders.push(...g.orders);
    });

    console.log(`Found ${allOrders.length} orders. Dumping details...`);
    
    // Check if any order contains "Anna" or "9045501567" in full JSON
    const searchStr = JSON.stringify(allOrders);
    if (searchStr.includes('Anna') || searchStr.includes('9045501567')) {
        console.log('✅ MATCH FOUND in orders!');
    } else {
        console.log('❌ NO MATCH for Anna or phone number in any order payload.');
    }
    
    // Print summaries
    allOrders.forEach(o => {
       const customer = o.customer || {};
       const order = o.order || {}; // structure varies?
       // In 'deliveries/by_delivery_date_and_status', the object IS the order (DeliveryOrder)
       
       console.log(`ID: ${o.id} | Ext: ${o.externalNumber} | Phone: ${customer.phone} | Name: ${customer.name} | Created: ${o.creationStatus}`);
    });

  } catch (err) {
    console.error('Error:', err.message);
  }
}

dumpRecentOrders();
