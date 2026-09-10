const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/tags - all tags with usage counts
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.name, COUNT(pt.project_id) AS project_count
    FROM tags t LEFT JOIN project_tags pt ON pt.tag_id = t.id
    GROUP BY t.id ORDER BY t.name
  `).all();
  res.json(rows);
});

module.exports = router;
