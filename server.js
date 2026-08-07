const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ML_BASE = 'https://api.mercadolibre.com';
const CLIENT_ID = '5798831532059966';
const CLIENT_SECRET = 'qt5i8KjEWCMMECtWDspShpDktS9dWCeN';

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'CPF Hub API online', version: '2.0' });
});

// Proxy GET genérico
app.get('/ml/*', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });
  const path = req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `${ML_BASE}/${path}${query ? '?' + query : ''}`;
  try {
    const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Busca pedidos com dados financeiros reais discriminados
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

    // 2. Detalhes financeiros reais de cada order em paralelo
    const detailed = await Promise.all(orders.map(async (order) => {
      try {
        const [orderDetail, shipDetail] = await Promise.all([
          // Order completa com sale_fee por item
          axios.get(`${ML_BASE}/orders/${order.id}`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.data).catch(() => order),

          // Shipment com custo real de frete do seller
          order.shipping?.id
            ? axios.get(`${ML_BASE}/shipments/${order.shipping.id}`, {
                headers: { Authorization: `Bearer ${token}` }
              }).then(r => r.data).catch(() => null)
            : Promise.resolve(null)
        ]);

        // Frete real pago pelo seller
        let shippingCost = 0;
        if (shipDetail) {
          shippingCost = Math.abs(parseFloat(shipDetail.shipping_option?.cost || 0));
          if (!shippingCost) shippingCost = Math.abs(parseFloat(shipDetail.base_cost || 0));
        }

        // Comissão real do ML por item (sale_fee)
        let mlFee = 0;
        const items = orderDetail.order_items || order.order_items || [];
        items.forEach(item => {
          if (item.sale_fee) mlFee += Math.abs(parseFloat(item.sale_fee));
        });

        // Fallback: marketplace_fee nos payments
        if (!mlFee) {
          const payments = orderDetail.payments || order.payments || [];
          payments.forEach(p => {
            if (p.marketplace_fee) mlFee += Math.abs(parseFloat(p.marketplace_fee));
          });
        }

        const salePrice = parseFloat(order.total_amount) || 0;

        return {
          ...orderDetail,
          _financial: {
            sale_price: salePrice,
            ml_fee: mlFee,
            shipping_cost: shippingCost,
            net_received: salePrice - mlFee - shippingCost,
          }
        };

      } catch (e) {
        const salePrice = parseFloat(order.total_amount) || 0;
        return {
          ...order,
          _financial: {
            sale_price: salePrice,
            ml_fee: 0,
            shipping_cost: 0,
            net_received: salePrice,
          }
        };
      }
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
    const response = await axios.post(`${ML_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CPF Hub v2.0 rodando na porta ${PORT}`));
