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
  res.json({ status: 'CPF Hub API online', version: '4.0' });
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

// Busca pedidos com dados financeiros reais e precisos
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

    // 2. Detalhes financeiros reais em lotes de 10 (evita rate limit do ML)
    const BATCH = 10;
    const detailed = [];
    for(let i = 0; i < orders.length; i += BATCH){
      const batch = orders.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (order) => {
      try {
        const salePrice = parseFloat(order.total_amount) || 0;

        // ── COMISSÃO REAL ──
        // sale_fee vem por UNIDADE no order_items
        // deve ser multiplicado pela quantidade de cada item
        const items = order.order_items || [];
        let mlFee = 0;
        items.forEach(item => {
          const feePerUnit = Math.abs(parseFloat(item.sale_fee || 0));
          const qty = parseInt(item.quantity || 1);
          mlFee += feePerUnit * qty;
        });

        // ── FRETE REAL ──
        // Endpoint correto: /shipments/{id}/costs → senders[0].cost
        // É o valor final que o seller paga, já com descontos do ML aplicados
        let shippingCost = 0;
        const shippingId = order.shipping?.id;
        if (shippingId) {
          const shipCosts = await axios.get(
            `${ML_BASE}/shipments/${shippingId}/costs`,
            { headers: { Authorization: `Bearer ${token}` } }
          ).then(r => r.data).catch(() => null);

          if (shipCosts?.senders?.length > 0) {
            // senders[0].cost = custo final do seller após descontos
            shippingCost = Math.abs(parseFloat(shipCosts.senders[0].cost || 0));
          }
        }

        const netReceived = salePrice - mlFee - shippingCost;

        return {
          ...order,
          _financial: {
            sale_price:    salePrice,
            ml_fee:        mlFee,
            shipping_cost: shippingCost,
            net_received:  netReceived,
          }
        };

      } catch (e) {
        const salePrice = parseFloat(order.total_amount) || 0;
        return {
          ...order,
          _financial: {
            sale_price:    salePrice,
            ml_fee:        0,
            shipping_cost: 0,
            net_received:  salePrice,
          }
        };
      }
    }));
      detailed.push(...results);
      // Pausa de 300ms entre lotes para respeitar rate limit do ML
      if(i + BATCH < orders.length) await new Promise(r => setTimeout(r, 300));
    }

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
app.listen(PORT, () => console.log(`CPF Hub v4.0 rodando na porta ${PORT}`));
