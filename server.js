const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ML_BASE = 'https://api.mercadolibre.com';
const CLIENT_ID = '5798831532059966';
const CLIENT_SECRET = 'qt5i8KjEWCMMECtWDspShpDktS9dWCeN';

app.get('/', (req, res) => {
  res.json({ status: 'CPF Hub API online', version: '5.0' });
});

// Proxy GET genérico
app.get('/ml/*', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });
  const path = req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `${ML_BASE}/${path}${query ? '?' + query : ''}`;
  try {
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Busca pedidos com dados financeiros reais e rateio de frete por pacote
app.get('/orders-full', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });

  const { seller, offset = 0, limit = 50, dateFrom, dateTo } = req.query;

  try {
    // 1. Lista de orders
    let url = `${ML_BASE}/orders/search?seller=${seller}&sort=date_desc&offset=${offset}&limit=${limit}`;
    if (dateFrom) url += `&order.date_created.from=${dateFrom}`;
    if (dateTo)   url += `&order.date_created.to=${dateTo}`;

    const listResp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    const orders = listResp.data.results || [];
    const paging = listResp.data.paging || {};

    // 2. Agrupa orders por pack_id para rateio correto de frete
    const packMap = {}; // pack_id -> [orders]
    const soloOrders = []; // orders sem pack

    orders.forEach(order => {
      if (order.pack_id) {
        if (!packMap[order.pack_id]) packMap[order.pack_id] = [];
        packMap[order.pack_id].push(order);
      } else {
        soloOrders.push(order);
      }
    });

    // 3. Busca frete real de cada pack (uma única chamada por pack)
    const packFreteMap = {}; // pack_id -> shipping_cost real
    await Promise.all(Object.keys(packMap).map(async packId => {
      try {
        // Pega o shipping_id de uma das orders do pack
        const anyOrder = packMap[packId][0];
        const shippingId = anyOrder.shipping?.id;
        if (!shippingId) { packFreteMap[packId] = 0; return; }

        const shipCosts = await axios.get(
          `${ML_BASE}/shipments/${shippingId}/costs`,
          { headers: { Authorization: `Bearer ${token}` } }
        ).then(r => r.data).catch(() => null);

        // senders[0].cost = custo final do seller após descontos do ML
        const cost = shipCosts?.senders?.[0]?.cost || 0;
        packFreteMap[packId] = Math.abs(parseFloat(cost));
      } catch(e) {
        packFreteMap[packId] = 0;
      }
    }));

    // 4. Para cada pack, rateia o frete proporcional ao valor de cada item
    const processOrder = (order, freteRateado) => {
      const salePrice = parseFloat(order.total_amount) || 0;

      // Comissão real: sale_fee × quantidade por item
      let mlFee = 0;
      const items = order.order_items || [];
      items.forEach(item => {
        const feePerUnit = Math.abs(parseFloat(item.sale_fee || 0));
        const qty = parseInt(item.quantity || 1);
        mlFee += feePerUnit * qty;
      });

      const shippingCost = freteRateado;
      const netReceived = salePrice - mlFee - shippingCost;

      return {
        ...order,
        _financial: {
          sale_price:    salePrice,
          ml_fee:        mlFee,
          shipping_cost: shippingCost,
          net_received:  netReceived,
          is_pack:       !!order.pack_id,
          pack_id:       order.pack_id || null,
        }
      };
    };

    const detailed = [];

    // Orders de pacote — rateia frete pelo peso do valor de cada order no pack
    for (const packId of Object.keys(packMap)) {
      const packOrders = packMap[packId];
      const totalFretepack = packFreteMap[packId] || 0;
      const totalValorPack = packOrders.reduce((a, o) => a + (parseFloat(o.total_amount) || 0), 0);

      packOrders.forEach(order => {
        const salePrice = parseFloat(order.total_amount) || 0;
        // Frete rateado proporcionalmente ao valor do item no pack
        const freteRateado = totalValorPack > 0
          ? totalFretepack * (salePrice / totalValorPack)
          : 0;
        detailed.push(processOrder(order, freteRateado));
      });
    }

    // Orders solo — frete integral
    await Promise.all(soloOrders.map(async order => {
      const shippingId = order.shipping?.id;
      let frete = 0;
      if (shippingId) {
        const shipCosts = await axios.get(
          `${ML_BASE}/shipments/${shippingId}/costs`,
          { headers: { Authorization: `Bearer ${token}` } }
        ).then(r => r.data).catch(() => null);
        frete = Math.abs(parseFloat(shipCosts?.senders?.[0]?.cost || 0));
      }
      detailed.push(processOrder(order, frete));
    }));

    res.json({ results: detailed, paging });

  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Refresh token
app.post('/ml/oauth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token obrigatório' });
  try {
    const r = await axios.post(
      `${ML_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CPF Hub v5.0 rodando na porta ${PORT}`));
