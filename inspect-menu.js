const axios = require('axios');
const citiesConfig = require('./api/cities-config');

async function inspectMenu() {
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

    console.log('Fetching menu...');
    const res = await axios.post(
      'https://api-ru.iiko.services/api/1/nomenclature',
      { organizationId: city.organizationId },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const products = res.data.products || [];
    const sizes = res.data.sizes || [];
    const groups = res.data.groups || [];

    // Find "Лионский киш"
    const problemId = '70291db1-a0fc-49df-a625-762c919cbf99';
    const problemProduct = products.find(p => p.id === problemId);

    if (problemProduct) {
        console.log('\n--- Problem Product: Лионский киш ---');
        console.log(JSON.stringify(problemProduct, null, 2));
    } else {
        console.log('\n--- Problem Product NOT FOUND in menu ---');
    }
    
    // Find Simple Products (not ByWeight, no modifiers if possible)
    console.log('\n--- Candidates for Simple Fallback Product ---');
    const simpleCandidates = products.filter(p => 
        p.type !== 'Dish' && // Dish usually has modifiers? No, 'Dish' is standard. 'Good' is retail.
        // Actually, check for absence of groupModifiers and modifiers
        (!p.groupModifiers || p.groupModifiers.length === 0) &&
        (!p.modifiers || p.modifiers.length === 0) &&
        p.isDeleted === false
    ).slice(0, 10);

    simpleCandidates.forEach(p => {
        console.log(`[${p.id}] ${p.name} (Type: ${p.type})`);
    });

    console.log('\n--- Sizes ---');
    console.log(JSON.stringify(sizes, null, 2));

  } catch (err) {
    console.error('Error:', err.response ? err.response.data : err.message);
  }
}

inspectMenu();
