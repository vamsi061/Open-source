const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());
app.use((req, res, next) => { console.log(new Date().toISOString(), req.method, req.url); next(); });

app.use('/api/projects', require('./routes/projects'));
app.use('/api/categories', require('./routes/categories'));
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
const server = app.listen(PORT, () => console.log(`repovault listening on http://localhost:${PORT} (db: Supabase)`));
// keep-alive window: Chrome/Node race — with the default 5s, the server closes idle
// sockets while the browser still has them pooled; the next request written to such a
// zombie socket hangs forever (fetch never resolves, CLOSE_WAIT conns pile up).
// 65s comfortably exceeds every browser's idle-pool TTL (~60s), so the browser
// closes sockets itself before the server ever does.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000; // must exceed keepAliveTimeout
