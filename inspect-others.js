const axios = require('axios');
const citiesConfig = require('./api/cities-config');

async function inspectOtherProducts() {
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

    const res = await axios.post(
      'https://api-ru.iiko.services/api/1/nomenclature',
      { organizationId: city.organizationId },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const products = res.data.products || [];
    
    const idsToCheck = [
      'ea7586e1-f6bc-49cf-b7e5-8ee7be75f1ba', // Вкусное путешествие
      '1fa82d60-df51-4112-bd53-c40ba5c9b1c5', // Морс облепиховый
      '1a87e019-3dff-4e07-b9f1-73cf9140bdbf'  // Морс клюквенный
    ];

    idsToCheck.forEach(id => {
        const p = products.find(x => x.id === id);
        if (p) {
            console.log(`\nID: ${id} | Name: ${p.name}`);
            console.log(`Type: ${p.type} | OrderItemType: ${p.orderItemType}`);
            console.log(`ModifierSchema: ${p.modifierSchemaName} (${p.modifierSchemaId})`);
            if (p.sizePrices && p.sizePrices.length) {
                console.log('Sizes:', p.sizePrices.map(sp => sp.sizeId));
            }
        } else {
            console.log(`\nID: ${id} NOT FOUND`);
        }
    });

  } catch (err) {
    console.error('Error:', err.message);
  }
}

inspectOtherProducts();
