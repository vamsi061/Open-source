const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { q } = require('../db/database');

// GET /api/tags - all tags with usage counts
router.get('/', async (req, res, next) => {
  try {
    const rows = await q(db.from('tags').select('id, name, project_tags(count)').order('name'));
    res.json(
      rows.map((t) => ({
        id: t.id,
        name: t.name,
        project_count: t.project_tags?.[0]?.count ?? 0,
      }))
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
