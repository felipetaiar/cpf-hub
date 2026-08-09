const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const path = require('path');
app.use(cors());
app.use(express.json());

// Serve static HTML files from /public folder
app.use(express.static(path.join(__dirname, 'public')));

const ML_BASE = 'https://api.mercadolibre.com';
const CLIENT_ID = '6586109675721603';
const CLIENT_SECRET = 'z5T3D01Ry6Noe8XuudH9NNxLZDxbuUBJ';


// ══ PERSISTÊNCIA DE TOKENS ML VIA GITHUB ══
const TOKENS_FILE = 'data/ml-tokens.json';

async function getTokensFromGitHub() {
  try {
    const r = await axios.get(
      `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${TOKENS_FILE}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    return JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  } catch(e) {
    return null;
  }
}

async function saveTokensToGitHub(tokens) {
  try {
    let sha = null;
    try {
      const r = await axios.get(
        `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${TOKENS_FILE}`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
      );
      sha = r.data.sha;
    } catch(e) {}

    const content = Buffer.from(JSON.stringify(tokens, null, 2)).toString('base64');
    await axios.put(
      `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${TOKENS_FILE}`,
      { message: 'CPF Hub: renova tokens ML', content, ...(sha ? { sha } : {}) },
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
  } catch(e) {
    console.warn('Erro ao salvar tokens:', e.message);
  }
}

// GET /ml-tokens — retorna tokens salvos
app.get('/ml-tokens', async (req, res) => {
  const tokens = await getTokensFromGitHub();
  if (tokens) res.json(tokens);
  else res.status(404).json({ error: 'Tokens não encontrados' });
});

// POST /ml-tokens — salva tokens
app.post('/ml-tokens', async (req, res) => {
  const { access_token, refresh_token } = req.body;
  if (!access_token || !refresh_token) return res.status(400).json({ error: 'access_token e refresh_token obrigatórios' });
  await saveTokensToGitHub({ access_token, refresh_token, updated_at: new Date().toISOString() });
  res.json({ ok: true });
});

// ══ PERSISTÊNCIA DE CUSTOS VIA GITHUB ══
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'felipetaiar/cpf-hub';
const COSTS_FILE   = 'data/sku-costs.json';
const GITHUB_API   = 'https://api.github.com';

async function getFileSHA() {
  try {
    const r = await axios.get(
      `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${COSTS_FILE}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    return { sha: r.data.sha, content: Buffer.from(r.data.content, 'base64').toString('utf8') };
  } catch(e) {
    if(e.response?.status === 404) return { sha: null, content: '{}' };
    throw e;
  }
}

// GET /costs — carrega custos do GitHub
app.get('/costs', async (req, res) => {
  try {
    const { content } = await getFileSHA();
    res.json(JSON.parse(content));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /costs — salva custos no GitHub
app.post('/costs', async (req, res) => {
  try {
    const newCosts = req.body;
    if(!newCosts || typeof newCosts !== 'object') return res.status(400).json({ error: 'Dados inválidos' });

    const { sha, content } = await getFileSHA();
    const existing = JSON.parse(content);
    const merged = { ...existing, ...newCosts };
    const encoded = Buffer.from(JSON.stringify(merged, null, 2)).toString('base64');

    await axios.put(
      `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${COSTS_FILE}`,
      {
        message: `CPF Hub: atualiza custos ${new Date().toISOString().slice(0,10)}`,
        content: encoded,
        ...(sha ? { sha } : {})
      },
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );

    res.json({ ok: true, total: Object.keys(merged).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'CPF Hub API online', version: '14.0' });
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

        const [shipCosts, shipDetail] = await Promise.all([
          axios.get(`${ML_BASE}/shipments/${shippingId}/costs`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.data).catch(() => null),
          axios.get(`${ML_BASE}/shipments/${shippingId}`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.data).catch(() => null),
        ]);

        const cost  = shipCosts?.senders?.[0]?.cost || 0;
        const bonus = shipCosts?.receiver?.save || 0;
        const isFlex = shipDetail?.logistic_type === 'self_service' || shipDetail?.mode === 'me2';
        packFreteMap[packId] = { frete: Math.abs(parseFloat(cost)), bonus: Math.abs(parseFloat(bonus)), isFlex };
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

    const processOrder = async (order, freteRateado, bonusEnvio = 0, isFlex = false) => {
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
      const netReceived  = salePrice - mlFee - shippingCost + estorno + bonusEnvio;

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
          bonus_envio:   bonusEnvio,
          is_flex:       isFlex,
          is_pack:       !!order.pack_id,
          pack_id:       order.pack_id || null,
        }
      };
    };

    const detailed = [];

    // Orders de pacote — rateia frete pelo peso do valor de cada order no pack
    for (const packId of Object.keys(packMap)) {
      const packOrders = packMap[packId];
      const totalFretepack = packFreteMap[packId]?.frete || 0;
      const totalBonusPack  = packFreteMap[packId]?.bonus || 0;
      const totalValorPack = packOrders.reduce((a, o) => a + (parseFloat(o.total_amount) || 0), 0);

      for (const order of packOrders) {
        const salePrice = parseFloat(order.total_amount) || 0;
        // Frete rateado proporcionalmente ao valor do item no pack
        const freteRateado = totalValorPack > 0
          ? totalFretepack * (salePrice / totalValorPack)
          : 0;
        const bonusRateado = totalValorPack > 0
          ? totalBonusPack * (salePrice / totalValorPack)
          : 0;
        const isFlexPack = packFreteMap[packId]?.isFlex || false;
        detailed.push(await processOrder(order, freteRateado, bonusRateado, isFlexPack));
      }
    }

    // Orders solo — frete integral
    for (const order of soloOrders) {
      const shippingId = order.shipping?.id;
      let frete = 0;
      let bonusEnvio = 0;
      let isFlex = false;
      if (shippingId) {
        const [shipCosts, shipDetail] = await Promise.all([
          axios.get(`${ML_BASE}/shipments/${shippingId}/costs`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.data).catch(() => null),
          axios.get(`${ML_BASE}/shipments/${shippingId}`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.data).catch(() => null),
        ]);
        frete      = Math.abs(parseFloat(shipCosts?.senders?.[0]?.cost || 0));
        bonusEnvio = Math.abs(parseFloat(shipCosts?.receiver?.save || 0));
        isFlex     = shipDetail?.logistic_type === 'self_service' || shipDetail?.mode === 'me2';
      }
      detailed.push(await processOrder(order, frete, bonusEnvio, isFlex));
    }

    res.json({ results: detailed, paging });

  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Hunter Spy — trends, highlights, categorias (endpoints disponíveis com nosso APP)
app.get('/spy/trends', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });
  try {
    const r = await axios.get(`${ML_BASE}/trends/MLB`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Busca itens do próprio seller para análise
app.get('/spy/my-items', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });
  const { seller_id, limit = 50, offset = 0 } = req.query;
  try {
    const r = await axios.get(
      `${ML_BASE}/users/${seller_id}/items/search?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    // Busca detalhes de cada item
    const ids = r.data.results || [];
    if (!ids.length) return res.json({ results: [], paging: r.data.paging });
    const details = await axios.get(
      `${ML_BASE}/items?ids=${ids.join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(d => d.data).catch(() => []);
    res.json({ results: details.map(d => d.body || d), paging: r.data.paging });
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Detalhes de um item específico (concorrente via ID ou URL)
app.get('/spy/item/:id', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });
  try {
    const [item, desc] = await Promise.all([
      axios.get(`${ML_BASE}/items/${req.params.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.data).catch(() => null),
      axios.get(`${ML_BASE}/items/${req.params.id}/description`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.data).catch(() => null),
    ]);
    res.json({ item, description: desc });
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Highlights (destaques) do ML por categoria
app.get('/spy/highlights', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });
  const { category = 'MLB1092' } = req.query; // pet shop padrão
  try {
    const r = await axios.get(`${ML_BASE}/highlights/MLB/category/${category}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    // Busca detalhes
    const ids = (r.data.content || []).map(i => i.id).slice(0, 20);
    if (!ids.length) return res.json({ results: [] });
    const details = await axios.get(
      `${ML_BASE}/items?ids=${ids.join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(d => d.data).catch(() => []);
    res.json({ results: details.map(d => d.body || d) });
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// Visitas dos meus anúncios
app.get('/spy/visits/:id', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });
  try {
    const r = await axios.get(
      `${ML_BASE}/items/${req.params.id}/visits/time_window?last=30&unit=day&ending=now`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
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
    const data = r.data;
    // Salva novos tokens no GitHub automaticamente após renovação
    if (data.access_token) {
      await saveTokensToGitHub({
        access_token: data.access_token,
        refresh_token: data.refresh_token || refresh_token,
        updated_at: new Date().toISOString()
      });
    }
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CPF Hub v14.0 rodando na porta ${PORT}`));
