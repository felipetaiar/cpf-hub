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
  res.json({ status: 'CPF Hub API online', version: '1.0' });
});

// Proxy GET para a API do ML
app.get('/ml/*', async (req, res) => {
  const token = req.headers['x-ml-token'];
  if (!token) return res.status(401).json({ error: 'Token não informado' });

  const path = req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `${ML_BASE}/${path}${query ? '?' + query : ''}`;

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json(err.response?.data || { error: err.message });
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
app.listen(PORT, () => console.log(`CPF Hub rodando na porta ${PORT}`));
