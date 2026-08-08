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
  res.json({ status: 'CPF Hub API online', version: '8.0' });
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
    // Busca billing_info para separar comissão % do custo fixo ML
    const fetchFeeBreakdown = async (orderId) => {
      try {
        const billing = await axios.get(
          `${ML_BASE}/orders/${orderId}/billing_info`,
          { headers: { Authorization: `Bearer ${token}` } }
        ).then(r => r.data).catch(() => null);

        if (!billing) return { ml_fee_pct: 0, ml_fee_fixed: 0 };

        // billing_info.sale_fees[] tem os componentes separados
        let feePct = 0, feeFixed = 0;
        const fees = billing.sale_fees || [];
        fees.forEach(f => {
          const val = Math.abs(parseFloat(f.amount || 0));
          // type: "marketplace_fee" = comissão %, "fixed_fee" = custo fixo
          if (f.type === 'fixed_fee' || f.reason === 'fixed') {
            feeFixed += val;
          } else {
            feePct += val;
          }
        });

        // fallback: se não veio separado, retorna zerado
        return { ml_fee_pct: feePct, ml_fee_fixed: feeFixed };
      } catch(e) {
        return { ml_fee_pct: 0, ml_fee_fixed: 0 };
      }
    };

    const processOrder = async (order, freteRateado) => {
      const salePrice = parseFloat(order.total_amount) || 0;

      // sale_fee × quantidade = total da tarifa ML (comissão % + custo fixo)
      let mlFee = 0;
      const items = order.order_items || [];
      items.forEach(item => {
        const feePerUnit = Math.abs(parseFloat(item.sale_fee || 0));
        const qty = parseInt(item.quantity || 1);
        mlFee += feePerUnit * qty;
      });

      // Estorno: transaction_amount_refunded nos payments
      let estorno = 0;
      const payments = order.payments || [];
      payments.forEach(p => {
        const refunded = parseFloat(p.transaction_amount_refunded || 0);
        if (refunded > 0) estorno += refunded;
      });

      // Breakdown da tarifa ML (comissão % vs custo fixo)
      const breakdown = await fetchFeeBreakdown(order.id);
      // Se o billing_info não separou, estimamos: custo fixo = total - (14% do valor)
      let mlFeePct   = breakdown.ml_fee_pct;
      let mlFeeFixed = breakdown.ml_fee_fixed;
      if (mlFeePct === 0 && mlFeeFixed === 0 && mlFee > 0) {
        // Estimativa: 14% sobre o preço de venda = comissão percentual
        const estimated_pct = salePrice * 0.14;
        mlFeePct   = Math.min(estimated_pct, mlFee);
        mlFeeFixed = Math.max(0, mlFee - mlFeePct);
      }

      const shippingCost = freteRateado;
      const netReceived  = salePrice - mlFee - shippingCost + estorno;

      return {
        ...order,
        _financial: {
          sale_price:    salePrice,
          ml_fee:        mlFee,
          ml_fee_pct:    mlFeePct,
          ml_fee_fixed:  mlFeeFixed,
          shipping_cost: shippingCost,
          estorno:       estorno,
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

      for (const order of packOrders) {
        const salePrice = parseFloat(order.total_amount) || 0;
        // Frete rateado proporcionalmente ao valor do item no pack
        const freteRateado = totalValorPack > 0
          ? totalFretepack * (salePrice / totalValorPack)
          : 0;
        detailed.push(await processOrder(order, freteRateado));
      }
    }

    // Orders solo — frete integral
    for (const order of soloOrders) {
      const shippingId = order.shipping?.id;
      let frete = 0;
      if (shippingId) {
        const shipCosts = await axios.get(
          `${ML_BASE}/shipments/${shippingId}/costs`,
          { headers: { Authorization: `Bearer ${token}` } }
        ).then(r => r.data).catch(() => null);
        frete = Math.abs(parseFloat(shipCosts?.senders?.[0]?.cost || 0));
      }
      detailed.push(await processOrder(order, frete));
    }

    res.json({ results: detailed, paging });

  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Busca pública ML (sem autenticação) — para Hunter Spy
app.get('/ml-public/*', async (req, res) => {
  const path = req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `${ML_BASE}/${path}${query ? '?' + query : ''}`;
  try {
    const r = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    res.json(r.data);
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
app.listen(PORT, () => console.log(`CPF Hub v8.0 rodando na porta ${PORT}`));
