const createOrderInIiko = require('./tilda-iiko');
const fs = require('fs');
const path = require('path');

// Helper to log requests for debugging
const logDebug = (prefix, data) => {
  try {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const logsDir = path.join(__dirname, '..', 'logs');
    
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    const filename = `${prefix}-${timestamp}.json`;
    fs.writeFileSync(
      path.join(logsDir, filename), 
      JSON.stringify(data, null, 2)
    );
    console.log(`Logged ${prefix} to ${filename}`);
  } catch (e) {
    console.error('Failed to write log:', e);
  }
};

module.exports = async (req, res) => {
  console.log('Init Payment Request Method:', req.method);
  
  if (req.body) {
    console.log('Request Body Keys:', Object.keys(req.body));
    // Log the full incoming payload from Tilda
    logDebug('tilda-init-payment-request', req.body);
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // VALIDATION: Ensure we have a valid body
  if (!req.body || Object.keys(req.body).length === 0) {
    console.error('Empty request body received');
    return res.status(400).send('Bad Request: Empty body');
  }

  try {
    // BYPASS PAYMENT: Directly create order in Iiko
    console.log('Bypassing payment, delegating to tilda-iiko handler...');

    let responseData = null;
    let responseStatus = 200;

    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return mockRes;
      },
      json: (data) => {
        responseData = data;
        return mockRes;
      },
      send: (data) => {
        responseData = data;
        return mockRes;
      },
      setHeader: () => {}
    };

    // Call tilda-iiko.js handler with the current request and mocked response
    await createOrderInIiko(req, mockRes);

    // Check result
    if (responseStatus >= 200 && responseStatus < 300 && responseData && responseData.ok) {
      console.log('Order processed successfully via tilda-iiko.');
      
      // DEBUG MODE: Show details instead of redirecting
      const iikoData = responseData.iiko || {};
      const orderId = (iikoData.orderInfo && iikoData.orderInfo.id) || 'Не найден в ответе';
      const externalNumber = (iikoData.orderInfo && iikoData.orderInfo.externalNumber) || 'Не найден';
      const creationStatus = (iikoData.orderInfo && iikoData.orderInfo.creationStatus) || 'Неизвестен';
      
      const html = `
        <html>
          <head>
            <meta charset="utf-8">
            <title>Заказ отправлен в iiko</title>
            <style>
              body { font-family: sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
              .success { color: green; font-weight: bold; font-size: 1.2em; }
              .box { background: #f0f0f0; padding: 15px; border-radius: 5px; margin: 10px 0; }
              pre { white-space: pre-wrap; word-wrap: break-word; }
            </style>
          </head>
          <body>
            <h1 class="success">✅ Заказ успешно отправлен в iiko!</h1>
            <p>Сделайте скриншот этой страницы и отправьте в поддержку, если заказа нет на кассе.</p>
            
            <div class="box">
              <p><strong>ID заказа (iiko):</strong> ${orderId}</p>
              <p><strong>Внешний номер:</strong> ${externalNumber}</p>
              <p><strong>Статус создания:</strong> ${creationStatus}</p>
            </div>

            <h3>Полный ответ от iiko (Техническая информация):</h3>
            <div class="box">
              <pre>${JSON.stringify(responseData, null, 2)}</pre>
            </div>
            
            <br>
            <a href="/ordersuccess.html" style="font-size: 1.2em;">Перейти на страницу "Спасибо за заказ"</a>
          </body>
        </html>
      `;
      
      return res.status(200).send(html);
      // return res.redirect(303, '/ordersuccess.html');
    } else {
      console.error('tilda-iiko handler returned error:', responseStatus, responseData);
      const errorMsg = responseData && responseData.error ? responseData.error : 'Unknown error';
      return res.status(responseStatus).send('Error creating order: ' + errorMsg);
    }

  } catch (error) {
    console.error('Error in init-payment bypass:', error);
    return res.status(500).send('Internal Server Error: ' + error.message);
  }
};
