
const axios = require('axios');
const citiesConfig = require('./api/cities-config');

async function fetchMenu() {
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

    console.log('Fetching nomenclature...');
    const menuRes = await axios.post(
      'https://api-ru.iiko.services/api/1/nomenclature',
      { organizationId: city.organizationId },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const products = menuRes.data.products;
    console.log(`Found ${products.length} products.`);

    // Find our specific products
    const targets = ['Лионский киш', 'Вкусное путешествие', 'Морс облепиховый', 'Морс клюквенный'];
    
    console.log('\n--- FOUND PRODUCTS ---');
    products.forEach(p => {
        // Simple fuzzy match or exact match
        if (targets.some(t => p.name.toLowerCase().includes(t.toLowerCase()))) {
            console.log(`Name: ${p.name}`);
            console.log(`ID: ${p.id}`);
            console.log(`Code: ${p.code}`);
            console.log('---');
        }
    });

  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) {
      console.error(err.response.data);
    }
  }
}

fetchMenu();
