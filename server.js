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
  res.json({ status: 'CPF Hub API online', version: '3.0' });
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

// Busca pedidos com dados financeiros reais
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

    // 2. Detalhes financeiros reais em paralelo
    const detailed = await Promise.all(orders.map(async (order) => {
      try {
        const salePrice = parseFloat(order.total_amount) || 0;

        // Busca order completa (tem sale_fee por item com quantidade já multiplicada)
        const orderDetail = await axios.get(`${ML_BASE}/orders/${order.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.data).catch(() => order);

        // ── COMISSÃO REAL ──
        // sale_fee no order_items já vem multiplicado pela quantidade
        let mlFee = 0;
        const items = orderDetail.order_items || order.order_items || [];
        items.forEach(item => {
          // sale_fee = comissão total do item (unit_price * qty * pct)
          const fee = parseFloat(item.sale_fee || 0);
          mlFee += Math.abs(fee);
        });

        // Fallback: marketplace_fee nos payments (também é o total)
        if (mlFee === 0) {
          const payments = orderDetail.payments || order.payments || [];
          payments.forEach(p => {
            if (p.marketplace_fee) mlFee += Math.abs(parseFloat(p.marketplace_fee) || 0);
          });
        }

        // ── FRETE REAL ──
        // Busca no shipment o custo real que o seller paga
        let shippingCost = 0;
        const shippingId = order.shipping?.id || orderDetail.shipping?.id;

        if (shippingId) {
          const shipDetail = await axios.get(`${ML_BASE}/shipments/${shippingId}`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.data).catch(() => null);

          if (shipDetail) {
            // shipping_option.cost = valor que o seller paga pelo envio
            const optCost = parseFloat(shipDetail.shipping_option?.cost || 0);
            // base_cost = custo base do envio
            const baseCost = parseFloat(shipDetail.base_cost || 0);
            // sender_cost = custo para o remetente (seller)
            const senderCost = parseFloat(shipDetail.sender_cost || 0);

            // Prioridade: sender_cost > shipping_option.cost > base_cost
            shippingCost = senderCost || optCost || baseCost;
            shippingCost = Math.abs(shippingCost);
          }
        }

        // Fallback: tenta pegar do payments
        if (shippingCost === 0) {
          const payments = orderDetail.payments || order.payments || [];
          payments.forEach(p => {
            const sc = Math.abs(parseFloat(p.shipping_cost || 0));
            if (sc > 0) shippingCost = Math.max(shippingCost, sc);
          });
        }

        const netReceived = salePrice - mlFee - shippingCost;

        return {
          ...orderDetail,
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
app.listen(PORT, () => console.log(`CPF Hub v3.0 rodando na porta ${PORT}`));
