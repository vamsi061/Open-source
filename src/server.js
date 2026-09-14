const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());

app.use('/api/projects', require('./routes/projects'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/runs', require('./routes/runs'));
app.use('/api/tags', require('./routes/tags'));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'repovault', db: 'supabase' }));

// static web UI
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`repovault listening on http://localhost:${PORT} (db: Supabase)`));
